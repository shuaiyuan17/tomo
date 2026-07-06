import { createServer, type Server, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, StreamingMessage, MessageReaction, RecentChatMessage, ImageAttachment, DocumentAttachment, StopTyping } from "./types.js";
import { formatImageMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime } from "./documentStore.js";
import {
  buildDocumentAttachment,
  buildImageAttachment,
  isDeclaredDocumentTooLarge,
  readDocumentResponseWithCap,
} from "./attachments.js";
import { log } from "../logger.js";
import { deliverTextParts } from "./delivery.js";
import { splitText, isSatelliteService, formatReplyContextMarker, SATELLITE_MARKER } from "./text-utils.js";
import { MessageGuidDedupeStore } from "./imessage-dedupe.js";

const TEXT_CHUNK_LIMIT = 4000;
const RECENT_MESSAGES_PER_CHAT = 50;
// Reply-context lookups run before inbound dispatch — bound them so a slow
// BlueBubbles server can only delay delivery, never stall it.
const MESSAGE_LOOKUP_TIMEOUT_MS = 3000;

interface BlueBubblesConfig {
  url: string;
  password: string;
  webhookPort: number;
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
  /** Persistent cache for inbound message GUIDs. Null/undefined keeps it in memory only. */
  dedupeStorePath?: string | null;
}

export class BlueBubblesChannel implements Channel {
  readonly name = "imessage";
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private server: Server | null = null;
  private webhookId: number | null = null;
  private apiUrl: string;
  private password: string;
  private webhookPort: number;
  private imageStoreBaseDir: string | undefined;
  private contactCache = new Map<string, string>(); // address → display name
  private messageGuidDedupe: MessageGuidDedupeStore;
  // Bounded per-chat window of message GUIDs + text, newest first. Populated
  // from the webhook for inbound AND our own outbound rows (BlueBubbles fires
  // new-message for isFromMe too), so both reply-context lookups and
  // substring-targeted reactions/replies resolve without extra HTTP calls.
  private recentByChat = new Map<string, RecentChatMessage[]>();

  constructor(config: BlueBubblesConfig) {
    this.apiUrl = config.url.replace(/\/+$/, "");
    this.password = config.password;
    this.webhookPort = config.webhookPort;
    this.imageStoreBaseDir = config.imageStoreBaseDir;
    this.messageGuidDedupe = new MessageGuidDedupeStore(config.dedupeStorePath ?? null);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async start(): Promise<void> {
    log.info("iMessage channel starting");

    // Verify BlueBubbles server is reachable
    try {
      await this.api("GET", "/ping");
      log.info("BlueBubbles server connected");
    } catch (err) {
      log.error({ err }, "Failed to connect to BlueBubbles server at %s", this.apiUrl);
      throw new Error(`BlueBubbles server unreachable at ${this.apiUrl}`, { cause: err });
    }

    // Load contacts for name resolution
    await this.loadContacts();

    // Start webhook HTTP server
    await this.startWebhookServer();

    // Register webhook with BlueBubbles
    await this.registerWebhook();

    log.info("iMessage channel ready");
  }

  async stop(): Promise<void> {
    log.info("iMessage channel stopping");

    // Unregister webhook
    if (this.webhookId !== null) {
      try {
        await this.api("DELETE", `/webhook/${this.webhookId}`);
        log.info("Webhook unregistered");
      } catch {
        log.warn("Failed to unregister webhook");
      }
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
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

    // Split long messages
    const chunks = splitText(text, TEXT_CHUNK_LIMIT);
    for (const [i, chunk] of chunks.entries()) {
      // Threaded replies require the Private API helper (like tapbacks);
      // plain sends stay on apple-script. Only the first chunk threads —
      // continuation chunks read as one message, not repeated replies.
      const threaded = i === 0 && message.replyTo;
      await this.api("POST", "/message/text", {
        chatGuid: message.chatId,
        tempGuid: `tomo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message: chunk,
        ...(threaded
          ? { method: "private-api", selectedMessageGuid: message.replyTo, partIndex: 0 }
          : { method: "apple-script" }),
      });
    }
  }

  recentMessages(chatId: string): RecentChatMessage[] {
    const exact = this.recentByChat.get(chatId);
    if (exact) return [...exact];
    if (chatId.includes(";")) return [];
    // Callers may address a DM by bare handle (the config identity form,
    // e.g. "+15551234567") while the ring is keyed by BlueBubbles chat GUID
    // ("iMessage;-;+15551234567") — match on the GUID's identifier part.
    const want = this.normalizeAddress(chatId);
    for (const [key, ring] of this.recentByChat) {
      const parts = key.split(";");
      if (parts.length < 3 || parts[1] === "+") continue; // groups are GUID-addressed
      if (this.normalizeAddress(parts.slice(2).join(";")) === want) return [...ring];
    }
    return [];
  }

  async setChatTitle(chatId: string, title: string): Promise<void> {
    await this.api("PUT", `/chat/${encodeURIComponent(chatId)}`, {
      displayName: title,
    });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    await this.api("POST", "/message/react", {
      chatGuid: chatId,
      selectedMessageGuid: messageId,
      reaction: remove ? `-${reaction}` : reaction,
      partIndex: 0,
    });
  }

  createStreamingMessage(chatId: string, replyTo?: string): StreamingMessage {
    // iMessage can't edit sent messages — buffer per block, ship at boundary
    // (commitBlock between text blocks, finish at end of turn). NO_REPLY-only
    // blocks are dropped silently to mirror Telegram's prefix-suppression.
    let buffer = "";
    let canceled = false;
    // Group replies carry the triggering message's GUID (mirrors Telegram);
    // thread only the first shipped block — one reply, not one per block.
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
        // iMessage buffers until ship, so nothing visible has been sent yet —
        // just mark canceled and drop the buffer.
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
    // Typing indicators require BlueBubbles Private API.
    // BlueBubbles' typing indicator decays server-side faster than Telegram's,
    // so we refresh at 3s (vs Telegram's 6s) to avoid visible flicker.
    let sealed = false;
    let tickInFlight: Promise<void> | null = null;
    let consecutiveErrors = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    let ttl: ReturnType<typeof setTimeout> | null = null;

    const INTERVAL_MS = 3000;
    const TTL_MS = 2 * 60 * 1000;
    const STOP_WAIT_MS = 1000;
    const MAX_ERRORS = 10;

    const clearTyping = async () => {
      try {
        await this.api("DELETE", `/chat/${encodeURIComponent(chatId)}/typing`);
      } catch (err) {
        log.debug({ err, chatId }, "Failed to clear iMessage typing indicator");
      }
    };

    const cleanup = async (options: { clear?: boolean } = {}) => {
      if (sealed) return;
      sealed = true;
      if (interval) clearInterval(interval);
      if (ttl) clearTimeout(ttl);
      const pendingTick = tickInFlight;
      let pendingTickSettled = !pendingTick;
      const markPendingTickSettled = pendingTick?.finally(() => {
        pendingTickSettled = true;
      });
      if (pendingTick) {
        let stopWaitTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          markPendingTickSettled!.finally(() => {
            if (stopWaitTimer) clearTimeout(stopWaitTimer);
          }),
          new Promise<void>((resolve) => {
            stopWaitTimer = setTimeout(resolve, STOP_WAIT_MS);
          }),
        ]);
      }
      if (options.clear) {
        const needsPostSettleClear = !!pendingTick && !pendingTickSettled;
        await clearTyping();
        if (needsPostSettleClear) {
          void markPendingTickSettled!.finally(() => {
            void clearTyping();
          });
        }
      }
      // Callers pass clear=true once they know no more typing should be
      // visible. If a slow POST outlives STOP_WAIT_MS, the follow-up clear
      // above prevents that late POST from re-enabling the indicator.
    };

    const sendTyping = () => {
      // tickInFlight guard: if a previous POST is still pending (slow
      // BlueBubbles HTTP), drop this tick instead of piling up requests.
      if (sealed || tickInFlight) return;
      if (consecutiveErrors >= MAX_ERRORS) {
        log.warn({ chatId }, "iMessage typing suspended after %d consecutive errors", MAX_ERRORS);
        void cleanup();
        return;
      }
      tickInFlight = (async () => {
        try {
          await this.api("POST", `/chat/${encodeURIComponent(chatId)}/typing`);
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

  // --- Webhook server ---

  private async startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleWebhookRequest(req, res));

      this.server.on("error", (err) => {
        log.error({ err }, "Webhook server error");
        reject(err);
      });

      // Loopback only — the webhook is registered as http://127.0.0.1:<port>,
      // so there is no reason to accept connections from other hosts. The
      // handler has no authentication; binding 0.0.0.0 would let anyone on
      // the LAN inject forged messages into the agent.
      this.server.listen(this.webhookPort, "127.0.0.1", () => {
        log.info({ port: this.webhookPort }, "Webhook server listening");
        resolve();
      });
    });
  }

  private handleWebhookRequest(req: HttpRequest, res: ServerResponse): void {
    if (req.method !== "POST" || !req.url?.startsWith("/bluebubbles/webhook")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const MAX_BODY_BYTES = 1024 * 1024;
    let body = "";
    let bodyBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          res.writeHead(413);
          res.end();
          req.destroy();
        }
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');

      try {
        const payload = JSON.parse(body);
        this.handleWebhookEvent(payload).catch((err) => {
          log.error({ err }, "Error processing webhook event");
        });
      } catch {
        log.warn("Invalid webhook payload");
      }
    });
  }

  private async registerWebhook(): Promise<void> {
    // Literal IPv4 loopback, NOT "localhost": our server binds 127.0.0.1
    // only, and BlueBubbles may resolve "localhost" to ::1 first — which
    // would get connection refused even though the server is up.
    const webhookUrl = `http://127.0.0.1:${this.webhookPort}/bluebubbles/webhook`;
    // Stale registration from versions that registered the localhost form.
    const legacyWebhookUrl = `http://localhost:${this.webhookPort}/bluebubbles/webhook`;

    try {
      // Clean up existing webhooks for our URL (current and legacy forms,
      // so an upgrade doesn't leave a duplicate registration behind)
      const existing = await this.api("GET", "/webhook");
      const webhooks = (existing?.data ?? []) as Array<{ id: number; url: string }>;
      for (const wh of webhooks) {
        if (wh.url === webhookUrl || wh.url === legacyWebhookUrl) {
          await this.api("DELETE", `/webhook/${wh.id}`);
        }
      }

      // Register new webhook
      const result = await this.api("POST", "/webhook", {
        url: webhookUrl,
        events: ["new-message"],
      });
      const resultData = result?.data as { id: number } | undefined;
      this.webhookId = resultData?.id ?? null;
      log.info({ webhookId: this.webhookId, url: webhookUrl }, "Webhook registered");
    } catch (err) {
      log.error({ err }, "Failed to register webhook");
      throw err;
    }
  }

  // --- Webhook event handling ---

  private async handleWebhookEvent(payload: Record<string, unknown>): Promise<void> {
    if (payload.type !== "new-message") return;

    const data = payload.data as Record<string, unknown>;
    if (!data) return;

    const text = (data.text as string) ?? "";
    const guid = data.guid as string;

    // Get sender info
    const handle = data.handle as Record<string, unknown> | undefined;
    const senderAddress = (handle?.address as string) ?? "Unknown";

    // Resolve chat info
    const chats = data.chats as Array<Record<string, unknown>> | undefined;
    const chat = chats?.[0];
    if (!chat) return;

    const chatGuid = chat.guid as string;
    if (!chatGuid) return;

    // Track every real message row — inbound AND our own outbound (BlueBubbles
    // fires new-message for isFromMe rows too) — so reply-context lookups and
    // substring-targeted reactions/replies can resolve text to a GUID later.
    // Insertion is GUID-deduped, so webhook replays don't double-record.
    if (guid && text.trim()) {
      this.recordRecentMessage(chatGuid, {
        id: guid,
        text,
        ...(data.isFromMe ? {} : { senderName: this.resolveContactName(senderAddress) }),
        timestamp: typeof data.dateCreated === "number" ? data.dateCreated : Date.now(),
        fromMe: Boolean(data.isFromMe),
      });
    }

    // Skip messages from self (prevent echo loop)
    if (data.isFromMe) return;

    // BlueBubbles' poller can replay a message row from its lookback window
    // after a restart or reconnection. Persist the GUID before dispatch so the
    // same inbound message cannot start another agent run, even after Tomo
    // restarts.
    if (guid && this.messageGuidDedupe.checkAndRecord(guid)) {
      log.debug({ guid }, "Dropping replayed iMessage webhook (guid already seen)");
      return;
    }

    // Determine if group chat (iMessage;+; = group, iMessage;-; or SMS;-; = DM)
    const isGroup = chatGuid.includes(";+;");

    // iMessage has no @mention system — treat all group messages as mentioned
    // (the agent gets a one-time system prompt to stay silent unless it has something to say)
    const isMentioned = isGroup;

    // Handle slash commands
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1).join(" ");
      if (command === "new" || command === "model" || command === "restore" || command === "login" || command === "status" || command === "cost" || command === "pet" || command === "summon" || command === "dismiss" || command === "pause" || command === "resume") {
        // Normalized exactly like the message path's senderId below, so owner
        // checks (identityForSender) match however BlueBubbles formats the
        // address.
        const senderId = handle?.address ? this.normalizeAddress(senderAddress) : undefined;
        for (const handler of this.commandHandlers) {
          await handler(command, chatGuid, senderAddress, args, senderId);
        }
        return;
      }
    }

    // Download image + document attachments
    const attachments = data.attachments as Array<Record<string, unknown>> | undefined;
    const intendedImageCount = (attachments ?? []).filter(
      (a) => typeof a.mimeType === "string" && (a.mimeType as string).startsWith("image/"),
    ).length;
    const intendedDocumentCount = (attachments ?? []).filter(
      (a) => typeof a.mimeType === "string" && isSupportedDocumentMime(a.mimeType as string),
    ).length;
    const { images, documents } = await this.downloadAttachments(attachments, chatGuid);

    // Mark chat as read (best-effort; requires BlueBubbles Private API helper)
    this.api("POST", `/chat/${encodeURIComponent(chatGuid)}/read`).catch(() => {});

    const senderName = this.resolveContactName(senderAddress);

    const imageSavedPaths = images.map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const docSavedPaths = documents.map((d) => d.savedPath).filter((p): p is string => Boolean(p));
    const imageMarker = formatImageMarker(intendedImageCount, imageSavedPaths);
    const docMarker = formatDocumentMarker(intendedDocumentCount, docSavedPaths);

    // Satellite messages arrive over Apple's low-bandwidth emergency relay and
    // carry the "iMessageLite" service instead of "iMessage". BlueBubbles does
    // not always expose the message service in serialized webhooks, but the
    // sender handle service survives serialization. Surface either signal to the
    // model so it keeps replies short + text-only and doesn't expect photos.
    // Only tag when there's real text — avoids turning an empty satellite ghost
    // row into a non-empty prompt that would bypass the empty-message guard below.
    const isSatelliteMessage =
      isSatelliteService(data.service) || isSatelliteService(handle?.service);
    const satelliteMarker =
      isSatelliteMessage && text.trim() ? SATELLITE_MARKER : "";

    // Threaded replies (long-press → Reply) carry the replied-to message's
    // GUID. Surface the original as inline context in the same visual family
    // as the satellite marker; when the original can't be found the marker
    // degrades to its quote-less form. Best-effort — never blocks delivery.
    // Only tag rows with real content so a ghost row can't become a prompt.
    const threadOriginatorGuid = data.threadOriginatorGuid as string | undefined;
    const hasContent = Boolean(text.trim()) || images.length > 0 || documents.length > 0;
    const replyMarker = threadOriginatorGuid && hasContent
      ? formatReplyContextMarker(await this.lookupMessageText(chatGuid, threadOriginatorGuid))
      : "";

    const markers = [satelliteMarker, replyMarker, imageMarker, docMarker].filter(Boolean).join(" ");
    const composedText = text
      ? (markers ? `${markers} ${text}` : text)
      : markers;

    // Ghost, tapback, and system rows may arrive as new-message events with no
    // text or usable attachment. Do not turn them into blank agent prompts.
    if (!composedText.trim() && images.length === 0 && documents.length === 0) {
      log.debug({ guid }, "Ignoring empty iMessage (no text or attachments)");
      return;
    }

    const message: IncomingMessage = {
      id: guid,
      chatId: chatGuid,
      senderName,
      // Normalized so the same person matches whether BlueBubbles reports
      // "+1 (415) 555-1234" or "+14155551234" across restarts.
      senderId: handle?.address ? this.normalizeAddress(senderAddress) : undefined,
      text: composedText,
      images: images.length > 0 ? images : undefined,
      documents: documents.length > 0 ? documents : undefined,
      timestamp: typeof data.dateCreated === "number" ? data.dateCreated : Date.now(),
      isGroup,
      isMentioned,
      chatTitle: (chat.displayName as string) ?? undefined,
    };

    // Fire-and-forget: the agent's per-session queue handles ordering.
    // Awaiting here would prevent rapid messages from piling up for
    // coalescing.
    for (const handler of this.handlers) {
      handler(message).catch((err) => log.error({ err }, "iMessage handler failed"));
    }
  }

  private recordRecentMessage(chatGuid: string, message: RecentChatMessage): void {
    const ring = this.recentByChat.get(chatGuid) ?? [];
    if (ring.some((m) => m.id === message.id)) return;
    ring.unshift(message); // newest first
    if (ring.length > RECENT_MESSAGES_PER_CHAT) ring.pop();
    this.recentByChat.set(chatGuid, ring);
  }

  /**
   * Text of a message by GUID: recent-message cache first (free), then the
   * BlueBubbles server (covers messages older than the cache window).
   * Best-effort — returns undefined rather than throwing.
   */
  private async lookupMessageText(chatGuid: string, guid: string): Promise<string | undefined> {
    const cached = this.recentByChat.get(chatGuid)?.find((m) => m.id === guid);
    if (cached) return cached.text;

    try {
      const result = await this.api("GET", `/message/${encodeURIComponent(guid)}`, undefined, { timeoutMs: MESSAGE_LOOKUP_TIMEOUT_MS });
      const original = result?.data as Record<string, unknown> | undefined;
      return typeof original?.text === "string" ? original.text : undefined;
    } catch (err) {
      log.debug({ err, guid }, "Failed to look up replied-to message");
      return undefined;
    }
  }

  private async downloadAttachments(
    attachments: Array<Record<string, unknown>> | undefined,
    chatGuid?: string,
  ): Promise<{ images: ImageAttachment[]; documents: DocumentAttachment[] }> {
    if (!attachments || attachments.length === 0) return { images: [], documents: [] };

    const images: ImageAttachment[] = [];
    const documents: DocumentAttachment[] = [];

    for (const att of attachments) {
      const mimeType = att.mimeType as string | undefined;
      if (!mimeType) continue;

      const isImage = mimeType.startsWith("image/");
      const isDocument = isSupportedDocumentMime(mimeType);
      if (!isImage && !isDocument) continue;

      const attGuid = att.guid as string;
      if (!attGuid) continue;

      // Pre-check declared size before any HTTP work for documents. BlueBubbles
      // exposes `totalBytes` on the attachment payload; if it's already over
      // the cap we skip the download entirely, so a malicious 100 GB PDF
      // cannot make us start streaming bytes.
      if (isDocument) {
        const declared = att.totalBytes;
        if (isDeclaredDocumentTooLarge(declared, { guid: attGuid, mimeType, declaredBytes: declared })) continue;
      }

      try {
        const url = `${this.apiUrl}/api/v1/attachment/${encodeURIComponent(attGuid)}/download?password=${encodeURIComponent(this.password)}`;
        const res = await fetch(url);
        if (!res.ok) continue;

        const buffer = isDocument
          ? await readDocumentResponseWithCap(res, { guid: attGuid, mimeType })
          : Buffer.from(await res.arrayBuffer());

        if (!buffer) continue;

        if (isImage) {
          images.push(await buildImageAttachment(
            buffer,
            mimeType,
            {
              sessionKey: chatGuid ? `imessage_${chatGuid}` : "imessage",
              guid: attGuid,
            },
            this.imageStoreBaseDir,
          ));
        } else {
          const filename = (att.transferName as string | undefined) ?? undefined;
          documents.push(await buildDocumentAttachment(
            buffer,
            mimeType,
            {
              sessionKey: chatGuid ? `imessage_${chatGuid}` : "imessage",
              guid: attGuid,
              filename,
            },
            this.imageStoreBaseDir,
          ));
        }
      } catch (err) {
        log.error({ err, guid: attGuid }, "Failed to download attachment");
      }
    }

    return { images, documents };
  }

  // --- Contact resolution ---

  private async loadContacts(): Promise<void> {
    try {
      const result = await this.api("GET", "/contact");
      const contacts = (result?.data ?? []) as Array<Record<string, unknown>>;

      for (const contact of contacts) {
        const firstName = (contact.firstName as string) ?? "";
        const lastName = (contact.lastName as string) ?? "";
        const displayName = [firstName, lastName].filter(Boolean).join(" ");
        if (!displayName) continue;

        // Map all phone numbers and emails for this contact
        const phoneNumbers = (contact.phoneNumbers ?? []) as Array<Record<string, unknown>>;
        const emails = (contact.emails ?? []) as Array<Record<string, unknown>>;

        for (const phone of phoneNumbers) {
          const addr = phone.address as string | undefined;
          if (addr) this.contactCache.set(this.normalizeAddress(addr), displayName);
        }
        for (const email of emails) {
          const addr = email.address as string | undefined;
          if (addr) this.contactCache.set(addr.toLowerCase(), displayName);
        }
      }

      log.info({ contacts: this.contactCache.size }, "Contacts loaded");
    } catch (err) {
      log.warn({ err }, "Failed to load contacts, will use raw addresses");
    }
  }

  private resolveContactName(address: string): string {
    return this.contactCache.get(this.normalizeAddress(address)) ?? address;
  }

  /** Normalize phone number: strip non-digits except leading + */
  private normalizeAddress(addr: string): string {
    if (addr.includes("@")) return addr.toLowerCase();
    return addr.replace(/[^\d+]/g, "");
  }

  // --- BlueBubbles API ---

  private async api(method: string, path: string, body?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.apiUrl}/api/v1${path}${separator}password=${encodeURIComponent(this.password)}`;

    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...(options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BlueBubbles API ${method} ${path} returned ${res.status}: ${text}`);
    }

    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  private async sendAttachment(chatGuid: string, filePath: string, caption?: string): Promise<void> {
    const { readFileSync, existsSync: fileExists } = await import("node:fs");
    const { basename } = await import("node:path");

    if (!fileExists(filePath)) {
      log.warn({ path: filePath }, "Attachment file not found");
      return;
    }

    const fileData = readFileSync(filePath);
    const fileName = basename(filePath);

    // Build multipart form data manually
    const boundary = `----TomoFormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // chatGuid field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chatGuid"\r\n\r\n${chatGuid}\r\n`));

    // tempGuid field
    const tempGuid = `tomo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tempGuid"\r\n\r\n${tempGuid}\r\n`));

    // name field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`));

    // file field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from("\r\n"));

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = `${this.apiUrl}/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ status: res.status, response: text }, "Failed to send attachment");
    }

    // Send caption as separate message if present
    if (caption) {
      await this.send({ chatId: chatGuid, text: caption });
    }
  }

}
