import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DocumentAttachment, ImageAttachment, IncomingMessage } from "../channels/types.js";
import { writeFileAtomicSync } from "../fs-utils.js";
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
}

type RecvLine = { op: "recv"; v: 1; rec: Omit<InboxRecord, "status" | "startedAt"> };
type MarkLine = { op: "start" | "done" | "seen"; id: string; at: number };
type LogLine = RecvLine | MarkLine;

export type AcceptResult =
  | { status: "accepted"; id: string }
  /** Already known (pending or consumed): the caller must not dispatch it again. */
  | { status: "duplicate"; id: string }
  /** The write failed. The caller keeps the old in-memory behaviour for this one. */
  | { status: "unpersisted" };

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
  now?: () => number;
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
    this.load();
  }

  /** Dedup key. Provider message ids are only unique per chat on Telegram. */
  static idFor(channel: string, chatId: string, messageId: string): string {
    return JSON.stringify([channel, chatId, messageId]);
  }

  /** Is this message already known — pending or consumed? */
  has(id: string): boolean {
    return this.live.has(id) || this.seen.has(id);
  }

  /** Is this record still waiting for a turn (accepted, never started)? */
  isPending(id: string): boolean {
    return this.live.get(id)?.status === "received";
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
    const id = DurableInbox.idFor(channelName, message.chatId, message.id);
    if (this.has(id)) return { status: "duplicate", id };
    if (this.closed) return { status: "unpersisted" };
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
      log.error({ err, path: this.path, channel: channelName }, "Durable inbox: could not persist inbound message; continuing in memory");
      return { status: "unpersisted" };
    }
    this.live.set(id, { ...rec, status: "received" });
    return { status: "accepted", id };
  }

  /** A turn began consuming these. From here a crash is NOT replayed. */
  markStarted(ids: readonly string[]): void {
    for (const id of ids) {
      const rec = this.live.get(id);
      if (!rec || rec.status === "started") continue;
      const at = this.now();
      if (!this.tryAppend({ op: "start", id, at })) continue;
      rec.status = "started";
      rec.startedAt = at;
    }
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
      mkdirSync(dirname(this.path), { recursive: true });
      this.fd = openSync(this.path, "a", 0o600);
    }
    writeSync(this.fd, `${JSON.stringify(line)}\n`);
    if (this.fsync) fsyncSync(this.fd);
    this.appendsSinceCompact++;
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
    if (raw.length > 0) {
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

  /** Rewrite the log as just its live state plus recent dedup tombstones. */
  private compact(): void {
    if (this.readFailed || this.closed) return;
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

    if (lines.length === 0 && !existsSync(this.path)) return;
    try {
      if (this.fd !== undefined) {
        closeSync(this.fd);
        this.fd = undefined;
      }
      writeFileAtomicSync(this.path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
      this.appendsSinceCompact = 0;
    } catch (err) {
      log.warn({ err, path: this.path }, "Durable inbox: compaction failed; the log keeps growing until the next one");
    }
  }
}
