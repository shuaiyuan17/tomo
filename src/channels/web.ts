import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import { ownerBindings, ownerSessionKey, OWNER_CHANNELS, type OwnerConfig } from "../owner.js";
import type { Channel, CommandHandler, IncomingMessage, MessageHandler, MessageReaction, OutgoingMessage } from "./types.js";
import { markDefiniteFailure } from "./types.js";
import { watchBus, type WatchBus } from "../watch/bus.js";
import type { WatchEvent, WatchTask } from "../watch/protocol.js";
import type { SdkSignal } from "../agent/sdk-signals.js";
import { isGroupSessionKey, legacySessionKeysForBinding } from "../sessions/keys.js";
import { webSessionId } from "../web/owner.js";
import { WebEvents } from "../web/events.js";
import { MAX_SNAPSHOT_TASK_BYTES, TaskBoard } from "../web/tasks.js";
import { redactCommand } from "../web/redact-command.js";
import { selectOwnerSessionKey } from "../web/data.js";
import { OutgoingMediaError, type OutgoingMediaStore } from "../web/outgoing-media.js";
import { claimUploads, recoverClaims } from "../web/uploads.js";
import { buildImageAttachment } from "./attachments.js";
import { formatImageMarker } from "./imageStore.js";
import { FALLBACK_MIME, formatFileMarker, sanitizeAttachmentFilename, saveInboundFile, type SavedFileNotice } from "./fileStore.js";
import type { ImageAttachment } from "./types.js";
import type { JournalEntry, Resolution, WebRequestJournal } from "../web/request-journal.js";
import type { ModelSwitchOutcome, ModelSwitchRefusal } from "../agent/model-switch.js";
import type { WebHome, WebModelChangeResult, WebModelView } from "../web/protocol.js";
import { modelLabel } from "../models.js";
import { formatReactionMarker, formatReplyContextMarker, neutralizeInboundBody } from "./text-utils.js";
import { MAX_BUFFER_BYTES, messageInputSchema, WEB_CHAT_ID, WEB_REACTIONS, WEB_REQUEST_QUOTE_LIMIT, WebError, type WebReaction, type WebReply, type MessageInput, type TaskOutput, type WebCompaction, type WebCompactResult, type WebCompactState, type WebEvent, type WebRateLimit, type TaskAction, type WebStopResult, type WebTaskActionResult, type WebTurnStatus, type WebUsage, type WebRequest, type WebTaskAccess, type WebFiledFile } from "../web/protocol.js";

/** A running tool's progress reaches the browser at most this often; the page counts in between. */
export const TOOL_PROGRESS_EVERY_MS = 10_000;
/** A shell task's full command is served up to this many characters. */
const COMMAND_LIMIT = 16_000;
/** Task types whose output tail the SDK serves (`get_task_output`). */
const OUTPUT_TASK_TYPES = new Set(["local_bash", "monitor"]);
/** A subagent whose transcript names no model yet is looked up again after these delays, then given up. */
export const MODEL_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
/** How often the owner-key rule is re-read while owner tasks are shown. */
export const OWNER_KEY_CHECK_MS = 1_000;
/** Interrupted requests the owner has not dealt with; past this, new browser
 *  messages are refused (503 interrupted_backlog) rather than dropping any. */
export const MAX_INTERRUPTED_BACKLOG = 64;
/** Snapshot bytes left for reply blocks and pending request text after the receipts envelope and the task panel. */
const SNAPSHOT_MAILBOX_BYTES = MAX_BUFFER_BYTES - 64 * 1024 - MAX_SNAPSHOT_TASK_BYTES;
/** Tomo's reactions on web messages kept (and shipped in the snapshot): the most recent ones. */
export const MAX_WEB_REACTIONS = 256;

export interface WebLifecycle { start(): Promise<void>; stop(): Promise<void> }
/** The daemon side of Tomo's home (src/home/service.ts) as the browser reaches it. */
export interface WebHomeAccess {
  view(): WebHome;
  /** A picture from an open Home page; re-validated there. */
  snapshot(input: unknown): { accepted: boolean };
}
/** The agent side of the Study's Model page (see Agent.webModelView / switchModelFromWeb). */
export interface WebModelAccess {
  view(key: string): Omit<WebModelView, "sessionId" | "writable">;
  switch(key: string, model: string, from: string): ModelSwitchOutcome;
}
/** HTTP status of each refused model switch; the reason is the error code. */
const MODEL_REFUSAL_STATUS: Record<ModelSwitchRefusal, number> = {
  unknown_model: 422, gateway_required: 422, gateway_unroutable: 422,
  model_changed: 409, turn_in_flight: 409, persist_failed: 503,
};
interface Receipt { digest: string; request: WebRequest; settled: boolean }
/** Snapshot bytes a request holds while its text is kept: the text and what it replied to. */
const heldBytes = (request: { text?: string; reply?: WebReply }) =>
  (request.text !== undefined ? Buffer.byteLength(JSON.stringify(request.text)) : 0)
  + (request.reply ? Buffer.byteLength(JSON.stringify(request.reply)) : 0);
/** A reply's quote as a request keeps it: enough for the pending bubble's two lines. */
const keptReply = (reply: WebReply): WebReply => {
  const points = Array.from(reply.text);
  return { ...reply, text: points.length > WEB_REQUEST_QUOTE_LIMIT ? `${points.slice(0, WEB_REQUEST_QUOTE_LIMIT).join("")}…` : reply.text };
};

/** A real channel: only Agent's registered MessageHandler accepts input, and
 * only the existing delivery pipeline calls send. HTTP is an optional peer. */
/**
 * Typed text never reads as a leading `[Sent an image, saved to: …]` marker
 * (only the server writes those, for real uploads): a leading "[" gets a
 * zero-width space in front, which the marker reader does not skip.
 */
export function neutralizeMarker(text: string): string {
  return text.startsWith("[") ? `\u200b${text}` : text;
}

export class WebChannel implements Channel {
  readonly name = "web";
  readonly events = new WebEvents();
  readonly ownerId: string | null;
  private owner: OwnerConfig | undefined;
  private handler: MessageHandler | undefined;
  private lifecycle: WebLifecycle | undefined;
  private closed = false;
  private tornDown = false;
  private unsubscribe: (() => void) | undefined;
  private handoffs = new Set<Promise<boolean>>();
  private receipts = new Map<string, Receipt>();
  private blocks: Extract<WebEvent, { type: "block" }>[] = [];
  private blockBytes = 0;
  /** Recent compactions per browser session, for the Study's context view. */
  private compactions = new Map<string, WebCompaction[]>();
  private readonly usageReader: ((refresh: boolean) => Promise<WebUsage>) | undefined;
  private readonly taskModel: ((sessionKey: string, taskId: string) => Promise<string | undefined>) | undefined;
  /** Model lookups in progress (or given up), per key and task. */
  private modelLookups = new Map<string, { key: string; taskId: string; runId: string | undefined; attempt: number; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly now: () => number;
  private readonly outgoing: OutgoingMediaStore | undefined;
  private readonly uploads: { dir: string; workspaceDir: string | undefined; fileDir?: string | undefined } | undefined;
  /** Request ids being admitted right now (between the duplicate check and the receipt). */
  private readonly inFlight = new Set<string>();
  private readonly compact: ((sessionKey: string, onSettled: (outcome: "done" | "unverified" | "failed") => void) => "queued" | "already_requested" | "no_owner") | undefined;
  private compactState: WebCompactState | undefined;
  private readonly stopTurn: ((sessionKey: string) => Promise<boolean>) | undefined;
  private rateLimit: WebRateLimit | undefined;
  /** The SDK's standing prompt suggestion per browser session. */
  private suggestions = new Map<string, string>();
  /** Tomo's reaction on each of the owner's web messages it reacted to, oldest first (see reactToMessage). */
  private reactions = new Map<string, WebReaction>();
  /** Where they are kept across restarts; undefined: in memory only (no path, or the file was unreadable). */
  private reactionsPath: string | undefined;
  /** When a tool's progress was last sent to the browser, by tool_use id. */
  private toolProgressAt = new Map<string, number>();
  private readonly toolCommand: ((sessionKey: string, toolUseId: string) => string | undefined) | undefined;
  private readonly taskControl: { stop: (sessionKey: string, taskId: string) => Promise<boolean>; background: (sessionKey: string, toolUseId: string) => Promise<boolean> } | undefined;
  private readonly taskOutput: ((sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>) | undefined;
  private readonly models: WebModelAccess | undefined;
  private readonly sessionKeys: (() => readonly string[]) | undefined;
  private readonly homeAccess: WebHomeAccess | undefined;
  /** Live and recently ended subagents/background tasks, per visible session. */
  readonly tasks: TaskBoard;

  /** The DM key the web catalog shows as the owner conversation (data.ts rule). */
  private readonly ownerKey: () => string | undefined;
  /** Re-checks the owner-key rule while the owner's board entry is filled. */
  private ownerKeyTimer: ReturnType<typeof setInterval> | undefined;
  /** Text of accepted requests not yet settled, and of interrupted ones the
   *  owner has not dealt with: shown as pending bubbles in the snapshot. */
  private pendingTextBytes = 0;
  private readonly journal: WebRequestJournal | undefined;
  /** Requests the previous run accepted and never settled (see request-journal.ts). */
  readonly interruptedAtStart: JournalEntry[] = [];
  /** Interrupted requests whose owner notice is not yet recorded as given (any earlier run). */
  readonly unnotifiedAtStart: JournalEntry[] = [];
  /** The journal could not be read: no new custody until it can (fail closed). */
  private journalUnavailable = false;

  constructor(owner: OwnerConfig | undefined, private readonly bus: WatchBus = watchBus,
    options: { now?: () => number; ownerKey?: () => string | undefined;
      /** Reads a shell/Monitor task's output tail from the live session of `sessionKey`. */
      taskOutput?: (sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>;
      /** A Bash tool call's full command from the live session, by tool_use id. */
      toolCommand?: (sessionKey: string, toolUseId: string) => string | undefined;
      /** Stop one task, or move the foreground task a tool call started to the background. */
      taskControl?: { stop: (sessionKey: string, taskId: string) => Promise<boolean>; background: (sessionKey: string, toolUseId: string) => Promise<boolean> };
      /** Queue an owner-requested compact of the given (owner) session; the agent runs it and reports back. */
      compact?: (sessionKey: string, onSettled: (outcome: "done" | "unverified" | "failed") => void) => "queued" | "already_requested" | "no_owner";
      /** Reads a subagent's model from its transcript (the SDK's task events carry none). */
      taskModel?: (sessionKey: string, taskId: string) => Promise<string | undefined>;
      /** Where pictures the agent sends are copied, so the browser can show them by id. */
      outgoingMedia?: OutgoingMediaStore;
      /** Staged browser uploads (`uploadsDir`), the workspace whose inbound image store files them,
       *  and the one whose inbound file store files other files (absent: saveInboundFiles is off). */
      uploads?: { dir: string; workspaceDir: string | undefined; fileDir?: string | undefined };
      /** Durable receipts; loaded here, before any request is accepted. */
      journal?: WebRequestJournal;
      /** Soft-stops the running turn of `sessionKey`; false when nothing was running. */
      stop?: (sessionKey: string) => Promise<boolean>;
      /** Claude subscription usage for the Plan usage card (cached, debounced). */
      usage?: (refresh: boolean) => Promise<WebUsage>;
      /** The Study's Model page: a session key's model, and the agent's shared model switch. */
      models?: WebModelAccess;
      /** Every key in the session registry: where a group's browser session id is looked up. */
      sessionKeys?: () => readonly string[];
      /** Tomo's home (scene, status, snapshots); absent: the Home page has nothing to show (503). */
      home?: WebHomeAccess;
      /** Where Tomo's reactions on web messages are kept (JSON); absent: in memory only. */
      reactionsPath?: string } = {}) {
    this.homeAccess = options.home;
    this.models = options.models;
    this.sessionKeys = options.sessionKeys;
    this.usageReader = options.usage;
    this.stopTurn = options.stop;
    this.taskOutput = options.taskOutput;
    this.toolCommand = options.toolCommand;
    this.taskControl = options.taskControl;
    this.compact = options.compact;
    this.taskModel = options.taskModel;
    this.outgoing = options.outgoingMedia;
    this.uploads = options.uploads;
    const now = options.now ?? Date.now;
    this.now = now;
    // Without registry access the catalog would pick the canonical key.
    this.ownerKey = options.ownerKey ?? (() => selectOwnerSessionKey(owner, []));
    this.tasks = new TaskBoard((sessionId, tasks) => {
      try { this.events.publish({ type: "tasks", sessionId, tasks }); } catch { /* An oversized panel update never fails the Agent. */ }
    }, { now, router: () => this.taskRouter() });
    this.owner = owner;
    this.ownerId = this.owner ? webSessionId(ownerSessionKey(this.owner)) : null;
    this.unsubscribe = this.bus.subscribe((event) => this.observe(event));
    this.journal = options.journal;
    if (this.journal) this.restore(this.journal);
    if (options.reactionsPath) this.loadReactions(options.reactionsPath);
    // Uploads claimed when the last run stopped: recorded ones go, the rest return to staging.
    if (this.uploads) recoverClaims(this.uploads.dir, (requestId) => this.receipts.has(requestId));
  }
  /** Previous run's receipts: settled, deduplicated by id, never re-run. */
  private restore(journal: WebRequestJournal): void {
    let loaded;
    // Unreadable: refuse new requests rather than accept them over an empty
    // state (which could re-run a resent id, or later overwrite the file).
    try { loaded = journal.load(); } catch { this.journalUnavailable = true; return; }
    for (const entry of loaded.entries) {
      const request: WebRequest = { requestId: entry.requestId, state: entry.state, timestamp: entry.timestamp,
        ...(this.ownerId ? { sessionId: this.ownerId } : {}), ...(entry.text !== undefined ? { text: entry.text } : {}),
        ...(entry.images?.length ? { images: entry.images } : {}),
        ...(entry.files?.length ? { files: entry.files } : {}),
        ...(entry.reply ? { reply: entry.reply } : {}),
        // History: a request whose turn completed was read, whatever the last run saw.
        ...(entry.state === "completed" ? { read: true } : {}) };
      if (entry.text !== undefined) this.pendingTextBytes += heldBytes(request);
      this.receipts.set(entry.requestId, { digest: entry.digest, request, settled: true });
    }
    this.interruptedAtStart.push(...loaded.interrupted);
    this.unnotifiedAtStart.push(...loaded.unnotified);
  }
  attach(lifecycle: WebLifecycle): void { this.lifecycle = lifecycle; }
  onMessage(handler: MessageHandler): void { this.handler = handler; }
  settleMessage(messageId: string, outcome: "refused" | "unknown"): void {
    const receipt = this.receipts.get(messageId);
    if (!receipt || receipt.settled) return;
    this.state(messageId, outcome);
    receipt.settled = true;
    this.clearRequestText(receipt);
  }
  onCommand(_handler: CommandHandler): void { /* No command endpoint; chat remains ordinary Agent input. */ }

  async receive(raw: MessageInput): Promise<WebRequest> {
    const parsed = messageInputSchema.safeParse(raw);
    if (!parsed.success) throw new WebError(400, "invalid_message");
    const input = parsed.data;
    if (this.closed || this.tornDown || !this.handler) throw new WebError(503, "ingress_closed");
    if (!this.ownerId || !this.owner) throw new WebError(409, "owner_setup_required");
    if (input.targetId !== undefined && input.targetId !== this.ownerId) throw new WebError(403, "owner_dm_only");
    if (this.journalUnavailable) throw new WebError(503, "journal_unavailable");
    const attached = [...(input.images ?? []), ...(input.files ?? []).map((file) => `${file.id}:${file.type}:${file.name}`), ...(input.refiled ?? []).map((path) => `refiled:${path}`)];
    // What it replies to is part of the message (absent: the digest older receipts were recorded with).
    const replied = input.reply ? `\0reply:${input.reply.reaction ?? ""}:${input.reply.text}` : "";
    const digest = createHash("sha256").update((attached.length ? `${input.text}\0${attached.join(",")}` : input.text) + replied).digest("hex");
    const previous = this.receipts.get(input.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new WebError(409, "request_id_conflict");
      return { ...previous.request };
    }
    const backlog = this.interruptedBacklog();
    if (backlog.count >= MAX_INTERRUPTED_BACKLOG || backlog.bytes > SNAPSHOT_MAILBOX_BYTES / 2) throw new WebError(503, "interrupted_backlog");
    const reply = input.reply ? keptReply(input.reply) : undefined;
    const textBytes = heldBytes({ text: input.text, reply });
    if (this.pendingTextBytes + this.blockBytes + textBytes > SNAPSHOT_MAILBOX_BYTES) throw new WebError(429, "request_limit");
    if ([...this.receipts.values()].filter((r) => !r.settled).length >= 32) {
      throw new WebError(429, "request_limit");
    }
    if (this.receipts.size >= 4096) {
      const oldest = [...this.receipts].find(([, receipt]) => receipt.settled && !this.awaitingOwner(receipt));
      if (!oldest) throw new WebError(429, "request_limit");
      this.receipts.delete(oldest[0]);
    }
    // The id is taken NOW, synchronously, before any await: a second request
    // with it (a double click, a retry racing the first) is refused as in
    // flight instead of filing the same uploads twice.
    if (this.inFlight.has(input.requestId)) throw new WebError(409, "request_in_flight");
    this.inFlight.add(input.requestId);
    // Attached uploads are claimed and filed like any channel's inbound
    // images; one that expired or is unknown refuses the message, before
    // anything is accepted. Until the receipt is durable they stay claimable.
    let uploads: Awaited<ReturnType<WebChannel["fileUploads"]>> | undefined;
    let refiled: WebFiledFile[];
    try {
      // Checked first: nothing is claimed or filed for a message that names a file it may not.
      refiled = this.refiledFiles(input.refiled ?? []);
      uploads = input.images?.length || input.files?.length ? await this.fileUploads(input.images ?? [], input.files ?? [], input.requestId) : undefined;
    } finally { this.inFlight.delete(input.requestId); }
    // From here to receipts.set there is no await, so no other receive can interleave.
    const images = uploads?.list.length ? uploads : undefined;
    const filed = images?.list.flatMap((image) => image.savedPath ? [image.savedPath] : []) ?? [];
    const filedFiles: WebFiledFile[] = [...refiled, ...(uploads?.notices ?? []).flatMap((notice) => notice.savedPath
      ? [{ path: notice.savedPath, name: notice.filename, type: notice.mimeType, size: notice.byteSize ?? 0, ...(notice.mimeUnknown ? { typeUnknown: true } : {}) }] : [])];
    const request: WebRequest = { requestId: input.requestId, state: "queued", sessionId: this.ownerId, text: input.text, timestamp: this.now(), responseTurnId: input.requestId,
      ...(filed.length ? { images: filed } : {}), ...(filedFiles.length ? { files: filedFiles } : {}), ...(reply ? { reply } : {}) };
    this.receipts.set(input.requestId, { digest, request, settled: false });
    this.pendingTextBytes += textBytes;
    // Durable before custody: a crash after the 202 must leave a record.
    // Durable first, with the filed images' paths; only then do the staged
    // copies go. A failure leaves them staged, so the page can retry the same ids.
    try { this.journal?.recordReceived(input.requestId, digest, input.text, request.timestamp!, filed, filedFiles, reply); } catch {
      uploads?.undo();
      this.clearRequestText(this.receipts.get(input.requestId)!);
      this.receipts.delete(input.requestId);
      throw new WebError(503, "persist_failed");
    }
    uploads?.finalize();
    // Images first, then files — the order the iMessage channel writes its markers in.
    // A resend's files are announced exactly as the first time (the same path, name, type and size).
    const notices: SavedFileNotice[] = filedFiles.map((file) => ({ filename: file.name, mimeType: file.type, byteSize: file.size, mimeUnknown: file.typeUnknown, savedPath: file.path, status: "saved" }));
    // A reply's quote leads, as on iMessage (reply, then attachments); a
    // reaction is the whole message, worded as an iMessage tapback. The
    // quoted text is the FULL original the page sent, not the kept copy.
    const marker = input.reply?.reaction ? formatReactionMarker(input.reply.reaction, input.reply.text)
      : [input.reply ? formatReplyContextMarker(input.reply.text) : "", images ? formatImageMarker(images.list.length, filed, images.unconverted) : "", formatFileMarker(notices)].filter(Boolean).join(" ");
    // What was typed is neutralised before our markers go in front: typed text
    // cannot pass for a reply, a tapback or an attachment marker.
    const body = neutralizeMarker(neutralizeInboundBody(input.text));
    const message: IncomingMessage = { id: input.requestId, chatId: WEB_CHAT_ID, senderName: "Owner",
      text: marker ? (body ? `${marker} ${body}` : marker) : body, timestamp: Date.now(), isGroup: false,
      ...(input.reply?.reaction ? { isReaction: true } : input.reply ? { isReply: true } : {}),
      ...(images ? { images: images.list } : {}) };
    const handoff = Promise.resolve().then(() => this.handler!(message));
    this.handoffs.add(handoff);
    try {
      const accepted = await handoff;
      if (!accepted) { this.state(input.requestId, "refused"); throw new WebError(503, "ingress_refused"); }
      this.events.publish({ type: "request", request: { ...request } });
      return { ...request };
    } catch (err) {
      if (request.state !== "refused") this.state(input.requestId, "unknown");
      this.receipts.get(input.requestId)!.settled = true;
      this.clearRequestText(this.receipts.get(input.requestId)!);
      throw err instanceof WebError ? err : new WebError(503, "handoff_failed");
    } finally { this.handoffs.delete(handoff); }
  }

  /**
   * The staged uploads of one message, filed as Telegram and iMessage file
   * theirs. Images: base64 for the model, and (with saveInboundImages) a copy
   * under memory/incoming-images as `HHMMSS_web_owner_<id8>.<ext>`. Other
   * files: through the same inbound file store as iMessage's (saveInboundFile:
   * memory/incoming-files/<date>/HHMMSS_web_owner_<sanitised name>, its cap,
   * never overwriting), path only — the marker tells the agent where it is.
   * Every id is claimed and checked first (present, unexpired, the kind the
   * message says, not repeated); one bad id refuses the message and nothing
   * is written. The staged files are NOT removed here: receive() does that
   * once the receipt is durable. `undo` removes what this filed, for a
   * receipt that could not be written.
   */
  private async fileUploads(imageIds: readonly string[], fileRefs: ReadonlyArray<{ id: string; name: string; type: string }>, requestId: string):
    Promise<{ list: ImageAttachment[]; notices: SavedFileNotice[]; unconverted: number; undo: () => void; finalize: () => void }> {
    if (!this.uploads) throw new WebError(400, "uploads_unavailable");
    // Without saveInboundImages / saveInboundFiles there is no durable copy to
    // record with the receipt (and the owner asked for them not to be kept):
    // refused, and the page does not offer attaching them (bootstrap capabilities).
    if (imageIds.length && !this.uploads.workspaceDir) throw new WebError(409, "uploads_disabled");
    const fileDir = this.uploads.fileDir;
    if (fileRefs.length && !fileDir) throw new WebError(409, "uploads_disabled");
    const claim = claimUploads(this.uploads.dir, [...imageIds, ...fileRefs.map((file) => file.id)], requestId);
    if (!claim) throw new WebError(409, "upload_missing");
    // Each id must be the kind it was sent as: an image id named as a file (or the reverse) is refused.
    const kinds = claim.files.map((file) => file.kind);
    if (kinds.some((kind, at) => kind !== (at < imageIds.length ? "image" : "file"))) { claim.release(); throw new WebError(409, "upload_missing"); }
    const list: ImageAttachment[] = [];
    const notices: SavedFileNotice[] = [];
    const undo = () => {
      for (const path of [...list.map((image) => image.savedPath), ...notices.map((notice) => notice.savedPath)]) if (path) rmSync(path, { force: true });
      claim.release();
    };
    let unconverted = 0;
    try {
      for (const [at, { id, bytes, type, kind }] of claim.files.entries()) {
        if (kind === "file") {
          const ref = fileRefs[at - imageIds.length];
          // The browser's type, when it gave one; else the same fallback (flagged unknown) as iMessage's MIME-less files.
          const mimeUnknown = !ref.type.trim();
          const mimeType = mimeUnknown ? FALLBACK_MIME : ref.type.trim();
          const savedPath = await saveInboundFile(bytes, mimeType, { sessionKey: `web_${WEB_CHAT_ID}`, filename: ref.name, timestamp: new Date() }, fileDir!);
          // Filing was asked for and failed: refuse, keep the uploads staged.
          if (!savedPath) throw new WebError(503, "persist_failed");
          notices.push({ filename: sanitizeAttachmentFilename(ref.name, mimeType), mimeType, byteSize: bytes.length, mimeUnknown, savedPath, status: "saved" });
          continue;
        }
        // Still HEIC: the web process could not convert it at upload (see uploads.ts).
        if (type === "image/heic") unconverted++;
        const image = await buildImageAttachment(bytes, type, { sessionKey: `web_${WEB_CHAT_ID}`, guid: id, timestamp: new Date() }, this.uploads.workspaceDir!);
        list.push(image);
        if (!image.savedPath) throw new WebError(503, "persist_failed");
      }
    } catch (error) { undo(); throw error; }
    return { list, notices, unconverted, undo, finalize: claim.finalize };
  }

  /**
   * A resend's already-filed files: each path must be one an interrupted
   * request still awaiting the owner filed (its receipt lists it), and still
   * be a regular file there. Anything else refuses the message — this is
   * never a way to name an arbitrary path.
   */
  private refiledFiles(paths: readonly string[]): WebFiledFile[] {
    if (!paths.length) return [];
    if (new Set(paths).size !== paths.length) throw new WebError(409, "upload_missing");
    const known = new Map<string, WebFiledFile>();
    for (const receipt of this.receipts.values()) {
      if (this.awaitingOwner(receipt)) for (const file of receipt.request.files ?? []) known.set(file.path, file);
    }
    return paths.map((path) => {
      const file = known.get(path);
      let present = false;
      try { present = !!file && lstatSync(path).isFile(); } catch { /* gone */ }
      if (!file || !present) throw new WebError(409, "upload_missing");
      return { ...file };
    });
  }

  request(id: string): WebRequest { return { ...(this.receipts.get(id)?.request ?? { requestId: id, state: "unknown" }) }; }
  snapshot() {
    // Unsettled requests and interrupted ones awaiting the owner always ship
    // (both bounded at admission). Then recent settled ones, so a reloaded
    // page can still label them, and interrupted ones from the last week, so
    // their history bubbles keep their badge.
    const now = this.now();
    const all = [...this.receipts.values()];
    const must = all.filter((r) => !r.settled || this.awaitingOwner(r));
    const recent = all.filter((r) => !must.includes(r) && ((r.request.timestamp ?? 0) > now - 15 * 60_000
      || (r.request.state === "interrupted" && (r.request.timestamp ?? 0) > now - 7 * 24 * 60 * 60_000)));
    const requests = [...must, ...recent.slice(-Math.max(0, 128 - must.length))]
      .sort((a, b) => (a.request.timestamp ?? 0) - (b.request.timestamp ?? 0)).map((r) => ({ ...r.request }));
    const blocks = [...this.blocks];
    const tasks = this.tasks.snapshot();
    return { epoch: this.events.epoch, cursor: this.events.cursor(), requests, blocks, tasks,
      ...(this.compactState ? { compact: { ...this.compactState } } : {}),
      ...(this.rateLimit ? { rateLimit: { ...this.rateLimit } } : {}),
      ...(this.suggestions.size ? { suggestions: Object.fromEntries(this.suggestions) } : {}),
      ...(this.reactions.size ? { reactions: Object.fromEntries(this.reactions) } : {}) };
  }

  /**
   * Where the browser may read a task it was shown: only a task the panel's
   * send gate would show in `sessionId` right now. Shell and Monitor tasks
   * also return their output tail, read from the live SDK session.
   */
  async task(sessionId: string, taskId: string, output: boolean, command = false): Promise<WebTaskAccess> {
    const found = this.tasks.locate(sessionId, taskId);
    if (!found) throw new WebError(404, "task_not_found");
    const access: WebTaskAccess = { sessionKey: found.slot, taskType: found.task.taskType };
    if (command) {
      if (found.task.taskType !== "local_bash") throw new WebError(400, "no_task_command");
      // The full command, redacted on this side; the task's own description
      // (redacted, 200 characters) when the live session no longer has it.
      const toolUseId = this.tasks.toolUseOf(found.slot, taskId);
      const raw = (toolUseId && this.toolCommand?.(found.slot, toolUseId)) || undefined;
      const text = raw ? redactCommand(raw) : found.task.description;
      return { ...access, command: { text: text.slice(0, COMMAND_LIMIT), truncated: !raw || text.length > COMMAND_LIMIT } };
    }
    if (!output) return access;
    if (!OUTPUT_TASK_TYPES.has(found.task.taskType)) throw new WebError(400, "no_task_output");
    const value = await this.taskOutput?.(found.slot, taskId).catch(() => undefined);
    if (!value) throw new WebError(503, "task_output_unavailable");
    return { ...access, output: { output: value.output.slice(-16 * 1024), size: value.size } };
  }

  /**
   * The owner acts on ONE running task from the task view: stop it, or move a foreground one to
   * the background. Only a task the panel shows right now, and only in the owner conversation
   * (groups stay read-only in the browser). `done: false` means the SDK did not take it — the
   * task had just ended, or was no longer in the foreground; the next `tasks` event says which.
   */
  async taskAction(sessionId: string, taskId: string, action: TaskAction): Promise<WebTaskActionResult> {
    const key = this.ownerKey();
    if (!this.taskControl || !this.ownerId || !key) throw new WebError(409, "owner_setup_required");
    const found = this.tasks.locate(sessionId, taskId);
    if (!found) throw new WebError(404, "task_not_found");
    if (sessionId !== this.ownerId || found.slot !== key) throw new WebError(403, "owner_dm_only");
    if (found.task.state !== "running") throw new WebError(409, "task_not_running");
    if (action === "stop") return { done: await this.taskControl.stop(found.slot, taskId).catch(() => false) };
    if (found.task.background) throw new WebError(409, "task_already_background");
    const toolUseId = this.tasks.toolUseOf(found.slot, taskId);
    if (!toolUseId) throw new WebError(409, "task_not_backgroundable");
    return { done: await this.taskControl.background(found.slot, toolUseId).catch(() => false) };
  }

  /**
   * The owner pressed Stop: soft-stop the running turn of the owner
   * conversation the browser shows. The turn ends at the SDK's next
   * checkpoint and settles like any other; background tasks keep running.
   */
  async stopOwnerTurn(): Promise<WebStopResult> {
    const key = this.ownerKey();
    if (!this.stopTurn || !this.ownerId || !key) throw new WebError(409, "owner_setup_required");
    return { stopped: await this.stopTurn(key).catch(() => false) };
  }

  private setSuggestion(sessionId: string, text: string | null): void {
    if ((this.suggestions.get(sessionId) ?? null) === text) return;
    if (text === null) this.suggestions.delete(sessionId); else this.suggestions.set(sessionId, text);
    this.publishQuietly({ type: "suggestion", sessionId, text });
  }
  /** Status events are never worth failing an Agent path over. */
  private publishQuietly(event: WebEvent): void {
    try { this.events.publish(event); } catch { /* oversized: dropped */ }
  }
  /**
   * An SDK signal for one session, as the browser shows it. Rate-limit state
   * is the account's, not a conversation's; it is kept for the Plan usage
   * card and sent only when it changes. Tool progress is sent at the first
   * report and then at most every TOOL_PROGRESS_EVERY_MS: the page counts the
   * seconds in between itself.
   */
  private observeSignal(sessionKey: string | undefined, signal: SdkSignal): void {
    if (signal.kind === "rate_limit") {
      const limit = { status: signal.status, ...(signal.limit ? { limit: signal.limit } : {}), ...(signal.resetsAt !== undefined ? { resetsAt: signal.resetsAt } : {}),
        ...(signal.utilization !== undefined ? { utilization: signal.utilization } : {}), ...(signal.overage ? { overage: true } : {}) };
      const old = this.rateLimit;
      if (old && old.status === signal.status && old.limit === signal.limit && old.resetsAt === signal.resetsAt
        && old.utilization === signal.utilization && !!old.overage === !!signal.overage) return;
      this.rateLimit = { ...limit, at: this.now() };
      this.publishQuietly({ type: "rate-limit", limit: { ...this.rateLimit } });
      return;
    }
    // The home's business (status-reducer.ts), not the composer's.
    if (signal.kind === "compacting") return;
    const sessionId = sessionKey ? this.sessionId(sessionKey) : undefined;
    if (!sessionId) return;
    if (signal.kind === "suggestion") { this.setSuggestion(sessionId, signal.text); return; }
    if (signal.kind === "tool_progress") {
      const now = this.now();
      const last = this.toolProgressAt.get(signal.toolUseId);
      if (last !== undefined && now - last < TOOL_PROGRESS_EVERY_MS) return;
      this.toolProgressAt.delete(signal.toolUseId);
      this.toolProgressAt.set(signal.toolUseId, now);
      if (this.toolProgressAt.size > 256) this.toolProgressAt.delete(this.toolProgressAt.keys().next().value!);
      this.publishQuietly({ type: "turn", sessionId, status: { kind: "tool", tool: signal.tool, elapsed: signal.elapsedSeconds } });
      return;
    }
    const status: WebTurnStatus = signal.kind === "retry"
      ? { kind: "retry", attempt: signal.attempt, max: signal.maxRetries, delayMs: signal.delayMs, error: signal.error }
      : signal.kind === "refusal"
        ? { kind: "refusal", model: signal.model, ...(signal.fallbackModel ? { fallbackModel: signal.fallbackModel } : {}), ...(signal.category ? { category: signal.category } : {}) }
        : signal.kind === "error" ? { kind: "error", error: signal.error } : { kind: "stopped" };
    this.publishQuietly({ type: "turn", sessionId, status });
  }

  /** Subscription usage for the browser; never fails: an unconfigured reader reads as "unavailable". */
  async usage(refresh: boolean): Promise<WebUsage> {
    if (!this.usageReader) return { state: "unavailable", windows: [], fetchedAt: Date.now(), updatedAt: null, nextRefreshAt: Date.now(), expiresAt: Date.now() + 30 * 60_000, serverNow: Date.now() };
    return this.usageReader(refresh);
  }

  /**
   * The owner asks Tomo to compact their session — the owner conversation
   * the browser shows (the catalog's owner-key rule, as the task panel uses).
   * First check, here: refused (409 tasks_running) while that session has
   * running non-ambient tasks. The last check is Tomo's own, when the turn
   * runs (the event tells it to skip if anything is running). Each request
   * gets an id; its state (accepted → done | failed, or declined) is
   * published and kept in the snapshot.
   */
  requestCompact(): WebCompactResult {
    const key = this.ownerKey();
    if (!this.compact || !this.ownerId || !key) throw new WebError(409, "owner_setup_required");
    const requestId = randomUUID();
    const running = this.tasks.snapshot().filter((t) => t.sessionId === this.ownerId && t.state === "running" && !t.ambient).length;
    if (running > 0) {
      this.setCompactState({ requestId, state: "declined", at: Date.now() });
      throw new WebError(409, "tasks_running");
    }
    const status = this.compact(key, (outcome) => {
      if (this.compactState?.requestId === requestId) this.setCompactState({ requestId, state: outcome, at: Date.now() });
    });
    if (status === "no_owner") throw new WebError(409, "owner_setup_required");
    if (status === "already_requested") return { status, requestId: this.compactState?.requestId ?? requestId };
    this.setCompactState({ requestId, state: "accepted", at: Date.now() });
    return { status, requestId };
  }

  /**
   * The daemon key behind a browser session id, for the sessions the browser
   * catalog shows: the owner conversation (the same owner-key rule) or a
   * group in the registry. Anything else is not found.
   */
  private visibleKey(sessionId: string): { key: string; owner: boolean } {
    if (this.ownerId && sessionId === this.ownerId) {
      const key = this.ownerKey();
      if (!key) throw new WebError(409, "owner_setup_required");
      return { key, owner: true };
    }
    let keys: readonly string[] = [];
    try { keys = this.sessionKeys?.() ?? []; } catch { /* unreadable registry: not found */ }
    const key = keys.find((k) => isGroupSessionKey(k) && webSessionId(k) === sessionId);
    if (!key) throw new WebError(404, "session_not_found");
    return { key, owner: false };
  }

  /** Tomo's home for the Home page: always a valid scene (the last good one, or the starter). */
  home(): WebHome {
    if (!this.homeAccess || this.tornDown) throw new WebError(503, "home_unavailable");
    return this.homeAccess.view();
  }
  /** A picture of the home from an open Home page, for Tomo to look at. */
  homeSnapshot(input: unknown): { accepted: boolean } {
    if (!this.homeAccess || this.tornDown) throw new WebError(503, "home_unavailable");
    return this.homeAccess.snapshot(input);
  }
  /**
   * May the browser already read `key`'s task text? The Tasks panel's own
   * rule (taskRouter): any group, and for DMs only the key the catalog shows
   * as the owner conversation.
   */
  mayShowTask(key: string): boolean { return this.taskRouter()(key) !== undefined; }

  /** The model a browser session runs on and what it could switch to. Groups read it, never switch it. */
  model(sessionId: string): WebModelView {
    if (!this.models) throw new WebError(503, "service_unavailable");
    const { key, owner } = this.visibleKey(sessionId);
    return { sessionId, writable: owner, ...this.models.view(key) };
  }

  /**
   * Switch the owner conversation's model through the agent's shared switch
   * (the one /model uses). `from` is the model the owner reviewed: a different
   * current model refuses (409 model_changed). Refused while a turn is in
   * flight (409 turn_in_flight) rather than cutting it off. Nothing is
   * persisted on any refusal. Open pages re-read on the invalidate event.
   */
  switchModel(sessionId: string, model: string, from: string): WebModelChangeResult {
    if (!this.models) throw new WebError(503, "service_unavailable");
    if (this.tornDown) throw new WebError(503, "ingress_closed");
    const { key, owner } = this.visibleKey(sessionId);
    if (!owner) throw new WebError(403, "owner_dm_only");
    const outcome = this.models.switch(key, model, from);
    if (!outcome.ok) throw new WebError(MODEL_REFUSAL_STATUS[outcome.reason], outcome.reason);
    if (outcome.changed) {
      try { this.events.publish({ type: "invalidate", sessionId }); } catch { /* best effort */ }
    }
    return { status: outcome.changed ? "switched" : "unchanged",
      model: { id: outcome.model, label: modelLabel(outcome.model) }, previous: { id: outcome.previous, label: modelLabel(outcome.previous) } };
  }

  private setCompactState(state: WebCompactState): void {
    this.compactState = state;
    try { this.events.publish({ type: "compact", request: { ...state } }); } catch { /* best effort */ }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const requestId = message.chatId;
    const receipt = this.receipts.get(requestId);
    if (this.tornDown || !this.ownerId || !receipt || receipt.settled || !["queued", "running", "failed"].includes(receipt.request.state)) {
      throw markDefiniteFailure(new Error("Web outlet unavailable"));
    }
    // A picture (MEDIA:<path>, or a path STICKER:) is copied into the
    // outgoing store and shown by id; the path never reaches the browser.
    // A Telegram sticker file_id has nothing to show here: only its caption goes.
    const picture = message.photo ?? (message.sticker && /^[/~]/.test(message.sticker) ? message.sticker : undefined);
    let images: string[] | undefined;
    if (picture) {
      const sessionKey = this.ownerKey();
      if (!this.outgoing || !sessionKey) throw markDefiniteFailure(new Error("Web attachments are not supported"));
      try {
        images = [this.outgoing.file(sessionKey, [requestId, receipt.request.responseTurnId ?? ""], picture).id];
      } catch (err) {
        // Not shown (private, not an image, too large, gone): the picture is
        // definitely undelivered; the pipeline still sends its caption as text.
        throw markDefiniteFailure(err instanceof OutgoingMediaError ? new Error(`Web attachment refused: ${err.code}`) : err);
      }
    }
    if (!message.text && !images) return;
    const block: Extract<WebEvent, { type: "block" }> = { type: "block", sessionId: this.ownerId,
      requestId, turnId: receipt.request.responseTurnId, id: `${requestId}:${this.blocks.length}`, text: message.text, ...(images ? { images } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(block));
    // The rest of the snapshot frame is reserved for receipts and the task
    // panel, whose worst case is fixed, so the snapshot never truncates it.
    if (this.blockBytes + bytes + this.pendingTextBytes > SNAPSHOT_MAILBOX_BYTES) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(new Error("Web mailbox full"));
    }
    try { this.events.publish(block); } catch (err) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(err);
    }
    this.blocks.push(block);
    this.blockBytes += bytes;
  }

  /**
   * Tomo's tapback on one of the owner's web messages (`react_to_message`):
   * `messageId` is the request id the message was received under, which is
   * what the agent records as the latest inbound message. One reaction per
   * message, as on iMessage: a new one replaces it, `remove` takes it back.
   * Shown on the message at once and kept across restarts (the transcript
   * records no reaction of Tomo's, on any channel).
   */
  async reactToMessage(_chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    if (this.tornDown || !this.ownerId) throw markDefiniteFailure(new Error("Web outlet unavailable"));
    if (!this.receipts.has(messageId)) throw markDefiniteFailure(new Error("That web message is no longer known; react to a newer one"));
    if (remove ? this.reactions.get(messageId) === undefined : this.reactions.get(messageId) === reaction) return;
    this.reactions.delete(messageId);
    if (!remove) this.reactions.set(messageId, reaction);
    while (this.reactions.size > MAX_WEB_REACTIONS) this.reactions.delete(this.reactions.keys().next().value!);
    this.saveReactions();
    try { this.events.publish({ type: "reaction", sessionId: this.ownerId, requestId: messageId, reaction: remove ? null : reaction }); }
    catch { /* The snapshot carries it; the page reads it on its next sync. */ }
  }

  /** An unreadable file is not an empty one: it is left alone and reactions stay in memory. */
  private loadReactions(path: string): void {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.reactionsPath = path;
      else log.warn({ err, path }, "Web reactions file unreadable; Tomo's reactions on web messages are kept in memory only");
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { reactions?: unknown };
      if (!Array.isArray(parsed.reactions)) throw new Error("no reactions list");
      for (const item of parsed.reactions.slice(-MAX_WEB_REACTIONS)) {
        const [id, reaction] = Array.isArray(item) ? item : [];
        if (typeof id === "string" && id.length <= 128 && (WEB_REACTIONS as readonly unknown[]).includes(reaction)) this.reactions.set(id, reaction as WebReaction);
      }
      this.reactionsPath = path;
    } catch (err) {
      log.warn({ err, path }, "Web reactions file unparseable; Tomo's reactions on web messages are kept in memory only");
    }
  }

  private saveReactions(): void {
    if (!this.reactionsPath) return;
    try {
      mkdirSync(dirname(this.reactionsPath), { recursive: true, mode: 0o700 });
      writeJsonAtomicSync(this.reactionsPath, { version: 1, reactions: [...this.reactions] }, { mode: 0o600 });
    } catch (err) { log.warn({ err }, "Could not save Tomo's reactions on web messages"); }
  }

  startTyping(_chatId: string) {
    if (this.ownerId) this.events.publish({ type: "typing", sessionId: this.ownerId, active: true });
    return () => { if (this.ownerId) this.events.publish({ type: "typing", sessionId: this.ownerId, active: false }); };
  }
  async start(): Promise<void> { try { await this.lifecycle?.start(); } catch { /* Optional UI cannot fail Agent.start. */ } }
  closeIngestion(): void { this.closed = true; }
  async quiesce(): Promise<void> { await Promise.allSettled(this.handoffs); }
  async teardown(): Promise<void> {
    this.tornDown = true;
    this.unsubscribe?.();
    this.tasks.dispose();
    for (const lookup of this.modelLookups.values()) clearTimeout(lookup.timer);
    this.modelLookups.clear();
    clearInterval(this.ownerKeyTimer);
    try { await this.lifecycle?.stop(); } catch { /* Optional process cleanup cannot prevent daemon shutdown. */ }
  }
  async stop(): Promise<void> { this.closeIngestion(); await this.quiesce(); await this.teardown(); }

  /** An interrupted request whose text the owner has not dealt with yet. */
  private awaitingOwner(receipt: Receipt): boolean {
    return receipt.request.state === "interrupted" && receipt.request.text !== undefined;
  }
  private interruptedBacklog(): { count: number; bytes: number } {
    let count = 0; let bytes = 0;
    for (const receipt of this.receipts.values()) {
      if (!this.awaitingOwner(receipt)) continue;
      count++; bytes += Buffer.byteLength(JSON.stringify(receipt.request.text));
    }
    return { count, bytes };
  }
  /**
   * The owner dealt with an interrupted request ("dismiss" in the browser), or
   * its message is in the transcript: its text can go. Persisted first; the
   * bubble disappears, the request still reads back as interrupted.
   */
  resolveInterrupted(requestId: string, how: Resolution): WebRequest {
    const receipt = this.receipts.get(requestId);
    if (!receipt || !this.awaitingOwner(receipt)) throw new WebError(404, "not_interrupted");
    try { this.journal?.resolve(requestId, how); } catch { throw new WebError(503, "persist_failed"); }
    this.clearRequestText(receipt);
    this.events.publish({ type: "request", request: { ...receipt.request } });
    return { ...receipt.request };
  }
  /**
   * Tell the owner's session about every interrupted request not yet
   * announced (this restart's or an earlier one's), THEN record that it was
   * told. A crash in between repeats the notice on the next start rather
   * than losing it: at least once, never silently zero.
   */
  announceInterrupted(note: (items: JournalEntry[]) => boolean): void {
    const items = this.unnotifiedAtStart.splice(0);
    if (items.length === 0) return;
    // Recorded as given only once the notice is durably queued (written and
    // fsynced). Not persisted → stays "interrupted, not notified": the next
    // start announces it again.
    if (!note(items)) return;
    try { this.journal?.markNotified(items.map((e) => e.requestId)); } catch { /* Not recorded: the next start repeats it. */ }
  }
  /** Interrupted requests (this run's restart or earlier ones) still awaiting the owner. */
  interruptedAwaiting(): string[] {
    return [...this.receipts.values()].filter((r) => this.awaitingOwner(r)).map((r) => r.request.requestId);
  }
  /** Interrupted requests whose message the transcript already has (checked at start). */
  markRecorded(requestIds: Iterable<string>): void {
    for (const id of requestIds) {
      try { this.resolveInterrupted(id, "recorded"); } catch { /* Kept: resolved later by the owner. */ }
    }
  }

  private clearRequestText(receipt: Receipt): void {
    if (receipt.request.text !== undefined) this.pendingTextBytes -= heldBytes(receipt.request);
    delete receipt.request.text;
    delete receipt.request.images;
    delete receipt.request.files;
    delete receipt.request.reply;
  }

  private state(requestId: string, state: WebRequest["state"]): void {
    const receipt = this.receipts.get(requestId);
    if (!receipt) return;
    receipt.request.state = state;
    this.journal?.recordState(requestId, state);
    this.events.publish({ type: "request", request: { ...receipt.request } });
  }
  /** Compactions of `sessionId` seen since this daemon started, oldest first. */
  contextEvents(sessionId: string): WebCompaction[] { return [...(this.compactions.get(sessionId) ?? [])]; }
  /** The browser session id for a daemon session key, or undefined when the browser may not see it. */
  sessionIdFor(key: string): string | undefined { return this.sessionId(key); }
  private sessionId(key: string): string | undefined {
    if (isGroupSessionKey(key)) return webSessionId(key);
    if (!this.owner || !this.ownerId) return;
    const owner = this.owner;
    if (key === ownerSessionKey(owner) || OWNER_CHANNELS.some((ch) =>
      ownerBindings(owner, ch).some((id) => legacySessionKeysForBinding([key], ch, id).length > 0))) return this.ownerId;
  }
  /**
   * Task text reaches the browser only for sessions its catalog shows: any
   * group, and for DMs exactly the key `selectOwnerSessionKey` picks — not
   * every legacy key bound to the owner, which the catalog may be hiding.
   */
  /**
   * The board's send gate calls this once per send: one fresh read of the
   * owner-key rule, then a router for every key in that send. Groups always
   * show (they are readable in the browser); a DM only when it is the key the
   * catalog rule picks as the owner conversation in this snapshot.
   */
  private taskRouter(): (key: string) => string | undefined {
    const ownerKey = this.ownerKey();
    const ownerId = this.ownerId;
    return (key) => {
      if (isGroupSessionKey(key)) return webSessionId(key);
      return ownerKey !== undefined && key === ownerKey && ownerId ? ownerId : undefined;
    };
  }
  /**
   * Subagents (local_agent) get their model from their meta.json, else the
   * first assistant entry of their transcript (readSubagentModel). Looked up
   * when the task first appears; if neither has it yet, retried after
   * MODEL_RETRY_DELAYS_MS (1 s, 3 s, 10 s) and then given up — for THIS run.
   * A task that ended keeps being looked up while the panel still holds it;
   * once it has left the panel, its retries are dropped.
   *
   * A found model ends the lookup (the board caches it, `hasModel`). A lookup
   * is per run: a resumed subagent (same task id, new run id) is looked up
   * afresh. Before, a finished or exhausted lookup stayed in the map for good,
   * so a subagent that left the panel and was later resumed came back without
   * its badge and was never looked up again (2026-11-14).
   * Other task types have no model and are never looked up.
   */
  private lookUpModels(key: string, tasks: WatchTask[]): void {
    if (!this.taskModel) return;
    // Drop lookups for tasks the board no longer holds (left the panel).
    for (const [id, lookup] of this.modelLookups) {
      if (!this.tasks.holds(lookup.key, lookup.taskId)) { clearTimeout(lookup.timer); this.modelLookups.delete(id); }
    }
    for (const task of tasks) {
      if (task.taskType !== "local_agent" || this.tasks.hasModel(key, task.taskId)) continue;
      const id = `${key}\0${task.taskId}`;
      const existing = this.modelLookups.get(id);
      if (existing && existing.runId === task.runId) continue;
      if (existing) clearTimeout(existing.timer); // a new run: look again
      const lookup = { key, taskId: task.taskId, runId: task.runId, attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      this.modelLookups.set(id, lookup);
      const attempt = () => {
        lookup.timer = undefined;
        void this.taskModel!(key, task.taskId).then((model) => {
          if (this.modelLookups.get(id) !== lookup || this.tornDown) return;
          // A short task may have ended meanwhile; it still gets its badge
          // while the panel keeps it. Once it left the panel, stop.
          if (!this.tasks.holds(key, task.taskId)) { this.modelLookups.delete(id); return; }
          if (model) { this.tasks.setModel(key, task.taskId, model); this.modelLookups.delete(id); return; }
          const delay = MODEL_RETRY_DELAYS_MS[lookup.attempt++];
          if (delay !== undefined) { lookup.timer = setTimeout(attempt, delay); lookup.timer.unref?.(); }
        }, () => {});
      };
      attempt();
    }
  }

  /** Every owner-bound or group key is recorded; the gate decides what is shown. */
  private observeTasks(key: string, event: Extract<WatchEvent, { type: "tasks" }>): void {
    this.tasks.apply(key, event.tasks, event.ended);
    this.lookUpModels(key, event.tasks);
    // The owner rule can change with no task event at all; re-run the gate so
    // a DM that stops being the owner conversation is withdrawn promptly.
    if (!isGroupSessionKey(key) && !this.ownerKeyTimer) {
      this.ownerKeyTimer = setInterval(() => this.tasks.publish(), OWNER_KEY_CHECK_MS);
      this.ownerKeyTimer.unref?.();
    }
  }
  private observe(event: WatchEvent): void {
    // Session-less: a run changes the job's next / last run. Carries nothing.
    if (event.type === "cron.fired" || event.type === "cron.done") { this.events.publish({ type: "cron" }); return; }
    if (event.type === "sdk") { this.observeSignal(event.sessionKey, event.signal); return; }
    if (!("sessionKey" in event) || !event.sessionKey) return;
    const sessionId = this.sessionId(event.sessionKey);
    if (!sessionId) return;
    if (event.type === "turn.join") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt) { receipt.request.responseTurnId = event.turnId; receipt.request.joined = true; this.state(event.requestId, "running"); }
    } else if (event.type === "turn.handoff") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt && !receipt.settled) { receipt.request.handedOff = true; this.state(event.requestId, "running"); }
    } else if (event.type === "turn.requeue") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt && !receipt.settled) this.state(event.requestId, "queued");
    } else if (event.type === "read") {
      // A read receipt changes no state and is not journaled. Owner only:
      // web requests only ever run there.
      if (sessionId !== this.ownerId) return;
      for (const requestId of event.requestIds) {
        const receipt = this.receipts.get(requestId);
        if (!receipt || receipt.request.read) continue;
        receipt.request.read = true;
        this.events.publish({ type: "request", request: { ...receipt.request } });
      }
    } else if (event.type === "turn.start") {
      // A new turn makes the last one's suggestion stale.
      this.publishQuietly({ type: "turn", sessionId, status: null });
      this.setSuggestion(sessionId, null);
      if (event.requestId && this.receipts.has(event.requestId)) this.state(event.requestId, "running");
    } else if (event.type === "turn.end" && event.requestId) {
      // Handed to the SDK and then cut short: it may have run. Say so rather
      // than "failed", which invites a resend that could run it twice.
      if (event.uncertain) this.state(event.requestId, "unknown");
      else if (this.request(event.requestId).state !== "failed") this.state(event.requestId, event.ok ? "completed" : "failed");
      const receipt = this.receipts.get(event.requestId);
      if (receipt) { receipt.settled = true; this.clearRequestText(receipt); }
      this.blocks = this.blocks.filter((block) => block.requestId !== event.requestId);
      this.blockBytes = this.blocks.reduce((sum, block) => sum + Buffer.byteLength(JSON.stringify(block)), 0);
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "compact") {
      const list = this.compactions.get(sessionId) ?? [];
      list.push({ timestamp: event.ts, ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}) });
      if (list.length > 50) list.shift();
      if (!this.compactions.has(sessionId) && this.compactions.size >= 256) this.compactions.delete(this.compactions.keys().next().value!);
      this.compactions.set(sessionId, list);
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "transcript" || event.type === "turn.stats") {
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "tasks") {
      this.observeTasks(event.sessionKey, event);
    } else if (event.type === "tool.start" || event.type === "tool.end") {
      this.events.publish({ type: "tool", sessionId, tool: event.tool.slice(0, 128),
        state: event.type === "tool.start" ? "started" : event.ok ? "completed" : "failed" });
    }
  }
}
