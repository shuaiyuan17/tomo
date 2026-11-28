/**
 * Reading a session's transcript back: the substring search behind
 * `recall_conversation` and the CLI (`searchTranscript`), the scored recall
 * (`recallTranscript`) and the compacted-archive search (`searchArchive`).
 * Read-only: nothing here writes a file or any of SessionStore's state.
 * SessionStore keeps the public methods and forwards here.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "./types.js";
import { log } from "../logger.js";
import { textOfContent, type TranscriptEvent } from "./transcript-event.js";
import { readJsonlFileSync, readFirstJsonlRecordSync, iterateJsonlBackwardsSync, type JsonlReadProgress } from "../jsonl.js";
import { usableSeq, usableTimestamp, orderTimestamp } from "./transcript-order.js";
import { RecallScorer } from "./recall-score.js";
import type { TranscriptReadFile } from "./store-support.js";

/** What a search needs from SessionStore. */
export interface TranscriptSource {
  /** The key's files in read order, newest first (SessionStore.transcriptReadSet). */
  readSet(key: string): { files: TranscriptReadFile[]; hasSidecars: boolean };
  /** The key's transcript may not be read yet (SessionStore.withholdsTranscript). Asked before `readSet`. */
  withheld(key: string): boolean;
}

/** What bounds one scored transcript search (`recallTranscript`). */
export interface RecallScanBudget {
  /** Wall time, in milliseconds. */
  maxMs: number;
  /** Bytes read from the transcript files. */
  maxBytes: number;
  /** Millisecond clock; tests pass their own. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * The search runs synchronously on the daemon's event loop, so this is how
 * long one `recall_conversation` call may hold up everything else. A direct
 * message transcript of about 30,000 records scans in well under it.
 *
 * Time is the real bound. A long-lived transcript grows by a megabyte or two a
 * month and scans at roughly 5 ms per megabyte, so a byte cap near today's size
 * would cut every undated search short long before the time budget mattered.
 * `maxBytes` stays only as a backstop for a pathological disk (one far larger
 * than the time budget could read), set well past what 300 ms can scan.
 */
export const RECALL_SCAN_BUDGET: Readonly<RecallScanBudget> = { maxMs: 300, maxBytes: 256 * 1024 * 1024 };
const RECALL_CLOCK_EVERY = 64;
/** How far into a file the scan looks for its first record before deciding
 *  whether `toTime` rules the whole file out. */
const RECALL_FILE_PROBE_BYTES = 64 * 1024;

function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface RecallCandidate {
  msg: SessionMessage;
  fileIndex: number;
  position: number;
}

export interface TranscriptRecallHit {
  msg: SessionMessage;
  score: number;
  /** Index in `msg.content` of the first matched word, for an excerpt around it. */
  matchIndex: number;
}

export interface TranscriptRecall {
  /** The best matches, oldest first. */
  hits: TranscriptRecallHit[];
  /** How many records passed the score filter, before `limit`. */
  matched: number;
  /** Records read inside the scan. */
  scanned: number;
  /** Records too long to score whole: only their beginning was searched
   *  (`RECALL_MAX_SCORED_CHARS`). Absent when there were none. */
  clipped?: number;
  /**
   * Set when the scan ran out of budget before reaching the window's lower
   * bound. `reachedBackTo` is the timestamp of the oldest record it passed, or
   * null when that is unknown or means nothing (a read set that is not in
   * time order).
   */
  stopped?: { reason: "time" | "bytes"; reachedBackTo: number | null };
  /** Bytes the scan read, probes included: what it spent of `maxBytes`. */
  bytesRead?: number;
}

/**
 * Search the transcript by text query, optionally filtered by seq/time
 * range. Returns the most recent `limit` matches in chronological order —
 * an assistant recalling things almost always wants the latest mentions,
 * not the oldest.
 *
 * Streams newest-first from disk with early exit, so the full transcript
 * is never materialized; continues into monthly rotation archives when the
 * active file doesn't fill the limit.
 *
 * THE EARLY EXIT IS ONLY SOUND WHILE THE READ SET IS CHRONOLOGICAL, i.e.
 * while there is no read-only legacy sidecar in it (see
 * `transcriptReadSet`). When there is one, the scan moves to
 * `searchTranscriptUnordered` below: every file read in full, every record
 * filtered on its own, and the merged result ordered by the records'
 * timestamps. `recall_conversation`'s `after` was the live casualty — a
 * `fromTime` lower bound ended the scan at the first record behind it and
 * abandoned every file after that one, returning nothing while the records
 * sat on disk.
 */
export function searchTranscript(src: TranscriptSource, key: string, opts: {
  query?: string;
  fromSeq?: number;
  toSeq?: number;
  fromTime?: number;
  toTime?: number;
  limit?: number;
}): SessionMessage[] {
  // WITHHELD FOR THE SAME REASON `get()` WITHHOLDS THE SESSION: while this
  // key's own filename is known to hold another key's history too and the
  // quarantine has not landed, a search of that file is a search of the other
  // session's messages — and `recall_conversation` is the caller.
  if (src.withheld(key)) return [];
  const limit = opts.limit ?? 50;
  const results: SessionMessage[] = [];
  const queryLower = opts.query?.toLowerCase();
  // Sidecars included: a legacy file the migration could not rename is still
  // this key's history, and a search that cannot see it is the exact defect
  // the sidecar rule exists to avoid.
  const readSet = src.readSet(key);
  if (readSet.hasSidecars) return searchTranscriptUnordered(readSet.files, opts, limit, queryLower);
  const files = readSet.files.map((file) => file.path);

  // Records skipped for being unplaceable under a bound, per file. Said
  // once per file after its scan, not once per record: the degenerate case
  // below can skip every line of a large transcript, and the point is only
  // that a search that reports "N message(s)" silently left some out.
  let skipped = 0;
  const noteSkipped = (file: string): void => {
    if (skipped > 0) log.debug({ file, skipped }, "Skipped transcript records that cannot be placed in the search window");
    skipped = 0;
  };

  outer: for (const file of files) {
    for (const msg of iterateJsonlBackwardsSync<SessionMessage>(file)) {
      // Scanning newest→oldest: once past the window's lower bound, nothing
      // older can match — but only a record whose position is KNOWN may end
      // the scan. `break outer` abandons the rest of this file AND every
      // rotation archive behind it, so a record that cannot be placed in the
      // window (no seq, no timestamp, a `timestamp: 0` legacy record) is
      // skipped instead, exactly like the non-string-content guard below.
      // `fromTime` is the live path: recall_conversation's `after` is the
      // only lower bound any caller passes, and one epoch-0 record used to
      // end the search while it still reported success.
      //
      // The cost of that choice is bounded by the transcript: if EVERY record
      // is unplaceable under the requested bound (a pre-seq legacy transcript
      // searched by `fromSeq`), the scan reads the whole active file and every
      // archive to return nothing, where it used to stop at the first record.
      // The live `fromTime` path cannot hit this — every channel writes a
      // millisecond `Date`-derived timestamp — so it is a CLI-only cost.
      const seq = usableSeq(msg);
      const time = usableTimestamp(msg);

      if (opts.fromSeq != null) {
        if (seq == null) { skipped++; continue; }
        if (seq < opts.fromSeq) break outer;
      }
      if (opts.fromTime != null) {
        if (time == null) { skipped++; continue; }
        if (time < opts.fromTime) break outer;
      }
      // Upper bounds exclude an unplaceable record rather than coercing it
      // to 0 and silently accepting it into every bounded result.
      if (opts.toSeq != null) {
        if (seq == null) { skipped++; continue; }
        if (seq > opts.toSeq) continue;
      }
      if (opts.toTime != null) {
        if (time == null) { skipped++; continue; }
        if (time > opts.toTime) continue;
      }
      // Legacy/hand-edited records may lack a string content — skip rather
      // than throw out of the whole search (this backs an agent tool call).
      if (typeof msg.content !== "string") continue;
      if (queryLower && !msg.content.toLowerCase().includes(queryLower)) continue;

      results.push(msg);
      if (results.length >= limit) break outer;
    }
    noteSkipped(file);
  }
  // The `break outer` paths leave the current file's count unreported.
  noteSkipped(files[files.length - 1] ?? "");

  return results.reverse();
}

/**
 * `searchTranscript` over a read set that contains a READ-ONLY LEGACY
 * SIDECAR, whose position in time its filename does not give away.
 *
 * Three differences from the ordered path, all forced by that:
 *
 * - NO EARLY EXIT, across files or within one. A record behind the window's
 *   lower bound says nothing about the records after it here, so every file
 *   is read in full and every record is judged on its own. That costs a full
 *   family scan per search — bounded by the transcript, paid only while a
 *   sidecar exists, and the alternative is the silent truncation above.
 * - THE MERGED RESULT IS ORDERED BY THE RECORDS, not by the files. Newest
 *   first for the `limit`, ties broken by file order then by position inside
 *   the file, then reversed into chronological order for the caller.
 * - SEQ BOUNDS APPLY TO THE ACTIVE FAMILY ONLY. `seq` is unique inside the
 *   active file and its rotation archives; a sidecar is a different run that
 *   no writer will continue, so its numbers are not comparable with the
 *   active family's at all. Comparing them would be arithmetic on two
 *   different scales, so `fromSeq`/`toSeq` are IGNORED for sidecar records
 *   (which therefore stay in the result) rather than quietly filtering them.
 *   `fromTime`/`toTime` are absolute and apply everywhere.
 */
function searchTranscriptUnordered(
  files: readonly TranscriptReadFile[],
  opts: { query?: string; fromSeq?: number; toSeq?: number; fromTime?: number; toTime?: number },
  limit: number,
  queryLower: string | undefined,
): SessionMessage[] {
  const hits: { msg: SessionMessage; fileIndex: number; position: number }[] = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const { path, sidecar } = files[fileIndex];
    let skipped = 0;
    let position = 0;
    for (const msg of iterateJsonlBackwardsSync<SessionMessage>(path)) {
      position++;
      const seq = usableSeq(msg);
      const time = usableTimestamp(msg);
      // A record that cannot be placed under a bound the caller asked for is
      // skipped, never used to end the scan — same rule as the ordered path,
      // with the seq bounds scoped to the active family.
      if (!sidecar && opts.fromSeq != null) {
        if (seq == null) { skipped++; continue; }
        if (seq < opts.fromSeq) continue;
      }
      if (!sidecar && opts.toSeq != null) {
        if (seq == null) { skipped++; continue; }
        if (seq > opts.toSeq) continue;
      }
      if (opts.fromTime != null) {
        if (time == null) { skipped++; continue; }
        if (time < opts.fromTime) continue;
      }
      if (opts.toTime != null) {
        if (time == null) { skipped++; continue; }
        if (time > opts.toTime) continue;
      }
      if (typeof msg.content !== "string") continue;
      if (queryLower && !msg.content.toLowerCase().includes(queryLower)) continue;
      hits.push({ msg, fileIndex, position });
    }
    if (skipped > 0) {
      log.debug({ file: path, skipped }, "Skipped transcript records that cannot be placed in the search window");
    }
  }

  hits.sort((a, b) => {
    const ta = orderTimestamp(a.msg);
    const tb = orderTimestamp(b.msg);
    if (ta !== tb) return ta < tb ? 1 : -1;
    if (a.fileIndex !== b.fileIndex) return a.fileIndex - b.fileIndex;
    return a.position - b.position;
  });

  // NO DEDUPE. An interrupted rotation that a sidecar preserved can hold the
  // same record in two files at once (the legacy active file and the archive
  // the rotation had already appended it to), and that duplicate is permanent
  // on disk — sidecars are never rewritten. Collapsing it HERE cost more than
  // it bought: the only key available is the record's own content, and two
  // different senders' identical messages in the same millisecond (a group
  // chat's "ok", a broadcast delivered to two people) are indistinguishable
  // from one record read twice, so the filter deleted real messages from
  // search results and from `recall_conversation`. It also applied WITHIN one
  // file, where a duplicate is not a rotation artefact at all but two genuine
  // identical messages. Reading a preserved duplicate twice is visible and
  // harmless; dropping someone's message is neither.
  return hits.slice(0, limit).map((hit) => hit.msg).reverse();
}

/**
 * Scored search of the transcript: `recall_conversation` with a query.
 *
 * Where `searchTranscript` keeps the most recent records that contain one
 * substring, this scores every record in the window against each phrasing
 * in `queries` (see recall-score.ts) and keeps the best `limit`. The scores
 * weigh a word by how rare it is among the records scanned, so there is no
 * early exit on `limit`: the window is read to its lower bound.
 *
 * THAT READ IS SYNCHRONOUS, ON THE DAEMON'S EVENT LOOP, so it is bounded.
 * It stops when the window's lower bound is reached, or when `budget` runs
 * out (wall time or bytes read from disk), whichever comes first, and
 * `stopped` then says how far back it got. The caller reports that rather
 * than presenting a partial scan as the whole history.
 *
 * `before` only saves reading at the grain of a file: a file that starts
 * after `toTime` is passed over, but inside a file the scan still runs from
 * its newest record, and what it passes on the way to the window is charged
 * to the budget. So a retry with `toTime` set to where the last scan
 * stopped gets further only while the part of that file above `toTime`
 * fits the budget. When it does not, the scan stops above `toTime` again
 * and `stopped.reachedBackTo` shows it (it is not below `toTime`): the
 * caller says that part of history is out of reach rather than suggesting
 * another retry. Getting past that needs an offset index, which this is not.
 *
 * The window rules are `searchTranscript`'s: only a record whose time is
 * known may end the scan, and a record that cannot be placed under a bound
 * is skipped. A file that starts after `toTime` is passed over unread. With a read-only legacy sidecar in the read set the files are
 * not in time order, so nothing ends the scan but the budget, and the result
 * is ordered by the records' own timestamps.
 */
export function recallTranscript(src: TranscriptSource, key: string, opts: {
  queries: readonly string[];
  fromTime?: number;
  toTime?: number;
  limit?: number;
  budget?: Partial<RecallScanBudget>;
}): TranscriptRecall {
  const scorer = new RecallScorer<RecallCandidate>(opts.queries);
  // Same withholding as `searchTranscript`: this is the same read.
  if (scorer.isEmpty || src.withheld(key)) return { hits: [], matched: 0, scanned: 0 };
  const limit = opts.limit ?? 50;
  const budget = { ...RECALL_SCAN_BUDGET, ...opts.budget };
  const now = budget.now ?? (() => performance.now());
  const startedAt = now();
  const progress: JsonlReadProgress = {
    bytesRead: 0,
    maxBytes: budget.maxBytes,
    outOfTime: () => now() - startedAt > budget.maxMs,
  };
  const readSet = src.readSet(key);
  const ordered = !readSet.hasSidecars;

  let scanned = 0;
  let stopped: TranscriptRecall["stopped"];
  // The oldest placeable record the scan has passed: how far back it got.
  let reachedBackTo: number | null = null;
  const exhausted = (): "time" | "bytes" | null => {
    if (progress.timedOut) return "time";
    if (progress.bytesRead > budget.maxBytes) return "bytes";
    // The clock is read once per few records: a search of tens of thousands
    // of short records should not spend its budget asking the time.
    if (scanned % RECALL_CLOCK_EVERY === 0 && now() - startedAt > budget.maxMs) return "time";
    return null;
  };

  outer: for (let fileIndex = 0; fileIndex < readSet.files.length; fileIndex++) {
    const { path } = readSet.files[fileIndex];
    // A file that begins after the window's upper bound holds nothing in
    // it, and is not read: this is what lets `before` reach history that a
    // scan from the newest record would run out of budget before touching.
    // It leans on the same fact as the lower bound's early exit, that a
    // chronological read set is in time order inside each file too, and
    // like it only a record whose time is known may decide.
    if (ordered && opts.toTime != null) {
      // The looks are reads too: a long run of files passed over must not
      // add up to more than the scan may spend.
      const reason = progress.bytesRead > budget.maxBytes ? "bytes" : now() - startedAt > budget.maxMs ? "time" : null;
      if (reason) {
        stopped = { reason, reachedBackTo };
        break;
      }
      // One bounded look, charged to the budget: a file whose first record
      // is not within it is simply read like any other.
      const first = readFirstJsonlRecordSync<SessionMessage>(path, RECALL_FILE_PROBE_BYTES);
      progress.bytesRead += Math.min(RECALL_FILE_PROBE_BYTES, safeFileSize(path));
      const firstTime = first ? usableTimestamp(first) : null;
      if (firstTime != null && firstTime > opts.toTime) continue;
    }
    let position = 0;
    let skipped = 0;
    for (const msg of iterateJsonlBackwardsSync<SessionMessage>(path, undefined, progress)) {
      position++;
      const time = usableTimestamp(msg);
      const belowWindow = opts.fromTime != null && time != null && time < opts.fromTime;
      // Reaching the lower bound in a chronological read set is the scan
      // finishing, so it is tested before the budget: a scan that got all
      // the way there is not reported as cut short.
      if (belowWindow && ordered) break outer;
      const reason = exhausted();
      if (reason) {
        stopped = { reason, reachedBackTo: ordered ? reachedBackTo : null };
        if (skipped > 0) log.debug({ file: path, skipped }, "Skipped transcript records that cannot be placed in the search window");
        break outer;
      }
      scanned++;
      if (belowWindow) continue;
      if (time != null) reachedBackTo = time;
      if ((opts.fromTime != null || opts.toTime != null) && time == null) { skipped++; continue; }
      if (opts.toTime != null && time != null && time > opts.toTime) continue;
      if (typeof msg.content !== "string") continue;
      scorer.observe({ msg, fileIndex, position }, msg.content);
    }
    if (skipped > 0) log.debug({ file: path, skipped }, "Skipped transcript records that cannot be placed in the search window");
    // The reader itself stopped at the byte budget, part-way through a line
    // too long to yield or a run of lines that do not parse.
    if (progress.cutShort) {
      stopped = { reason: progress.timedOut ? "time" : "bytes", reachedBackTo: ordered ? reachedBackTo : null };
      break;
    }
  }

  // Newest first. In a chronological read set that is the order the records
  // were read in; with a sidecar it is the records' own timestamps, ties by
  // file then position, as in `searchTranscriptUnordered`.
  const newestFirst = (a: RecallCandidate, b: RecallCandidate): number => {
    if (!ordered) {
      const ta = orderTimestamp(a.msg);
      const tb = orderTimestamp(b.msg);
      if (ta !== tb) return ta < tb ? 1 : -1;
    }
    if (a.fileIndex !== b.fileIndex) return a.fileIndex - b.fileIndex;
    return a.position - b.position;
  };
  const { hits, matched } = scorer.results(limit, newestFirst);
  return {
    hits: hits.map((hit) => ({ msg: hit.item.msg, score: hit.score, matchIndex: hit.matchIndex })),
    matched,
    scanned,
    ...(scorer.clippedMessages > 0 ? { clipped: scorer.clippedMessages } : {}),
    ...(stopped ? { stopped } : {}),
    bytesRead: progress.bytesRead,
  };
}

/** Search archive files (compacted SDK events) for a given session ID */
export function searchArchive(dir: string, sdkSessionId: string, opts: {
  query?: string;
  limit?: number;
}): SessionMessage[] {
  const archivePath = join(dir, `_archive_${sdkSessionId}.jsonl`);
  if (!existsSync(archivePath)) return [];

  const limit = opts.limit ?? 50;
  const results: SessionMessage[] = [];
  const queryLower = opts.query?.toLowerCase();

  for (const event of readJsonlFileSync<TranscriptEvent>(archivePath)) {
    try {
      if (event.type !== "user" && event.type !== "assistant") continue;

      // Extract text from SDK event format
      const msg = event.message;
      if (!msg) continue;

      const text = textOfContent(msg.content, " ", { missing: "empty", nonString: "stringify" }).trim();
      if (!text) continue;

      if (queryLower && !text.toLowerCase().includes(queryLower)) continue;

      const ts = event.timestamp ? new Date(event.timestamp).getTime() : 0;
      results.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: text,
        channel: "archive",
        timestamp: ts,
      });

      if (results.length >= limit) break;
    } catch {
      // Skip malformed lines
    }
  }

  return results;
}
