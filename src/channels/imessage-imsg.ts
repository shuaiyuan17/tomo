import { spawn as nodeSpawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Channel, IncomingMessage, OutgoingMessage, SendResult, MessageHandler, CommandHandler, MessageReaction, RecentChatMessage, ImageAttachment, DocumentAttachment, StopTyping } from "./types.js";
import { formatImageMarker, formatStickerMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime, MAX_DOCUMENT_BYTES } from "./documentStore.js";
import { buildDocumentAttachment, buildImageAttachment } from "./attachments.js";
import {
  FALLBACK_MIME,
  formatFileMarker,
  MAX_FILE_BYTES,
  sanitizeAttachmentFilename,
  saveInboundFile,
  type SavedFileNotice,
} from "./fileStore.js";
import { log } from "../logger.js";
import { splitText, formatReplyContextMarker, isSatelliteService, SATELLITE_MARKER } from "./text-utils.js";
import { MessageGuidDedupeStore } from "./imessage-dedupe.js";
import { ChatDbServiceLookup, type ServiceLookup } from "./imsg-satellite.js";
import { convertHeicImage, heicHasAlpha, looksLikeHeic, type HeicTargetFormat } from "./heic.js";
import { isStickerStagingRefusal, stickerStagingDiagnosis } from "./imsg-sticker-staging.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

const TEXT_CHUNK_LIMIT = 4000;
const RECENT_MESSAGES_PER_CHAT = 50;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const STATUS_PROBE_TIMEOUT_MS = 15_000;
// Cap on in-flight RPC requests. Past this the pending map is treated as a
// symptom of a stuck child; new requests fail fast instead of piling up.
const MAX_PENDING_REQUESTS = 256;
// Backstop for a write that parked on 'drain': if a still-alive child never
// drains within this window, treat it as wedged, settle the parked write (so
// the chain recovers) and restart the child (its watch replays from the
// committed cursor, so delivery is preserved).
const DEFAULT_DRAIN_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
// Backoff schedule for restarting a crashed `imsg rpc` child. The last entry
// repeats forever; the index resets once a child stays up for STABLE_CHILD_MS.
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const STABLE_CHILD_MS = 60_000;
// Silent retry schedule for a DEGRADED startup capability probe. The common
// cause is a boot-order race: after a reboot (every macOS update) the daemon
// comes up before Messages.app has relaunched with the bridge dylib injected,
// so the first probe reports advanced_features=false even though the bridge
// appears on its own moments later (#258). Retries are quiet; the loud
// actionable warning fires only after the whole schedule is exhausted, by
// which point the bridge is genuinely absent and the `imsg launch` advice is
// accurate. These are the gaps BETWEEN probe attempts (122s summed), and each
// probe can itself take up to STATUS_PROBE_TIMEOUT_MS (15s), so the warning
// lands ~2 minutes after start when probes answer promptly and up to ~4
// minutes when every probe times out — a bound on retry pacing, not a
// wall-clock deadline. The schedule is finite, not a forever-loop: after it,
// on-demand re-probes (below) take over.
const DEFAULT_CAPABILITY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000, 60_000];
// Floor between on-demand capability re-probes (a capability-gated call that
// found the cached answer false). Each probe spawns `imsg status --json`, and
// gated sites fire per message / per typing start — the floor keeps the
// degraded steady state at one cheap subprocess per 30s instead of one per
// call, while still picking a late-appearing bridge up within ~30s of the
// next gated call.
const DEFAULT_CAPABILITY_REPROBE_MIN_INTERVAL_MS = 30_000;

/** Slash commands recognized by all channels. */
const KNOWN_COMMANDS = new Set(["new", "model", "restore", "login", "mcp", "status", "cost", "usage", "pet", "summon", "dismiss", "pause", "resume"]);

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
 * A JSON-RPC error RESPONSE from the imsg child: the request was received,
 * processed, and refused — proof the message was NOT sent, so recovering with
 * a fallback plain send cannot double-deliver. Timeouts, child death, and
 * write failures reject with plain Errors instead: the child may have
 * consumed the request and dispatched the message before the failure, so a
 * fallback there risks the recipient seeing the text twice. A missing message
 * is the recoverable failure; a duplicate is the visible one.
 */
class ImsgRpcResponseError extends Error {}

export interface ImsgCapabilities {
  /**
   * RPC methods advertised by the installed imsg binary. Provenance (verified
   * against imsg v0.13.4 source): this is `kSupportedRPCMethods` in
   * Sources/imsg/RPCServer.swift — a STATIC list compiled into the CLI. It
   * proves the CLI process we spawn can dispatch the method; it says NOTHING
   * about the bridge dylib actually running inside Messages.app (which may be
   * older: the injected copy persists across brew upgrades until Messages
   * truly relaunches). Never gate a bridge-side surface on this alone.
   */
  rpcMethods: Set<string>;
  /** IMCore bridge injected into Messages.app (advanced features live). */
  advancedFeatures: boolean;
  /**
   * Per-selector availability probed by the bridge — the LIVE signal: `imsg
   * status` asks the injected dylib, which answers with the selector dict
   * compiled into it. 0.13+ dylibs emit every key they know as an explicit
   * true/false (a dictionary literal), which makes the two negative shapes
   * distinguishable: key === false means the bridge probed the OS and the
   * IMCore surface is missing (a real OS limit, e.g. the macOS 26 edit
   * selectors); key ABSENT means the running dylib predates the feature
   * entirely (e.g. a 0.12.x bridge never mentions `stickerSend`) — a state
   * that heals only via a real Messages relaunch with the newer dylib.
   */
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

/**
 * chat.db's synthetic link-preview rows, and only those.
 *
 * Every URL sent in Messages gets a companion `attachment` row holding the
 * serialised rich-link plist. They are not files the sender chose to send, and
 * announcing one would put a notice line in front of every shared link.
 *
 * The old test for this was `!mime_type`, on the reasoning that MIME-less rows
 * are "overwhelmingly" link previews. Overwhelmingly is not always, and the
 * gap was silently dropping real files. Measured against the live chat.db on
 * 2026-08-28 (1,287 attachment rows): 181 carried no `mime_type`, of which 162
 * were `.pluginPayloadAttachment` — and the other **19 were genuine files**
 * whose extension macOS has no MIME mapping for. They had been dropped exactly
 * the way the .zip was:
 *
 *   uti                          transfer_name              n
 *   dyn.age80y65tr30a            *.jsonl                   10
 *   dyn.age81q7pf                *.vue                      7
 *   com.apple.iconcomposer.icon  Bloom.icon                 1
 *   dyn.age81asa                 AuthKey_….p8               1   ← inbound
 *
 * The discriminator is therefore positive rather than residual: the payload
 * rows are named `<UUID>.pluginPayloadAttachment` and carry the dynamic UTI
 * `dyn.age81a5dzq7y066dbtf0g82peqf4hk2pdrb00n5xy` (that string is a stable
 * base-32 encoding of the "pluginPayloadAttachment" filename-extension tag,
 * not a per-machine id — all 162 rows here share it). Both signals are checked
 * because either alone is one upstream rename away from failing open, and both
 * are surfaced by imsg: `imsg history --attachments --json` emits `uti`,
 * `transfer_name`, `filename`, `mime_type`, `original_path`, `total_bytes`,
 * `is_sticker` and `missing` for every attachment (verified against imsg
 * 0.14.1).
 *
 * Failing this test is the safe direction: an unrecognised MIME-less row is
 * stored as `application/octet-stream` with "type unknown" in the notice. The
 * worst case is a notice line for a preview row; the worst case of the old
 * behaviour was losing a file.
 */
const PLUGIN_PAYLOAD_SUFFIX = ".pluginpayloadattachment";
const PLUGIN_PAYLOAD_UTI = "dyn.age81a5dzq7y066dbtf0g82peqf4hk2pdrb00n5xy";

function isPluginPayloadAttachment(att: Record<string, unknown>): boolean {
  const uti = typeof att.uti === "string" ? att.uti.toLowerCase() : "";
  if (uti === PLUGIN_PAYLOAD_UTI) return true;
  for (const key of ["transfer_name", "filename", "original_path", "path"] as const) {
    const value = att[key];
    if (typeof value === "string" && value.toLowerCase().endsWith(PLUGIN_PAYLOAD_SUFFIX)) return true;
  }
  return false;
}

export interface ImsgChannelConfig {
  /** Path to the imsg binary. Defaults to "imsg" (resolved via PATH). */
  cliPath?: string;
  /** Optional chat.db path forwarded as `imsg rpc --db`. */
  dbPath?: string;
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
  /**
   * Base dir for the path-only any-MIME file store. Undefined means the store
   * is OFF — there is deliberately no fallback to `imageStoreBaseDir` here.
   * The "unset follows saveInboundImages" default belongs to the config parser
   * (`saveInboundFiles` in config.ts) and lives there alone; repeating it in
   * this constructor is what let `saveInboundFiles: false` keep writing files.
   */
  fileStoreBaseDir?: string;
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
  /** Test seam: silent retry schedule for a degraded startup capability probe. */
  capabilityRetryDelaysMs?: number[];
  /** Test seam: rate-limit floor between on-demand capability re-probes. */
  capabilityReprobeMinIntervalMs?: number;
  /** Max time to wait for a `drain` on a parked write before treating the child
   *  as wedged and restarting it. Default 10s. */
  drainWaitTimeoutMs?: number;
  /**
   * Test seam: message-service lookup for satellite (iMessageLite) detection.
   * Defaults to a read-only chat.db-backed lookup over `dbPath` (or the
   * standard `~/Library/Messages/chat.db`).
   */
  serviceLookup?: ServiceLookup;
  /**
   * Test seam: HEIC/HEIF converter. Given a source path and a target format,
   * returns the path to a temp JPEG/PNG (the channel reads then unlinks it)
   * or `null` on failure. Defaults to a macOS `sips`-backed implementation.
   */
  convertHeic?: (srcPath: string, format: HeicTargetFormat) => Promise<string | null>;
  /**
   * Test seam: alpha-channel probe for a source image file. `true`/`false` on
   * a clean probe, `null` when unknown. Defaults to `sips -g hasAlpha`.
   */
  probeHeicAlpha?: (srcPath: string) => Promise<boolean | null>;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
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
  private readonly cliPath: string;
  private readonly dbPath: string | undefined;
  private readonly imageStoreBaseDir: string | undefined;
  private readonly fileStoreBaseDir: string | undefined;
  private readonly cursorStorePath: string | null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly probeCapabilitiesFn: () => Promise<ImsgCapabilities>;
  private readonly restartDelaysMs: number[];
  private readonly drainWaitTimeoutMs: number;
  private messageGuidDedupe: MessageGuidDedupeStore;
  private readonly serviceLookup: ServiceLookup;
  private readonly convertHeicFn: (srcPath: string, format: HeicTargetFormat) => Promise<string | null>;
  private readonly probeHeicAlphaFn: (srcPath: string) => Promise<boolean | null>;
  // Settles a request's parked-on-'drain' write link, keyed by request id, so a
  // request timeout/cancel can release its own stuck write (else future writes
  // queue behind a forever-pending drain-wait).
  private writeWaiters = new Map<number, () => void>();

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
  private readonly capabilityRetryDelaysMs: number[];
  private readonly capabilityReprobeMinIntervalMs: number;
  /** Pending timer of the silent startup capability-retry loop. */
  private capabilityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Single-flight guard: at most one capability probe subprocess at a time. */
  private capabilityProbeInFlight = false;
  /** When the last capability probe completed (rate-limits on-demand re-probes). */
  private lastCapabilityProbeAt = 0;
  /**
   * How the last capability probe ended: null = it answered (even if it
   * reported the bridge down), otherwise the error it threw. The exhaustion
   * warning branches on this — "bridge not injected" and "probe keeps
   * failing" are operationally different failures with different remedies,
   * and naming the wrong one sends the operator to the wrong subsystem.
   */
  private lastCapabilityProbeError: unknown = null;
  /** Exclusive chat.db rowid cursor; watch resubscribes after this row. */
  private lastRowId = 0;
  // Lowest rowid whose dispatch failed and hasn't been re-handled yet. While
  // set, the cursor refuses to advance PAST it (never skip a failed real
  // message) and a resubscribe from the committed cursor replays the gap.
  private failedRowId: number | null = null;
  // Serializes watch-notification processing. Rows arrive in rowid order on the
  // stream, but each row's handler awaits attachment IO — without this chain a
  // later row could overtake an earlier one and reach the agent out of order.
  private watchChain: Promise<void> = Promise.resolve();
  // Bumped whenever the current subscription is torn down (crash, gap
  // recovery). Chain links captured under an older generation short-circuit,
  // so stale rows from a dead subscription never dispatch out of order.
  private watchGeneration = 0;
  // Serializes stdin writes so we can honor backpressure (await 'drain' when
  // write() returns false) instead of unboundedly buffering in the pipe.
  private writeChain: Promise<void> = Promise.resolve();

  // Bounded per-chat window of message GUIDs + text, newest first. Populated
  // from the watch stream for inbound AND our own outbound rows (imsg emits
  // is_from_me rows too), so reply-context lookups and substring-targeted
  // reactions/replies resolve without extra RPC calls.
  private recentByChat = new Map<string, RecentChatMessage[]>();

  constructor(config: ImsgChannelConfig = {}) {
    this.cliPath = config.cliPath ?? "imsg";
    this.dbPath = config.dbPath;
    this.imageStoreBaseDir = config.imageStoreBaseDir;
    // No `?? config.imageStoreBaseDir` here. Undefined means OFF, full stop —
    // the `storage-disabled` notice path covers it, so the agent is still told
    // a file arrived. Inheriting the image setting is the config parser's job
    // (config.ts, `saveInboundFiles`), and doing it in two places meant
    // `saveInboundFiles: false` was silently overridden whenever
    // `saveInboundImages` stayed at its default of true.
    this.fileStoreBaseDir = config.fileStoreBaseDir;
    this.cursorStorePath = config.cursorStorePath ?? null;
    this.spawnFn = config.spawnFn ?? nodeSpawn;
    this.probeCapabilitiesFn = config.probeCapabilities ?? (() => this.probeStatus());
    this.restartDelaysMs = config.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.capabilityRetryDelaysMs = config.capabilityRetryDelaysMs ?? DEFAULT_CAPABILITY_RETRY_DELAYS_MS;
    this.capabilityReprobeMinIntervalMs = config.capabilityReprobeMinIntervalMs ?? DEFAULT_CAPABILITY_REPROBE_MIN_INTERVAL_MS;
    this.drainWaitTimeoutMs = config.drainWaitTimeoutMs ?? DEFAULT_DRAIN_WAIT_TIMEOUT_MS;
    this.messageGuidDedupe = new MessageGuidDedupeStore(config.dedupeStorePath ?? null);
    this.serviceLookup = config.serviceLookup ?? new ChatDbServiceLookup(config.dbPath ?? DEFAULT_CHAT_DB_PATH);
    this.convertHeicFn = config.convertHeic ?? convertHeicImage;
    this.probeHeicAlphaFn = config.probeHeicAlpha ?? heicHasAlpha;
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
    // basic send/watch (AppleScript transport needs no bridge). A degraded
    // first probe is usually a boot-order race (daemon up before Messages.app
    // has the bridge injected, #258), so it is NOT warned about here: the
    // silent retry loop below re-probes with backoff and only warns once the
    // schedule is exhausted, and capability-gated call sites keep re-probing
    // on demand after that — a bridge that appears later is picked up without
    // a daemon restart.
    try {
      this.capabilities = await this.probeCapabilitiesFn();
      this.lastCapabilityProbeError = null;
    } catch (err) {
      this.capabilities = NO_CAPABILITIES;
      this.lastCapabilityProbeError = err;
      log.info({ err }, "imsg status probe failed; assuming basic features until a re-probe succeeds");
    }
    this.lastCapabilityProbeAt = Date.now();
    log.info({
      advancedFeatures: this.capabilities.advancedFeatures,
      typing: this.capabilities.typingIndicators,
      readReceipts: this.capabilities.readReceipts,
      editSupported: this.isEditSupported(),
    }, "imsg capabilities probed");

    // First spawn + subscribe must succeed or daemon startup should fail
    // loudly (missing binary, missing Full Disk Access, ...).
    await this.spawnChildAndSubscribe();

    // Start the capability retry loop only once startup has SUCCEEDED. If the
    // subscribe above throws, start() rejects and nothing here has armed a
    // timer — otherwise a channel that never started would keep spawning
    // `imsg status` probes and eventually warn about a bridge it isn't using.
    if (!this.capabilities.advancedFeatures) {
      log.info({ retryDelaysMs: this.capabilityRetryDelaysMs }, "imsg bridge not available yet (advanced_features=false); re-probing quietly with backoff");
      this.scheduleCapabilityRetry(0);
    }

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
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.capabilityRetryTimer) {
      clearTimeout(this.capabilityRetryTimer);
      this.capabilityRetryTimer = null;
    }
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
   */
  async quiesce(): Promise<void> {
    await this.watchChain;
  }

  /**
   * Phase 3 — physical teardown. Slow and fallible; the agent runs it only
   * after everything durable has been written, and bounds it.
   */
  async teardown(): Promise<void> {
    log.info("iMessage channel (imsg) stopping");
    this.stopping = true;
    if (this.child && this.subscriptionId !== null) {
      try {
        await this.request("watch.unsubscribe", { subscription: this.subscriptionId }, 3_000);
      } catch {
        // Best-effort; the child is about to be killed anyway.
      }
    }
    this.killChild();
    this.serviceLookup.close();
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
      if (richParams && this.capabilities.advancedFeatures && bridgeAddressable) {
        try {
          const result = await this.request("send.rich", {
            chat_guid: chatId,
            text: chunk,
            ...richParams,
            part_index: 0,
          });
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
        this.maybeReprobeCapabilities();
      } else if (isBareHttpUrl(chunk) && bridgeAddressable) {
        // A part that is exactly one URL: send it as an Apple rich link
        // preview when the injected bridge supports it (the balloon iMessage
        // renders when a human shares a link), else leave it a plain text
        // send as before. send.rich's url mode accepts NO other params
        // (no text/reply_to/effect), which is why this branch is mutually
        // exclusive with the rich-text branch above.
        if (this.richLinksSupported()) {
          if (await this.trySendRichLink(chatId, chunk.trim())) continue;
        } else {
          // Snapshot lacks the rich-link selectors. Unlike a missing edit
          // selector (an OS limit), this state heals: a Messages relaunch
          // with the 0.13+ bridge adds the selectors while advanced_features
          // stays true throughout — hence evenIfBridged, or the reprobe
          // would early-return forever and rich links would need a daemon
          // restart to ever light up. (Mind the operational trap the
          // diagnosis names: `imsg launch` alone no-ops while the old bridge
          // still answers ping — Messages must actually quit first.)
          this.maybeReprobeCapabilities({ evenIfBridged: true });
          log.info(
            { chatId, ...this.capabilityGateDiagnosis(null, ["urlPreviewMessage", "sendRichLinkAction"]) },
            "imsg rich link preview unavailable; sending the URL as plain text",
          );
        }
      }
      const result = await this.request("send", {
        ...this.imsgTarget(chatId),
        text: chunk,
      });
      this.recordOwnSend(chatId, result, chunk);
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
    return this.capabilities.advancedFeatures
      && this.capabilities.selectors.urlPreviewMessage === true
      && this.capabilities.selectors.sendRichLinkAction === true;
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
      const result = await this.request("send.rich", { chat_guid: chatId, url });
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
    await this.request("group.rename", { chat_guid: this.requireChatGuid(chatId, "rename"), name: title });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    // Targeted tapback via the IMCore bridge. The param name is `kind` — the
    // canonical `imsg tapback --kind love|like|dislike|laugh|emphasize|question`
    // flag. (The v0.12.3 RPC source also accepts a `reaction` alias, but the
    // shipped binary honors only `kind`: sending `reaction` was silently
    // ignored and defaulted every tapback to 👍 — confirmed on-device.) Our
    // MessageReaction enum values map 1:1 to imsg's --kind values.
    await this.request("tapback", {
      chat_guid: this.requireChatGuid(chatId, "tapback"),
      message_guid: messageId,
      kind: reaction,
      remove,
      part_index: 0,
    });
  }

  /**
   * True only when the whole edit path is live: the IMCore bridge is injected,
   * the installed imsg advertises `message.edit`, AND the bridge selector probe
   * confirmed an edit selector exists. Gated the same way as typing/read so a
   * partial capability set can never reach `message.edit` (see #227).
   */
  isEditSupported(): boolean {
    return this.capabilities.advancedFeatures
      && this.capabilities.rpcMethods.has("message.edit")
      && (this.capabilities.selectors.editMessageItem === true
        || this.capabilities.selectors.editMessage === true);
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Edited message text cannot be empty");
    // Apple removed both IMCore edit selectors (editMessageItem and the older
    // editMessage) in macOS 26 — calling message.edit blindly is what crashed
    // Messages.app in #227. Only proceed when the startup selector probe
    // confirmed one of them exists.
    if (!this.isEditSupported()) {
      // No-op unless the BRIDGE itself is down (a stale degraded snapshot,
      // #258). A missing edit selector with a live bridge is a real OS-level
      // limit (macOS 26 removed both selectors) that no re-probe can change.
      this.maybeReprobeCapabilities();
      log.warn(
        { chatId, messageId, ...this.capabilityGateDiagnosis("message.edit", ["editMessageItem", "editMessage"]) },
        "imsg message edit refused by capability gate",
      );
      throw new Error(
        "iMessage message editing is unsupported on this macOS: the IMCore edit selectors "
        + "(editMessageItem/editMessage) are unavailable per the imsg bridge probe. "
        + "Send a correction message instead.",
      );
    }
    await this.request("message.edit", {
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
    await this.request("message.unsend", {
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
    if (!this.capabilities.typingIndicators) {
      this.maybeReprobeCapabilities();
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
      await this.request("typing", { chat_guid: chatId, typing }, 5_000);
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

  // --- imsg rpc child lifecycle ---

  private async spawnChildAndSubscribe(): Promise<void> {
    const args = ["rpc", ...(this.dbPath ? ["--db", this.dbPath] : [])];
    const child = this.spawnFn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.childSpawnedAt = Date.now();
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      // Drop late/buffered stdout from a child that is no longer current: after
      // a kill + gap-recovery generation bump, a straggler line from the dead
      // child must not be parsed and dispatched under the new subscription
      // (out of order, before the in-order replay).
      if (this.child !== child) return;
      this.handleStdout(chunk);
    });
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
    try {
      const result = await this.request("watch.subscribe", {
        attachments: true,
        convert_attachments: true,
        include_reactions: true,
        ...(this.lastRowId > 0 ? { since_rowid: this.lastRowId } : {}),
      });
      const subscription = result.subscription;
      this.subscriptionId = typeof subscription === "number" ? subscription : null;
      log.info({ subscription: this.subscriptionId, sinceRowId: this.lastRowId || undefined }, "imsg watch subscribed");
    } catch (err) {
      // The child spawned but the subscribe failed (FDA missing, startup
      // error, ...). Kill the child we just started before propagating —
      // otherwise it leaks as a live `imsg rpc` process with dangling pipes.
      // Also reject any OTHER in-flight requests (e.g. sends issued during a
      // restart): once we null this.child, the child's exit event is stale and
      // handleChildDown() would skip them, hanging them until timeout.
      if (this.child === child) {
        this.child = null;
        this.subscriptionId = null;
      }
      // Fresh write chain for the next attempt (a stalled drain-wait on this
      // dead child must not block future writes) and reject in-flight requests.
      this.writeChain = Promise.resolve();
      this.rejectAllPending("subscribe failed");
      child.kill();
      throw err;
    }
  }

  /** Reject every in-flight request (the child can no longer answer them). */
  private rejectAllPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const req of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`imsg rpc child ${reason} while awaiting ${req.method}`));
    }
  }

  private handleChildDown(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return; // stale event from an already-replaced child
    this.child = null;
    this.subscriptionId = null;
    // Abandon the current watch chain: queued rows belong to the dead
    // subscription and will replay in order after resubscribe.
    this.watchGeneration++;
    this.watchChain = Promise.resolve();
    // Give the restarted child a fresh write chain. A write that returned false
    // and is still awaiting 'drain' on the dead child would otherwise keep the
    // global chain pending forever, so every restarted watch.subscribe would
    // queue behind it and time out — a permanent restart loop. (The stalled
    // link itself settles via the drain/exit race in enqueueWrite.)
    this.writeChain = Promise.resolve();

    this.rejectAllPending(reason);
    this.scheduleRestart(reason);
  }

  /** Schedule a backoff restart of the rpc child (no-op once stopping). */
  private scheduleRestart(reason: string): void {
    if (this.stopping || this.restartTimer) return;

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
        // spawnChildAndSubscribe already killed the failed child; just queue
        // another attempt (its own exit event is ignored as stale).
        log.error({ err }, "imsg rpc child restart failed");
        this.scheduleRestart("restart failed");
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
    // Nulling this.child above makes the kill's exit event a stale no-op in
    // handleChildDown, so settle in-flight requests here — otherwise a send
    // awaited during shutdown would never resolve (its timeout timer is
    // unref'd, so it may never fire before the process exits).
    this.rejectAllPending("stopped");
    child.kill();
  }

  // --- JSON-RPC over stdio (newline-delimited JSON) ---

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error(`imsg rpc child is not running (${method})`));
    }
    // Bound the in-flight set. A pending map this large means the child has
    // stopped answering (or draining); fail fast rather than buffer unboundedly.
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`imsg rpc pending queue full (${MAX_PENDING_REQUESTS}); dropping ${method}`));
    }
    const id = this.nextRequestId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Settle this request's write link if it is still parked on 'drain':
        // the request is gone, so leaving the link pending would queue every
        // future write behind it forever.
        this.writeWaiters.get(id)?.();
        reject(new Error(`imsg rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      // Route the write through the backpressure-aware, serialized writer.
      // A write failure rejects the request (the response will never come).
      this.enqueueWrite(child, line, id).catch((err: Error) => {
        const req = this.pending.get(id);
        if (req) {
          this.pending.delete(id);
          clearTimeout(req.timer);
          reject(new Error(`imsg rpc write failed for ${method}: ${err.message}`));
        }
      });
    });
  }

  /**
   * Serialized, backpressure-aware stdin writer. When `write()` returns false
   * the pipe buffer is full — await the 'drain' event before the next write so
   * we never let Node buffer an unbounded backlog in memory.
   *
   * `id` is the owning request: if it is no longer pending by the time this
   * write dequeues (the request already timed out or was rejected), the write
   * is SKIPPED. Otherwise a queued send could fire late — after the caller saw
   * a timeout and possibly retried — producing a duplicate side-effecting send.
   */
  private enqueueWrite(child: ChildProcessWithoutNullStreams, line: string, id: number): Promise<void> {
    this.writeChain = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      if (!this.pending.has(id)) {
        // Request already settled (timeout/reject); do not execute its write.
        resolve();
        return;
      }
      if (!child.stdin.writable) {
        reject(new Error("stdin is not writable"));
        return;
      }
      let settled = false;
      let onDrain: (() => void) | null = null;
      let onExit: (() => void) | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (onDrain) child.stdin.removeListener("drain", onDrain);
        if (onExit) {
          child.removeListener("exit", onExit);
          child.removeListener("close", onExit);
        }
        if (drainTimer) clearTimeout(drainTimer);
        this.writeWaiters.delete(id);
      };
      const finishOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const ok = child.stdin.write(line, (err) => {
        if (err) fail(err);
      });
      // write() true → the chunk was flushed/queued below the highWaterMark, so
      // proceed immediately. false → wait for 'drain', but never forever:
      //  - the child exiting/closing unblocks the chain (request rejected via
      //    handleChildDown), and
      //  - the owning request timing out settles this link (via writeWaiters),
      //    and
      //  - a backstop timeout catches a still-ALIVE child that silently stops
      //    draining: settle the link AND restart the child (its watch replays
      //    from the committed cursor, so no delivery is lost) so one wedged
      //    pipe can't stall every future write.
      if (ok) {
        finishOk();
      } else {
        onDrain = finishOk;
        onExit = finishOk;
        child.stdin.once("drain", onDrain);
        child.once("exit", onExit);
        child.once("close", onExit);
        this.writeWaiters.set(id, finishOk);
        drainTimer = setTimeout(() => {
          if (settled) return;
          log.warn({ drainWaitTimeoutMs: this.drainWaitTimeoutMs }, "imsg stdin never drained; restarting the rpc child");
          finishOk();
          if (this.child === child) {
            child.kill();
            this.handleChildDown(child, "stdin drain timeout");
          }
        }, this.drainWaitTimeoutMs);
        drainTimer.unref?.();
      }
    }));
    // Keep the chain from rejecting (which would poison every later write);
    // per-write failures are surfaced through the returned promise instead.
    const result = this.writeChain;
    this.writeChain = this.writeChain.catch(() => {});
    return result;
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
      // A response proves the child consumed the request line, so a write
      // link still parked on 'drain' for it can settle now instead of waiting
      // out the drain backstop (which would needlessly restart a healthy,
      // answering child).
      this.writeWaiters.get(id)?.();
      if (payload.error) {
        const error = payload.error as { code?: number; message?: string; data?: string };
        const detail = error.data ? `: ${error.data}` : "";
        // Typed rejection: an error RESPONSE proves the child processed and
        // refused the request (nothing was sent) — callers with a fallback
        // send key on this to avoid double-delivering after ambiguous
        // failures (timeout/child-death), which reject as plain Errors.
        req.reject(new ImsgRpcResponseError(`imsg rpc ${req.method} failed (${error.code ?? "?"}) ${error.message ?? "error"}${detail}`));
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
      // Serialize through a FIFO chain: rows arrive in rowid order, but each
      // handler awaits attachment IO, so without this a later row could reach
      // the agent before an earlier one. Capture the generation so that if the
      // subscription is torn down (crash / gap recovery) while rows are queued,
      // those stale rows short-circuit instead of dispatching out of order.
      const generation = this.watchGeneration;
      this.watchChain = this.watchChain.then(() => {
        if (generation !== this.watchGeneration) return;
        return this.handleWatchMessage(message, generation).catch((err) => {
          log.error({ err }, "Error processing imsg watch message");
        });
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
    if (this.stopping) {
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
      if (generation !== this.watchGeneration) {
        log.debug({ err, rowId, generation, current: this.watchGeneration }, "imsg stale-generation row failure ignored");
        return;
      }
      // ANY failure while handling this row — a real-message dispatch, a slash
      // COMMAND handler, or an unexpected error — must halt + floor + resubscribe
      // rather than let a later row advance the cursor past it. Otherwise the
      // failed row is skipped forever on resubscribe.
      this.recoverFromGap(rowId, err);
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
      this.advanceCursor(rowId);
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
      if (this.isStaleGeneration(generation, rowId)) return;
      this.advanceCursor(rowId);
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
      this.advanceCursor(rowId);
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
      this.advanceCursor(rowId);
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
        if (this.isStaleGeneration(generation, rowId)) return;
        if (guid) this.messageGuidDedupe.record(guid);
        this.advanceCursor(rowId);
        return;
      }
    }

    // Attachments arrive as local file paths (imsg reads chat.db directly).
    // Stickers are counted apart from plain images: chat.db marks them
    // (attachment.is_sticker, surfaced by imsg 0.13+) and a sticker described
    // as just "an image" buries the expressive act (and, worse, hides that
    // the source lives in StickerCache with its alpha channel intact).
    const rawAttachments = Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : [];
    const isImageAtt = (a: Record<string, unknown>) => this.attachmentMime(a).startsWith("image/");
    const intendedStickerCount = rawAttachments.filter((a) => isImageAtt(a) && a.is_sticker === true).length;
    const intendedImageCount = rawAttachments.filter((a) => isImageAtt(a) && a.is_sticker !== true).length;
    const intendedDocumentCount = rawAttachments.filter((a) => isSupportedDocumentMime(this.attachmentMime(a))).length;
    const { images, documents, files } = await this.loadAttachments(rawAttachments, chatGuid);

    // Attachment loading may have blocked long enough for a restart + replay to
    // supersede this row. Bail before any side effect (read, dispatch, cursor).
    if (this.isStaleGeneration(generation, rowId)) return;

    // Mark chat as read (best-effort; needs the bridge's read-receipt path).
    if (this.capabilities.readReceipts) {
      this.request("read", { chat_guid: chatGuid }, 5_000).catch(() => {});
    } else {
      // Skipped as before — but a degraded snapshot may be stale (#258), so
      // kick a rate-limited background re-probe off the inbound path.
      this.maybeReprobeCapabilities();
    }

    const imageSavedPaths = images.filter((i) => !i.isSticker).map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const stickerSavedPaths = images.filter((i) => i.isSticker).map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const docSavedPaths = documents.map((d) => d.savedPath).filter((p): p is string => Boolean(p));
    const stickerMarker = formatStickerMarker(intendedStickerCount, stickerSavedPaths);
    const imageMarker = formatImageMarker(intendedImageCount, imageSavedPaths);
    const docMarker = formatDocumentMarker(intendedDocumentCount, docSavedPaths);
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
      this.advanceCursor(rowId);
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
    if (this.isStaleGeneration(generation, rowId)) return;

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
    if (this.isStaleGeneration(generation, rowId)) return;

    // Success under the current generation: record the GUID and advance.
    if (guid) this.messageGuidDedupe.record(guid);
    this.advanceCursor(rowId);
  }

  /** True (with a log) when a row's generation has been superseded by a replay. */
  private isStaleGeneration(generation: number, rowId: number): boolean {
    if (generation === this.watchGeneration) return false;
    log.debug({ rowId, generation, current: this.watchGeneration }, "imsg abandoning stale-generation row (superseded by replay)");
    return true;
  }

  /**
   * Persist the exclusive rowid cursor once a row is fully handled. Refuses to
   * advance PAST an unresolved failed row (that would skip it); reaching the
   * failed row again (successful replay) clears the floor.
   */
  private advanceCursor(rowId: number): void {
    if (this.failedRowId !== null) {
      if (rowId > this.failedRowId) return; // never commit past the gap
      if (rowId >= this.failedRowId) this.failedRowId = null; // gap re-handled
    }
    if (rowId > this.lastRowId) {
      this.lastRowId = rowId;
      this.persistCursor();
    }
  }

  /**
   * A real message failed to dispatch. Mark its rowid as the failed floor and
   * tear down the subscription so it resubscribes from the last committed
   * cursor — replaying the failed row and everything after it, in order. The
   * generation bump in handleChildDown abandons any rows already queued behind
   * the failure so they don't reach the agent out of order.
   */
  private recoverFromGap(rowId: number, err: unknown): void {
    // A row without a numeric rowid (parsed as 0) can't be replayed by
    // since_rowid. Flooring at 0 would block every future cursor commit (all
    // real rowids are > 0) and the floor could never clear — the cursor file
    // would silently freeze forever. Log and move on instead.
    if (rowId <= 0) {
      log.error({ err }, "imsg dispatch failed for a row with no rowid; cannot replay — skipping");
      return;
    }
    if (this.failedRowId === null || rowId < this.failedRowId) this.failedRowId = rowId;
    log.error({ err, rowId, sinceRowId: this.lastRowId }, "imsg dispatch failed; resubscribing to replay the gap");
    const child = this.child;
    if (child) {
      child.kill();
      this.handleChildDown(child, "dispatch gap recovery");
    } else {
      // No live child (a restart is already in flight) — it will resubscribe
      // from the (un-advanced) committed cursor and replay the failed row.
      this.scheduleRestart("dispatch gap recovery");
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
  ): Promise<{ images: ImageAttachment[]; documents: DocumentAttachment[]; files: SavedFileNotice[] }> {
    const images: ImageAttachment[] = [];
    const documents: DocumentAttachment[] = [];
    const files: SavedFileNotice[] = [];

    for (const att of attachments) {
      const mimeType = this.attachmentMime(att);
      // A MIME-less row is skipped ONLY when it is positively identifiable as
      // a synthetic link-preview payload (see isPluginPayloadAttachment).
      // Everything else MIME-less is a real file and gets stored.
      if (!mimeType && isPluginPayloadAttachment(att)) continue;

      const isImage = mimeType.startsWith("image/");
      const isDocument = isSupportedDocumentMime(mimeType);
      if (!isImage && !isDocument) {
        // Everything else used to be dropped right here, silently. That is how
        // a .zip of SSH keys arrived on 2026-08-27 as a lone
        // object-replacement character with no text and no indication an
        // attachment existed at all. We don't attach these to the message (the
        // model can't read a zip as an attachment, and a 32 MB binary must not
        // be uploaded), so persist the bytes and hand back a one-line notice
        // instead. Always a notice — never a silent drop, including when the
        // file is missing or has no local path, which is the same invisible
        // failure wearing a different hat.
        files.push(await this.storeUnsupportedAttachment(att, mimeType, chatGuid));
        continue;
      }

      // Images and documents are load-or-nothing: with no bytes there is
      // nothing to put in the context, and the intended-count markers already
      // tell the agent how many did not make it.
      if (att.missing === true) continue;
      const filePath = this.attachmentPath(att);
      if (!filePath) continue;

      try {
        if (isDocument) {
          // Cap document reads before touching the bytes — check the declared
          // size first, then cap the read itself, since the declared size can
          // be missing or wrong.
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
          // imsg's convert_attachments is unreliable — it hands us a converted
          // JPEG for some rows but raw HEIC for others (raw HEIC observed on
          // group photos, converted JPEG on a DM photo, 2026-07-07). The
          // harness image reader can't display HEIC, so normalize here as a
          // channel-side fallback: any HEIC (by mime, extension, OR ftyp magic
          // bytes) is converted via sips before it's stored/encoded — to PNG
          // when the pixels carry alpha (a JPEG rendition flattens the
          // transparency into a solid background), to JPEG otherwise.
          // Failure keeps the original bytes — never drop the attachment.
          const isSticker = att.is_sticker === true;
          const { buffer: imageBuffer, mimeType: imageMime } = await this.normalizeHeicImage(buffer, mimeType, filePath, isSticker);
          const image = await buildImageAttachment(imageBuffer, imageMime, meta, this.imageStoreBaseDir);
          if (isSticker) image.isSticker = true;
          images.push(image);
        } else {
          const filename = (typeof att.transfer_name === "string" && att.transfer_name) || basename(filePath);
          documents.push(await buildDocumentAttachment(buffer, mimeType, { ...meta, filename }, this.imageStoreBaseDir));
        }
      } catch (err) {
        log.error({ err, path: filePath }, "Failed to read imsg attachment");
      }
    }

    return { images, documents, files };
  }

  /**
   * Persist an attachment whose MIME is neither an image nor a supported
   * document, and describe it for the agent. The bytes are copied out of
   * `~/Library/Messages/Attachments/…` into the workspace — Messages' own copy
   * is not ours to rely on (it is pruned, and the directory is TCC-protected),
   * and chat.db is never touched.
   *
   * ALWAYS returns a notice. There is no outcome — too large, write failed,
   * storage off, file missing, no local path at all — in which the right
   * answer is silence. Returning `null` for "no usable path" was the original
   * bug still alive in the failure path: nothing recorded that a file had been
   * *intended*, so an attachment-only message reached the ghost-row check with
   * no marker and was discarded, exactly as the .zip was.
   */
  private async storeUnsupportedAttachment(
    att: Record<string, unknown>,
    mimeType: string,
    chatGuid: string,
  ): Promise<SavedFileNotice> {
    const filePath = this.attachmentPath(att);
    // transfer_name is the name the sender's device attached ("id_rsa.zip");
    // filename/basename are the on-disk copy, which is far less informative.
    const originalName = (typeof att.transfer_name === "string" && att.transfer_name)
      || (typeof att.filename === "string" && att.filename)
      || (filePath ? basename(filePath) : "");
    const displayName = sanitizeAttachmentFilename(originalName, mimeType);
    // A MIME-less row that got past isPluginPayloadAttachment is a real file
    // of a type macOS has no mapping for (.jsonl, .vue, .icon were all
    // observed). Report the fallback type, flagged as unknown so the agent
    // doesn't read "octet-stream" as a positive identification.
    const mimeUnknown = !mimeType;
    const effectiveMime = mimeType || FALLBACK_MIME;
    // Declared size is the only size available when there are no bytes to
    // stat; it still tells the agent whether a 2 KB key or a 2 GB video went
    // missing.
    const declaredSize = typeof att.total_bytes === "number"
      ? att.total_bytes
      : (typeof att.byte_size === "number" ? att.byte_size : undefined);
    const unavailable = (status: "source-missing" | "source-unavailable"): SavedFileNotice => {
      log.warn(
        { path: filePath || undefined, mimeType: effectiveMime, name: displayName, status },
        "Inbound file announced but no bytes available; reporting it anyway",
      );
      return { filename: displayName, mimeType: effectiveMime, byteSize: declaredSize, mimeUnknown, status };
    };

    // imsg says the local copy is gone (Messages pruned it, or the transfer
    // never completed). "The sender attached keys.zip but it never
    // downloaded" is information the agent needs, not a reason to say nothing.
    if (att.missing === true) return unavailable("source-missing");
    if (!filePath) return unavailable("source-unavailable");

    try {
      const declared = att.total_bytes ?? att.byte_size;
      const actual = (await stat(filePath)).size;
      const byteSize = actual;
      const base = { filename: displayName, mimeType: effectiveMime, byteSize, mimeUnknown } as const;

      // Check the cap before reading: the whole point is never to pull an
      // oversized blob into memory just to throw it away.
      if (actual > MAX_FILE_BYTES || (typeof declared === "number" && declared > MAX_FILE_BYTES)) {
        log.warn(
          { path: filePath, mimeType: effectiveMime, actual, declared, max: MAX_FILE_BYTES },
          "Inbound file over size cap; not stored",
        );
        return { ...base, status: "too-large" };
      }

      if (!this.fileStoreBaseDir) {
        return { ...base, status: "storage-disabled" };
      }

      const buffer = await readFile(filePath);
      const savedPath = await saveInboundFile(
        buffer,
        effectiveMime,
        { sessionKey: `imessage_${chatGuid}`, filename: originalName },
        this.fileStoreBaseDir,
      );
      return savedPath
        ? { ...base, savedPath, status: "saved" }
        : { ...base, status: "save-failed" };
    } catch (err) {
      log.error({ err, path: filePath, mimeType: effectiveMime }, "Failed to store inbound file attachment");
      return { filename: displayName, mimeType: effectiveMime, byteSize: declaredSize, mimeUnknown, status: "save-failed" };
    }
  }

  /**
   * Channel-side HEIC/HEIF → JPEG/PNG fallback. Returns the converted buffer
   * + mime when the attachment is HEIC and the conversion succeeds; otherwise
   * returns the inputs unchanged so a non-HEIC image passes through untouched
   * and a failed conversion keeps the original bytes (never drops the
   * attachment). Never throws. `filePath` is only used for extension sniffing
   * and the alpha probe — the convert reads the same on-disk file imsg
   * pointed us at, and writes to a temp file that we read then unlink;
   * chat.db and Messages are never touched.
   *
   * Target format: transparency must survive the transcode — a transparent
   * HEIC written to JPEG silently lands on a solid background (a die-cut
   * sticker's backdrop turned black and nobody noticed for a day,
   * 2026-08-05). Keeping HEIC isn't an option (the harness image reader
   * can't display it), so PNG is the alpha-safe target. Stickers skip the
   * probe entirely: their source (~/Library/Messages/StickerCache/…/*.heic)
   * is transparent die-cut art by construction, and a PNG of one is also
   * exactly what `send.sticker` accepts back, so the saved copy stays
   * resendable as a native sticker. Non-sticker HEICs ask `sips -g hasAlpha`
   * and fall back to JPEG when the probe can't answer — the pre-existing
   * behavior for ordinary photos, where PNG would cost megabytes for
   * nothing.
   */
  private async normalizeHeicImage(
    buffer: Buffer,
    mimeType: string,
    filePath: string,
    isSticker = false,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!looksLikeHeic(mimeType, filePath, buffer)) return { buffer, mimeType };

    let format: HeicTargetFormat;
    if (isSticker) {
      format = "png";
    } else {
      const alpha = await this.probeHeicAlphaFn(filePath).catch(() => null);
      format = alpha === true ? "png" : "jpeg";
    }

    const outPath = await this.convertHeicFn(filePath, format).catch((err) => {
      log.error({ err, path: filePath, format }, "HEIC conversion threw; keeping original attachment");
      return null;
    });
    if (!outPath) return { buffer, mimeType };

    try {
      const converted = await readFile(outPath);
      return { buffer: converted, mimeType: format === "png" ? "image/png" : "image/jpeg" };
    } catch (err) {
      log.error({ err, path: filePath, outPath }, "Failed to read converted image; keeping original attachment");
      return { buffer, mimeType };
    } finally {
      await unlink(outPath).catch(() => undefined);
    }
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
    return this.capabilities.advancedFeatures
      && this.capabilities.rpcMethods.has("send.attachment")
      && this.capabilities.selectors.sendAttachment === true;
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
      log.warn({ path: filePath }, "Attachment file not found");
      return replyTo ? { threaded: false } : undefined;
    }

    // send.attachment is bridge-only (chat selector); the plain `send` file
    // param also accepts a bare handle via `to`.
    const resolvedGuid = this.resolveChatGuid(chatGuid);
    if (resolvedGuid) chatGuid = resolvedGuid;
    let threaded = false;
    if (replyTo && resolvedGuid && this.attachmentReplyToSupported()) {
      try {
        await this.request("send.attachment", { chat_guid: chatGuid, file: filePath, reply_to: replyTo });
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
      this.maybeReprobeCapabilities();
      log.info(
        { chatId: chatGuid, ...this.capabilityGateDiagnosis("send.attachment", ["sendAttachment"]) },
        "imsg threaded attachment send unavailable; sending the attachment unthreaded",
      );
    }

    if (!threaded) {
      // The plain `send` file param works on the AppleScript transport — no
      // bridge required (send.attachment is bridge-only).
      await this.request("send", { ...this.imsgTarget(chatGuid), file: filePath });
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
      const captionResult = await this.send({
        chatId: chatGuid,
        text: caption,
        ...(offerTarget ? { replyTo } : {}),
      });
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
    return this.capabilities.advancedFeatures
      && this.capabilities.rpcMethods.has("send.sticker")
      && this.capabilities.selectors.stickerSend === true;
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
    if (!sticker.startsWith("/") && !sticker.startsWith("~")) {
      log.warn({ chatId: chatGuid }, "Ignoring non-path sticker value on iMessage channel (Telegram file_ids are channel-bound)");
      return;
    }
    // Expand a leading `~` ourselves: imsg's send.sticker expands it too, but
    // the fallback plain `send` may not, and our own existence check below
    // certainly doesn't.
    const filePath = sticker.replace(/^~(?=$|\/)/, homedir());
    if (!existsSync(filePath)) {
      log.warn({ path: filePath, chatId: chatGuid }, "Sticker file not found; nothing sent");
      return;
    }

    // send.sticker is bridge-only; a bare handle with no known conversation
    // takes the plain attachment route below via `to`.
    const resolvedGuid = this.resolveChatGuid(chatGuid);
    if (resolvedGuid) chatGuid = resolvedGuid;
    if (this.stickerSendSupported() && resolvedGuid) {
      try {
        const result = await this.request("send.sticker", { chat_guid: chatGuid, file: filePath });
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
      this.maybeReprobeCapabilities({ evenIfBridged: true });
      log.info(
        { chatId: chatGuid, ...this.capabilityGateDiagnosis("send.sticker", ["stickerSend"]) },
        "imsg native sticker send unavailable; sending as a plain image attachment",
      );
    }
    const result = await this.request("send", { ...this.imsgTarget(chatGuid), file: filePath });
    this.recordOwnSend(chatGuid, result, `[sticker: ${basename(filePath)}]`);
  }

  // --- Capability probe ---

  /**
   * Silent startup retry loop for a degraded capability probe (#258). The
   * common cause is a boot-order race — the daemon starts before Messages.app
   * has come up with the bridge dylib injected (every macOS-update reboot) —
   * so retries stay QUIET: no warning until the whole schedule is exhausted,
   * and a retry that finds the bridge simply swaps the snapshot in (one info
   * line from reprobeCapabilities) and ends the loop. Once exhausted, the
   * loud warning fires — worded for what actually happened (bridge reported
   * absent vs. probe kept failing; see the branch below) — and on-demand
   * re-probes take over so a bridge that appears even later is still picked
   * up without a restart. Only armed after start() has fully succeeded, so a
   * failed startup never leaks a probing loop for a dead channel.
   * Never calls `imsg launch` itself: that kills and relaunches Messages.app
   * and must stay a human decision.
   */
  private scheduleCapabilityRetry(attempt: number): void {
    if (this.stopping || this.capabilityRetryTimer) return;
    if (attempt >= this.capabilityRetryDelaysMs.length) {
      // Hard operational prerequisite: without `imsg launch` (bridge
      // injected), the IMCore-backed outbound RPCs — send.rich, tapback,
      // message.unsend, group.rename, typing — have no live path and BLOCK
      // until their request timeouts (30s / 5s) fire. Inbound watch and plain
      // AppleScript `send` still work, but outbound is effectively dead. Warn
      // loudly (only now, after the silent retries) so a cutover that skipped
      // `imsg launch` is obvious in the logs.
      //
      // Two operationally different failures reach this point, and the
      // warning must say which it saw — a confidently wrong remedy is worse
      // than none (#258's original sin):
      // - the probe ANSWERED with advanced_features=false → the bridge is
      //   genuinely not injected and `imsg launch` is the accurate remedy;
      // - the probe kept THROWING (missing/broken binary, spawn error,
      //   timeout, malformed JSON) → capabilities are UNKNOWN, the bridge may
      //   be fine, and `imsg launch` likely won't help.
      if (this.lastCapabilityProbeError == null) {
        log.warn(
          { retriesExhausted: this.capabilityRetryDelaysMs.length },
          "imsg bridge NOT injected (advanced_features=false) after startup retries: run `imsg launch`. Until then, outbound tapback/typing/unsend/rename/threaded-reply RPCs will hang until timeout; only inbound watch and plain sends work. The channel keeps re-probing in the background and picks the bridge up automatically once it is injected.",
        );
      } else {
        log.warn(
          { err: this.lastCapabilityProbeError, retriesExhausted: this.capabilityRetryDelaysMs.length },
          "imsg status probe still failing after startup retries — capabilities UNKNOWN, assuming basic features. This is a probe failure, not (necessarily) a missing bridge: check the imsg binary first (`imsg status --json`) before reaching for `imsg launch`. Typing and threaded replies degrade to no-ops (they are capability-gated); tapback/unsend/rename are NOT gated and will still be attempted — if the bridge is in fact absent they hang until their request timeout. The channel keeps re-probing in the background.",
        );
      }
      return;
    }
    const timer = setTimeout(() => {
      this.capabilityRetryTimer = null;
      if (this.stopping) return;
      void this.reprobeCapabilities("startup retry").then(() => {
        if (this.stopping || this.capabilities.advancedFeatures) return; // healed (or shutting down) — silently done
        this.scheduleCapabilityRetry(attempt + 1);
      });
    }, this.capabilityRetryDelaysMs[attempt]);
    // Don't hold the process open just for a pending capability retry.
    timer.unref?.();
    this.capabilityRetryTimer = timer;
  }

  /**
   * Legible failure mode for a closed capability gate: names exactly what the
   * gate read and what it saw, plus a one-line verdict on WHICH link of the
   * chain broke and what (if anything) heals it. Logged at every refusal
   * point so a reader seeing "stickers not sending" can tell, from the logs
   * alone, whether the bridge lacks the surface or the gate misread it —
   * absence of a key from a probe is otherwise indistinguishable from
   * "probed and refused" (the exact confusion that shipped these gates
   * pointing at signals nobody had verified; see the provenance notes on
   * ImsgCapabilities).
   *
   * The checks mirror the gate conditions in short-circuit order:
   * advancedFeatures, then the CLI-side rpc_methods entry (when the gate has
   * one), then the bridge-side selectors. Pass `rpcMethod: null` for gates
   * that don't read rpc_methods, so the diagnosis can never claim a check
   * the gate doesn't make.
   */
  private capabilityGateDiagnosis(
    rpcMethod: string | null,
    selectorKeys: string[],
  ): { checked: Record<string, string | boolean>; verdict: string } {
    const caps = this.capabilities;
    const checked: Record<string, string | boolean> = { advancedFeatures: caps.advancedFeatures };
    if (rpcMethod !== null) checked[`rpcMethods.${rpcMethod}`] = caps.rpcMethods.has(rpcMethod);
    const absent: string[] = [];
    const probedFalse: string[] = [];
    for (const key of selectorKeys) {
      const value = caps.selectors[key];
      checked[`selectors.${key}`] = value === undefined ? "absent" : value;
      if (value === undefined) absent.push(key);
      else if (value !== true) probedFalse.push(key);
    }
    let verdict: string;
    if (!caps.advancedFeatures) {
      verdict = "bridge not injected (advanced_features=false): run `imsg launch`";
    } else if (rpcMethod !== null && !caps.rpcMethods.has(rpcMethod)) {
      verdict = `installed imsg CLI does not implement ${rpcMethod} `
        + "(rpc_methods is a static list compiled into the CLI, not a bridge probe): upgrade imsg";
    } else if (absent.length > 0) {
      verdict = Object.keys(caps.selectors).length === 0
        ? "bridge is up but reported no selectors (its status probe failed or predates selector reporting); "
          + "a background re-probe may heal this"
        : `selector(s) ${absent.join(", ")} ABSENT from the bridge's probe output: the dylib running inside `
          + "Messages.app predates this feature (0.13+ dylibs report every selector they know as explicit "
          + "true/false). Heals only via a real relaunch: quit Messages.app, then `imsg launch` — "
          + "launch alone silently no-ops while the old bridge still answers ping";
    } else {
      verdict = `selector(s) ${probedFalse.join(", ")} probed FALSE by the live bridge: the IMCore surface `
        + "is missing on this macOS; no relaunch or upgrade changes this";
    }
    return { checked, verdict };
  }

  /**
   * Fire-and-forget re-probe for capability-gated call sites that found the
   * cached answer false. The gated call itself still skips exactly as before
   * (no subprocess, no latency on its path) — the probe runs in the
   * background so the NEXT call sees a fresh answer. No-op when:
   * - the bridge is already up (a per-selector false, e.g. editSupported on
   *   macOS 26, is a real OS limit a re-probe cannot change) — UNLESS the
   *   caller passes `evenIfBridged`, for selectors whose absence means "the
   *   injected bridge predates the feature" rather than "the OS removed it":
   *   the rich-link selectors appear when Messages relaunches with a newer
   *   bridge dylib, an event the daemon survives with advanced_features true
   *   throughout — so without the opt-in this gate would return early
   *   forever and the cached selector snapshot could never heal,
   * - the startup retry loop still owns probing, or
   * - a probe ran within the last capabilityReprobeMinIntervalMs (keeps the
   *   degraded steady state at ≤1 subprocess per interval, not one per call).
   */
  private maybeReprobeCapabilities(options: { evenIfBridged?: boolean } = {}): void {
    if (this.stopping) return;
    if (this.capabilities.advancedFeatures && !options.evenIfBridged) return;
    if (this.capabilityRetryTimer) return;
    if (Date.now() - this.lastCapabilityProbeAt < this.capabilityReprobeMinIntervalMs) return;
    // No reservation needed before the async call: reprobeCapabilities sets
    // its single-flight guard synchronously, so same-tick gated calls that
    // also pass the rate check coalesce there, and the guard's finally block
    // re-anchors lastCapabilityProbeAt on completion.
    void this.reprobeCapabilities("on-demand");
  }

  /**
   * Re-run the capability probe and swap in the fresh snapshot. Single-flight:
   * concurrent callers coalesce into one subprocess. A probe FAILURE keeps the
   * cached snapshot — callers only re-probe while degraded, so there is
   * nothing to lose — and logs at debug (failures while degraded are expected
   * noise, and the actionable warning already fired once at startup). The only
   * non-debug output is one info line when the bridge transitions to
   * available, so a transient boot-order race that resolves itself resolves
   * without ever warning.
   */
  private async reprobeCapabilities(reason: string): Promise<void> {
    if (this.capabilityProbeInFlight || this.stopping) return;
    this.capabilityProbeInFlight = true;
    try {
      const caps = await this.probeCapabilitiesFn();
      // stop() may have run while the probe was in flight — a stopped channel
      // must not mutate its snapshot (or log an upgrade it can't honor).
      if (this.stopping) return;
      this.lastCapabilityProbeError = null;
      const hadBridge = this.capabilities.advancedFeatures;
      this.capabilities = caps;
      if (!hadBridge && caps.advancedFeatures) {
        log.info({
          reason,
          advancedFeatures: caps.advancedFeatures,
          typing: caps.typingIndicators,
          readReceipts: caps.readReceipts,
          editSupported: this.isEditSupported(),
        }, "imsg bridge is now available; capabilities upgraded");
      }
    } catch (err) {
      if (this.stopping) return;
      this.lastCapabilityProbeError = err;
      log.debug({ err, reason }, "imsg capability re-probe failed; keeping cached capabilities");
    } finally {
      this.capabilityProbeInFlight = false;
      if (!this.stopping) this.lastCapabilityProbeAt = Date.now();
    }
  }

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
