import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { AdmissionPredicate, Channel, IncomingMessage, OutgoingMessage, SendResult, MessageHandler, CommandHandler, MessageReaction, RecentChatMessage, StopTyping } from "./types.js";
import { AttachmentUnreadableError, PartialSendError, markNothingSent, markPartsSent } from "./types.js";
import { formatFileMarker } from "./fileStore.js";
import { log } from "../logger.js";
import { splitText, formatReplyContextMarker, isSatelliteService, SATELLITE_MARKER } from "./text-utils.js";
import { MessageGuidDedupeStore } from "./imessage-dedupe.js";
import { ChatDbServiceLookup, type ServiceLookup } from "./imsg-satellite.js";
import { isStickerStagingRefusal, stickerStagingDiagnosis } from "./imsg-sticker-staging.js";
import { normalizeImessageHandle } from "../sessions/keys.js";
import { CHAT_COMMAND_NAMES } from "./chat-commands.js";
import type { ImsgChannelConfig } from "./imsg-channel-config.js";
import { ImsgAttachmentIntake } from "./imsg-inbound-attachments.js";
import { DEFAULT_CHAT_DB_PATH, ImsgRpcClient, ImsgRpcResponseError } from "./imsg-rpc.js";

export type { ImsgChannelConfig } from "./imsg-channel-config.js";
export type { ImsgCapabilities } from "./imsg-rpc.js";
export {
  DEFERRED_ATTACHMENT_POLL_INTERVAL_MS,
  DEFERRED_ATTACHMENT_TIMEOUT_MS,
  DEFERRED_CHECK_STOP_WAIT_MS,
  DEFERRED_FOLLOWUP_DISPATCH_TIMEOUT_MS,
  MAX_DEFERRED_ATTACHMENT_WATCHES,
  MESSAGE_CONVERSION_BUDGET_MS,
  shortOfDeclaredSize,
} from "./imsg-inbound-attachments.js";

const TEXT_CHUNK_LIMIT = 4000;
const RECENT_MESSAGES_PER_CHAT = 50;

/** Slash commands recognized by all channels. */
const KNOWN_COMMANDS = new Set(CHAT_COMMAND_NAMES);

/**
 * True when an outbound message part is exactly one http(s) URL and nothing
 * else — the only shape eligible for a rich link preview send (send.rich's
 * url mode carries no accompanying text).
 */
/**
 * imsg addresses a conversation two ways, and the params are mutually
 * exclusive: `chat_guid` (a chat selector — what inbound events carry and what
 * sessions are keyed by, e.g. "any;-;+15551234567") or, for the plain `send`
 * only, `to` (a bare phone number or email). The bare form is the identity
 * config's binding and reaches this adapter for fixed iMessage reply
 * policies, cron/proactive sends before any inbound iMessage, and raw
 * `imessage:+1…` targets. Every bridge op (send.rich, send.attachment,
 * send.sticker, typing, tapback, edit, unsend, rename) takes only a chat
 * selector, so a handle must first be resolved to a known GUID or the op
 * degraded. A handle is anything without the GUID's `;` separators.
 */
export function isImsgChatGuid(chatId: string): boolean {
  return chatId.includes(";");
}

function isBareHttpUrl(part: string): boolean {
  const trimmed = part.trim();
  return /^https?:\/\/\S+$/i.test(trimmed);
}

/**
 * iMessage channel backed by the `imsg` CLI (github.com/openclaw/imsg).
 * One long-lived `imsg rpc` child speaks JSON-RPC 2.0 as newline-delimited
 * JSON over stdio:
 *
 * - inbound: `watch.subscribe` notifications (method "message"), which carry
 *   attachments with local file paths and built-in reply context
 *   (thread_originator_guid marks genuine threaded replies; reply_to_text
 *   quotes the originator — reply_to_guid alone is NOT a reply signal, it is
 *   set on nearly every chat.db row)
 * - outbound: `send` (AppleScript transport), `send.rich` for threaded
 *   replies, `tapback`, `typing`, `read`, `message.unsend` (IMCore bridge)
 *
 * Chat ids are chat.db chat GUIDs verbatim (e.g. "any;-;+15551234567",
 * "any;+;<hex>" on macOS 26). Never normalize them: the session key is derived
 * from this string, so rewriting it orphans every existing session file.
 * (Verbatim passthrough is also what let session keys survive the cutover from
 * the older BlueBubbles backend, removed 2026-08-27, which reported the same
 * GUIDs.)
 *
 * Message edit is gated on the bridge selector probe (`imsg status --json`):
 * on macOS 26 Apple removed both edit selectors OS-wide, so the channel
 * refuses cleanly instead of calling `message.edit` blindly — see tomo#227 for
 * what calling it blindly did to Messages.app.
 */
export class ImsgChannel implements Channel {
  readonly name = "imessage";
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private messageGuidDedupe: MessageGuidDedupeStore;
  private readonly serviceLookup: ServiceLookup;

  // Bounded per-chat window of message GUIDs + text, newest first. Populated
  // from the watch stream for inbound AND our own outbound rows (imsg emits
  // is_from_me rows too), so reply-context lookups and substring-targeted
  // reactions/replies resolve without extra RPC calls.
  private recentByChat = new Map<string, RecentChatMessage[]>();

  private readonly intake: ImsgAttachmentIntake;
  private readonly rpc: ImsgRpcClient;

  constructor(config: ImsgChannelConfig = {}) {
    this.messageGuidDedupe = new MessageGuidDedupeStore(config.dedupeStorePath ?? null);
    this.serviceLookup = config.serviceLookup ?? new ChatDbServiceLookup(config.dbPath ?? DEFAULT_CHAT_DB_PATH);
    this.intake = new ImsgAttachmentIntake(config, {
      handlers: this.handlers,
      isStopping: () => this.rpc.isStopping,
      appendToWatchChain: (build) => this.rpc.appendToWatchChain(build),
    });
    // Loads the persisted watch cursor (last, as before the split).
    this.rpc = new ImsgRpcClient(config, {
      onWatchMessage: (data, generation) => this.handleWatchMessage(data, generation),
    });
  }

  /** See {@link ImsgRpcClient.isEditSupported}. */
  isEditSupported(): boolean {
    return this.rpc.isEditSupported();
  }

  /** Deferred-attachment watches still armed (see ImsgAttachmentIntake). */
  get pendingDeferredAttachmentWatches(): number {
    return this.intake.pendingDeferredAttachmentWatches;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Set by the Agent (onAdmission). Absent = every chat is admitted. */
  private admissionPredicate: AdmissionPredicate | undefined;

  onAdmission(predicate: AdmissionPredicate): void {
    this.admissionPredicate = predicate;
  }

  /** Fails CLOSED: a predicate that throws leaves admission unknown, and an
   *  unknown chat gets nothing spent on it (the agent still decides). */
  private isAdmitted(chatGuid: string): boolean {
    if (!this.admissionPredicate) return true;
    try {
      return this.admissionPredicate(chatGuid);
    } catch (err) {
      log.warn({ err }, "imsg admission check failed; skipping attachments and read receipt");
      return false;
    }
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async start(): Promise<void> {
    log.info("iMessage channel (imsg) starting");

    await this.rpc.start();

    log.info("iMessage channel (imsg) ready");
  }

  /**
   * Phase 1 — shut the inbound door. Synchronous and I/O-free, so the whole
   * fleet closes in one turn of the event loop.
   *
   * Deliberately does NOT bump `watchGeneration`. The generation counter means
   * "a replay has superseded this row"; a row mid-parse at shutdown has no
   * replay behind it, so bumping would make `isStaleGeneration` abandon it —
   * dropping a row nobody will ever send again. It keeps its generation and
   * runs to completion; `quiesce()` waits for it.
   *
   * The child stays alive: outbound sends still have to work while the agent
   * drains its turns. Killing it here is what caused the shutdown-window
   * `[delivery failed]` markers.
   */
  closeIngestion(): void {
    log.info("iMessage channel (imsg): closing ingestion");
    this.rpc.closeIngestion();
    this.intake.cancelDeferredAttachmentWatches();
  }

  /**
   * Phase 2 — wait for rows already past the entry guard.
   *
   * `watchChain` is the FIFO every notified row runs on, so awaiting it awaits
   * exactly the rows that were mid-parse (attachment read, HEIC conversion,
   * the dispatch hand-off) when ingestion closed. Each link swallows its own
   * errors, so this settles rather than rejects.
   *
   * Awaiting the chain AS IT IS NOW is enough: `stopping` is already set, so
   * `handleWatchMessage` refuses anything appended after this point and the
   * chain cannot grow with new work.
   *
   * Deferred-attachment checks run OFF the chain, so they are awaited
   * separately; with `stopping` set they bail at their next step and never
   * queue a delivery, so awaiting them first and the chain second is enough.
   */
  async quiesce(): Promise<void> {
    await this.intake.settleDeferredChecks();
    await this.rpc.watchChainTail;
  }

  /**
   * Phase 3 — physical teardown. Slow and fallible; the agent runs it only
   * after everything durable has been written, and bounds it.
   */
  async teardown(): Promise<void> {
    log.info("iMessage channel (imsg) stopping");
    await this.rpc.beginTeardown();
    this.intake.cancelDeferredAttachmentWatches();
    // A check still running may be about to read chat.db; let it finish
    // before the lookup is closed under it.
    await this.intake.settleDeferredChecks();
    this.rpc.killChild();
    this.serviceLookup.close();
    this.intake.attachmentLookup.close();
  }

  /** Full shutdown for a standalone caller. `Agent.stop()` drives the phases itself. */
  async stop(): Promise<void> {
    this.closeIngestion();
    await this.quiesce();
    await this.teardown();
  }

  async send(message: OutgoingMessage): Promise<SendResult | void> {
    if (message.sticker) {
      await this.sendSticker(message.chatId, message.sticker);
      // A sticker can never carry a reply target here: `send.sticker` takes no
      // `reply_to` (verified against imsg 0.14.1 — it rejects the param
      // outright), and the bridge's own `stickerReplyTo` selector probes
      // false. `attach_to` is a DIFFERENT act (affixing the sticker onto an
      // existing bubble), deliberately not wired; see sendSticker. So report
      // the drop rather than swallow it — the caller threads exactly one
      // message per turn and would otherwise spend the target on nothing.
      return message.replyTo ? { threaded: false } : undefined;
    }

    if (message.photo) {
      return await this.sendAttachment(message.chatId, message.photo, message.text, message.replyTo);
    }

    const text = message.text;
    // Nothing to ship: an empty text send cannot carry the target either, so
    // report the drop rather than let the caller retire it on a no-op.
    if (!text) return message.replyTo ? { threaded: false } : undefined;

    // A bare handle can only take the plain `send` (`to`). Resolve it to the
    // conversation's GUID when one is known so rich sends still work; else
    // every bridge route below is skipped and the text goes out plain.
    const chatGuid = this.resolveChatGuid(message.chatId);
    const bridgeAddressable = chatGuid !== null;
    const chatId = chatGuid ?? message.chatId;
    if (!bridgeAddressable && (message.replyTo || message.effect)) {
      log.info(
        { chatId: message.chatId },
        "imsg target is a bare handle with no known chat GUID; sending plain (reply target/effect dropped)",
      );
    }

    // Only a `send.rich` that actually carried `reply_to` threads anything.
    // Every other route out of this loop — bridge down, a rich refusal, a
    // continuation chunk — lands on the plain `send` below, which has no
    // reply_to param at all. Track the one success rather than assume it.
    let threaded = false;
    const chunks = splitText(text, TEXT_CHUNK_LIMIT);
    // Parts of THIS text already on the phone, so a failure can say whether
    // anything went out (markNothingSent) or how much (markPartsSent).
    let sentParts = 0;
    try {
      for (const [i, chunk] of chunks.entries()) {
        // Threaded replies and expressive-send effects need the IMCore bridge
        // (send.rich); plain sends stay on the AppleScript transport. Only the
        // first chunk carries either: continuation chunks read as one message,
        // not repeated replies — and one effect per message, not one per chunk
        // (three confetti bursts for one long message is noise, not emphasis).
        const richParams = i === 0 && (message.replyTo || message.effect)
          ? {
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            ...(message.effect ? { effect: message.effect } : {}),
          }
          : null;
        if (richParams && this.rpc.currentCapabilities.advancedFeatures && bridgeAddressable) {
          try {
            const result = await this.rpc.request("send.rich", {
              chat_guid: chatId,
              text: chunk,
              ...richParams,
              part_index: 0,
            });
            sentParts++;
            this.recordOwnSend(chatId, result, chunk);
            if (message.replyTo) threaded = true;
            continue;
          } catch (err) {
            // Fall back to a plain send only on a definite refusal (an RPC
            // error response proves nothing was sent). An ambiguous failure —
            // timeout, child death — may have dispatched the message before
            // dying; resending the text plain would double-deliver, so
            // propagate instead: prefer a missing message over a duplicate.
            if (!(err instanceof ImsgRpcResponseError)) throw err;
            log.warn({ err, chatId }, "imsg rich send refused; falling back to plain send");
          }
        } else if (richParams && bridgeAddressable) {
          // Bridge down per the cached snapshot → this goes out plain, as
          // before (the effect is silently dropped — a structured field, so
          // nothing can leak into the visible text). Kick a rate-limited
          // background re-probe so a bridge that has since come up (#258)
          // restores rich sends for the next send.
          this.rpc.maybeReprobeCapabilities();
        } else if (isBareHttpUrl(chunk) && bridgeAddressable) {
          // A part that is exactly one URL: send it as an Apple rich link
          // preview when the injected bridge supports it (the balloon iMessage
          // renders when a human shares a link), else leave it a plain text
          // send as before. send.rich's url mode accepts NO other params
          // (no text/reply_to/effect), which is why this branch is mutually
          // exclusive with the rich-text branch above.
          if (this.richLinksSupported()) {
            if (await this.trySendRichLink(chatId, chunk.trim())) { sentParts++; continue; }
          } else {
            // Snapshot lacks the rich-link selectors. Unlike a missing edit
            // selector (an OS limit), this state heals: a Messages relaunch
            // with the 0.13+ bridge adds the selectors while advanced_features
            // stays true throughout — hence evenIfBridged, or the reprobe
            // would early-return forever and rich links would need a daemon
            // restart to ever light up. (Mind the operational trap the
            // diagnosis names: `imsg launch` alone no-ops while the old bridge
            // still answers ping — Messages must actually quit first.)
            this.rpc.maybeReprobeCapabilities({ evenIfBridged: true });
            log.info(
              { chatId, ...this.rpc.capabilityGateDiagnosis(null, ["urlPreviewMessage", "sendRichLinkAction"]) },
              "imsg rich link preview unavailable; sending the URL as plain text",
            );
          }
        }
        const result = await this.rpc.request("send", {
          ...this.imsgTarget(chatId),
          text: chunk,
        });
        sentParts++;
        this.recordOwnSend(chatId, result, chunk);
      }
    } catch (err) {
      // Only an RPC error RESPONSE proves the failing call sent nothing; with
      // no earlier part out either, the whole send put nothing on the wire.
      if (sentParts === 0 && err instanceof ImsgRpcResponseError) markNothingSent(err);
      else if (sentParts > 0) markPartsSent(err, sentParts, chunks.length);
      throw err;
    }
    // The text shipped, but if it shipped PLAIN the reply target did not go
    // with it: the AppleScript `send` has no reply_to. Returning nothing here
    // would read as "delivered as asked" and the pipeline would retire a
    // target that never reached a bubble, stranding the rest of the turn.
    return message.replyTo && !threaded ? { threaded: false } : undefined;
  }

  /**
   * Rich link previews need more than `advanced_features`: the injected
   * bridge must expose both rich-link selectors (added in imsg 0.13 — an
   * older bridge still running inside Messages.app reports neither, and
   * send.rich's url mode refuses). The RPC handler re-checks the live bridge
   * itself; this cached gate just avoids a doomed roundtrip per URL send.
   */
  private richLinksSupported(): boolean {
    return this.rpc.currentCapabilities.advancedFeatures
      && this.rpc.currentCapabilities.selectors.urlPreviewMessage === true
      && this.rpc.currentCapabilities.selectors.sendRichLinkAction === true;
  }

  /**
   * Best-effort rich-link send. imsg fetches link metadata server-side with a
   * bounded (~8s) deadline and degrades to a URL-only preview on fetch
   * failure, so an error RESPONSE here means the send did NOT happen
   * (validation or bridge refusal) — safe to fall back to a plain text send
   * of the same URL. An ambiguous failure (timeout, child death) propagates:
   * the message may already be out, and a fallback would double-send it.
   */
  private async trySendRichLink(chatId: string, url: string): Promise<boolean> {
    try {
      const result = await this.rpc.request("send.rich", { chat_guid: chatId, url });
      this.recordOwnSend(chatId, result, url);
      return true;
    } catch (err) {
      if (!(err instanceof ImsgRpcResponseError)) throw err;
      log.warn({ err, chatId }, "imsg rich link send refused; falling back to plain text send");
      return false;
    }
  }

  recentMessages(chatId: string): RecentChatMessage[] {
    // Own sends to a bare handle are recorded under the handle itself (no
    // GUID was known to key them by), so look for an exact ring first.
    const exact = this.recentByChat.get(chatId);
    if (exact) return [...exact];
    const guid = this.resolveChatGuid(chatId);
    return guid ? [...(this.recentByChat.get(guid) ?? [])] : [];
  }

  /**
   * The chat GUID for a target: the target itself when it already is one,
   * else the GUID of the DM conversation with that handle, if this process
   * has seen one (inbound events and own sends both key the recent-message
   * ring by GUID). `null` when the handle has no known conversation yet —
   * the plain `send` still reaches it via `to`, bridge ops cannot.
   */
  private resolveChatGuid(chatId: string): string | null {
    if (isImsgChatGuid(chatId)) return chatId;
    const want = this.normalizeAddress(chatId);
    for (const key of this.recentByChat.keys()) {
      const parts = key.split(";");
      if (parts.length < 3 || parts[1] === "+") continue; // groups are GUID-addressed
      if (this.normalizeAddress(parts.slice(2).join(";")) === want) return key;
    }
    return null;
  }

  /** The `send` RPC's target params for a GUID or a bare handle (see isImsgChatGuid). */
  private imsgTarget(chatId: string): { chat_guid: string } | { to: string } {
    return isImsgChatGuid(chatId) ? { chat_guid: chatId } : { to: chatId };
  }

  /**
   * The chat GUID a bridge-only op needs, or a clear refusal: with only a bare
   * handle and no conversation seen yet, there is no `chat_guid` to pass and
   * `to` is not accepted by any bridge method.
   */
  private requireChatGuid(chatId: string, op: string): string {
    const guid = this.resolveChatGuid(chatId);
    if (guid) return guid;
    throw new Error(
      `iMessage ${op} needs an existing conversation: "${chatId}" is a bare handle and no chat with it `
      + "has been seen yet. It becomes addressable once a message is exchanged with that contact.",
    );
  }

  async setChatTitle(chatId: string, title: string): Promise<void> {
    // Requires the IMCore bridge (imsg launch).
    await this.rpc.request("group.rename", { chat_guid: this.requireChatGuid(chatId, "rename"), name: title });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    // Targeted tapback via the IMCore bridge. The param name is `kind` — the
    // canonical `imsg tapback --kind love|like|dislike|laugh|emphasize|question`
    // flag. (The v0.12.3 RPC source also accepts a `reaction` alias, but the
    // shipped binary honors only `kind`: sending `reaction` was silently
    // ignored and defaulted every tapback to 👍 — confirmed on-device.) Our
    // MessageReaction enum values map 1:1 to imsg's --kind values.
    await this.rpc.request("tapback", {
      chat_guid: this.requireChatGuid(chatId, "tapback"),
      message_guid: messageId,
      kind: reaction,
      remove,
      part_index: 0,
    });
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Edited message text cannot be empty");
    // Apple removed both legacy IMCore edit selectors (editMessageItem and the
    // older editMessage) in macOS 26 and added a translation-aware variant —
    // calling message.edit blindly is what crashed Messages.app in #227. Only
    // proceed when the startup selector probe confirmed one of them exists.
    if (!this.isEditSupported()) {
      // No-op unless the BRIDGE itself is down (a stale degraded snapshot,
      // #258). A missing edit selector with a live bridge is a real OS-level
      // limit (macOS 26 removed both selectors) that no re-probe can change.
      this.rpc.maybeReprobeCapabilities();
      log.warn(
        { chatId, messageId, ...this.rpc.capabilityGateDiagnosis("message.edit", ["editMessageItem", "editMessage", "editMessageItemTranslation"]) },
        "imsg message edit refused by capability gate",
      );
      throw new Error(
        "iMessage message editing is unsupported on this macOS: the IMCore edit selectors "
        + "(editMessageItem/editMessage) are unavailable per the imsg bridge probe. "
        + "Send a correction message instead.",
      );
    }
    await this.rpc.request("message.edit", {
      chat_guid: this.requireChatGuid(chatId, "edit"),
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
    await this.rpc.request("message.unsend", {
      chat_guid: this.requireChatGuid(chatId, "unsend"),
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

  startTyping(chatId: string): StopTyping {
    // Typing indicators require the IMCore bridge; without it every tick
    // would error, so degrade to a no-op — but kick a rate-limited background
    // re-probe first, so a bridge that came up after the cached snapshot
    // (#258) is noticed and the NEXT typing start works.
    if (!this.rpc.currentCapabilities.typingIndicators) {
      this.rpc.maybeReprobeCapabilities();
      return () => {};
    }
    // The `typing` RPC takes only a chat selector; a bare handle with no
    // conversation seen yet has none, so the indicator degrades to a no-op.
    const typingGuid = this.resolveChatGuid(chatId);
    if (!typingGuid) {
      log.debug({ chatId }, "imsg typing skipped: bare handle with no known chat GUID");
      return () => {};
    }
    chatId = typingGuid;

    let sealed = false;
    let tickInFlight: Promise<void> | null = null;
    let consecutiveErrors = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    let ttl: ReturnType<typeof setTimeout> | null = null;

    // The bridge's indicator persistence across time isn't documented, so
    // refresh periodically. The cadence can be gentle: each tick is a local
    // IMCore call, not a network round trip.
    const INTERVAL_MS = 10_000;
    const TTL_MS = 2 * 60 * 1000;
    const MAX_ERRORS = 5;

    const setTypingState = async (typing: boolean) => {
      await this.rpc.request("typing", { chat_guid: chatId, typing }, 5_000);
    };

    const cleanup = async () => {
      if (sealed) return;
      sealed = true;
      if (interval) clearInterval(interval);
      if (ttl) clearTimeout(ttl);
      if (tickInFlight) await tickInFlight.catch(() => {});
      // The bridge indicator has no known decay — nothing turns it off on our
      // behalf, so always stop it explicitly.
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

  // --- Inbound watch messages ---

  private async handleWatchMessage(data: Record<string, unknown>, generation: number): Promise<void> {
    const rowId = typeof data.id === "number" ? data.id : 0;

    // Entry guard: refuse rows that have not STARTED when ingestion closes.
    // Returning BEFORE processWatchRow is what keeps this safe — the cursor is
    // only advanced at the end of a successful dispatch, so declining here
    // leaves it pointing at this row and the next process replays it from
    // `since_rowid`.
    //
    // It deliberately does NOT cover a row already inside processWatchRow.
    // That row may sit for seconds in attachment loading, and refusing it
    // afterwards is not free: the guard is the only reason a refusal is
    // recoverable, and once parsing has begun the honest move is to let it
    // finish into the batcher (the agent awaits `quiesce()` before draining)
    // rather than abandon it. Killing it mid-flight is how a row became
    // un-dispatched AND un-replayable at the same time.
    if (this.rpc.isStopping) {
      log.info({ rowId }, "imsg row refused: channel stopped (cursor left un-advanced, row replays on restart)");
      return;
    }

    try {
      await this.processWatchRow(data, rowId, generation);
    } catch (err) {
      // A row's handling can outlive its subscription: it starts under one
      // generation, the child restarts (bumping the generation) and the new
      // child REPLAYS this row and advances the cursor past it — and only THEN
      // does the old in-flight handling reject. That late failure is stale: the
      // row was already superseded by replay, so halting+flooring on it would
      // resubscribe from a cursor ALREADY past the row (wedging it forever).
      // Only the current generation's failures may halt+floor+resubscribe.
      if (generation !== this.rpc.generation) {
        log.debug({ err, rowId, generation, current: this.rpc.generation }, "imsg stale-generation row failure ignored");
        return;
      }
      // ANY failure while handling this row — a real-message dispatch, a slash
      // COMMAND handler, or an unexpected error — must halt + floor + resubscribe
      // rather than let a later row advance the cursor past it. Otherwise the
      // failed row is skipped forever on resubscribe.
      this.rpc.recoverFromGap(rowId, err);
    }
  }

  private async processWatchRow(data: Record<string, unknown>, rowId: number, generation: number): Promise<void> {
    // At-least-once ordering: the rowid cursor and the GUID dedupe entry are
    // advanced ONLY after a row is fully handled (dispatched OR deliberately
    // dropped) — never before. Advancing up front and then crashing mid-
    // dispatch would silently DROP the message on the resubscribe (the
    // unacceptable failure); advancing after means a crash replays the row,
    // and the persistent GUID dedupe makes that replay a harmless duplicate.
    // Any throw here propagates to handleWatchMessage → recoverFromGap.
    //
    // Generation staleness: this row can BLOCK on an await (attachment load, a
    // command handler, the dispatch hand-off) while the child restarts and the
    // replacement generation REPLAYS this same row and moves on. When the stale
    // row then resumes, the replay is authoritative — it must NOT dispatch,
    // record the GUID, or advance the cursor (that would double-deliver, deliver
    // out of order, or dedupe the authoritative replay away as "seen"). We
    // re-check `generation` after every await point that precedes a side effect.
    const chatGuid = typeof data.chat_guid === "string" ? data.chat_guid : "";
    if (!chatGuid) {
      // Malformed/unjoined row: nothing to dispatch, deterministic on replay.
      this.rpc.advanceCursor(rowId);
      return;
    }

    const guid = typeof data.guid === "string" ? data.guid : "";
    const text = typeof data.text === "string" ? data.text : "";
    const isFromMe = data.is_from_me === true;
    const sender = typeof data.sender === "string" ? data.sender : "";
    const senderName = (typeof data.sender_name === "string" && data.sender_name) || sender || "Unknown";
    const timestamp = typeof data.created_at === "string" ? Date.parse(data.created_at) : NaN;
    const timestampMs = Number.isFinite(timestamp) ? timestamp : Date.now();

    // Inbound tapbacks surface as reaction events (include_reactions: true).
    // Handled before ring recording so a reaction row never pollutes substring
    // targeting. Tapbacks are ambient;
    // dispatch is best-effort and the cursor always advances past them.
    if (data.is_reaction === true) {
      await this.handleInboundReaction(chatGuid, data, { guid, isFromMe, sender, senderName, timestampMs });
      if (this.rpc.isStaleGeneration(generation, rowId)) return;
      this.rpc.advanceCursor(rowId);
      return;
    }

    // Track every real message row — inbound AND our own outbound — so
    // reply-context lookups and substring-targeted reactions/replies can
    // resolve text to a GUID later. Insertion is GUID-deduped. (In-memory
    // only; safe to do before dispatch.)
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
    if (isFromMe) {
      this.rpc.advanceCursor(rowId);
      return;
    }

    // The rowid cursor makes exact replays unlikely, but keep the persistent
    // GUID dedupe as a second layer — the store is keyed on chat.db message
    // GUIDs, so it survives restarts and backend changes alike (it is what
    // stopped the 2026-07-07 cutover from the now-removed BlueBubbles backend
    // re-dispatching already-delivered messages). CHECK only here — the GUID is
    // recorded after dispatch, below.
    if (guid && this.messageGuidDedupe.has(guid)) {
      log.debug({ guid }, "Dropping replayed imsg message (guid already seen)");
      this.rpc.advanceCursor(rowId);
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
          // A throwing command handler propagates to handleWatchMessage →
          // recoverFromGap (halt + floor + resubscribe), so the command row is
          // replayed rather than skipped when a later row advances the cursor.
          await handler(command, chatGuid, senderName, args, senderId);
        }
        // If the child restarted while a handler ran, the replay owns this row —
        // don't record/advance (recording would dedupe the authoritative replay).
        if (this.rpc.isStaleGeneration(generation, rowId)) return;
        if (guid) this.messageGuidDedupe.record(guid);
        this.rpc.advanceCursor(rowId);
        return;
      }
    }

    // Attachments arrive as local file paths (imsg reads chat.db directly).
    // Stickers are counted apart from plain images: chat.db marks them
    // (attachment.is_sticker, surfaced by imsg 0.13+) and a sticker described
    // as just "an image" buries the expressive act (and, worse, hides that
    // the source lives in StickerCache with its alpha channel intact).
    // Admission (advisory, see AdmissionPredicate): a chat the agent is about
    // to refuse — a stranger's DM, a group nobody activated — gets nothing
    // spent on it and no presence signal. Its attachments are not copied to
    // disk and it is not marked read. The row is still dispatched so the
    // agent makes (and logs) the real custody decision, and the cursor
    // advances as usual.
    const admitted = this.isAdmitted(chatGuid);
    const rawAttachments = admitted && Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : [];
    // `deferred` = image/document attachments whose file is not on disk yet
    // (still downloading). They are counted in the markers as pending and
    // re-checked in the background once this row has been dispatched.
    const { images, documents, files, deferred } = await this.intake.loadAttachments(rawAttachments, chatGuid);

    // Attachment loading may have blocked long enough for a restart + replay to
    // supersede this row. Bail before any side effect (read, dispatch, cursor).
    if (this.rpc.isStaleGeneration(generation, rowId)) return;

    // Mark chat as read (best-effort; needs the bridge's read-receipt path).
    if (!admitted) {
      // No read receipt for a chat that will not be answered.
    } else if (this.rpc.currentCapabilities.readReceipts) {
      this.rpc.request("read", { chat_guid: chatGuid }, 5_000).catch(() => {});
    } else {
      // Skipped as before — but a degraded snapshot may be stale (#258), so
      // kick a rate-limited background re-probe off the inbound path.
      this.rpc.maybeReprobeCapabilities();
    }

    // Decide BEFORE writing the markers whether the deferred attachments will
    // really be followed up, so "still downloading" is never promised for a
    // message that won't get a follow-up (watch cap reached, or this message's
    // watch already finished and this is a re-seen copy).
    const deferKey = guid || `row:${rowId}`;
    const deferPlan = deferred.length > 0 ? this.intake.planDeferredAttachmentWatch(deferKey, deferred.length) : "none";
    const pendingForMarkers = deferPlan === "arm" || deferPlan === "active" ? deferred : [];
    const { stickerMarker, imageMarker, docMarker } = this.intake.attachmentMarkers(rawAttachments, images, documents, pendingForMarkers);
    // Path-only marker: unlike the image/document markers this is the ONLY
    // representation of the file the agent gets — no bytes are attached.
    const fileMarker = formatFileMarker(files);

    // Satellite (iMessageLite) detection. imsg's JSON exposes no message
    // service, so read `message.service` straight from chat.db (see
    // imsg-satellite.ts) and reuse the same SATELLITE_MARKER indicator (#208).
    // Only when there's real text — a marker on an attachment-only/ghost row
    // says nothing, and the guard avoids a sqlite hit on every such row.
    const isSatelliteMessage = Boolean(text.trim())
      && isSatelliteService(this.serviceLookup.serviceForGuid(guid));
    const satelliteMarker = isSatelliteMessage ? SATELLITE_MARKER : "";

    // Reply context gates on thread_originator_guid ONLY — chat.db sets that
    // column solely on genuine long-press → Reply messages. imsg also emits
    // reply_to_guid, but that mirrors chat.db's message.reply_to_guid column,
    // which is populated on virtually EVERY message (it points at the message
    // that preceded it in the conversation — usually our own last outbound),
    // so falling back to it tagged every plain inbound send as a reply
    // quoting our latest message (a 100% reply rate, observed live when the
    // channel first shipped). For genuine threaded replies imsg resolves reply_to_text from
    // the originator (thread_originator_guid takes precedence over
    // reply_to_guid in its lookup), so the quoted excerpt is the right
    // message; when imsg couldn't resolve it, fall back to the recent-message
    // ring before degrading to the quote-less marker. Only tag rows with real
    // content so a ghost row can't become a prompt.
    const threadOriginatorGuid = typeof data.thread_originator_guid === "string" ? data.thread_originator_guid : "";
    const hasContent = Boolean(text.trim()) || images.length > 0 || documents.length > 0 || files.length > 0;
    const replyMarker = threadOriginatorGuid && hasContent
      ? formatReplyContextMarker(
        (typeof data.reply_to_text === "string" && data.reply_to_text)
          || this.recentByChat.get(chatGuid)?.find((m) => m.id === threadOriginatorGuid)?.text,
      )
      : "";

    const markers = [satelliteMarker, replyMarker, stickerMarker, imageMarker, docMarker, fileMarker].filter(Boolean).join(" ");
    const composedText = text
      ? (markers ? `${markers} ${text}` : text)
      : markers;

    // Ghost, poll, and system rows can arrive with no text or usable
    // attachment. Do not turn them into blank agent prompts.
    // `files` is included for the same reason as the other two: a file notice
    // always contributes to composedText today, but the guard should not
    // depend on that staying true — this check is the exact place the .zip
    // died.
    if (!composedText.trim() && images.length === 0 && documents.length === 0 && files.length === 0) {
      log.debug({ guid }, "Ignoring empty imsg message (no text or attachments)");
      this.rpc.advanceCursor(rowId);
      return;
    }

    const message: IncomingMessage = {
      id: guid,
      // chat_guid is passed through VERBATIM as the session's chatId — no
      // normalization. On macOS 26 chat.db stores GUIDs as `any;-;+E164`
      // (DMs) and `any;+;<hex>` (groups); the session key is derived straight
      // from this string (imessage_any_-__… / imessage_any___<hex>), so any
      // rewriting here orphans existing session files.
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

    // Final staleness gate immediately before the delivery side effect: if a
    // restart replayed this row while we were building it, the replay is
    // authoritative — do NOT dispatch (would double-deliver, out of order).
    if (this.rpc.isStaleGeneration(generation, rowId)) return;

    // Hand off to the agent (its per-session queue handles turn ordering) and
    // AWAIT the enqueue so "dispatched" is real before we commit the cursor. A
    // throw here propagates to handleWatchMessage → recoverFromGap, which
    // leaves the cursor un-advanced so the row replays (never skipped).
    const accepted = await this.dispatch(message);

    // A REFUSAL is not a throw and must not be read as success. The agent
    // says no only when its batcher has already been drained for shutdown, so
    // nothing downstream is holding this row: recording the GUID would make
    // the replay a "duplicate" and dedupe it away, and advancing the cursor
    // would skip it outright. Leave both alone and the next process replays
    // the row from `since_rowid`. No recoverFromGap either — nothing failed,
    // and the floor+resubscribe would be pointless work on a dying channel.
    if (!accepted) {
      log.warn(
        { rowId, guid },
        "imsg row refused by the agent (shutting down); cursor left un-advanced, row replays on restart",
      );
      return;
    }

    // If a restart superseded us during the dispatch hand-off, we already
    // delivered — but let the replay own the cursor and the dedupe record, so
    // the authoritative replay isn't deduped away (safe-side: a duplicate, not
    // a drop).
    if (this.rpc.isStaleGeneration(generation, rowId)) return;

    // Success under the current generation: record the GUID and advance.
    if (guid) this.messageGuidDedupe.record(guid);
    this.rpc.advanceCursor(rowId);

    // Only now — once the row is committed — start watching for attachments
    // that were still downloading. Arming it any earlier would let a refused
    // or superseded row leave a watch behind for a message the replay is
    // about to deliver (and arm) again.
    if (deferPlan === "arm") {
      this.intake.startDeferredAttachmentWatch(deferKey, deferred, rawAttachments, message, text);
    }
  }

  /**
   * Hand a message to every registered handler and await the hand-off. The
   * handler promise resolves once the agent has queued/batched the message
   * (not when the turn completes), which is the right commit point for the
   * at-least-once cursor.
   *
   * Two ways to not commit: a rejection propagates (the hand-off itself broke)
   * so the caller skips the cursor advance and the row replays, and a `false`
   * resolution means the agent declined custody — same outcome, no throw.
   */
  private async dispatch(message: IncomingMessage): Promise<boolean> {
    const accepted = await Promise.all(this.handlers.map((handler) => handler(message)));
    // Unanimity, not majority: one refusal means at least one handler has no
    // memory of this row, and the cursor may only move for a row every handler
    // took custody of. With a single registered handler (the Agent) this is
    // just its own answer.
    return accepted.every(Boolean);
  }

  private async handleInboundReaction(
    chatGuid: string,
    data: Record<string, unknown>,
    meta: { guid: string; isFromMe: boolean; sender: string; senderName: string; timestampMs: number },
  ): Promise<void> {
    // Only surface tapbacks other people ADD; removals and our own reactions
    // are noise. Dedupe by reaction-row GUID so watch replays don't re-fire.
    // Reactions are ambient, so checkAndRecord (record-before-dispatch) is
    // fine: a dropped tapback on a mid-dispatch crash is acceptable, unlike a
    // dropped message.
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

    await Promise.all(this.handlers.map((handler) =>
      handler(message).catch((err) => log.error({ err }, "iMessage tapback handler failed"))));
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

  // --- Outbound attachments ---

  /**
   * Threading an attachment needs the IMCore bridge: `send.attachment` is the
   * only RPC that accepts `reply_to`, and it is bridge-only (verified against
   * imsg 0.14.1 — a `reply_to` send reports transport `bridge_v2`, while the
   * plain `send` file param rides AppleScript). Gate it like every other
   * bridge surface so an un-injected Messages.app degrades to an unthreaded
   * attachment instead of failing the send.
   */
  private attachmentReplyToSupported(): boolean {
    return this.rpc.currentCapabilities.advancedFeatures
      && this.rpc.currentCapabilities.rpcMethods.has("send.attachment")
      && this.rpc.currentCapabilities.selectors.sendAttachment === true;
  }

  /**
   * Send a file, optionally threaded to `replyTo` and optionally followed by a
   * caption as its own message (iMessage attachments carry no caption field).
   *
   * Returns `{ threaded: false }` only when a `replyTo` was asked for and
   * NEITHER the picture NOR its caption went out threaded — bridge down, RPC
   * refusal with no caption to fall back to, or the file missing so nothing
   * shipped at all. If the picture could not thread but a caption follows, the
   * caption is offered the target and ITS result is what this method returns.
   * The caller needs an honest answer either way: it hands the target to
   * exactly one message, and before this the channel dropped it silently,
   * leaving both the photo and the text after it unthreaded.
   *
   * The caption follow-up is threaded only as a FALLBACK. Behind a threaded
   * picture it ships plain — one reply per turn, and the picture already is
   * it. But when the picture could not thread, the caption inherits the
   * target and its result becomes this call's result: text threading
   * (`send.rich`) and attachment threading (`send.attachment`) are separate
   * bridge surfaces, so an imsg too old for the latter can still thread the
   * caption. That matters for a final one-block `caption + MEDIA:path`, where
   * there is no later send for the caller to reoffer the target to. With the
   * bridge genuinely down the caption falls back to a plain send and reports
   * `{ threaded: false }` itself, which propagates unchanged.
   */
  private async sendAttachment(
    chatGuid: string,
    filePath: string,
    caption?: string,
    replyTo?: string,
  ): Promise<SendResult | void> {
    if (!existsSync(filePath)) {
      // A DEFINITE pre-flight failure, thrown rather than swallowed. This used
      // to log and return normally, which told the caller "delivered" about a
      // picture that never left the machine — and took the caption with it,
      // because the caller ships `caption + photo` as one send. The pipeline
      // (delivery-pipeline.ts) owns the fallback: on this error it delivers
      // the caption as text and records the picture as failed. Not sending
      // the caption from HERE is what keeps that a single owner — a
      // channel-side caption send is invisible to the pipeline, which would
      // then either count the block delivered (picture included) or send the
      // caption a second time. The file can disappear between the pipeline's
      // existsSync and this one, so this branch is reachable with a caption
      // in hand.
      log.warn({ path: filePath }, "Attachment file not found");
      throw new AttachmentUnreadableError(filePath);
    }

    // send.attachment is bridge-only (chat selector); the plain `send` file
    // param also accepts a bare handle via `to`.
    const resolvedGuid = this.resolveChatGuid(chatGuid);
    if (resolvedGuid) chatGuid = resolvedGuid;
    let threaded = false;
    if (replyTo && resolvedGuid && this.attachmentReplyToSupported()) {
      try {
        await this.rpc.request("send.attachment", { chat_guid: chatGuid, file: filePath, reply_to: replyTo });
        threaded = true;
      } catch (err) {
        // Same rule as send.rich: fall back to a plain send only on a definite
        // refusal (an RPC error response proves nothing was sent). An
        // ambiguous failure may already have dispatched the attachment, and
        // resending it would double-deliver the picture.
        if (!(err instanceof ImsgRpcResponseError)) throw err;
        log.warn({ err, chatId: chatGuid }, "imsg threaded attachment send refused; falling back to an unthreaded send");
      }
    } else if (replyTo && !resolvedGuid) {
      log.info({ chatId: chatGuid }, "imsg target is a bare handle with no known chat GUID; sending the attachment unthreaded");
    } else if (replyTo) {
      // Bridge down (or an imsg too old for send.attachment): the picture
      // still ships, unthreaded. Kick a rate-limited re-probe so a bridge that
      // has since come up threads the next one (#258).
      this.rpc.maybeReprobeCapabilities();
      log.info(
        { chatId: chatGuid, ...this.rpc.capabilityGateDiagnosis("send.attachment", ["sendAttachment"]) },
        "imsg threaded attachment send unavailable; sending the attachment unthreaded",
      );
    }

    if (!threaded) {
      // The plain `send` file param works on the AppleScript transport — no
      // bridge required (send.attachment is bridge-only).
      await this.rpc.request("send", { ...this.imsgTarget(chatGuid), file: filePath });
    }

    if (caption) {
      // If the picture could not take the target, the caption is the turn's
      // last chance at it: a final `caption + MEDIA:path` block has no later
      // send for the caller to reoffer it to, and text threads through
      // `send.rich` even when the attachment surface is missing. Hand the
      // target down and let the caption's own result speak for the whole
      // attachment send — it threads when only send.attachment was missing,
      // and reports `{ threaded: false }` when the bridge is genuinely down.
      const offerTarget = Boolean(replyTo) && !threaded;
      let captionResult: SendResult | void;
      try {
        captionResult = await this.send({
          chatId: chatGuid,
          text: caption,
          ...(offerTarget ? { replyTo } : {}),
        });
      } catch (err) {
        // The picture is on the phone; only the caption is in doubt. Said so,
        // rather than letting the caller conclude the whole send failed.
        throw new PartialSendError(err, { photo: true });
      }
      if (offerTarget) return captionResult ?? undefined;
    }
    return replyTo && !threaded ? { threaded: false } : undefined;
  }

  // --- Outbound stickers ---

  /**
   * The whole native-sticker path is live: bridge injected, the installed
   * imsg advertises `send.sticker` (added in 0.13), AND the bridge selector
   * probe confirmed the sticker IMCore surface (`stickerSend` is the
   * conjunction imsg computes over the five transfer/message selectors it
   * needs). Like the rich-link selectors — and unlike the macOS-26 edit
   * selectors — an absent `stickerSend` with a live bridge usually means the
   * injected bridge dylib predates 0.13, a state that heals when Messages
   * relaunches with the newer bridge; see the reprobe in sendSticker.
   */
  private stickerSendSupported(): boolean {
    return this.rpc.currentCapabilities.advancedFeatures
      && this.rpc.currentCapabilities.rpcMethods.has("send.sticker")
      && this.rpc.currentCapabilities.selectors.stickerSend === true;
  }

  /**
   * OutgoingMessage.sticker carries one of two channel-bound payload shapes:
   * a Telegram `file_id` or a local image path for iMessage (always starts
   * with `/` or `~`). Discriminate by shape: path-shaped values go to
   * `send.sticker` (native sticker balloon via the IMCore bridge), non-path
   * values are Telegram ids that mean nothing here and keep the old
   * warn-and-drop.
   *
   * The discriminator leans on file_ids being URL-safe-base64-ish — an
   * OBSERVED property, not a documented contract (the Bot API only promises
   * "a string"). The ambiguity is inherent to a single-valued tag, and we
   * accept it deliberately: for a mis-shaped file_id to do anything on this
   * branch it would have to be sent on the iMessage channel at all (already
   * a model error — a file_id is only meaningful on the channel it came
   * from), begin with `/` or `~`, AND exactly name an existing local file;
   * failing that last coincidence the existence check below drops it, same
   * outcome as the non-path branch. And if it does name a real file, sending
   * that file is precisely the surface MEDIA: already exposes from the same
   * model text. Every stricter heuristic we considered (extension checks,
   * charset tests on the non-path side) narrows legitimate paths without
   * changing that posture. Do not add a second tag for this.
   *
   * A sticker that can't send natively must NOT vanish: unlike an effect
   * (a delivery property riding on text), the sticker IS the message —
   * dropping it leaves the recipient nothing. So every definite non-native
   * outcome (unsupported bridge, send.sticker refusal — e.g. image over
   * imsg's 500KB/618px sticker caps, or an SMS chat) degrades to a plain
   * image attachment send: the picture arriving as a picture is most of the
   * value, and sticker-balloon-vs-inline-image is cosmetic. Ambiguous
   * failures (timeout, child death) propagate instead — the sticker may
   * already be out, and a fallback would double-deliver (same rule as
   * send.rich).
   *
   * `attach_to` (sticking onto an existing message) is deliberately not
   * wired: the STICKER: tag is single-valued and cannot name a target
   * message, and overloading `replyTo` would silently turn "threaded reply"
   * into the visually different "affixed to bubble" act. If that act is ever
   * wanted it needs its own surface, not a half-wiring of this one.
   */
  private async sendSticker(chatGuid: string, sticker: string): Promise<void> {
    // BOTH PRE-FLIGHT REFUSALS THROW, the same way `sendAttachment` does.
    // They used to log and return, which reports "delivered" to the caller
    // about a sticker that never left the machine — and the sticker IS the
    // message here, so the recipient gets nothing at all and the pipeline
    // records a turn that landed. `AttachmentUnreadableError` is definite by
    // construction (nothing was dispatched), which is exactly what lets
    // delivery-pipeline.ts fall back without risking a double-send.
    if (!sticker.startsWith("/") && !sticker.startsWith("~")) {
      log.warn({ chatId: chatGuid }, "Non-path sticker value on iMessage channel (Telegram file_ids are channel-bound)");
      throw new AttachmentUnreadableError(sticker, `Sticker reference is not a file path: ${sticker}`);
    }
    // Expand a leading `~` ourselves: imsg's send.sticker expands it too, but
    // the fallback plain `send` may not, and our own existence check below
    // certainly doesn't.
    const filePath = sticker.replace(/^~(?=$|\/)/, homedir());
    if (!existsSync(filePath)) {
      log.warn({ path: filePath, chatId: chatGuid }, "Sticker file not found");
      throw new AttachmentUnreadableError(filePath);
    }

    // send.sticker is bridge-only; a bare handle with no known conversation
    // takes the plain attachment route below via `to`.
    const resolvedGuid = this.resolveChatGuid(chatGuid);
    if (resolvedGuid) chatGuid = resolvedGuid;
    if (this.stickerSendSupported() && resolvedGuid) {
      try {
        const result = await this.rpc.request("send.sticker", { chat_guid: chatGuid, file: filePath });
        this.recordOwnSend(chatGuid, result, `[sticker: ${basename(filePath)}]`);
        return;
      } catch (err) {
        // Degrade to a plain attachment only on a definite refusal (an RPC
        // error response proves nothing was sent). Ambiguous failures may
        // have dispatched the sticker before dying; propagate rather than
        // risk the recipient seeing the image twice.
        if (!(err instanceof ImsgRpcResponseError)) throw err;
        if (isStickerStagingRefusal(err)) {
          // The dylib's staging-hygiene walk refused an already-staged path.
          // imsg 0.13.4's send.sticker RPC stages the file itself (same
          // StickerAssetPreparer step as the CLI), so this is NOT a
          // missing-staging bug on our side — it means an ancestor of
          // ~/Library/Messages/Attachments/imsg/stickers fails the dylib's
          // per-component checks (user-owned, not world-writable, no
          // symlinks). Diagnose locally so the log names the component and
          // the remedy instead of parroting the opaque bridge error.
          log.warn(
            { err, chatId: chatGuid, ...stickerStagingDiagnosis() },
            "imsg sticker send refused by the bridge's staging-hygiene check; falling back to a plain image attachment",
          );
        } else {
          log.warn({ err, chatId: chatGuid }, "imsg sticker send refused; falling back to a plain image attachment");
        }
      }
    } else if (!resolvedGuid) {
      log.info({ chatId: chatGuid }, "imsg target is a bare handle with no known chat GUID; sending the sticker as a plain image attachment");
    } else {
      // Snapshot lacks the sticker surface. When the bridge itself is down
      // this is the usual stale-snapshot case (#258); when the bridge is up
      // but `stickerSend` is absent, the injected dylib predates imsg 0.13
      // and the selector appears once Messages relaunches with the newer
      // bridge (advanced_features stays true throughout) — hence
      // evenIfBridged, exactly like rich links, or the reprobe would
      // early-return forever and native stickers could never light up
      // without a daemon restart. (A relaunch means Messages actually
      // quitting first — the diagnosis spells out why `imsg launch` alone
      // may not be one.)
      this.rpc.maybeReprobeCapabilities({ evenIfBridged: true });
      log.info(
        { chatId: chatGuid, ...this.rpc.capabilityGateDiagnosis("send.sticker", ["stickerSend"]) },
        "imsg native sticker send unavailable; sending as a plain image attachment",
      );
    }
    const result = await this.rpc.request("send", { ...this.imsgTarget(chatGuid), file: filePath });
    this.recordOwnSend(chatGuid, result, `[sticker: ${basename(filePath)}]`);
  }

  /** Normalize phone number: strip non-digits except leading + */
  /** The shared handle normal form (see normalizeImessageHandle), so sender
   *  ids compare equal to configured owner handles however either is spelled. */
  private normalizeAddress(addr: string): string {
    return normalizeImessageHandle(addr);
  }
}
