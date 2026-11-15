import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { DocumentAttachment, ImageAttachment, IncomingMessage } from "../channels/types.js";
import { isRawJsonlLine, parseJsonl, reportRawJsonlLines, serializeJsonlRecord } from "../jsonl.js";
import { log } from "../logger.js";
import type { SessionResolution } from "../router.js";

/**
 * DURABLE INBOUND INBOX.
 *
 * Between "the channel handed us a message" and "a turn has consumed it" a
 * message used to live only in memory (the InboundBatcher's Map, the
 * `queuedInbound` records, the SessionQueue's promise chain). The channels
 * acknowledge it at that same moment — imsg commits its rowid cursor when the
 * hand-off resolves, and grammY confirms a Telegram update before our
 * middleware even runs — so a daemon that dies before the turn starts loses
 * the message in both directions at once: never answered, never redelivered.
 * The graceful paths (stop(), uncaughtException) already record such messages
 * in the transcript as "not processed"; a SIGKILL, an OOM, a power cut or a
 * native crash records nothing.
 *
 * The inbox closes that gap with an append-only JSONL log, written and
 * fsynced BEFORE custody is returned to the channel:
 *
 *   recv   — accepted; carries everything needed to re-dispatch the message
 *   start  — a turn (or a steer into one) began consuming it
 *   done   — it was consumed, or deliberately dropped / recorded
 *   seen   — compaction tombstone: kept only so a redelivery is deduped
 *
 * State on load is a replay of that log. `received` records are re-dispatched
 * on the next daemon start; `started` records are NOT (the turn may already
 * have run tools, sent replies — re-running it risks doing it twice) — the
 * agent tells the session instead. Dedup is on (channel, chatId, provider
 * message id), which is what makes persist-before-ack safe: a channel that
 * redelivers a message whose ack we never got to commit finds it already
 * known.
 *
 * One writer: the daemon. The CLI never touches this file and the PID file
 * keeps a second daemon out, so there is no cross-process lock. Compaction is
 * an atomic rewrite; a torn tail line from a crash mid-append is preserved in
 * a `.corrupt-<ts>` sibling rather than silently dropped.
 */

export type InboxStatus = "received" | "started";

/** An attachment as persisted: never the bytes, only where to find them again. */
export interface PersistedImage {
  mediaType: string;
  savedPath?: string;
  isSticker?: boolean;
  conversionFailed?: boolean;
}

export interface PersistedDocument {
  mediaType: string;
  filename?: string;
  savedPath?: string;
}

export type PersistedMessage = Omit<IncomingMessage, "images" | "documents"> & {
  images?: PersistedImage[];
  documents?: PersistedDocument[];
};

export interface InboxRecord {
  /** Dedup key — see {@link DurableInbox.idFor}. */
  id: string;
  channel: string;
  /** Receipt-time resolution, so a replay routes exactly where the original would have. */
  resolution: SessionResolution;
  message: PersistedMessage;
  /** When the agent took custody (not the provider timestamp). */
  receivedAt: number;
  status: InboxStatus;
  startedAt?: number;
  /**
   * In memory only: the `start` mark could not be written, so the log on disk
   * may still say `received`. The record is treated as started everywhere in
   * this process (never handed to a replay, rewritten as started by the next
   * compaction) — see {@link DurableInbox.markStarted}.
   */
  unreplayable?: boolean;
}

type RecvLine = { op: "recv"; v: 1; rec: Omit<InboxRecord, "status" | "startedAt"> };
type MarkLine = { op: "start" | "done" | "seen"; id: string; at: number };
type LogLine = RecvLine | MarkLine;

export type AcceptResult =
  | { status: "accepted"; id: string }
  /** Already known (pending or consumed): the caller must not dispatch it again. */
  | { status: "duplicate"; id: string }
  /**
   * Not on disk. `closed`: the inbox was closed (shutdown) — the ordinary
   * refusal path applies. `failed`: the write itself failed, which is an
   * ingress fault the caller must surface (see Agent.enqueueMessage).
   */
  | { status: "unpersisted"; reason: "closed" | "failed" };

/** Byte writer, injectable so tests can simulate short writes. */
export type WriteFn = (fd: number, buffer: Uint8Array, offset: number, length: number) => number;

export interface DurableInboxOptions {
  path: string;
  /** How long a consumed message's id is remembered for dedup. Default 7 days. */
  dedupRetentionMs?: number;
  /** Hard cap on remembered consumed ids (newest kept). Default 10 000. */
  maxSeen?: number;
  /** Appends between in-process compactions. Default 500. */
  compactEvery?: number;
  /** fsync every append. Default true; tests may turn it off. */
  fsync?: boolean;
  /**
   * Inspect without owning: no compaction on load, no writes. For a reader
   * other than the daemon (a status command, a test) — a second instance that
   * compacted would replace the file under the daemon's open descriptor.
   */
  readOnly?: boolean;
  now?: () => number;
  /** Test seam for `fs.writeSync` (short writes, failures). */
  writeSync?: WriteFn;
}

const DEFAULT_DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SEEN = 10_000;
const DEFAULT_COMPACT_EVERY = 500;

/** Strip attachment bytes; keep what a replay needs to reload them. */
export function persistableMessage(message: IncomingMessage): PersistedMessage {
  const { images, documents, ...rest } = message;
  const out: PersistedMessage = { ...rest };
  if (images && images.length > 0) {
    out.images = images.map((img) => ({
      mediaType: img.mediaType,
      ...(img.savedPath ? { savedPath: img.savedPath } : {}),
      ...(img.isSticker ? { isSticker: true } : {}),
      ...(img.conversionFailed ? { conversionFailed: true } : {}),
    }));
  }
  if (documents && documents.length > 0) {
    out.documents = documents.map((doc) => ({
      mediaType: doc.mediaType,
      ...(doc.filename ? { filename: doc.filename } : {}),
      ...(doc.savedPath ? { savedPath: doc.savedPath } : {}),
    }));
  }
  return out;
}

/**
 * Transcript marker for an inbox message too old to answer when the daemon
 * came back (see `inboxReplayMaxAgeMinutes`), or whose channel is gone. Same
 * shape as SHUTDOWN_NOT_PROCESSED, so it reads as a visible non-answer.
 */
export const INBOX_STALE_NOT_PROCESSED = "[not processed — received before a restart and too old to answer]";

/** Note appended to a replayed message whose attachment bytes are gone. */
export const ATTACHMENT_NOT_RESTORED = "[an attachment sent with this message could not be restored after Tomo restarted]";

/**
 * Rebuild an IncomingMessage from its persisted form. Attachments come back
 * from their saved copies; one that was never saved (or has since gone) is
 * dropped with a note in the text, so the model knows something was there.
 */
export function restoreMessage(persisted: PersistedMessage): IncomingMessage {
  const { images, documents, ...rest } = persisted;
  const message: IncomingMessage = { ...rest };
  let lost = 0;
  const readB64 = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    try {
      return readFileSync(path).toString("base64");
    } catch {
      return undefined;
    }
  };
  if (images && images.length > 0) {
    const restored: ImageAttachment[] = [];
    for (const img of images) {
      const data = readB64(img.savedPath);
      if (data === undefined) { lost++; continue; }
      restored.push({ ...img, data });
    }
    if (restored.length > 0) message.images = restored;
  }
  if (documents && documents.length > 0) {
    const restored: DocumentAttachment[] = [];
    for (const doc of documents) {
      const data = readB64(doc.savedPath);
      if (data === undefined) { lost++; continue; }
      restored.push({ ...doc, data });
    }
    if (restored.length > 0) message.documents = restored;
  }
  if (lost > 0) {
    message.text = message.text ? `${message.text}\n${ATTACHMENT_NOT_RESTORED}` : ATTACHMENT_NOT_RESTORED;
  }
  return message;
}

const defaultWrite: WriteFn = (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length);

/**
 * Write all of `buffer`. `write(2)` may write fewer bytes than asked (a full
 * disk, a signal, a quota): the remainder is written in a loop, and a write
 * that makes no progress at all is an error, never a silent truncation.
 */
function writeAllSync(fd: number, buffer: Uint8Array, write: WriteFn): void {
  let offset = 0;
  while (offset < buffer.length) {
    const n = write(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`short write: ${offset} of ${buffer.length} bytes written`);
    offset += n;
  }
}

/** fsync a directory so a create or rename in it survives a power loss. */
function fsyncDir(dir: string): void {
  try {
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Some platforms refuse fsync on a directory; the entry itself is there.
  }
}

/** Temp-file name of a compaction of `path` (see writeFileDurableSync). */
function isCompactionTemp(path: string, name: string): boolean {
  return name.startsWith(`${basename(path)}.`) && name.endsWith(".tmp");
}

/**
 * Replace `path` so that a power loss leaves either the old file or the whole
 * new one: write and fsync a temp file, check it holds every byte, rename it
 * over, fsync the directory. (`writeFileAtomicSync` renames without syncing,
 * which is fine for a config file and not for a log that holds messages we
 * have already acknowledged.) A temp file of the wrong length is discarded
 * and the original kept: renaming a truncated log over a whole one would
 * delete acknowledged messages.
 */
function writeFileDurableSync(path: string, content: string, sync: boolean, write: WriteFn): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(content, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeAllSync(fd, bytes, write);
    if (sync) fsyncSync(fd);
    const size = fstatSync(fd).size;
    if (size !== bytes.length) throw new Error(`compaction temp file is ${size} bytes, expected ${bytes.length}`);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  if (sync) fsyncDir(dirname(path));
}

export class DurableInbox {
  readonly path: string;
  private readonly live = new Map<string, InboxRecord>();
  /** Consumed ids → when they were consumed. Insertion order ≈ consumption order. */
  private readonly seen = new Map<string, number>();
  private fd: number | undefined;
  private appendsSinceCompact = 0;
  /**
   * The log existed but could not be read. An unreadable source is not an
   * empty one: compaction would rewrite it from nothing, so it is disabled
   * for this process. Appends continue — the log is append-only, so nothing
   * already in it is touched.
   */
  private readFailed = false;
  private closed = false;
  /**
   * The last append failed part-way, so the file may end in a torn line. The
   * next append starts on a fresh line, or it would be glued to the fragment
   * and lost with it.
   */
  private tornTail = false;
  private readonly write: WriteFn;
  private readonly dedupRetentionMs: number;
  private readonly maxSeen: number;
  private readonly compactEvery: number;
  private readonly fsync: boolean;
  private readonly now: () => number;

  constructor(opts: DurableInboxOptions) {
    this.path = opts.path;
    this.dedupRetentionMs = opts.dedupRetentionMs ?? DEFAULT_DEDUP_RETENTION_MS;
    this.maxSeen = opts.maxSeen ?? DEFAULT_MAX_SEEN;
    this.compactEvery = opts.compactEvery ?? DEFAULT_COMPACT_EVERY;
    this.fsync = opts.fsync ?? true;
    this.now = opts.now ?? Date.now;
    this.write = opts.writeSync ?? defaultWrite;
    this.closed = opts.readOnly ?? false;
    if (!this.closed) this.removeStaleTemps();
    this.load();
  }

  /**
   * Dedup key. Provider message ids are only unique per chat on Telegram, and
   * an iMessage attachment follow-up shares its original's GUID (`inboxKey`
   * tells them apart; see IncomingMessage.inboxKey).
   */
  static idFor(channel: string, chatId: string, messageId: string, inboxKey?: string): string {
    return JSON.stringify(inboxKey ? [channel, chatId, messageId, inboxKey] : [channel, chatId, messageId]);
  }

  /** Is this message already known — pending or consumed? */
  has(id: string): boolean {
    return this.live.has(id) || this.seen.has(id);
  }

  /** Is this record still waiting for a turn (accepted, never started)? */
  isPending(id: string): boolean {
    return this.live.get(id)?.status === "received";
  }

  /** The live record for `id`, if any (a copy). */
  get(id: string): InboxRecord | undefined {
    const rec = this.live.get(id);
    return rec ? { ...rec } : undefined;
  }

  /** Snapshot of every unconsumed record, oldest first. */
  pending(): InboxRecord[] {
    return [...this.live.values()]
      .map((rec) => ({ ...rec }))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /**
   * Persist a message before custody is acknowledged. Synchronous and fsynced
   * on return, so a `true` handed back to the channel afterwards is backed by
   * disk.
   */
  accept(channelName: string, message: IncomingMessage, resolution: SessionResolution): AcceptResult {
    const id = DurableInbox.idFor(channelName, message.chatId, message.id, message.inboxKey);
    if (this.has(id)) return { status: "duplicate", id };
    if (this.closed) return { status: "unpersisted", reason: "closed" };
    const rec: RecvLine["rec"] = {
      id,
      channel: channelName,
      resolution: { ...resolution, replyTarget: { ...resolution.replyTarget } },
      message: persistableMessage(message),
      receivedAt: this.now(),
    };
    try {
      this.append({ op: "recv", v: 1, rec });
    } catch (err) {
      log.error({ err, path: this.path, channel: channelName }, "Durable inbox: could not persist inbound message");
      return { status: "unpersisted", reason: "failed" };
    }
    this.live.set(id, { ...rec, status: "received" });
    return { status: "accepted", id };
  }

  /**
   * A turn began consuming these. From here a crash is NOT replayed.
   *
   * A `start` that cannot be written is the dangerous direction: the log
   * still says `received`, so a crash before `done` would re-run a turn that
   * may already have replied. The write is retried once; if it still fails,
   * the whole log is rewritten (a different path to the disk — a fresh file
   * and a rename) with these records started. If that fails too, they are
   * marked `unreplayable` in memory — started for every purpose in this
   * process, so nothing here ever hands them to a replay and the next
   * successful compaction records them as started — and their ids are
   * returned so the caller can raise it.
   *
   * @returns ids whose `start` is NOT on disk (empty when all were written).
   */
  markStarted(ids: readonly string[]): string[] {
    const unwritten: InboxRecord[] = [];
    for (const id of ids) {
      const rec = this.live.get(id);
      if (!rec || rec.status === "started") continue;
      const at = this.now();
      rec.status = "started";
      rec.startedAt = at;
      if (this.tryAppend({ op: "start", id, at }) || this.tryAppend({ op: "start", id, at })) continue;
      unwritten.push(rec);
    }
    if (unwritten.length === 0) return [];
    if (this.compact()) return [];
    for (const rec of unwritten) rec.unreplayable = true;
    log.error(
      { path: this.path, ids: unwritten.map((r) => r.id) },
      "Durable inbox: could not record that a turn started; a crash before it ends could answer these messages twice",
    );
    return unwritten.map((r) => r.id);
  }

  /** Consumed (answered, dropped, or recorded). Kept only as a dedup tombstone. */
  markDone(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!this.live.has(id)) continue;
      const at = this.now();
      // A failed write leaves the record live: the worst case is a replay of
      // something already handled, which is the safer of the two errors.
      if (!this.tryAppend({ op: "done", id, at })) continue;
      this.live.delete(id);
      this.seen.set(id, at);
      changed = true;
    }
    if (changed && this.appendsSinceCompact >= this.compactEvery) this.compact();
  }

  close(): void {
    this.closed = true;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* best effort */ }
      this.fd = undefined;
    }
  }

  // -------------------------------------------------------------------------

  private tryAppend(line: LogLine): boolean {
    if (this.closed) return false;
    try {
      this.append(line);
      return true;
    } catch (err) {
      log.warn({ err, path: this.path, op: line.op }, "Durable inbox: append failed");
      return false;
    }
  }

  private append(line: LogLine): void {
    if (this.fd === undefined) {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true });
      const created = !existsSync(this.path);
      this.fd = openSync(this.path, "a", 0o600);
      // A new file's directory entry is not durable until the directory is:
      // without this, a power loss can take the whole log with it even though
      // every line in it was fsynced.
      if (created && this.fsync) fsyncDir(dir);
    }
    const text = `${this.tornTail ? "\n" : ""}${JSON.stringify(line)}\n`;
    try {
      writeAllSync(this.fd, Buffer.from(text, "utf8"), this.write);
      if (this.fsync) fsyncSync(this.fd);
    } catch (err) {
      this.tornTail = true;
      throw err;
    }
    this.tornTail = false;
    this.appendsSinceCompact++;
  }

  /** A compaction that died between writing its temp file and the rename leaves the temp behind. */
  private removeStaleTemps(): void {
    const dir = dirname(this.path);
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!isCompactionTemp(this.path, name)) continue;
      try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.readFailed = true;
      log.error({ err, path: this.path }, "Durable inbox: log unreadable; replay and dedup are off for this run, compaction disabled");
      return;
    }

    const records = parseJsonl<LogLine>(text, { preserveUnparseable: true });
    const raw = records.filter(isRawJsonlLine);
    if (raw.length > 0 && !this.closed) {
      reportRawJsonlLines(records, { file: this.path });
      this.quarantine(raw.map((line) => serializeJsonlRecord(line)));
    }

    for (const line of records) {
      if (isRawJsonlLine(line) || typeof line !== "object" || line === null) continue;
      this.applyLine(line);
    }
    this.compact();
  }

  private applyLine(line: LogLine): void {
    switch (line.op) {
      case "recv": {
        const rec = line.rec;
        if (!rec || typeof rec.id !== "string" || !rec.message || !rec.resolution) return;
        if (this.has(rec.id)) return;
        this.live.set(rec.id, { ...rec, status: "received" });
        return;
      }
      case "start": {
        const rec = this.live.get(line.id);
        if (rec) { rec.status = "started"; rec.startedAt = line.at; }
        return;
      }
      case "done":
      case "seen": {
        this.live.delete(line.id);
        this.seen.delete(line.id);
        this.seen.set(line.id, typeof line.at === "number" ? line.at : this.now());
        return;
      }
      default:
        return;
    }
  }

  /** Keep a line we could not read, instead of letting compaction erase it. */
  private quarantine(lines: string[]): void {
    const target = `${this.path}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    try {
      appendFileSync(target, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch (err) {
      // Without the copy the rewrite would lose them; keep the log as it is.
      this.readFailed = true;
      log.error({ err, path: this.path }, "Durable inbox: could not quarantine unreadable lines; compaction disabled");
    }
  }

  /**
   * Rewrite the log as just its live state plus recent dedup tombstones.
   * @returns whether the rewrite landed.
   */
  private compact(): boolean {
    if (this.readFailed || this.closed) return false;
    const cutoff = this.now() - this.dedupRetentionMs;
    for (const [id, at] of this.seen) {
      if (at < cutoff) this.seen.delete(id);
    }
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    const lines: LogLine[] = [];
    for (const [id, at] of this.seen) lines.push({ op: "seen", id, at });
    for (const rec of this.pending()) {
      const { status, startedAt, ...base } = rec;
      lines.push({ op: "recv", v: 1, rec: base });
      if (status === "started") lines.push({ op: "start", id: rec.id, at: startedAt ?? rec.receivedAt });
    }

    if (lines.length === 0 && !existsSync(this.path)) return true;
    try {
      writeFileDurableSync(this.path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), this.fsync, this.write);
    } catch (err) {
      log.warn({ err, path: this.path }, "Durable inbox: compaction failed; the original log is kept and keeps growing until the next one");
      return false;
    }
    // Only now: the descriptor points at the replaced file, so the next append
    // must reopen. Closed after a failed rewrite it would merely be reopened.
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* best effort */ }
      this.fd = undefined;
    }
    this.tornTail = false;
    this.appendsSinceCompact = 0;
    for (const rec of this.live.values()) delete rec.unreplayable;
    return true;
  }
}
