import { spawn as nodeSpawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, StreamingMessage, MessageReaction, RecentChatMessage, ImageAttachment, DocumentAttachment, StopTyping } from "./types.js";
import { formatImageMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime, MAX_DOCUMENT_BYTES } from "./documentStore.js";
import { buildDocumentAttachment, buildImageAttachment } from "./attachments.js";
import { log } from "../logger.js";
import { deliverTextParts } from "./delivery.js";
import { splitText, formatReplyContextMarker } from "./text-utils.js";
import { MessageGuidDedupeStore } from "./imessage-dedupe.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

const TEXT_CHUNK_LIMIT = 4000;
const RECENT_MESSAGES_PER_CHAT = 50;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const STATUS_PROBE_TIMEOUT_MS = 15_000;
// Backoff schedule for restarting a crashed `imsg rpc` child. The last entry
// repeats forever; the index resets once a child stays up for STABLE_CHILD_MS.
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const STABLE_CHILD_MS = 60_000;

/** Slash commands recognized by all channels (mirrors the BlueBubbles channel). */
const KNOWN_COMMANDS = new Set(["new", "model", "restore", "login", "status", "cost", "pet", "summon", "dismiss", "pause", "resume"]);

export interface ImsgCapabilities {
  /** RPC methods advertised by the installed imsg binary. */
  rpcMethods: Set<string>;
  /** IMCore bridge injected into Messages.app (advanced features live). */
  advancedFeatures: boolean;
  /** Per-selector availability probed by the bridge (macOS-version dependent). */
  selectors: Record<string, boolean>;
  typingIndicators: boolean;
  readReceipts: boolean;
}

const NO_CAPABILITIES: ImsgCapabilities = {
  rpcMethods: new Set(),
  advancedFeatures: false,
  selectors: {},
  typingIndicators: false,
  readReceipts: false,
};

export interface ImsgChannelConfig {
  /** Path to the imsg binary. Defaults to "imsg" (resolved via PATH). */
  cliPath?: string;
  /** Optional chat.db path forwarded as `imsg rpc --db`. */
  dbPath?: string;
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
  /** Persistent cache for inbound message GUIDs. Null/undefined keeps it in memory only. */
  dedupeStorePath?: string | null;
  /** Persistent watch cursor (last seen chat.db rowid). Null/undefined keeps it in memory only. */
  cursorStorePath?: string | null;
  /** Test seam: replacement for child_process.spawn. */
  spawnFn?: typeof nodeSpawn;
  /** Test seam: replacement for the `imsg status --json` capability probe. */
  probeCapabilities?: () => Promise<ImsgCapabilities>;
  /** Test seam: restart backoff schedule. */
  restartDelaysMs?: number[];
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/**
 * iMessage channel backed by the `imsg` CLI (github.com/openclaw/imsg),
 * successor to the BlueBubbles channel. One long-lived `imsg rpc` child
 * speaks JSON-RPC 2.0 as newline-delimited JSON over stdio:
 *
 * - inbound: `watch.subscribe` notifications (method "message"), which carry
 *   attachments with local file paths and built-in reply context
 *   (reply_to_guid/reply_to_text/reply_to_sender)
 * - outbound: `send` (AppleScript transport), `send.rich` for threaded
 *   replies, `tapback`, `typing`, `read`, `message.unsend` (IMCore bridge)
 *
 * Chat ids are chat.db chat GUIDs verbatim (e.g. "any;-;+15551234567",
 * "any;+;<hex>" on macOS 26) — the same values BlueBubbles reported — so
 * existing session keys survive the BlueBubbles → imsg cutover unchanged.
 *
 * Message edit is gated on the bridge selector probe (`imsg status --json`):
 * on macOS 26 Apple removed both edit selectors OS-wide, so the channel
 * refuses cleanly instead of calling `message.edit` blindly (see tomo#227 for
 * what calling it blindly did to BlueBubbles).
 */
export class ImsgChannel implements Channel {
  readonly name = "imessage";
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private readonly cliPath: string;
  private readonly dbPath: string | undefined;
  private readonly imageStoreBaseDir: string | undefined;
  private readonly cursorStorePath: string | null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly probeCapabilitiesFn: () => Promise<ImsgCapabilities>;
  private readonly restartDelaysMs: number[];
  private messageGuidDedupe: MessageGuidDedupeStore;

  private child: ChildProcessWithoutNullStreams | null = null;
  private childSpawnedAt = 0;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private subscriptionId: number | null = null;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilities: ImsgCapabilities = NO_CAPABILITIES;
  /** Exclusive chat.db rowid cursor; watch resubscribes after this row. */
  private lastRowId = 0;

  // Bounded per-chat window of message GUIDs + text, newest first. Populated
  // from the watch stream for inbound AND our own outbound rows (imsg emits
  // is_from_me rows too), so reply-context lookups and substring-targeted
  // reactions/replies resolve without extra RPC calls.
  private recentByChat = new Map<string, RecentChatMessage[]>();

  constructor(config: ImsgChannelConfig = {}) {
    this.cliPath = config.cliPath ?? "imsg";
    this.dbPath = config.dbPath;
    this.imageStoreBaseDir = config.imageStoreBaseDir;
    this.cursorStorePath = config.cursorStorePath ?? null;
    this.spawnFn = config.spawnFn ?? nodeSpawn;
    this.probeCapabilitiesFn = config.probeCapabilities ?? (() => this.probeStatus());
    this.restartDelaysMs = config.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.messageGuidDedupe = new MessageGuidDedupeStore(config.dedupeStorePath ?? null);
    this.loadCursor();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async start(): Promise<void> {
    log.info("iMessage channel (imsg) starting");

    // Capability probe: `imsg status --json` reports the injected bridge's
    // selector availability. Failure is non-fatal — the channel degrades to
    // basic send/watch (AppleScript transport needs no bridge).
    try {
      this.capabilities = await this.probeCapabilitiesFn();
      log.info({
        advancedFeatures: this.capabilities.advancedFeatures,
        typing: this.capabilities.typingIndicators,
        readReceipts: this.capabilities.readReceipts,
        editSupported: this.isEditSupported(),
      }, "imsg capabilities probed");
    } catch (err) {
      this.capabilities = NO_CAPABILITIES;
      log.warn({ err }, "imsg status probe failed; assuming basic features only");
    }

    // First spawn + subscribe must succeed or daemon startup should fail
    // loudly (missing binary, missing Full Disk Access, ...).
    await this.spawnChildAndSubscribe();

    log.info("iMessage channel (imsg) ready");
  }

  async stop(): Promise<void> {
    log.info("iMessage channel (imsg) stopping");
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.child && this.subscriptionId !== null) {
      try {
        await this.request("watch.unsubscribe", { subscription: this.subscriptionId }, 3_000);
      } catch {
        // Best-effort; the child is about to be killed anyway.
      }
    }
    this.killChild();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (message.sticker) {
      log.warn({ chatId: message.chatId }, "Ignoring unsupported sticker send on iMessage channel");
      return;
    }

    if (message.photo) {
      await this.sendAttachment(message.chatId, message.photo, message.text);
      return;
    }

    const text = message.text;
    if (!text) return;

    const chunks = splitText(text, TEXT_CHUNK_LIMIT);
    for (const [i, chunk] of chunks.entries()) {
      // Threaded replies need the IMCore bridge (send.rich); plain sends stay
      // on the AppleScript transport. Only the first chunk threads —
      // continuation chunks read as one message, not repeated replies.
      const threaded = i === 0 && message.replyTo;
      if (threaded && this.capabilities.advancedFeatures) {
        try {
          const result = await this.request("send.rich", {
            chat_guid: message.chatId,
            text: chunk,
            reply_to: message.replyTo,
            part_index: 0,
          });
          this.recordOwnSend(message.chatId, result, chunk);
          continue;
        } catch (err) {
          log.warn({ err, chatId: message.chatId }, "imsg threaded reply failed; falling back to plain send");
        }
      }
      const result = await this.request("send", {
        chat_guid: message.chatId,
        text: chunk,
      });
      this.recordOwnSend(message.chatId, result, chunk);
    }
  }

  recentMessages(chatId: string): RecentChatMessage[] {
    const exact = this.recentByChat.get(chatId);
    if (exact) return [...exact];
    if (chatId.includes(";")) return [];
    // Callers may address a DM by bare handle (the config identity form,
    // e.g. "+15551234567") while the ring is keyed by chat GUID
    // ("any;-;+15551234567") — match on the GUID's identifier part.
    const want = this.normalizeAddress(chatId);
    for (const [key, ring] of this.recentByChat) {
      const parts = key.split(";");
      if (parts.length < 3 || parts[1] === "+") continue; // groups are GUID-addressed
      if (this.normalizeAddress(parts.slice(2).join(";")) === want) return [...ring];
    }
    return [];
  }

  async setChatTitle(chatId: string, title: string): Promise<void> {
    // Requires the IMCore bridge (imsg launch).
    await this.request("group.rename", { chat_guid: chatId, name: title });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    // Targeted tapback via the IMCore bridge — reaction names map 1:1 to
    // imsg's normalized kinds (love/like/dislike/laugh/emphasize/question).
    await this.request("tapback", {
      chat_guid: chatId,
      message_guid: messageId,
      reaction,
      remove,
      part_index: 0,
    });
  }

  /** True when the bridge selector probe confirmed an edit path exists. */
  isEditSupported(): boolean {
    return this.capabilities.selectors.editMessageItem === true
      || this.capabilities.selectors.editMessage === true;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Edited message text cannot be empty");
    // Apple removed both IMCore edit selectors (editMessageItem and the older
    // editMessage) in macOS 26 — calling message.edit blindly is what crashed
    // Messages.app on the BlueBubbles path (#227). Only proceed when the
    // startup selector probe confirmed one of them exists.
    if (!this.isEditSupported()) {
      throw new Error(
        "iMessage message editing is unsupported on this macOS: the IMCore edit selectors "
        + "(editMessageItem/editMessage) are unavailable per the imsg bridge probe. "
        + "Send a correction message instead.",
      );
    }
    await this.request("message.edit", {
      chat_guid: chatId,
      message_guid: messageId,
      text,
      // Shown as a follow-up bubble on recipients too old to render edits.
      backwards_compatibility_message: `Edited to: ${text}`,
      part_index: 0,
    });
    // Keep substring targeting working against what's actually on screen.
    // Message GUIDs are globally unique, so scanning rings needs no chat key.
    for (const ring of this.recentByChat.values()) {
      const entry = ring.find((m) => m.id === messageId);
      if (entry) {
        entry.text = text;
        return;
      }
    }
  }

  async unsendMessage(chatId: string, messageId: string): Promise<void> {
    // Requires the IMCore bridge (retractMessagePart). Apple only allows
    // unsend within 2 minutes of sending; recipients see a "message was
    // unsent" notice. Bridge/selector failures surface as RPC errors.
    await this.request("message.unsend", {
      chat_guid: chatId,
      message_guid: messageId,
      part_index: 0,
    });
    for (const ring of this.recentByChat.values()) {
      const idx = ring.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        ring.splice(idx, 1);
        return;
      }
    }
  }

  createStreamingMessage(chatId: string, replyTo?: string): StreamingMessage {
    // iMessage can't stream into a sent bubble — buffer per block, ship at
    // boundary (commitBlock between text blocks, finish at end of turn).
    // NO_REPLY-only blocks are dropped silently, mirroring the BlueBubbles
    // channel and Telegram's prefix suppression.
    let buffer = "";
    let canceled = false;
    // Group replies carry the triggering message's GUID; thread only the
    // first shipped block — one reply, not one per block.
    let pendingReplyTo = replyTo;

    const NO_REPLY_RE = /^\s*NO_REPLY\s*$/i;

    const shipBuffer = async () => {
      if (canceled || !buffer) return;
      if (NO_REPLY_RE.test(buffer)) { buffer = ""; return; }
      const text = buffer;
      buffer = "";
      const threadTarget = pendingReplyTo;
      pendingReplyTo = undefined;
      await deliverTextParts(this, chatId, text, { replyTo: threadTarget });
    };

    return {
      update: (text: string) => {
        if (canceled) return;
        buffer = text;
      },
      commitBlock: async () => {
        if (canceled) return;
        await shipBuffer();
      },
      finish: async () => {
        if (canceled) return;
        await shipBuffer();
      },
      cancel: async () => {
        canceled = true;
        buffer = "";
      },
      discardBlock: async () => {
        if (canceled) return;
        buffer = "";
      },
    };
  }

  startTyping(chatId: string): StopTyping {
    // Typing indicators require the IMCore bridge; without it every tick
    // would error, so degrade to a no-op.
    if (!this.capabilities.typingIndicators) {
      return () => {};
    }

    let sealed = false;
    let tickInFlight: Promise<void> | null = null;
    let consecutiveErrors = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    let ttl: ReturnType<typeof setTimeout> | null = null;

    // The bridge's indicator persistence across time isn't documented, so
    // refresh periodically like the BlueBubbles channel does (at a gentler
    // cadence — each tick is a local IMCore call, not an HTTP hop).
    const INTERVAL_MS = 10_000;
    const TTL_MS = 2 * 60 * 1000;
    const MAX_ERRORS = 5;

    const setTypingState = async (typing: boolean) => {
      await this.request("typing", { chat_guid: chatId, typing }, 5_000);
    };

    const cleanup = async () => {
      if (sealed) return;
      sealed = true;
      if (interval) clearInterval(interval);
      if (ttl) clearTimeout(ttl);
      if (tickInFlight) await tickInFlight.catch(() => {});
      // Unlike BlueBubbles (whose server decays the indicator), the bridge
      // indicator has no known decay — always stop it explicitly.
      try {
        await setTypingState(false);
      } catch (err) {
        log.debug({ err, chatId }, "Failed to clear imsg typing indicator");
      }
    };

    const sendTyping = () => {
      if (sealed || tickInFlight) return;
      if (consecutiveErrors >= MAX_ERRORS) {
        log.warn({ chatId }, "imsg typing suspended after %d consecutive errors", MAX_ERRORS);
        void cleanup();
        return;
      }
      tickInFlight = (async () => {
        try {
          await setTypingState(true);
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors++;
        } finally {
          tickInFlight = null;
        }
      })();
    };

    sendTyping();
    interval = setInterval(sendTyping, INTERVAL_MS);
    ttl = setTimeout(() => void cleanup(), TTL_MS);

    return cleanup;
  }

  // --- imsg rpc child lifecycle ---

  private async spawnChildAndSubscribe(): Promise<void> {
    const args = ["rpc", ...(this.dbPath ? ["--db", this.dbPath] : [])];
    const child = this.spawnFn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.childSpawnedAt = Date.now();
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) log.debug({ imsg: line }, "imsg rpc stderr");
    });
    child.on("error", (err) => {
      log.error({ err }, "imsg rpc child failed to spawn");
      this.handleChildDown(child, `spawn error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.handleChildDown(child, `exited with code ${code} signal ${signal}`);
    });

    // Subscribe to the all-chat watch stream. `since_rowid` resumes from the
    // persisted cursor so messages that arrived while we were down replay
    // (the GUID dedupe store drops any we already dispatched).
    const result = await this.request("watch.subscribe", {
      attachments: true,
      convert_attachments: true,
      include_reactions: true,
      ...(this.lastRowId > 0 ? { since_rowid: this.lastRowId } : {}),
    });
    const subscription = result.subscription;
    this.subscriptionId = typeof subscription === "number" ? subscription : null;
    log.info({ subscription: this.subscriptionId, sinceRowId: this.lastRowId || undefined }, "imsg watch subscribed");
  }

  private handleChildDown(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return; // stale event from an already-replaced child
    this.child = null;
    this.subscriptionId = null;

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const req of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`imsg rpc child ${reason} while awaiting ${req.method}`));
    }

    if (this.stopping) return;

    // A child that survived a while earns a fresh backoff schedule.
    if (Date.now() - this.childSpawnedAt >= STABLE_CHILD_MS) {
      this.restartAttempt = 0;
    }
    const delay = this.restartDelaysMs[Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)];
    this.restartAttempt++;
    log.warn({ reason, delayMs: delay, attempt: this.restartAttempt }, "imsg rpc child down; restarting with backoff");

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnChildAndSubscribe().catch((err) => {
        log.error({ err }, "imsg rpc child restart failed");
        this.handleChildDown(this.child ?? child, "restart failed");
      });
    }, delay);
    // Don't hold the process open just for a pending restart.
    this.restartTimer.unref?.();
  }

  private killChild(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.subscriptionId = null;
    child.kill();
  }

  // --- JSON-RPC over stdio (newline-delimited JSON) ---

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error(`imsg rpc child is not running (${method})`));
    }
    const id = this.nextRequestId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`imsg rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(line, (err) => {
        if (err) {
          const req = this.pending.get(id);
          if (req) {
            this.pending.delete(id);
            clearTimeout(req.timer);
            reject(new Error(`imsg rpc write failed for ${method}: ${err.message}`));
          }
        }
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.warn({ line: line.slice(0, 200) }, "imsg rpc emitted a non-JSON line");
        continue;
      }
      this.handleRpcPayload(payload);
    }
  }

  private handleRpcPayload(payload: Record<string, unknown>): void {
    // Response to one of our requests
    if (payload.id !== undefined && payload.id !== null) {
      const id = typeof payload.id === "number" ? payload.id : Number(payload.id);
      const req = this.pending.get(id);
      if (!req) return;
      this.pending.delete(id);
      clearTimeout(req.timer);
      if (payload.error) {
        const error = payload.error as { code?: number; message?: string; data?: string };
        const detail = error.data ? `: ${error.data}` : "";
        req.reject(new Error(`imsg rpc ${req.method} failed (${error.code ?? "?"}) ${error.message ?? "error"}${detail}`));
      } else {
        req.resolve((payload.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    // Notification (no id)
    if (payload.method === "message") {
      const params = payload.params as Record<string, unknown> | undefined;
      const message = params?.message as Record<string, unknown> | undefined;
      if (!message) return;
      this.handleWatchMessage(message).catch((err) => {
        log.error({ err }, "Error processing imsg watch message");
      });
      return;
    }

    if (payload.method === "error") {
      // The watch stream died server-side; the subscription will not recover
      // on its own. Restart the child to rebuild it from the rowid cursor.
      log.error({ params: payload.params }, "imsg watch stream errored; restarting rpc child");
      const child = this.child;
      if (child) {
        child.kill();
        // Schedule the restart ourselves: handleChildDown nulls this.child,
        // so the child's own late "exit" event is ignored as stale.
        this.handleChildDown(child, "watch stream error");
      }
    }
  }

  // --- Inbound watch messages ---

  private async handleWatchMessage(data: Record<string, unknown>): Promise<void> {
    // Advance the watch cursor first: even rows we drop (echo, dedupe, ghost)
    // must not replay after a child restart.
    const rowId = typeof data.id === "number" ? data.id : 0;
    if (rowId > this.lastRowId) {
      this.lastRowId = rowId;
      this.persistCursor();
    }

    const chatGuid = typeof data.chat_guid === "string" ? data.chat_guid : "";
    if (!chatGuid) return;

    const guid = typeof data.guid === "string" ? data.guid : "";
    const text = typeof data.text === "string" ? data.text : "";
    const isFromMe = data.is_from_me === true;
    const sender = typeof data.sender === "string" ? data.sender : "";
    const senderName = (typeof data.sender_name === "string" && data.sender_name) || sender || "Unknown";
    const timestamp = typeof data.created_at === "string" ? Date.parse(data.created_at) : NaN;
    const timestampMs = Number.isFinite(timestamp) ? timestamp : Date.now();

    // Inbound tapbacks surface as reaction events (include_reactions: true) —
    // BlueBubbles dropped these entirely. Handled before ring recording so a
    // reaction row never pollutes substring targeting.
    if (data.is_reaction === true) {
      this.handleInboundReaction(chatGuid, data, { guid, isFromMe, sender, senderName, timestampMs });
      return;
    }

    // Track every real message row — inbound AND our own outbound — so
    // reply-context lookups and substring-targeted reactions/replies can
    // resolve text to a GUID later. Insertion is GUID-deduped.
    if (guid && text.trim()) {
      this.recordRecentMessage(chatGuid, {
        id: guid,
        text,
        ...(isFromMe ? {} : { senderName }),
        timestamp: timestampMs,
        fromMe: isFromMe,
      });
    }

    // Skip our own rows (outbound echo — imsg emits is_from_me rows on the
    // watch stream, debounced 500ms server-side so send follow-ups settle).
    if (isFromMe) return;

    // The rowid cursor makes exact replays unlikely, but keep the persistent
    // GUID dedupe as a second layer: it also spans the BlueBubbles → imsg
    // cutover (same chat.db message GUIDs), so messages the BlueBubbles
    // channel already dispatched are not dispatched again by this one.
    if (guid && this.messageGuidDedupe.checkAndRecord(guid)) {
      log.debug({ guid }, "Dropping replayed imsg message (guid already seen)");
      return;
    }

    // Group chats: GUIDs contain ";+;" (e.g. "any;+;<hex>").
    const isGroup = data.is_group === true || chatGuid.includes(";+;");
    // iMessage has no @mention system — treat all group messages as mentioned.
    const isMentioned = isGroup;

    // Handle slash commands
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1).join(" ");
      if (KNOWN_COMMANDS.has(command)) {
        const senderId = sender ? this.normalizeAddress(sender) : undefined;
        for (const handler of this.commandHandlers) {
          await handler(command, chatGuid, senderName, args, senderId);
        }
        return;
      }
    }

    // Attachments arrive as local file paths (imsg reads chat.db directly).
    const rawAttachments = Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : [];
    const intendedImageCount = rawAttachments.filter((a) => this.attachmentMime(a).startsWith("image/")).length;
    const intendedDocumentCount = rawAttachments.filter((a) => isSupportedDocumentMime(this.attachmentMime(a))).length;
    const { images, documents } = await this.loadAttachments(rawAttachments, chatGuid);

    // Mark chat as read (best-effort; needs the bridge's read-receipt path).
    if (this.capabilities.readReceipts) {
      this.request("read", { chat_guid: chatGuid }, 5_000).catch(() => {});
    }

    const imageSavedPaths = images.map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const docSavedPaths = documents.map((d) => d.savedPath).filter((p): p is string => Boolean(p));
    const imageMarker = formatImageMarker(intendedImageCount, imageSavedPaths);
    const docMarker = formatDocumentMarker(intendedDocumentCount, docSavedPaths);

    // Threaded replies carry the original inline: reply_to_guid plus
    // reply_to_text/reply_to_sender resolved by imsg from chat.db — no
    // lookup round-trip like the BlueBubbles channel needed. Only tag rows
    // with real content so a ghost row can't become a prompt.
    const replyToGuid = (typeof data.thread_originator_guid === "string" && data.thread_originator_guid)
      || (typeof data.reply_to_guid === "string" && data.reply_to_guid) || "";
    const hasContent = Boolean(text.trim()) || images.length > 0 || documents.length > 0;
    const replyMarker = replyToGuid && hasContent
      ? formatReplyContextMarker(typeof data.reply_to_text === "string" ? data.reply_to_text : undefined)
      : "";

    const markers = [replyMarker, imageMarker, docMarker].filter(Boolean).join(" ");
    const composedText = text
      ? (markers ? `${markers} ${text}` : text)
      : markers;

    // Ghost, poll, and system rows can arrive with no text or usable
    // attachment. Do not turn them into blank agent prompts.
    if (!composedText.trim() && images.length === 0 && documents.length === 0) {
      log.debug({ guid }, "Ignoring empty imsg message (no text or attachments)");
      return;
    }

    const message: IncomingMessage = {
      id: guid,
      chatId: chatGuid,
      senderName,
      // Normalized so the same person matches whether the handle is reported
      // as "+1 (415) 555-1234" or "+14155551234" across restarts.
      senderId: sender ? this.normalizeAddress(sender) : undefined,
      text: composedText,
      images: images.length > 0 ? images : undefined,
      documents: documents.length > 0 ? documents : undefined,
      timestamp: timestampMs,
      isGroup,
      isMentioned,
      chatTitle: (typeof data.chat_name === "string" && data.chat_name) || undefined,
    };

    // Fire-and-forget: the agent's per-session queue handles ordering.
    for (const handler of this.handlers) {
      handler(message).catch((err) => log.error({ err }, "iMessage handler failed"));
    }
  }

  private handleInboundReaction(
    chatGuid: string,
    data: Record<string, unknown>,
    meta: { guid: string; isFromMe: boolean; sender: string; senderName: string; timestampMs: number },
  ): void {
    // Only surface tapbacks other people ADD; removals and our own reactions
    // are noise. Dedupe by reaction-row GUID so watch replays don't re-fire.
    if (meta.isFromMe) return;
    if (data.is_reaction_add !== true) return;
    if (meta.guid && this.messageGuidDedupe.checkAndRecord(meta.guid)) return;

    const reactionType = typeof data.reaction_type === "string" ? data.reaction_type : "";
    const reactionEmoji = typeof data.reaction_emoji === "string" ? data.reaction_emoji : "";
    const reaction = reactionEmoji || reactionType;
    if (!reaction) return;

    const reactedToGuid = typeof data.reacted_to_guid === "string" ? data.reacted_to_guid : "";
    const original = reactedToGuid
      ? this.recentByChat.get(chatGuid)?.find((m) => m.id === reactedToGuid)?.text
      : undefined;
    const target = original ? formatReplyContextMarker(original).replace(/^\[replying to/, "[reacting to") : "";

    const message: IncomingMessage = {
      id: meta.guid,
      chatId: chatGuid,
      senderName: meta.senderName,
      senderId: meta.sender ? this.normalizeAddress(meta.sender) : undefined,
      text: target
        ? `${target} [tapback: ${reaction}]`
        : `[tapback: ${reaction} on an earlier message]`,
      timestamp: meta.timestampMs,
      isGroup: data.is_group === true || chatGuid.includes(";+;"),
      // Tapbacks are ambient signals, not summons — never treat as mentioned,
      // so group sessions can stay silent without an explicit NO_REPLY.
      isMentioned: false,
      chatTitle: (typeof data.chat_name === "string" && data.chat_name) || undefined,
    };

    for (const handler of this.handlers) {
      handler(message).catch((err) => log.error({ err }, "iMessage tapback handler failed"));
    }
  }

  private recordRecentMessage(chatGuid: string, message: RecentChatMessage): void {
    const ring = this.recentByChat.get(chatGuid) ?? [];
    if (ring.some((m) => m.id === message.id)) return;
    ring.unshift(message); // newest first
    if (ring.length > RECENT_MESSAGES_PER_CHAT) ring.pop();
    this.recentByChat.set(chatGuid, ring);
  }

  /** Record an outbound send into the recent ring when the RPC returned a GUID. */
  private recordOwnSend(chatId: string, result: Record<string, unknown>, text: string): void {
    const guid = typeof result.guid === "string" ? result.guid : undefined;
    if (!guid || !text.trim()) return;
    this.recordRecentMessage(chatId, {
      id: guid,
      text,
      timestamp: Date.now(),
      fromMe: true,
    });
  }

  // --- Attachments ---

  private attachmentMime(att: Record<string, unknown>): string {
    // Prefer the converted flavor (convert_attachments: true rewrites e.g.
    // HEIC/CAF into web-friendly types).
    const converted = att.converted_mime_type;
    if (typeof converted === "string" && converted) return converted;
    const mime = att.mime_type;
    return typeof mime === "string" ? mime : "";
  }

  private attachmentPath(att: Record<string, unknown>): string {
    if (typeof att.converted_path === "string" && att.converted_path) return att.converted_path;
    // v0.12.x emits `original_path`; older docs call it `path`. Accept both.
    if (typeof att.original_path === "string" && att.original_path) return att.original_path;
    if (typeof att.path === "string" && att.path) return att.path;
    return "";
  }

  private async loadAttachments(
    attachments: Array<Record<string, unknown>>,
    chatGuid: string,
  ): Promise<{ images: ImageAttachment[]; documents: DocumentAttachment[] }> {
    const images: ImageAttachment[] = [];
    const documents: DocumentAttachment[] = [];

    for (const att of attachments) {
      if (att.missing === true) continue;
      const mimeType = this.attachmentMime(att);
      if (!mimeType) continue;

      const isImage = mimeType.startsWith("image/");
      const isDocument = isSupportedDocumentMime(mimeType);
      if (!isImage && !isDocument) continue;

      const filePath = this.attachmentPath(att);
      if (!filePath) continue;

      try {
        if (isDocument) {
          // Cap document reads before touching the bytes (mirror the
          // BlueBubbles channel's pre-download and streaming caps).
          const declared = att.total_bytes ?? att.byte_size;
          if (typeof declared === "number" && declared > MAX_DOCUMENT_BYTES) {
            log.warn({ path: filePath, declared, max: MAX_DOCUMENT_BYTES }, "Skipping oversized document attachment (declared)");
            continue;
          }
          const actual = (await stat(filePath)).size;
          if (actual > MAX_DOCUMENT_BYTES) {
            log.warn({ path: filePath, actual, max: MAX_DOCUMENT_BYTES }, "Skipping oversized document attachment (on disk)");
            continue;
          }
        }

        const buffer = await readFile(filePath);
        const meta = {
          sessionKey: `imessage_${chatGuid}`,
          guid: (typeof att.filename === "string" && att.filename) || basename(filePath),
        };

        if (isImage) {
          images.push(await buildImageAttachment(buffer, mimeType, meta, this.imageStoreBaseDir));
        } else {
          const filename = (typeof att.transfer_name === "string" && att.transfer_name) || basename(filePath);
          documents.push(await buildDocumentAttachment(buffer, mimeType, { ...meta, filename }, this.imageStoreBaseDir));
        }
      } catch (err) {
        log.error({ err, path: filePath }, "Failed to read imsg attachment");
      }
    }

    return { images, documents };
  }

  // --- Outbound attachments ---

  private async sendAttachment(chatGuid: string, filePath: string, caption?: string): Promise<void> {
    if (!existsSync(filePath)) {
      log.warn({ path: filePath }, "Attachment file not found");
      return;
    }
    // The plain `send` file param works on the AppleScript transport — no
    // bridge required (send.attachment is bridge-only).
    await this.request("send", { chat_guid: chatGuid, file: filePath });

    if (caption) {
      await this.send({ chatId: chatGuid, text: caption });
    }
  }

  // --- Capability probe ---

  /** Run `imsg status --json` and normalize the capability surface. */
  private probeStatus(): Promise<ImsgCapabilities> {
    return new Promise((resolve, reject) => {
      execFile(this.cliPath, ["status", "--json"], { timeout: STATUS_PROBE_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          reject(new Error(`imsg status probe failed: ${err.message}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          resolve({
            rpcMethods: new Set(Array.isArray(parsed.rpc_methods) ? parsed.rpc_methods.filter((m): m is string => typeof m === "string") : []),
            advancedFeatures: parsed.advanced_features === true,
            selectors: (parsed.selectors ?? {}) as Record<string, boolean>,
            typingIndicators: parsed.typing_indicators === true,
            readReceipts: parsed.read_receipts === true,
          });
        } catch (parseErr) {
          reject(new Error(`imsg status probe returned invalid JSON: ${String(parseErr)}`));
        }
      });
    });
  }

  // --- Watch cursor persistence ---

  private loadCursor(): void {
    if (!this.cursorStorePath || !existsSync(this.cursorStorePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.cursorStorePath, "utf-8")) as { lastRowId?: unknown };
      if (typeof data.lastRowId === "number" && Number.isFinite(data.lastRowId)) {
        this.lastRowId = data.lastRowId;
      }
    } catch (err) {
      log.warn({ err, file: this.cursorStorePath }, "Could not load imsg watch cursor; starting from now");
    }
  }

  private persistCursor(): void {
    if (!this.cursorStorePath) return;
    try {
      mkdirSync(dirname(this.cursorStorePath), { recursive: true });
      writeJsonAtomicSync(this.cursorStorePath, { lastRowId: this.lastRowId });
    } catch (err) {
      log.debug({ err, file: this.cursorStorePath }, "Could not persist imsg watch cursor");
    }
  }

  /** Normalize phone number: strip non-digits except leading + */
  private normalizeAddress(addr: string): string {
    if (addr.includes("@")) return addr.toLowerCase();
    return addr.replace(/[^\d+]/g, "");
  }
}
