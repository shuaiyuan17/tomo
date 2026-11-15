import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RequestState } from "./protocol.js";

/**
 * Durable custody for browser messages (append-only JSONL, 0600, fsynced).
 *
 * WRITTEN BEFORE THE BROWSER HEARS "ACCEPTED". A `recv` record is on disk
 * before `WebChannel.receive` hands the message to the Agent, so a hard crash
 * after the 202 can no longer lose it without a trace; a terminal `state`
 * record follows when the request settles.
 *
 * NEVER REPLAYED. A request with no terminal record when the daemon starts
 * may have been handed to the SDK and partly acted on, and the browser that
 * sent it is gone; running it again could repeat whatever it did. It is
 * marked `interrupted` instead (the cron policy for an interrupted run), the
 * browser shows it as such, and the owner's session is told once.
 *
 * AN INTERRUPTED REQUEST KEEPS ITS FULL TEXT until it is RESOLVED: found in
 * the transcript (`recorded`) or dismissed by the owner in the browser
 * (`dismissed`). Neither compaction nor the receipt cap ever drops it before
 * that; WebChannel refuses new requests instead when the backlog is too big.
 * Text of settled requests is dropped at settlement.
 *
 * FAILS CLOSED. If the file cannot be read, or a record before the last line
 * is unreadable, `load()` throws, the journal stays unloaded, and nothing ever
 * rewrites or appends to the file; WebChannel then refuses new requests. Only
 * a torn LAST line (a crash mid-append, so that request never got its 202) is
 * skipped.
 *
 * The journal also keeps request-id dedup across restarts: a browser that
 * resends the same request id after a restart gets the recorded outcome (or
 * 409 on different text), never a second execution.
 *
 * Bounded: the last {@link MAX_JOURNAL_RECEIPTS} resolved requests are kept.
 * The file is rewritten (temp + fsync + rename + directory fsync) on load and
 * after every {@link COMPACT_EVERY} appends.
 */
export const MAX_JOURNAL_RECEIPTS = 4096;
export const COMPACT_EVERY = 1000;

const TERMINAL: ReadonlySet<RequestState> = new Set(["completed", "failed", "refused", "unknown", "interrupted"]);

export type Resolution = "recorded" | "dismissed";
type JournalRecord =
  /** `images`: where the message's attached images were filed (memory/incoming-images), kept with the text. */
  | { op: "recv"; id: string; digest: string; ts: number; text?: string; images?: string[] }
  | { op: "state"; id: string; state: RequestState }
  | { op: "resolve"; id: string; how: Resolution }
  /** The owner's session has been told about this interrupted request. */
  | { op: "notified"; id: string };

export interface JournalEntry { requestId: string; digest: string; timestamp: number; state: RequestState; text?: string; images?: string[] }
export interface JournalLoad {
  /** Every retained request, oldest first. Unresolved interrupted ones carry their full text. */
  entries: JournalEntry[];
  /** Requests this load found unsettled and marked interrupted. */
  interrupted: JournalEntry[];
  /** Every interrupted request (this load's or an earlier one's) whose owner
   *  notice is not yet recorded as given: a crash between persisting
   *  "interrupted" and queueing the notice must not lose the notice. */
  unnotified: JournalEntry[];
}

interface Entry extends JournalEntry { resolved?: Resolution; notified?: boolean }

export class JournalUnavailableError extends Error {
  constructor(cause: unknown) { super("Web request journal is unreadable"); this.cause = cause; this.name = "JournalUnavailableError"; }
}

export class WebRequestJournal {
  private entries = new Map<string, Entry>();
  private appends = 0;
  private loaded = false;
  private readonly maxReceipts: number;
  private readonly compactEvery: number;

  constructor(private readonly path: string, options: { maxReceipts?: number; compactEvery?: number } = {}) {
    this.maxReceipts = options.maxReceipts ?? MAX_JOURNAL_RECEIPTS;
    this.compactEvery = options.compactEvery ?? COMPACT_EVERY;
  }

  /**
   * Read the previous run's records, mark what it left unsettled, and compact.
   * Throws {@link JournalUnavailableError} (and leaves the file untouched) if
   * the journal cannot be read in full.
   */
  load(): JournalLoad {
    let raw = "";
    try { raw = readFileSync(this.path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new JournalUnavailableError(err);
    }
    const entries = new Map<string, Entry>();
    const lines = raw.split("\n");
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === "") last--;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let record: JournalRecord;
      try { record = JSON.parse(line) as JournalRecord; } catch (err) {
        if (index === last && !raw.endsWith("\n")) continue; // torn tail: never acknowledged
        throw new JournalUnavailableError(err);
      }
      if (record?.op === "recv" && typeof record.id === "string" && typeof record.digest === "string") {
        entries.delete(record.id);
        entries.set(record.id, { requestId: record.id, digest: record.digest, timestamp: Number(record.ts) || 0,
          state: "queued", ...(typeof record.text === "string" ? { text: record.text } : {}),
          ...(Array.isArray(record.images) && record.images.every((p: unknown) => typeof p === "string") ? { images: record.images.slice(0, 6) } : {}) });
      } else if (record?.op === "state" && typeof record.id === "string") {
        const entry = entries.get(record.id);
        if (entry) { entry.state = record.state; if (record.state !== "interrupted") { delete entry.text; delete entry.images; } }
      } else if (record?.op === "resolve" && typeof record.id === "string") {
        const entry = entries.get(record.id);
        if (entry) { entry.resolved = record.how; delete entry.text; delete entry.images; }
      } else if (record?.op === "notified" && typeof record.id === "string") {
        const entry = entries.get(record.id);
        if (entry) entry.notified = true;
      }
    }
    this.entries = entries;
    this.loaded = true;
    const interrupted: JournalEntry[] = [];
    for (const entry of this.entries.values()) {
      if (TERMINAL.has(entry.state)) continue;
      entry.state = "interrupted";
      interrupted.push(this.view(entry));
    }
    this.trim();
    this.compact();
    const unnotified = [...this.entries.values()].filter((e) => e.state === "interrupted" && !e.notified).map((e) => this.view(e));
    return { entries: [...this.entries.values()].map((e) => this.view(e)), interrupted, unnotified };
  }

  /** Durable before custody: throws when the record could not be fsynced. */
  recordReceived(requestId: string, digest: string, text: string, timestamp: number, images?: string[]): void {
    // In the map BEFORE the append: an append can trigger compaction, which
    // rewrites the file from the map and would otherwise drop this record.
    const previous = this.entries.get(requestId);
    this.entries.delete(requestId);
    this.entries.set(requestId, { requestId, digest, timestamp, state: "queued", text, ...(images?.length ? { images } : {}) });
    try { this.append({ op: "recv", id: requestId, digest, ts: timestamp, text, ...(images?.length ? { images } : {}) }); } catch (err) {
      this.entries.delete(requestId);
      if (previous) this.entries.set(requestId, previous);
      throw err;
    }
    this.trim();
  }

  /** Terminal outcome. Best effort: a lost record reads back as interrupted, the cautious side. */
  recordState(requestId: string, state: RequestState): void {
    const entry = this.entries.get(requestId);
    if (!this.loaded || !entry || !TERMINAL.has(state) || entry.state === state) return;
    entry.state = state;
    if (state !== "interrupted") { delete entry.text; delete entry.images; }
    try { this.append({ op: "state", id: requestId, state }); } catch { /* Read back as interrupted. */ }
  }

  /** An interrupted request is in the transcript, or the owner dismissed it: its text may go. Throws if not persisted. */
  resolve(requestId: string, how: Resolution): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.state !== "interrupted" || entry.resolved) return;
    // Applied BEFORE the append, which may compact from the map (see
    // recordReceived); undone if the record could not be written.
    const text = entry.text;
    const images = entry.images;
    entry.resolved = how;
    delete entry.text;
    delete entry.images;
    try { this.append({ op: "resolve", id: requestId, how }); } catch (err) {
      delete entry.resolved;
      if (text !== undefined) entry.text = text;
      if (images) entry.images = images;
      throw err;
    }
  }

  /** The owner notice for these interrupted requests is queued (durably): don't send it again. Throws if not persisted. */
  markNotified(requestIds: Iterable<string>): void {
    for (const id of requestIds) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== "interrupted" || entry.notified) continue;
      entry.notified = true; // before the append, which may compact from the map
      try { this.append({ op: "notified", id }); } catch (err) { delete entry.notified; throw err; }
    }
  }

  private view(entry: Entry): JournalEntry {
    return { requestId: entry.requestId, digest: entry.digest, timestamp: entry.timestamp, state: entry.state,
      ...(entry.text !== undefined ? { text: entry.text } : {}), ...(entry.images ? { images: [...entry.images] } : {}) };
  }

  /** Holds text the owner has not dealt with yet: never evicted. */
  private pinned(entry: Entry): boolean {
    if (entry.state === "interrupted" && !entry.notified) return true;
    return entry.text !== undefined && (!TERMINAL.has(entry.state) || (entry.state === "interrupted" && !entry.resolved));
  }

  private trim(): void {
    let excess = this.entries.size - this.maxReceipts;
    if (excess <= 0) return;
    for (const [id, entry] of this.entries) {
      if (excess <= 0) break;
      if (this.pinned(entry)) continue;
      this.entries.delete(id);
      excess--;
    }
  }

  private append(record: JournalRecord): void {
    if (!this.loaded) throw new Error("Web request journal used before a successful load()");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (++this.appends >= this.compactEvery) this.compact();
  }

  /** Rewrite the file from the retained entries; text only where still needed. */
  private compact(): void {
    if (!this.loaded) return;
    this.appends = 0;
    const lines: string[] = [];
    for (const entry of this.entries.values()) {
      const text = this.pinned(entry) ? entry.text : undefined;
      const images = this.pinned(entry) ? entry.images : undefined;
      lines.push(JSON.stringify({ op: "recv", id: entry.requestId, digest: entry.digest, ts: entry.timestamp, ...(text !== undefined ? { text } : {}), ...(images ? { images } : {}) }));
      if (TERMINAL.has(entry.state)) lines.push(JSON.stringify({ op: "state", id: entry.requestId, state: entry.state }));
      if (entry.resolved) lines.push(JSON.stringify({ op: "resolve", id: entry.requestId, how: entry.resolved }));
      if (entry.notified) lines.push(JSON.stringify({ op: "notified", id: entry.requestId }));
    }
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, lines.length ? `${lines.join("\n")}\n` : ""); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
      try { const dir = openSync(dirname(this.path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Directory fsync is advisory on some filesystems. */ }
    } catch {
      // Compaction is an optimisation: the append-only file stays valid.
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}
