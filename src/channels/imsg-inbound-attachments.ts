import { readFile, stat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import type { IncomingMessage, MessageHandler, ImageAttachment, DocumentAttachment } from "./types.js";
import { formatImageMarker, formatStickerMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime, MAX_DOCUMENT_BYTES } from "./documentStore.js";
import { buildDocumentAttachment, buildImageAttachment } from "./attachments.js";
import {
  FALLBACK_MIME,
  MAX_FILE_BYTES,
  sanitizeAttachmentFilename,
  saveInboundFile,
  type SavedFileNotice,
} from "./fileStore.js";
import { log } from "../logger.js";
import {
  ChatDbAttachmentLookup,
  expandChatDbPath,
  TRANSFER_STATE_COMPLETE,
  TRANSFER_STATE_FAILED,
  type AttachmentLookup,
  type AttachmentRow,
} from "./imsg-attachment-lookup.js";
import { convertHeicImage, heicHasAlpha, looksLikeHeic, SIPS_TIMEOUT_MS, type HeicTargetFormat } from "./heic.js";
import type { ImsgChannelConfig } from "./imsg-channel-config.js";
import { DEFAULT_CHAT_DB_PATH } from "./imsg-rpc.js";

/**
 * Total wall-clock a single inbound message may spend converting HEIC
 * attachments. `loadAttachments` walks its attachments sequentially, so the
 * per-`sips` deadline alone bounds one child, not one message: ten hostile
 * HEICs would serialise into ten deadlines of inbound-FIFO stall. Images past
 * the budget are delivered in their original format and marked unconverted.
 */
export const MESSAGE_CONVERSION_BUDGET_MS = 60_000;

/**
 * Deferred attachments. Messages can surface a message row in chat.db before
 * the attachment file behind it has been written to disk (imsg reports it as
 * `missing: true`); observed landing minutes later on a multi-photo send.
 * Blocking the in-order inbound FIFO for that long is not an option, so the
 * message is delivered at once with a "still downloading" marker and the
 * missing files are re-checked in the background every
 * {@link DEFERRED_ATTACHMENT_POLL_INTERVAL_MS}, giving up (loudly) after
 * {@link DEFERRED_ATTACHMENT_TIMEOUT_MS}. Whatever lands is delivered as a
 * follow-up inbound message from the same sender and chat.
 */
export const DEFERRED_ATTACHMENT_POLL_INTERVAL_MS = 5_000;
export const DEFERRED_ATTACHMENT_TIMEOUT_MS = 180_000;
/**
 * Longest a follow-up hand-off may take (waiting for its FIFO turn plus each
 * handler's answer). Past it the handler counts as not-accepted for this poll
 * and is retried at the next one — but a call still running is never repeated.
 */
export const DEFERRED_FOLLOWUP_DISPATCH_TIMEOUT_MS = 30_000;
/** Longest shutdown waits for a deferred-attachment re-check already running. */
export const DEFERRED_CHECK_STOP_WAIT_MS = 10_000;
/** Bound on remembered finished deferred-attachment watches (replay dedupe). */
const DEFERRED_ATTACHMENT_DONE_MEMORY = 256;
/**
 * Most messages watched at once. Past it a message falls back to the plain
 * `[Sent …]` marker (no follow-up promised) with a warning — a flood of
 * never-landing attachments must not grow timers without bound.
 */
export const MAX_DEFERRED_ATTACHMENT_WATCHES = 32;

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

/**
 * One inbound message whose image/document attachments were not on disk yet
 * when it was delivered. `remaining` shrinks as files land; the watch ends
 * when it is empty or the deadline passes.
 */
interface DeferredAttachment {
  att: Record<string, unknown>;
  /** Position in the message's attachment list. */
  index: number;
  /** Size seen at the previous poll (size-stability fallback). */
  lastSize: number | null;
}

/**
 * Loaded attachments waiting to be accepted as one follow-up message.
 * Delivery is tracked PER HANDLER: a handler that accepted is never handed
 * the same follow-up again, and one whose call is still pending (it outlived
 * the dispatch deadline) is not called a second time while it runs.
 */
interface DeferredFollowUp {
  atts: Array<Record<string, unknown>>;
  message: IncomingMessage;
  acceptedBy: Set<MessageHandler>;
  inFlight: Map<MessageHandler, Promise<boolean>>;
  /** The queued FIFO link delivering it, while one is outstanding. */
  queued: Promise<void> | null;
}

interface DeferredAttachmentWatch {
  key: string;
  messageId: string;
  chatGuid: string;
  /** Every attachment on the original message, in imsg's order. */
  entries: DeferredAttachment[];
  /** The subset of `entries` still waiting for its file. */
  remaining: DeferredAttachment[];
  /** Loaded, not yet accepted by every handler; delivered in order. */
  undelivered: DeferredFollowUp[];
  /** Routing fields copied from the original message (sender, chat, group/mention state). */
  origin: Pick<IncomingMessage, "id" | "chatId" | "senderName" | "senderId" | "isGroup" | "isMentioned" | "chatTitle">;
  /** Short quote of the original text so the agent can tie the follow-up back to it. */
  excerpt: string;
  /** Next re-check. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Overall give-up, independent of any re-check that may be stuck awaiting. */
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Messages can put a small preview at an attachment's final path before the
 * full file lands. On 2026-11-11 two 7.5–8.9 MB PNGs were read as 235–335 KB
 * previews (240×169 and 320×225) because the file existed and was non-empty
 * when we first looked. A file shorter than the size imsg declares for it is
 * not the attachment yet, so the first pass defers it to the background watch
 * instead of reading it. The watch keeps its own completion test (chat.db
 * transfer_state, else a size that holds across polls): by its first poll the
 * swap is long done, and a declared size that is simply wrong then costs one
 * poll's delay rather than the image. A converted file is exempt, since its
 * size has no relation to the original's, and so is an attachment with no
 * declared size, which keeps the old behaviour.
 */
export function shortOfDeclaredSize(onDisk: { att: Record<string, unknown>; path: string; size: number }): boolean {
  if (typeof onDisk.att.converted_path === "string" && onDisk.path === onDisk.att.converted_path) return false;
  const declared = onDisk.att.total_bytes ?? onDisk.att.byte_size;
  return typeof declared === "number" && declared > 0 && onDisk.size < declared;
}

/** What {@link ImsgAttachmentIntake} needs from the channel that owns it. */
export interface ImsgAttachmentIntakeDeps {
  /** The channel's message handlers (the live array; follow-ups go to each). */
  readonly handlers: readonly MessageHandler[];
  /** True once ingestion has closed. */
  isStopping(): boolean;
  /** Append a link to the channel's watch FIFO (see ImsgRpcClient). */
  appendToWatchChain(build: (tail: Promise<void>) => Promise<void>): Promise<void>;
}

/**
 * Inbound attachment loading (HEIC conversion, the any-MIME file store) and
 * the deferred watch for attachments that land after their message.
 * Owned by {@link ImsgChannel}.
 */
export class ImsgAttachmentIntake {
  private readonly imageStoreBaseDir: string | undefined;
  private readonly fileStoreBaseDir: string | undefined;
  private readonly convertHeicFn: (srcPath: string, format: HeicTargetFormat, timeoutMs?: number) => Promise<string | null>;
  private readonly conversionBudgetMs: number;
  private readonly deferredAttachmentPollIntervalMs: number;
  private readonly deferredAttachmentTimeoutMs: number;
  private readonly maxDeferredAttachmentWatches: number;
  private readonly deferredFollowUpDispatchTimeoutMs: number;
  private readonly deferredCheckStopWaitMs: number;
  readonly attachmentLookup: AttachmentLookup;
  /** Active deferred-attachment watches, keyed by message GUID (or rowid). */
  private deferredWatches = new Map<string, DeferredAttachmentWatch>();
  /** Keys of finished watches (bounded), so a re-seen message never re-arms one. */
  private deferredWatchesDone = new Set<string>();
  /** Deferred-attachment checks currently running (awaited on shutdown). */
  private deferredChecksInFlight = new Set<Promise<void>>();
  /** The one bounded shutdown wait for in-flight checks (shared by quiesce and teardown). */
  private deferredSettle: Promise<void> | null = null;
  private readonly probeHeicAlphaFn: (srcPath: string, timeoutMs?: number) => Promise<boolean | null>;

  constructor(config: ImsgChannelConfig, private readonly deps: ImsgAttachmentIntakeDeps) {
    this.imageStoreBaseDir = config.imageStoreBaseDir;
    // No `?? config.imageStoreBaseDir` here. Undefined means OFF, full stop —
    // the `storage-disabled` notice path covers it, so the agent is still told
    // a file arrived. Inheriting the image setting is the config parser's job
    // (config.ts, `saveInboundFiles`), and doing it in two places meant
    // `saveInboundFiles: false` was silently overridden whenever
    // `saveInboundImages` stayed at its default of true.
    this.fileStoreBaseDir = config.fileStoreBaseDir;
    this.convertHeicFn = config.convertHeic ?? convertHeicImage;
    this.conversionBudgetMs = config.conversionBudgetMs ?? MESSAGE_CONVERSION_BUDGET_MS;
    this.deferredAttachmentPollIntervalMs = config.deferredAttachmentPollIntervalMs ?? DEFERRED_ATTACHMENT_POLL_INTERVAL_MS;
    this.deferredAttachmentTimeoutMs = config.deferredAttachmentTimeoutMs ?? DEFERRED_ATTACHMENT_TIMEOUT_MS;
    this.maxDeferredAttachmentWatches = config.maxDeferredAttachmentWatches ?? MAX_DEFERRED_ATTACHMENT_WATCHES;
    this.deferredFollowUpDispatchTimeoutMs = config.deferredFollowUpDispatchTimeoutMs ?? DEFERRED_FOLLOWUP_DISPATCH_TIMEOUT_MS;
    this.deferredCheckStopWaitMs = config.deferredCheckStopWaitMs ?? DEFERRED_CHECK_STOP_WAIT_MS;
    this.attachmentLookup = config.attachmentLookup ?? new ChatDbAttachmentLookup(config.dbPath ?? DEFAULT_CHAT_DB_PATH);
    this.probeHeicAlphaFn = config.probeHeicAlpha ?? heicHasAlpha;
  }

  /**
   * The `[Sent …]` markers for one message's images, stickers and documents.
   * `rawAttachments` is everything the row carried; `images`/`documents` are
   * what loaded; `deferred` is what was still downloading.
   */
  attachmentMarkers(
    rawAttachments: Array<Record<string, unknown>>,
    images: ImageAttachment[],
    documents: DocumentAttachment[],
    deferred: Array<Record<string, unknown>>,
  ): { stickerMarker: string; imageMarker: string; docMarker: string } {
    // Stickers are counted apart from plain images: chat.db marks them
    // (attachment.is_sticker, surfaced by imsg 0.13+) and a sticker described
    // as just "an image" buries the expressive act.
    const isImageAtt = (a: Record<string, unknown>) => this.attachmentMime(a).startsWith("image/");
    const isStickerAtt = (a: Record<string, unknown>) => isImageAtt(a) && a.is_sticker === true;
    const isPlainImageAtt = (a: Record<string, unknown>) => isImageAtt(a) && a.is_sticker !== true;
    const isDocAtt = (a: Record<string, unknown>) => isSupportedDocumentMime(this.attachmentMime(a));
    const intendedStickerCount = rawAttachments.filter(isStickerAtt).length;
    const intendedImageCount = rawAttachments.filter(isPlainImageAtt).length;
    const intendedDocumentCount = rawAttachments.filter(isDocAtt).length;

    const imageSavedPaths = images.filter((i) => !i.isSticker).map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const stickerSavedPaths = images.filter((i) => i.isSticker).map((i) => i.savedPath).filter((p): p is string => Boolean(p));
    const docSavedPaths = documents.map((d) => d.savedPath).filter((p): p is string => Boolean(p));
    // Counted over the same partition as intendedImageCount/intendedStickerCount
    // above — `image.isSticker` is set from the identical `att.is_sticker ===
    // true` predicate — so the note can never claim more unconverted
    // attachments than the marker says were sent. `images` is a subset of the
    // intended set (an attachment that failed to READ never makes it here), so
    // the counts are consistent by construction; formatImageMarker clamps
    // anyway rather than emit "[Sent an image; 2 attachments could not …]".
    const unconvertedImages = images.filter((i) => !i.isSticker && i.conversionFailed).length;
    const unconvertedStickers = images.filter((i) => i.isSticker && i.conversionFailed).length;
    return {
      stickerMarker: formatStickerMarker(intendedStickerCount, stickerSavedPaths, unconvertedStickers, deferred.filter(isStickerAtt).length),
      imageMarker: formatImageMarker(intendedImageCount, imageSavedPaths, unconvertedImages, deferred.filter(isPlainImageAtt).length),
      docMarker: formatDocumentMarker(intendedDocumentCount, docSavedPaths, deferred.filter(isDocAtt).length),
    };
  }

  // --- Deferred (still-downloading) attachments ---

  /**
   * What to do with a message's still-downloading attachments:
   * - `arm`: start a watch once the row is committed;
   * - `active`: a watch for this message already runs (re-seen row) — it will
   *   deliver, so the marker may still promise a follow-up, but no second
   *   watch is armed;
   * - `skip`: no follow-up will come (channel stopping, this message's watch
   *   already finished, or the watch cap is reached) — plain marker.
   */
  planDeferredAttachmentWatch(key: string, count: number): "arm" | "active" | "skip" {
    if (this.deps.isStopping()) return "skip";
    if (this.deferredWatches.has(key)) return "active";
    if (this.deferredWatchesDone.has(key)) return "skip";
    if (this.deferredWatches.size >= this.maxDeferredAttachmentWatches) {
      log.warn(
        { messageId: key, count, active: this.deferredWatches.size, max: this.maxDeferredAttachmentWatches },
        "Too many imsg messages with attachments still downloading; not watching this one — its missing attachments will not be delivered",
      );
      return "skip";
    }
    return "arm";
  }

  startDeferredAttachmentWatch(
    key: string,
    deferred: Array<Record<string, unknown>>,
    rawAttachments: Array<Record<string, unknown>>,
    original: IncomingMessage,
    originalText: string,
  ): void {
    // Dedupe lives in planDeferredAttachmentWatch (rows are serialized on the
    // watch FIFO, so nothing for this key can slip in between plan and arm).
    // Only shutdown can have changed since the dispatch await.
    if (this.deps.isStopping()) return;
    const trimmed = originalText.trim().replace(/\s+/g, " ");
    const entries: DeferredAttachment[] = rawAttachments.map((att, index) => ({ att, index, lastSize: null }));
    const watch: DeferredAttachmentWatch = {
      key,
      messageId: original.id,
      chatGuid: original.chatId,
      entries,
      remaining: entries.filter((e) => deferred.includes(e.att)),
      undelivered: [],
      origin: {
        id: original.id,
        chatId: original.chatId,
        senderName: original.senderName,
        senderId: original.senderId,
        isGroup: original.isGroup,
        isMentioned: original.isMentioned,
        chatTitle: original.chatTitle,
      },
      excerpt: trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed,
      timer: null,
      deadlineTimer: null,
    };
    this.deferredWatches.set(key, watch);
    log.info(
      {
        messageId: original.id,
        chatGuid: original.chatId,
        count: deferred.length,
        pollMs: this.deferredAttachmentPollIntervalMs,
        timeoutMs: this.deferredAttachmentTimeoutMs,
      },
      "imsg attachment(s) not on disk yet (still downloading); delivered the message now, will re-check in the background",
    );
    const pathless = deferred.filter((att) => !this.hasAttachmentPath(att)).length;
    if (pathless > 0) {
      log.warn(
        { messageId: original.id, count: pathless },
        "Deferred imsg attachment has no local path; re-querying chat.db for it on every re-check",
      );
    }
    // The give-up runs on its own timer, so a re-check stuck in an await
    // (a hung handler, a slow conversion) cannot postpone it.
    watch.deadlineTimer = setTimeout(() => this.giveUpDeferredWatch(watch), this.deferredAttachmentTimeoutMs);
    watch.deadlineTimer.unref?.();
    this.scheduleDeferredCheck(watch);
  }

  private isLiveWatch(watch: DeferredAttachmentWatch): boolean {
    return !this.deps.isStopping() && this.deferredWatches.get(watch.key) === watch;
  }

  private scheduleDeferredCheck(watch: DeferredAttachmentWatch): void {
    watch.timer = setTimeout(() => {
      watch.timer = null;
      // Off the inbound FIFO: stat, read and HEIC conversion of landed files
      // run here, concurrently with new rows. Only the follow-up dispatch is
      // queued on the FIFO (see deliverFollowUp). Tracked so quiesce() and
      // teardown() wait for it (bounded) rather than close things under it.
      const check = this.checkDeferredAttachments(watch).catch((err) => {
        log.error({ err, messageId: watch.messageId }, "Error re-checking deferred imsg attachments");
        this.finishDeferredWatch(watch);
      });
      this.deferredChecksInFlight.add(check);
      void check.finally(() => this.deferredChecksInFlight.delete(check));
    }, this.deferredAttachmentPollIntervalMs);
    watch.timer.unref?.();
  }

  /** Resolve true when `p` settles within `ms`, false when the deadline wins. */
  private async withDeadline(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([p.then(() => true, () => true), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait (bounded) for deferred-attachment checks already running. Shutdown
   * calls this from both quiesce() and teardown(); the wait (and its warning)
   * happens once per stop, not once per phase.
   */
  settleDeferredChecks(): Promise<void> {
    this.deferredSettle ??= this.settleDeferredChecksOnce();
    return this.deferredSettle;
  }

  private async settleDeferredChecksOnce(): Promise<void> {
    if (this.deferredChecksInFlight.size === 0) return;
    const settled = await this.withDeadline(
      (async () => {
        while (this.deferredChecksInFlight.size > 0) await Promise.allSettled([...this.deferredChecksInFlight]);
      })(),
      this.deferredCheckStopWaitMs,
    );
    if (!settled) {
      log.warn(
        { inFlight: this.deferredChecksInFlight.size, waitedMs: this.deferredCheckStopWaitMs },
        "Deferred imsg attachment re-check still running at shutdown; not waiting for it any longer",
      );
    }
  }

  /**
   * Bind each attachment of the message to its chat.db row, one-to-one.
   *
   * imsg's attachment objects carry no attachment GUID or rowid (verified on
   * imsg 0.15.8: filename, is_sticker, mime_type, missing, original_path,
   * total_bytes, transfer_name, uti), so there is no stable id to join on.
   * Instead:
   * 1. An attachment with a path binds to the row with that path. The path
   *    is chat.db's own `attachment.filename` (imsg's `filename` is that
   *    column verbatim), unique per attachment.
   * 2. Path-less attachments bind by transfer name AND ordinal: the k-th
   *    path-less attachment named N takes the k-th still-unbound row named N,
   *    rows in ROWID order. imsg lists a message's attachments in ROWID order
   *    (checked against multi-attachment messages in a live chat.db).
   * 3. Name-less ones bind by position, only when the row count matches.
   * Every row is consumed at most once, so two attachments with the same
   * name can never both read the same row.
   */
  private bindAttachmentRows(watch: DeferredAttachmentWatch, rows: AttachmentRow[]): Map<DeferredAttachment, AttachmentRow> {
    const bound = new Map<DeferredAttachment, AttachmentRow>();
    const used = new Set<AttachmentRow>();
    for (const entry of watch.entries) {
      const paths = this.chatDbPathsOf(entry.att);
      if (paths.length === 0) continue;
      const row = rows.find((r) => !used.has(r) && r.path !== "" && paths.includes(r.path));
      if (row) {
        bound.set(entry, row);
        used.add(row);
      }
    }
    for (const entry of watch.entries) {
      if (bound.has(entry) || this.attachmentPath(entry.att)) continue;
      const name = typeof entry.att.transfer_name === "string" ? entry.att.transfer_name : "";
      if (!name) continue;
      const row = rows.find((r) => !used.has(r) && r.transferName === name);
      if (row) {
        bound.set(entry, row);
        used.add(row);
      }
    }
    if (rows.length === watch.entries.length) {
      for (const entry of watch.entries) {
        if (bound.has(entry) || this.attachmentPath(entry.att)) continue;
        const row = rows[entry.index];
        if (row && !used.has(row)) {
          bound.set(entry, row);
          used.add(row);
        }
      }
    }
    return bound;
  }

  /**
   * The paths an attachment may appear under in chat.db's
   * `attachment.filename`: imsg's `filename` (that column verbatim, `~/`
   * form) and the original path. Not the converted path — that is imsg's
   * cache, not chat.db's.
   */
  private chatDbPathsOf(att: Record<string, unknown>): string[] {
    const out: string[] = [];
    if (typeof att.filename === "string" && att.filename.includes("/")) out.push(expandChatDbPath(att.filename));
    if (typeof att.original_path === "string" && att.original_path) out.push(att.original_path);
    if (typeof att.path === "string" && att.path) out.push(att.path);
    return out;
  }

  private async checkDeferredAttachments(watch: DeferredAttachmentWatch): Promise<void> {
    if (!this.isLiveWatch(watch)) return;

    // When is a file done? Primary signal: chat.db `transfer_state` says the
    // transfer completed AND the file is on disk and non-empty. Fallback, only
    // when chat.db has no usable row (unreadable, or the row can't be bound):
    // the size is non-zero and identical on two consecutive polls. The
    // fallback is weaker — a preallocated or paused write also holds its
    // size — which is why it is not the first choice.
    const rows = this.attachmentLookup.attachmentsForMessage(watch.messageId);
    const bound = this.bindAttachmentRows(watch, rows);
    const ready: DeferredAttachment[] = [];
    const transferFailed: DeferredAttachment[] = [];
    for (const pending of watch.remaining) {
      // A stop mid-check must not keep probing the disk or chat.db.
      if (this.deps.isStopping()) return;
      const row = bound.get(pending);
      if (row?.path && !this.hasAttachmentPath(pending.att)) {
        log.info({ messageId: watch.messageId, path: row.path }, "Deferred imsg attachment path resolved from chat.db");
        pending.att = { ...pending.att, original_path: row.path };
      }
      const onDisk = await this.resolveOnDiskAttachment(pending.att);
      const size = onDisk && !onDisk.empty ? onDisk.size : null;
      const state = row?.transferState ?? null;
      if (state !== null) {
        if (state === TRANSFER_STATE_FAILED) transferFailed.push(pending);
        else if (state === TRANSFER_STATE_COMPLETE && size !== null) ready.push(pending);
      } else if (size !== null && size === pending.lastSize) {
        ready.push(pending);
      }
      pending.lastSize = size;
    }
    if (!this.isLiveWatch(watch)) return;

    if (transferFailed.length > 0) {
      watch.remaining = watch.remaining.filter((p) => !transferFailed.includes(p));
      log.warn(
        { messageId: watch.messageId, chatGuid: watch.chatGuid, count: transferFailed.length },
        "imsg attachment transfer failed (chat.db transfer_state); no longer waiting for it",
      );
    }

    if (ready.length > 0) {
      const readyAtts = ready.map((p) => p.att);
      const { images, documents, deferred, failed } = await this.loadAttachments(readyAtts, watch.chatGuid, { recheck: true });
      if (!this.isLiveWatch(watch)) return;
      // Anything that vanished again or failed to read stays pending (and is
      // retried at the next poll) until the deadline — never counted as done.
      const retry = new Set([...deferred, ...failed]);
      const arrived = readyAtts.filter((att) => !retry.has(att));
      watch.remaining = watch.remaining.filter((p) => !arrived.includes(p.att));
      if (arrived.length > 0) watch.undelivered.push(this.buildFollowUp(watch, arrived, images, documents));
    }

    // Deliver in order. One not fully accepted stays queued (and blocks the
    // ones after it, preserving order) for the next poll.
    while (watch.undelivered.length > 0) {
      if (!this.isLiveWatch(watch)) return;
      if (!await this.deliverFollowUp(watch, watch.undelivered[0])) break;
      watch.undelivered.shift();
    }
    if (!this.isLiveWatch(watch)) return;

    if (watch.remaining.length === 0 && watch.undelivered.length === 0) {
      log.info({ messageId: watch.messageId, chatGuid: watch.chatGuid }, "Deferred imsg attachment watch finished");
      this.finishDeferredWatch(watch);
      return;
    }
    this.scheduleDeferredCheck(watch);
  }

  private giveUpDeferredWatch(watch: DeferredAttachmentWatch): void {
    watch.deadlineTimer = null;
    if (this.deferredWatches.get(watch.key) !== watch) return;
    // A follow-up every handler accepted has been delivered (the check just
    // hasn't finished the watch yet) — nothing is lost, so no warning. Of the
    // rest, one still inside a handler can't be recalled any more; it is
    // reported apart from the ones never handed over.
    const unaccepted = watch.undelivered.filter((f) => !this.deps.handlers.every((h) => f.acceptedBy.has(h)));
    const handOffPending = unaccepted.filter((f) => f.inFlight.size > 0).reduce((n, f) => n + f.atts.length, 0);
    const undelivered = unaccepted.filter((f) => f.inFlight.size === 0).reduce((n, f) => n + f.atts.length, 0);
    if (watch.remaining.length === 0 && unaccepted.length === 0) {
      log.info({ messageId: watch.messageId }, "Deferred imsg attachment watch reached its deadline after delivery completed");
      this.finishDeferredWatch(watch);
      return;
    }
    log.warn(
      {
        messageId: watch.messageId,
        chatGuid: watch.chatGuid,
        count: watch.remaining.length + undelivered + handOffPending,
        neverArrived: watch.remaining.length,
        undelivered,
        handOffPending,
        timeoutMs: this.deferredAttachmentTimeoutMs,
      },
      "imsg attachment(s) never finished downloading or could not be delivered; giving up — the agent was told they were still downloading and will not receive them",
    );
    this.finishDeferredWatch(watch);
  }

  /**
   * Build the follow-up for attachments that finished downloading. It is
   * routed exactly like the original: same chat, same sender, same
   * group/mention state, and the ORIGINAL message id — so a threaded reply or
   * a tapback lands on the message the photos actually belong to.
   */
  private buildFollowUp(
    watch: DeferredAttachmentWatch,
    atts: Array<Record<string, unknown>>,
    images: ImageAttachment[],
    documents: DocumentAttachment[],
  ): DeferredFollowUp {
    const { stickerMarker, imageMarker, docMarker } = this.attachmentMarkers(atts, images, documents, []);
    const quote = watch.excerpt ? ` ("${watch.excerpt}")` : "";
    const header = `[Attachments from an earlier message${quote} finished downloading]`;
    const text = [header, stickerMarker, imageMarker, docMarker].filter(Boolean).join(" ");
    return {
      atts,
      message: {
        ...watch.origin,
        text,
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
        timestamp: Date.now(),
      },
      acceptedBy: new Set(),
      inFlight: new Map(),
      queued: null,
    };
  }

  /**
   * Hand a follow-up to every handler that has not accepted it yet. Queued on
   * the inbound FIFO (ordered with live rows; `quiesce()` waits for it) and
   * bounded by {@link DEFERRED_FOLLOWUP_DISPATCH_TIMEOUT_MS} at every step,
   * so a hung handler costs one poll, not the watch. Resolves true once every
   * handler has accepted.
   *
   * Unlike a watch row, a follow-up is retried per handler: re-running the
   * whole dispatch after one handler accepted and another failed would hand
   * the first a duplicate. A handler that THREW is retried (the same
   * at-least-once contract a failed row gets on replay); one that accepted
   * never is; one whose call is still running is not called again.
   */
  private async deliverFollowUp(watch: DeferredAttachmentWatch, followUp: DeferredFollowUp): Promise<boolean> {
    if (!followUp.queued) {
      const link: Promise<void> = this.deps.appendToWatchChain((tail) => tail
        .then(() => this.runFollowUpHandlers(watch, followUp))
        .catch((err) => { log.error({ err, messageId: watch.messageId }, "Failed to deliver deferred imsg attachments"); })
        .finally(() => { if (followUp.queued === link) followUp.queued = null; }));
      followUp.queued = link;
    }
    await this.withDeadline(followUp.queued, this.deferredFollowUpDispatchTimeoutMs);
    const done = this.deps.handlers.every((h) => followUp.acceptedBy.has(h));
    if (done) {
      log.info(
        { messageId: watch.messageId, chatGuid: watch.chatGuid, count: followUp.atts.length, stillPending: watch.remaining.length },
        "Delivered deferred imsg attachment(s) as a follow-up message",
      );
    } else {
      log.warn(
        { messageId: watch.messageId, count: followUp.atts.length, accepted: followUp.acceptedBy.size, handlers: this.deps.handlers.length },
        "Deferred imsg attachment follow-up not accepted by every handler; will retry until the watch times out",
      );
    }
    return done;
  }

  private async runFollowUpHandlers(watch: DeferredAttachmentWatch, followUp: DeferredFollowUp): Promise<void> {
    // The link may have waited on the FIFO past the give-up (or a stop):
    // the agent-facing warning already said these would not arrive, so they
    // must not arrive now.
    if (!this.isLiveWatch(watch)) return;
    const calls = this.deps.handlers.filter((h) => !followUp.acceptedBy.has(h)).map((handler) => {
      let call = followUp.inFlight.get(handler);
      if (!call) {
        const started: Promise<boolean> = Promise.resolve()
          .then(() => handler(followUp.message))
          .then(
            (accepted) => {
              // Recorded even when it lands after the deadline, so the retry
              // never re-sends to a handler that did take it.
              if (accepted) followUp.acceptedBy.add(handler);
              return accepted;
            },
            (err) => {
              log.error({ err, messageId: watch.messageId }, "Deferred imsg attachment follow-up handler threw");
              return false;
            },
          )
          .finally(() => { if (followUp.inFlight.get(handler) === started) followUp.inFlight.delete(handler); });
        followUp.inFlight.set(handler, started);
        call = started;
      }
      return this.withDeadline(call, this.deferredFollowUpDispatchTimeoutMs);
    });
    await Promise.all(calls);
  }

  private finishDeferredWatch(watch: DeferredAttachmentWatch): void {
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
    if (watch.deadlineTimer) {
      clearTimeout(watch.deadlineTimer);
      watch.deadlineTimer = null;
    }
    if (this.deferredWatches.get(watch.key) === watch) this.deferredWatches.delete(watch.key);
    this.deferredWatchesDone.add(watch.key);
    if (this.deferredWatchesDone.size > DEFERRED_ATTACHMENT_DONE_MEMORY) {
      const oldest = this.deferredWatchesDone.values().next().value;
      if (oldest !== undefined) this.deferredWatchesDone.delete(oldest);
    }
  }

  /**
   * Stop every deferred-attachment watch (channel shutdown or restart). The
   * watches are in memory only and nothing replays them, so the attachments
   * still pending are lost for good — say so, per message.
   */
  cancelDeferredAttachmentWatches(): void {
    if (this.deferredWatches.size === 0) return;
    const abandoned = [...this.deferredWatches.values()].map((watch) => {
      if (watch.timer) clearTimeout(watch.timer);
      if (watch.deadlineTimer) clearTimeout(watch.deadlineTimer);
      watch.timer = null;
      watch.deadlineTimer = null;
      return {
        messageId: watch.messageId,
        count: watch.remaining.length + watch.undelivered.reduce((n, f) => n + f.atts.length, 0),
      };
    });
    log.warn(
      { watches: abandoned },
      "imsg channel stopping with attachments still downloading; they will not be delivered",
    );
    this.deferredWatches.clear();
  }

  /** Number of active deferred-attachment watches. Test/diagnostic seam. */
  get pendingDeferredAttachmentWatches(): number {
    return this.deferredWatches.size;
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

  /**
   * `recheck` is the deferred-attachment watch re-loading files it has already
   * seen land and hold a stable size; imsg's stale `missing` flag is ignored
   * then (the disk has been checked twice since).
   */
  async loadAttachments(
    attachments: Array<Record<string, unknown>>,
    chatGuid: string,
    options: { recheck?: boolean } = {},
  ): Promise<{
    images: ImageAttachment[];
    documents: DocumentAttachment[];
    files: SavedFileNotice[];
    /** Image/document attachments whose file is not on disk yet (still downloading). */
    deferred: Array<Record<string, unknown>>;
    /** Image/document attachments whose read/store threw. */
    failed: Array<Record<string, unknown>>;
  }> {
    const images: ImageAttachment[] = [];
    const documents: DocumentAttachment[] = [];
    const files: SavedFileNotice[] = [];
    const deferred: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];

    // Per-`sips` deadlines bound one conversion; this bounds the MESSAGE. The
    // loop below is sequential, so ten hostile HEICs in one iMessage would
    // otherwise stall the inbound FIFO for ten times the per-child deadline —
    // the same denial of service, just requiring an attachment picker instead
    // of a single crafted file. Once the budget is gone the remaining images
    // skip conversion outright and are marked unconverted.
    const conversionDeadline = Date.now() + this.conversionBudgetMs;

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
      // nothing to put in the context. But "no bytes YET" is not "no bytes":
      // Messages can hand us the message row before the attachment file has
      // been written (imsg reports `missing: true`). Skipping it here used to
      // lose the photo for good — the marker said "[Sent 7 images]" with
      // nothing behind it and nothing ever looked again. Defer it instead;
      // the caller re-checks in the background and delivers a follow-up.
      //
      // `missing: true` defers even when a file is already there: imsg looked
      // a moment ago and found nothing, so what is on disk now may be half
      // written. The watch only takes it once its size holds across two
      // polls. A zero-byte file is never treated as landed.
      const onDisk = await this.resolveOnDiskAttachment(att);
      if (!onDisk || onDisk.empty || (att.missing === true && !options.recheck) || (!options.recheck && shortOfDeclaredSize(onDisk))) {
        deferred.push(att);
        continue;
      }
      const filePath = onDisk.path;
      const loadMime = this.attachmentMime(onDisk.att) || mimeType;

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
          const { buffer: imageBuffer, mimeType: imageMime, conversionFailed } = await this.normalizeHeicImage(buffer, loadMime, filePath, isSticker, conversionDeadline);
          const image = await buildImageAttachment(imageBuffer, imageMime, meta, this.imageStoreBaseDir);
          if (isSticker) image.isSticker = true;
          if (conversionFailed) image.conversionFailed = true;
          images.push(image);
        } else {
          const filename = (typeof att.transfer_name === "string" && att.transfer_name) || basename(filePath);
          documents.push(await buildDocumentAttachment(buffer, loadMime, { ...meta, filename }, this.imageStoreBaseDir));
        }
      } catch (err) {
        log.error({ err, path: filePath }, "Failed to read imsg attachment");
        failed.push(att);
      }
    }

    return { images, documents, files, deferred, failed };
  }

  /**
   * Locate an attachment's file on disk, or `null` when it is not there yet.
   *
   * Prefers imsg's converted copy; when only the original exists, returns the
   * attachment with the `converted_*` fields stripped so the MIME matches the
   * bytes actually read. `missing: true` is imsg's own "not on disk" verdict,
   * but it was taken when the row was read — the file may have landed since,
   * so the disk is always the authority. (The declared `total_bytes` is NOT
   * compared against the on-disk size: it describes the sender's original and
   * need not match the stored copy, so gating on it could defer forever.)
   */
  private async resolveOnDiskAttachment(
    att: Record<string, unknown>,
  ): Promise<{ att: Record<string, unknown>; path: string; size: number; empty: boolean } | null> {
    const converted = typeof att.converted_path === "string" ? att.converted_path : "";
    const convertedStat = converted ? await this.fileStat(converted) : null;
    if (convertedStat) return { att, path: converted, ...convertedStat };

    const original = (typeof att.original_path === "string" && att.original_path)
      || (typeof att.path === "string" && att.path)
      || "";
    if (!original) return null;
    const originalStat = await this.fileStat(original);
    if (!originalStat) return null;
    if (!converted) return { att, path: original, ...originalStat };
    const rest = { ...att };
    delete rest.converted_path;
    delete rest.converted_mime_type;
    return { att: rest, path: original, ...originalStat };
  }

  /**
   * Size of a path, or null when absent. `empty` flags a zero-byte REGULAR
   * file — the shape of an attachment Messages has created but not written
   * yet. (Non-regular files report size 0 without meaning that.)
   */
  private async fileStat(path: string): Promise<{ size: number; empty: boolean } | null> {
    try {
      const st = await stat(path);
      return { size: st.size, empty: st.isFile() && st.size === 0 };
    } catch {
      return null;
    }
  }

  /** True when the attachment row carries any local path at all. */
  private hasAttachmentPath(att: Record<string, unknown>): boolean {
    return ["converted_path", "original_path", "path"].some((k) => typeof att[k] === "string" && att[k] !== "");
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
    conversionDeadline = Date.now() + this.conversionBudgetMs,
  ): Promise<{ buffer: Buffer; mimeType: string; conversionFailed?: boolean }> {
    if (!looksLikeHeic(mimeType, filePath, buffer)) return { buffer, mimeType };

    // Whatever is left of the message-wide budget, capped at the per-child
    // deadline. Exhausted means: do not spawn at all — an earlier attachment
    // has already spent the time this message was allowed to take.
    const remainingMs = conversionDeadline - Date.now();
    if (remainingMs <= 0) {
      log.error(
        { path: filePath, budgetMs: this.conversionBudgetMs },
        "Per-message HEIC conversion budget exhausted; delivering the original bytes unconverted",
      );
      return { buffer, mimeType, conversionFailed: true };
    }
    const timeoutMs = Math.min(SIPS_TIMEOUT_MS, remainingMs);

    let format: HeicTargetFormat;
    if (isSticker) {
      format = "png";
    } else {
      const alpha = await this.probeHeicAlphaFn(filePath, timeoutMs).catch(() => null);
      format = alpha === true ? "png" : "jpeg";
    }

    const outPath = await this.convertHeicFn(filePath, format, Math.max(0, conversionDeadline - Date.now())).catch((err) => {
      log.error({ err, path: filePath, format }, "HEIC conversion threw; keeping original attachment");
      return null;
    });
    // `conversionFailed` covers every way this can go wrong — sips missing, a
    // non-zero exit, a throw, and (the case this flag was added for) a sips
    // that hung and was killed at its deadline. In all of them the agent gets
    // HEIC bytes it cannot display, so it is told so.
    if (!outPath) return { buffer, mimeType, conversionFailed: true };

    try {
      const converted = await readFile(outPath);
      return { buffer: converted, mimeType: format === "png" ? "image/png" : "image/jpeg" };
    } catch (err) {
      log.error({ err, path: filePath, outPath }, "Failed to read converted image; keeping original attachment");
      return { buffer, mimeType, conversionFailed: true };
    } finally {
      await unlink(outPath).catch(() => undefined);
    }
  }
}
