import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, statSync, readdirSync, openSync, closeSync, readSync, fstatSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Session, SessionMessage, SessionEntry, SessionRegistry, ReplyTarget } from "./types.js";
import { isDmSessionKey } from "./keys.js";
import { log } from "../logger.js";
import {
  parseJsonl, readJsonlFileSync, readJsonlTailSync, readFirstJsonlRecordSync, iterateJsonlBackwardsSync,
  isRawJsonlLine, reportRawJsonlLines, serializeJsonlRecord, type RawJsonlLine,
} from "../jsonl.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { watchBus } from "../watch/bus.js";
import { clip, TRANSCRIPT_TEXT_LIMIT } from "../watch/protocol.js";

const UNLINKED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Floor for the in-memory transcript tail: enough to cover historyLimit user
// turns with generous margin (a turn is typically 2-3 messages) while keeping
// months of history out of daemon memory.
const TRANSCRIPT_TAIL_MIN = 200;
// Rotate the active transcript once it outgrows this; prior months move to
// _archive_<key>_<YYYY-MM>.jsonl siblings.
const TRANSCRIPT_ROTATE_BYTES = 2 * 1024 * 1024;

function monthOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/** Ordering guard for rotation crash recovery: prefer the monotonic seq,
 *  fall back to timestamps for legacy messages without one. */
function isAfterMessage(msg: SessionMessage, last: SessionMessage): boolean {
  if (msg.seq != null && last.seq != null) return msg.seq > last.seq;
  return msg.timestamp > last.timestamp;
}

/**
 * A rotation that has been running for longer than this is assumed dead — the
 * process crashed, or was killed between the lock and its release.
 *
 * GENEROUS ON PURPOSE. The transcript is not "at most a few MB": rotation is
 * skipped for the rest of a month once everything in the file is current, so
 * a busy session can be far larger than the rotate threshold by the time the
 * month turns, and a slow disk can make that rewrite take a while. The two
 * errors are not symmetric. A crashed rotator's lock that outlives this only
 * delays an optimization; a LIVE rotator's lock taken over destroys data —
 * both rotators rename over the transcript. So the threshold errs long, and
 * the install step re-checks ownership regardless (see rotateFromSnapshot).
 */
const ROTATE_LOCK_STALE_MS = 10 * 60_000;

/**
 * How far into the future a lock's mtime may sit before it is read as wrong
 * rather than merely imprecise.
 *
 * A lock created microseconds ago can time-stamp a hair AHEAD of `Date.now()`
 * — filesystem timestamp granularity and clock reads are not the same source —
 * so "any negative age" is not a usable definition of "dated in the future".
 * Five seconds is far outside that noise and far inside ROTATE_LOCK_STALE_MS.
 */
const ROTATE_LOCK_FUTURE_SKEW_MS = 5_000;

interface RotationLock {
  release: () => void;
  /** Is the lock on disk still the one we took? Never throws. */
  stillHeld: () => boolean;
}

/**
 * Take the exclusive right to rotate `file`, or return null to skip this pass.
 *
 * `wx` is the core of it: the create-or-fail decision happens in the kernel,
 * so two processes cannot both believe they created the file.
 *
 * NEVER THROWS. `get()` is on the inbound message path, and rotation is an
 * optimization on top of it — an unwritable sessions directory (EACCES), a
 * read-only mount, ENOSPC or EMFILE must degrade to "don't rotate", never to
 * "don't receive the message". Everything here is inside one try/catch for
 * that reason.
 *
 * Deliberately NOT a liveness check on a recorded pid: pids are recycled, the
 * lock can be written by another user's process, and "is that pid alive"
 * answers a question about *a* process rather than about this one. Staleness
 * is judged by age, and the lock's identity by a token.
 */
function acquireRotationLock(file: string, key: string): RotationLock | null {
  const lockPath = `${file}.rotate-lock`;
  let token: string;

  try {
    // Identifies this ACQUISITION, not this process. A pid cannot distinguish
    // our lock from one the same pid took and lost a moment earlier, and the
    // question being asked later is "is the file on disk still the one we
    // created", which only a fresh random value can answer. Inside the try:
    // "never throws" has to include the crypto provider.
    token = `${process.pid}.${randomUUID()}`;
    if (!createLockFile(lockPath, token) && !takeOverStaleLock(lockPath, token, key)) {
      return null;
    }
    // VERIFY WHAT WE HOLD. `wx` proves nobody else created this file; it does
    // not prove nobody has since removed it and created their own. Reading the
    // token back does not make that impossible either — it narrows it to the
    // gap between our write and our read — but combined with the rename-based
    // claim below it means the only way to lose the lock unnoticed is for
    // another rotator to judge a lock less than ROTATE_LOCK_STALE_MS old to be
    // stale, which it never does.
    if (!lockHoldsToken(lockPath, token)) {
      log.warn({ key, lockPath }, "Transcript rotation lock was replaced by another rotator; skipping this pass");
      return null;
    }
  } catch (err) {
    log.warn({ err, key }, "Could not take the transcript rotation lock; skipping rotation this pass");
    return null;
  }

  let released = false;
  return {
    stillHeld: () => lockHoldsToken(lockPath, token),
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only if it is still ours. Removing a lock we no longer hold would
        // hand a third rotator a free run alongside whoever took it from us.
        if (lockHoldsToken(lockPath, token)) unlinkSync(lockPath);
      } catch { /* already gone, or unreadable — either way not ours to clear */ }
    },
  };
}

/** Create the lock with our token. False on EEXIST; other errors propagate. */
function createLockFile(lockPath: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeFileSync(fd, `${token}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Is the lock file on disk the one we created? */
function lockHoldsToken(lockPath: string, token: string): boolean {
  return readLockToken(lockPath) === token;
}

/** First line of a lock file, or null if it cannot be read. */
function readLockToken(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf-8").split("\n")[0];
  } catch {
    return null;
  }
}

/**
 * Replace an abandoned lock with ours, or return false to step aside.
 *
 * CLAIMED WITH A RENAME, NOT AN UNLINK. Two rotators can both judge the same
 * lock stale. If both unlink and then create, the second unlink destroys the
 * first rotator's *fresh* lock and both proceed — which is worse than no lock
 * at all: duplicate archive records, and the loser's post-rename drain
 * appending old-inode bytes onto the winner's rewritten file. Renaming the
 * stale lock aside is atomic and has exactly one winner; the loser gets ENOENT
 * and gives up for this pass.
 */
function takeOverStaleLock(lockPath: string, token: string, key: string): boolean {
  let judged: { age: number; dev: number; ino: number; token: string | null } | null;
  try {
    // TOKEN FIRST, THEN AGE. The two reads are separate syscalls and the
    // file can be replaced between them. In this order a replacement after
    // the token read shows up as a fresh mtime and we step aside; one after
    // the stat shows up as a token mismatch on the claim and is put back.
    // The other order has a hole: a stale age paired with the NEW token,
    // which the claim check would then accept.
    const token = readLockToken(lockPath);
    const st = statSync(lockPath);
    judged = { age: Date.now() - st.mtimeMs, dev: st.dev, ino: st.ino, token };
  } catch {
    // Released between the failed create and the stat — nothing to take over.
    judged = null;
  }

  if (judged !== null) {
    const age = judged.age;
    // Fresh and not ours — including the sub-millisecond "negative" ages that
    // come from timestamp granularity rather than from a wrong clock.
    if (age >= -ROTATE_LOCK_FUTURE_SKEW_MS && age <= ROTATE_LOCK_STALE_MS) return false;
    if (age < 0) {
      // A lock dated in the FUTURE: clock skew, a restored backup, a file
      // copied with its timestamps. Without this branch its age is never
      // greater than the threshold, so it is never stale, and rotation for
      // that key is disabled forever — silently, which is how a transcript
      // grows past every bound this code exists to enforce.
      log.warn({ lockPath, ageMs: age, key }, "Transcript rotation lock is dated in the future; treating it as abandoned");
    } else {
      log.warn({ lockPath, ageMs: age, key }, "Taking over an abandoned transcript rotation lock");
    }

    const claim = `${lockPath}.claimed-${token}`;
    try {
      renameSync(lockPath, claim);
    } catch {
      // Someone else claimed it in the same instant; theirs, not ours.
      return false;
    }

    // AND CHECK WE CLAIMED THE FILE WE JUDGED. The staleness verdict was
    // formed a few syscalls ago and describes one specific file; between then
    // and the rename, the rotator that abandoned it may have been replaced by
    // a live one taking the lock legitimately. Renaming by path would then
    // have stolen a FRESH lock, and both rotators would proceed — the exact
    // damage the lock exists to prevent.
    //
    // THE TOKEN IS THE IDENTITY, NOT THE INODE. ext4 hands a freed inode
    // straight back to the next create, so "the lock I judged dead" and "the
    // fresh lock that replaced it" can share dev+ino; on Linux CI they did.
    // The token is a random value per acquisition and cannot collide. dev+ino
    // is still compared as a cheap extra, never as the deciding one.
    let claimed: { dev: number; ino: number; token: string | null } | null = null;
    try {
      const st = statSync(claim);
      claimed = { dev: st.dev, ino: st.ino, token: readLockToken(claim) };
    } catch { /* treated as a mismatch below */ }

    if (!claimed || claimed.token !== judged.token || claimed.dev !== judged.dev || claimed.ino !== judged.ino) {
      log.warn({ lockPath, key }, "Rotation lock was replaced while being taken over; putting it back");
      // PUT BACK WITH A LINK, NOT A RENAME. For the instant the live lock sat
      // under the claim name, the lock path was empty, and a third rotator can
      // have created its own lock there. A rename would silently replace that
      // one; a link fails with EEXIST and leaves it. The rotator whose lock we
      // displaced then finds its token gone at install time and abandons —
      // see rotateFromSnapshot — so the third one runs alone either way.
      try {
        linkSync(claim, lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          log.warn({ claim, lockPath, key }, "A newer rotation lock appeared meanwhile; the displaced one is abandoned");
        } else {
          log.error({ err, claim, lockPath }, "Could not restore a rotation lock taken over in error");
        }
      }
      try { unlinkSync(claim); } catch { /* best-effort; leaves one stray file */ }
      return false;
    }

    try { unlinkSync(claim); } catch { /* best-effort; leaves one stray file */ }
  }

  return createLockFile(lockPath, token);
}

/** Does `path` still name the inode `fd` is open on? False on any error. */
function sameInode(fd: number, path: string): boolean {
  try {
    const a = fstatSync(fd);
    const b = statSync(path);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Read `fd` from `offset` up to the last complete line.
 *
 * Bytes after the final newline are a line another process is in the middle of
 * writing; returning them would let rotation parse — or, worse, rewrite — half
 * a record. The caller's cursor therefore advances only over complete lines,
 * which is the same invariant compact.ts maintains for SDK JSONLs.
 */
function readCompleteLinesFromFd(fd: number, offset: number): { text: string; bytesRead: number } {
  const size = fstatSync(fd).size;
  if (size <= offset) return { text: "", bytesRead: offset };
  const buf = Buffer.alloc(size - offset);
  let total = 0;
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, offset + total);
    if (n === 0) break; // EOF earlier than fstat reported
    total += n;
  }
  const lastNl = buf.subarray(0, total).lastIndexOf(0x0a);
  if (lastNl < 0) return { text: "", bytesRead: offset };
  return { text: buf.subarray(0, lastNl + 1).toString("utf-8"), bytesRead: offset + lastNl + 1 };
}

/**
 * Copy any complete lines appended to `fd` past `cursor` onto `target`, and
 * report the new cursor plus whether everything readable was carried across.
 *
 * This is what makes rotation safe against a concurrent APPENDER (the lock only
 * excludes other rotators). The daemon appending an inbound message while the
 * CLI rotates is the ordinary case, and on the old code that message was
 * erased by the rename.
 */
function spliceAppendsSince(
  fd: number,
  cursor: number,
  target: string,
  key: string,
): { cursor: number; ok: boolean } {
  let text: string;
  let bytesRead: number;
  try {
    ({ text, bytesRead } = readCompleteLinesFromFd(fd, cursor));
  } catch (err) {
    log.warn({ err, key }, "Could not re-read the transcript tail during rotation");
    return { cursor, ok: false };
  }
  if (!text) return { cursor, ok: true };
  try {
    appendFileSync(target, text);
  } catch (err) {
    // The caller decides what that means: before the rename it can still
    // abandon the rotation and lose nothing, after it the bytes are gone with
    // the unlinked inode. Saying either here would be wrong half the time.
    log.error({ err, key, target }, "Could not carry concurrent transcript appends across");
    return { cursor, ok: false };
  }
  log.info({ key, bytes: text.length }, "Carried messages appended during transcript rotation across");
  return { cursor: bytesRead, ok: true };
}

interface PendingNotesFile {
  version: 1;
  notes: Record<string, string[]>;
}

/** Get the full path to an SDK session JSONL file */
export function getSdkSessionPath(
  sessionId: string,
  sdkSessionsDir: string,
): string {
  return join(sdkSessionsDir, `${sessionId}.jsonl`);
}

/**
 * The oldest timestamp a real transcript record can carry. Tomo did not exist
 * before this, so anything below it is corrupt rather than ancient: a
 * `timestamp: 0` legacy record, a negative value, or a seconds-precision epoch
 * written where milliseconds were expected (1_700_000_000 is 1970-01-20).
 *
 * This matters because searchTranscript's lower bounds END the scan, so
 * reading such a value as "older than everything" truncates an entire recall.
 */
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

/**
 * A record's seq, or null when it has none we can order by.
 *
 * Stricter than `getLastSeq` / `isAfterMessage`, which accept any non-null
 * value: a hand-edited `seq: "12"` is invisible to a search bound here but
 * would still seed the next append there. Search must not order by a string;
 * the append path's leniency is pre-existing and left alone.
 */
function usableSeq(msg: SessionMessage): number | null {
  return typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : null;
}

/** A record's timestamp, or null when it has none we can order by. */
function usableTimestamp(msg: SessionMessage): number | null {
  return typeof msg.timestamp === "number"
    && Number.isFinite(msg.timestamp)
    && msg.timestamp >= MIN_PLAUSIBLE_TIMESTAMP_MS
    ? msg.timestamp
    : null;
}

/**
 * The registry file exists but could not be turned into a session list — a
 * JSON parse failure, a transient `EMFILE`/`EIO`, a half-restored file. Carries
 * the underlying error as `cause`.
 *
 * Thrown by `saveRegistry()` rather than by the read: the read keeps serving
 * the last state we successfully loaded, which is strictly better than `[]`,
 * but nothing may be persisted from it until the file can be read again.
 */
export class SessionRegistryReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`session registry could not be read: ${path}`, { cause });
    this.name = "SessionRegistryReadError";
    this.path = path;
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private registry: SessionEntry[] = [];
  /**
   * Set when the last load failed. While it is set the in-memory registry is
   * the last good state (or the empty initial one, if we have never had a good
   * read) and MUST NOT be written back: every mutator is loadRegistry() then
   * saveRegistry(), so persisting here is what turned one unreadable instant
   * into a permanently empty registry — every session→SDK-session link gone,
   * every JSONL orphaned beyond the reach of cleanupExpired. Cleared by the
   * next successful load.
   */
  private registryLoadError: SessionRegistryReadError | null = null;
  /** The failure is logged once per failure streak, not once per mutator. */
  private registryLoadErrorLogged = false;
  /** Ditto for "this read is answering from stale state" and for deferred
   *  bookkeeping writes — one line each per streak, not one per call. */
  private registryStaleReadLogged = false;
  private registryDeferredWriteLogged = false;
  /** A bookkeeping SAVE failed (ENOSPC, EROFS, EACCES on the directory…):
   *  logged once per streak, cleared by the next successful save. */
  private registryWriteErrorLogged = false;
  // Stat of the registry file as of the last read/write. loadRegistry() is
  // called on nearly every store operation to pick up external changes
  // (e.g. `tomo sessions clear`); the stat check lets those calls skip the
  // full read+parse when the file hasn't changed since we last touched it.
  private registryStat: { mtimeMs: number; size: number } | null = null;
  private dir: string;
  private sdkSessionsDir: string;
  private tailLimit: number;
  private rotateBytes: number;
  // Month for which rotation already ran and found nothing to roll — skip
  // re-reading an all-current-month file until the month turns over.
  private rotateSkipMonth = new Map<string, string>();

  constructor(
    dir: string,
    historyLimit: number,
    sdkSessionsDir: string,
    opts?: { tailMessages?: number; rotateBytes?: number },
  ) {
    if (!sdkSessionsDir) {
      throw new Error("SessionStore requires an explicit SDK sessions directory");
    }
    this.dir = dir;
    this.sdkSessionsDir = sdkSessionsDir;
    this.tailLimit = opts?.tailMessages ?? Math.max(TRANSCRIPT_TAIL_MIN, historyLimit * 10);
    this.rotateBytes = opts?.rotateBytes ?? TRANSCRIPT_ROTATE_BYTES;
    mkdirSync(dir, { recursive: true });
    this.loadRegistry();
    this.cleanupExpired();
  }

  /** Get or create a session, loading only the transcript tail from disk on
   *  first access. Older messages stay on disk (see searchTranscript). */
  get(key: string): Session {
    let session = this.sessions.get(key);
    if (session) return session;

    this.maybeRotateTranscript(key);
    const messages = this.loadTranscript(key);
    session = {
      key,
      messages,
      createdAt: this.transcriptCreatedAt(key) ?? (messages.length > 0 ? messages[0].timestamp : Date.now()),
      updatedAt: messages.length > 0 ? messages[messages.length - 1].timestamp : Date.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** Append a message to the session and persist to disk */
  append(key: string, message: SessionMessage): void {
    const session = this.get(key);

    // Auto-assign seq number if not present
    if (message.seq == null) {
      const lastSeq = this.getLastSeq(session);
      message.seq = lastSeq + 1;
    }

    session.messages.push(message);
    session.updatedAt = message.timestamp;

    const file = this.transcriptPath(key);
    appendFileSync(file, JSON.stringify(message) + "\n");

    // Every transcript write — user inbound (any ingress path) and assistant
    // outbound (turns, proactive sends) — funnels through here, making this
    // the single observability choke point for the watch feed.
    if (message.role === "user" || message.role === "assistant") {
      watchBus.publish({
        type: "transcript",
        ts: message.timestamp,
        sessionKey: key,
        role: message.role,
        channel: message.channel,
        ...(message.senderName ? { sender: message.senderName } : {}),
        text: clip(message.content, TRANSCRIPT_TEXT_LIMIT),
      });
    }

    // Long-running daemon: keep the in-memory cache bounded to the tail and
    // take the (amortized) chance to roll old months out of the active file.
    if (session.messages.length > this.tailLimit * 2) {
      session.messages.splice(0, session.messages.length - this.tailLimit);
      this.maybeRotateTranscript(key);
    }
  }

  /** Append a tool summary entry for a completed tool chain */
  appendToolSummary(key: string, opts: {
    toolsUsed: string[];
    toolCallCount: number;
    content: string;
    timestamp: number;
    sdkMessageUuid?: string;
  }): void {
    this.append(key, {
      role: "tool_summary",
      content: opts.content,
      channel: "sdk",
      timestamp: opts.timestamp,
      toolsUsed: opts.toolsUsed,
      toolCallCount: opts.toolCallCount,
      sdkMessageUuid: opts.sdkMessageUuid,
    });
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
   */
  searchTranscript(key: string, opts: {
    query?: string;
    fromSeq?: number;
    toSeq?: number;
    fromTime?: number;
    toTime?: number;
    limit?: number;
  }): SessionMessage[] {
    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];
    const queryLower = opts.query?.toLowerCase();
    const files = [this.transcriptPath(key), ...this.listTranscriptArchives(key)];

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

  /** Search archive files (compacted SDK events) for a given session ID */
  searchArchive(sdkSessionId: string, opts: {
    query?: string;
    limit?: number;
  }): SessionMessage[] {
    const archivePath = join(this.dir, `_archive_${sdkSessionId}.jsonl`);
    if (!existsSync(archivePath)) return [];

    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];
    const queryLower = opts.query?.toLowerCase();

    for (const event of readJsonlFileSync<Record<string, any>>(archivePath)) {
      try {
        if (event.type !== "user" && event.type !== "assistant") continue;

        // Extract text from SDK event format
        const msg = event.message;
        if (!msg) continue;

        let text = "";
        const content = msg.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text") text += (block.text ?? "") + " ";
          }
        }
        text = text.trim();
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

  /** Get the highest seq number in a session */
  private getLastSeq(session: Session): number {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].seq != null) return session.messages[i].seq!;
    }
    // No seq in the tail — rotation may have moved every active message into
    // monthly archives (e.g. a session idle across a month boundary).
    // Continue the sequence from the newest archived record so seq stays
    // monotonic across the whole transcript history.
    for (const file of this.listTranscriptArchives(session.key)) {
      for (const record of iterateJsonlBackwardsSync<SessionMessage>(file)) {
        if (record.seq != null) return record.seq;
      }
    }
    return 0;
  }

  /** Load prompt notes that must survive daemon restarts until the session's
   *  next turn drains them. Returns a defensive copy. */
  getPendingNotes(key: string): string[] {
    return [...(this.loadPendingNotes()[key] ?? [])];
  }

  /** Replace the durable prompt-note queue for one session. An empty list
   *  removes the key and deletes the sidecar when no queues remain. */
  setPendingNotes(key: string, notes: string[]): void {
    const data = this.loadPendingNotes();
    if (notes.length > 0) {
      data[key] = [...notes];
    } else {
      delete data[key];
    }

    if (Object.keys(data).length === 0) {
      if (existsSync(this.pendingNotesPath)) unlinkSync(this.pendingNotesPath);
      return;
    }

    const file: PendingNotesFile = { version: 1, notes: data };
    writeJsonAtomicSync(this.pendingNotesPath, file);
  }

  // --- SDK Session Registry ---

  /** Get the active SDK session ID for a channel key */
  getSdkSessionId(key: string): string | undefined {
    // Re-read from disk to pick up external changes (e.g. `tomo sessions clear`)
    this.loadRegistry();
    this.noteStaleRead("getSdkSessionId");
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    return entry?.sdkSessionId || undefined;
  }

  /** Get the active registry entry for a channel key */
  getEntry(key: string): SessionEntry | undefined {
    this.loadRegistry();
    this.noteStaleRead("getEntry");
    return this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
  }

  /** Link a new SDK session to a channel key */
  setSdkSessionId(key: string, sessionId: string): void {
    this.loadRegistry();
    // Link change: refuse before mutating anything in memory.
    this.assertRegistryLoaded();

    // A metadata-only stub (created by setChatTitle/addParticipant before any
    // SDK session existed — e.g. a freshly summoned group) is upgraded in
    // place so its title/participants survive the first real session.
    const stub = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null && !e.sdkSessionId);
    if (stub) {
      stub.sdkSessionId = sessionId;
      stub.lastActiveAt = Date.now();
      this.saveRegistry();
      return;
    }

    // Unlink any existing session for this key (reloads the registry first)
    this.clearSdkSessionId(key);

    const now = Date.now();
    this.registry.push({
      sdkSessionId: sessionId,
      channelKey: key,
      createdAt: now,
      lastActiveAt: now,
      unlinkedAt: null,
      expiresAt: null,
      stats: {
        totalQueries: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        contextUsed: 0,
        contextMax: 0,
      },
    });
    this.saveRegistry();
  }

  /** Update session stats after a query */
  updateStats(key: string, update: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextUsed: number;
    contextMax: number;
    contextBreakdown?: { name: string; tokens: number }[];
  }): void {
    // Reload before mutating: other processes (tomo sessions clear, tomo
    // config) rewrite the registry; saving a stale in-memory copy would
    // silently revert their changes.
    this.loadRegistry();
    // Bookkeeping: this runs after the model has already answered. Skipping it
    // costs a stale stat line; throwing would fail a turn that succeeded.
    if (!this.canWriteRegistry("updateStats")) return;
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (!entry) return;

    // Initialize stats if missing (migration from old format)
    if (!entry.stats) {
      entry.stats = {
        totalQueries: 0, totalCostUsd: 0,
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
        contextUsed: 0, contextMax: 0,
      };
    }

    entry.stats.totalQueries++;
    entry.stats.totalCostUsd += update.costUsd;
    entry.stats.totalInputTokens += update.inputTokens;
    entry.stats.totalOutputTokens += update.outputTokens;
    entry.stats.totalCacheReadTokens += update.cacheReadTokens;
    entry.stats.totalCacheCreationTokens += update.cacheCreationTokens;
    entry.stats.contextUsed = update.contextUsed;
    entry.stats.contextMax = update.contextMax;
    if (update.contextBreakdown) {
      entry.stats.contextBreakdown = update.contextBreakdown;
    }
    entry.lastActiveAt = Date.now();
    this.saveRegistryBestEffort("updateStats");
  }

  /** Touch the active session (update lastActiveAt) */
  touchSession(key: string): void {
    this.loadRegistry();
    if (!this.canWriteRegistry("touchSession")) return;
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (entry) {
      entry.lastActiveAt = Date.now();
      this.saveRegistryBestEffort("touchSession");
    }
  }

  /** List all SDK session entries */
  listSdkSessionIds(): [string, string][] {
    // Reload so long-lived daemon paths (continuity, notifications, session
    // catalog, router DM lookup) see external changes like `tomo sessions clear`.
    // Metadata-only stubs (no SDK session yet) are excluded — consumers treat
    // these pairs as resumable sessions.
    this.loadRegistry();
    this.noteStaleRead("listSdkSessionIds");
    return this.registry
      .filter((e) => e.unlinkedAt === null && e.sdkSessionId)
      .map((e) => [e.channelKey, e.sdkSessionId]);
  }

  /** Active registry entries (linked sessions AND metadata-only stubs). */
  listActiveEntries(): SessionEntry[] {
    this.loadRegistry();
    this.noteStaleRead("listActiveEntries");
    return this.registry.filter((e) => e.unlinkedAt === null);
  }

  /** List all sessions including unlinked */
  listAllSessions(): SessionEntry[] {
    this.loadRegistry();
    this.noteStaleRead("listAllSessions");
    return [...this.registry];
  }

  /** Unlink a session (marks for deletion after TTL). Metadata-only stubs
   *  have no SDK file to TTL — they are removed outright. */
  clearSdkSessionId(key: string): void {
    this.loadRegistry();
    this.assertRegistryLoaded();
    const now = Date.now();
    this.registry = this.registry.filter((entry) => {
      if (entry.channelKey === key && entry.unlinkedAt === null && !entry.sdkSessionId) {
        log.info({ key }, "Metadata-only session entry removed");
        return false;
      }
      return true;
    });
    for (const entry of this.registry) {
      if (entry.channelKey === key && entry.unlinkedAt === null) {
        entry.unlinkedAt = now;
        entry.expiresAt = now + UNLINKED_TTL_MS;
        log.info(
          { key, sessionId: entry.sdkSessionId, expiresAt: new Date(entry.expiresAt).toISOString() },
          "Session unlinked, will be deleted in 30 days",
        );
      }
    }
    this.saveRegistry();
  }

  /**
   * Retire a poisoned SDK resume chain while preserving active routing/group
   * metadata. Use this when the SDK JSONL likely ended mid-turn (for example a
   * local query timeout): resuming that file can continue stale tool work, but
   * the chat title, participants, and reply target are still valid.
   */
  retireSdkSessionId(key: string): string | undefined {
    this.loadRegistry();
    this.assertRegistryLoaded();
    const now = Date.now();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null && e.sdkSessionId);
    if (!entry) return undefined;

    const retiredSessionId = entry.sdkSessionId;
    entry.unlinkedAt = now;
    entry.expiresAt = now + UNLINKED_TTL_MS;

    this.registry.push({
      sdkSessionId: "",
      channelKey: key,
      createdAt: now,
      lastActiveAt: now,
      unlinkedAt: null,
      expiresAt: null,
      stats: {
        totalQueries: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        contextUsed: 0,
        contextMax: 0,
      },
      ...(entry.replyTarget ? { replyTarget: entry.replyTarget } : {}),
      ...(entry.chatTitle ? { chatTitle: entry.chatTitle } : {}),
      ...(entry.participants ? { participants: [...entry.participants] } : {}),
      ...(entry.participantIds ? { participantIds: structuredClone(entry.participantIds) } : {}),
      // Routing provenance outlives the retired transcript: once the retired
      // copy expires, this stub is all that remembers the raw key an
      // identity's removal must restore cron jobs to.
      ...(entry.migratedFrom ? { migratedFrom: entry.migratedFrom } : {}),
    });

    this.saveRegistry();
    log.warn(
      { key, sessionId: retiredSessionId, expiresAt: new Date(entry.expiresAt).toISOString() },
      "SDK session retired, metadata preserved",
    );
    return retiredSessionId;
  }

  /** Delete expired unlinked sessions and their SDK JSONL files */
  private cleanupExpired(): void {
    // Runs from the constructor, so it must not throw. It also unlinks SDK
    // JSONL files, which is irreversible — never do that from a registry we
    // could not read.
    if (!this.canWriteRegistry("cleanupExpired")) return;
    const now = Date.now();
    const sdkDir = this.sdkSessionsDir;
    const expired = this.registry.filter((e) => e.expiresAt !== null && e.expiresAt <= now);
    const deletedFiles = new Set<string>();

    for (const entry of expired) {
      // Metadata-only stubs have no SDK file (and an empty id would alias
      // every other stub in the stillReferenced check below)
      if (!entry.sdkSessionId) continue;

      // Skip deletion if any surviving entry still references this sdkSessionId
      // (e.g. shared after migrateSessionKey, or unlinked but not yet expired)
      const stillReferenced = this.registry.some(
        (e) => e.sdkSessionId === entry.sdkSessionId && (e.expiresAt === null || e.expiresAt > now),
      );
      if (stillReferenced) {
        log.info(
          { sessionId: entry.sdkSessionId, channelKey: entry.channelKey },
          "Expired entry removed, SDK file preserved: sdkSessionId still referenced by another entry",
        );
        continue;
      }

      if (deletedFiles.has(entry.sdkSessionId)) continue;
      deletedFiles.add(entry.sdkSessionId);

      const sdkFile = join(sdkDir, `${entry.sdkSessionId}.jsonl`);
      if (existsSync(sdkFile)) {
        try {
          unlinkSync(sdkFile);
          log.info({ sessionId: entry.sdkSessionId }, "Deleted expired SDK session file");
        } catch {
          log.warn({ sessionId: entry.sdkSessionId }, "Failed to delete expired SDK session file");
        }
      }
    }

    if (expired.length > 0) {
      this.registry = this.registry.filter((e) => e.expiresAt === null || e.expiresAt > now);
      this.saveRegistry();
      log.info({ count: expired.length }, "Cleaned up expired sessions");
    }
  }

  // --- Reply target for unified sessions ---

  /** Get the persisted reply target for a session key */
  getReplyTarget(key: string): ReplyTarget | undefined {
    this.loadRegistry();
    this.noteStaleRead("getReplyTarget");
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    return entry?.replyTarget;
  }

  /** Set and persist the reply target for a session key. No-op if unchanged. */
  setReplyTarget(key: string, target: ReplyTarget): void {
    this.loadRegistry();
    // Checked BEFORE ensureActiveEntry, which would otherwise push a stub into
    // the in-memory registry that we then could not persist.
    if (!this.canWriteRegistry("setReplyTarget")) return;
    const entry = this.ensureActiveEntry(key);
    const prev = entry.replyTarget;
    if (prev && prev.channelName === target.channelName && prev.chatId === target.chatId) return;
    entry.replyTarget = target;
    this.saveRegistryBestEffort("setReplyTarget");
  }

  /** Persist a friendly chat title for a session (mainly groups). No-op if unchanged. */
  setChatTitle(key: string, title: string): void {
    this.loadRegistry();
    if (!this.canWriteRegistry("setChatTitle")) return;
    const entry = this.ensureActiveEntry(key);
    if (entry.chatTitle !== title) {
      entry.chatTitle = title;
      this.saveRegistryBestEffort("setChatTitle");
    }
  }

  /** Add a participant name (and, when known, its stable sender id) to a
   *  session. No-op if nothing new was learned. */
  addParticipant(key: string, name: string, senderId?: string): void {
    this.loadRegistry();
    // Bookkeeping, and on the INBOUND path: updateGroupContext calls this
    // before the message is appended to the transcript, and the rejection is
    // swallowed upstream — a throw here silently drops the message.
    if (!this.canWriteRegistry("addParticipant")) return;
    const entry = this.ensureActiveEntry(key);
    let changed = false;

    const list = entry.participants ?? [];
    if (!list.includes(name)) {
      entry.participants = [...list, name];
      changed = true;
    }

    if (senderId) {
      const byId = entry.participantIds ?? {};
      const names = byId[senderId] ?? [];
      if (!names.includes(name)) {
        entry.participantIds = { ...byId, [senderId]: [...names, name] };
        changed = true;
      }
    }

    if (changed) this.saveRegistryBestEffort("addParticipant");
  }

  /** Active entry for a key, creating a metadata-only stub (empty sdkSessionId)
   *  when none exists — so group title/participants persist for sessions that
   *  haven't run a turn yet (e.g. a group summoned before it ever had its own
   *  session). setSdkSessionId upgrades the stub in place later. */
  private ensureActiveEntry(key: string): SessionEntry {
    this.loadRegistry();
    const existing = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (existing) return existing;

    const now = Date.now();
    const entry: SessionEntry = {
      sdkSessionId: "",
      channelKey: key,
      createdAt: now,
      lastActiveAt: now,
      unlinkedAt: null,
      expiresAt: null,
      stats: {
        totalQueries: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        contextUsed: 0,
        contextMax: 0,
      },
    };
    this.registry.push(entry);
    return entry;
  }

  /** Migrate a session from one key to another (for identity-based session unification) */
  migrateSessionKey(oldKey: string, newKey: string): void {
    this.loadRegistry();
    this.assertRegistryLoaded();
    const idx = this.registry.findIndex((e) => e.channelKey === oldKey && e.unlinkedAt === null);
    if (idx === -1) return;
    const entry = this.registry[idx];

    // Re-key the entry in place: the data lives on under newKey, so there's no
    // need to keep a phantom unlinked entry that would confuse `sessions list`
    // and (pre-fix) trick cleanupExpired into deleting the shared SDK file.
    const now = Date.now();
    this.registry[idx] = {
      ...entry,
      channelKey: newKey,
      lastActiveAt: now,
      // Remember where the entry came from: the raw key is gone from the
      // registry after this, and it is what identity removal restores to.
      ...(isDmSessionKey(newKey) && !isDmSessionKey(oldKey)
        ? { migratedFrom: entry.migratedFrom ?? oldKey }
        : {}),
    };

    // Rename transcript file
    const oldPath = this.transcriptPath(oldKey);
    const newPath = this.transcriptPath(newKey);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }

    // Bring monthly rotation archives along so search and createdAt keep
    // covering the pre-migration history.
    for (const archive of this.listTranscriptArchives(oldKey)) {
      const month = /_(\d{4}-\d{2})\.jsonl$/.exec(archive)?.[1];
      if (!month) continue;
      const target = this.transcriptArchivePath(newKey, month);
      if (!existsSync(target)) renameSync(archive, target);
    }

    const pendingNotes = this.loadPendingNotes();
    const oldNotes = pendingNotes[oldKey];
    if (oldNotes) {
      pendingNotes[newKey] = [...(pendingNotes[newKey] ?? []), ...oldNotes];
      delete pendingNotes[oldKey];
      writeJsonAtomicSync(this.pendingNotesPath, {
        version: 1,
        notes: pendingNotes,
      } satisfies PendingNotesFile);
    }

    // Clear in-memory session cache for old key
    this.sessions.delete(oldKey);

    this.saveRegistry();
    log.info({ oldKey, newKey, sdkSessionId: entry.sdkSessionId }, "Session migrated to unified key");
  }

  // --- Registry persistence ---

  private get registryPath(): string {
    return join(this.dir, "_sessions.json");
  }

  private get pendingNotesPath(): string {
    return join(this.dir, "_pending_notes.json");
  }

  private loadPendingNotes(): Record<string, string[]> {
    if (!existsSync(this.pendingNotesPath)) return {};
    try {
      const data = JSON.parse(readFileSync(this.pendingNotesPath, "utf-8")) as Partial<PendingNotesFile>;
      if (!data.notes || typeof data.notes !== "object") return {};
      return Object.fromEntries(
        Object.entries(data.notes)
          .filter((entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) && entry[1].every((note) => typeof note === "string")),
      );
    } catch (err) {
      log.warn({ err, file: this.pendingNotesPath }, "Could not load pending notes");
      return {};
    }
  }

  private loadRegistry(): void {
    const file = this.registryPath;

    // "No file at all" and "file we cannot read" are different states, and
    // conflating them is the whole bug: only the first one legitimately means
    // there are no sessions. statSync's own errors have to be split the same
    // way — an EACCES on the directory is not an absent registry.
    let stat: { mtimeMs: number; size: number } | null;
    try {
      const s = statSync(file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onRegistryLoadFailure(err);
        return;
      }
      stat = null;
    }

    if (!stat) {
      // Legitimately empty: a fresh install, or `tomo sessions clear`. This is
      // a successful load, so it clears any earlier failure.
      this.clearRegistryLoadError();
      this.registryStat = null;
      // Migrate from old _sdk_sessions.json if it exists
      this.migrateOldFormat();
      return;
    }
    if (stat.size === 0) {
      // A zero-byte registry is ambiguous, and JSON.parse("") throws — so
      // without this it would be a permanent refusal with no way to self-heal.
      // There is no `.bak` for the registry to arbitrate with, so prior good
      // state is the only signal available:
      //  - holding nothing: an interrupted first write on a fresh install.
      //    Reading it as empty loses nothing and recovers on the next save.
      //  - holding entries: something truncated a real registry, and reading
      //    it as empty is exactly the loss this class exists to prevent.
      // Recovery from the refusing case is to delete the file — that reads as
      // ENOENT, i.e. legitimately empty.
      if (this.registry.length > 0) {
        this.onRegistryLoadFailure(
          new Error(`registry file is 0 bytes while ${this.registry.length} session(s) are held in memory`),
        );
        return;
      }
      this.registry = [];
      this.registryStat = stat;
      this.clearRegistryLoadError();
      return;
    }
    // Skip the stat cache while we are in a failed state: the point of every
    // subsequent call is to find out whether the file has become readable.
    if (this.registryLoadError === null
      && this.registryStat
      && this.registryStat.mtimeMs === stat.mtimeMs
      && this.registryStat.size === stat.size) {
      return;
    }
    let data: SessionRegistry;
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as SessionRegistry;
    } catch (err) {
      this.onRegistryLoadFailure(err);
      return;
    }
    if (data === null || typeof data !== "object"
      || (data.sessions !== undefined && !Array.isArray(data.sessions))) {
      this.onRegistryLoadFailure(new Error("missing or malformed `sessions` array"));
      return;
    }
    this.registry = data.sessions ?? [];
    this.registryStat = stat;
    this.clearRegistryLoadError();
  }

  /**
   * Record that the registry could not be read. Deliberately leaves
   * `this.registry` and `this.registryStat` alone: the last state we
   * successfully loaded is the best information we have, and resetting to `[]`
   * is exactly what the next saveRegistry() would have made permanent.
   */
  private onRegistryLoadFailure(err: unknown): void {
    this.registryLoadError = new SessionRegistryReadError(this.registryPath, err);
    if (!this.registryLoadErrorLogged) {
      this.registryLoadErrorLogged = true;
      log.error(
        { err, file: this.registryPath },
        "Session registry unreadable; keeping the last known-good state in memory " +
        "and refusing to persist until it can be read again",
      );
    }
  }

  /**
   * Guard for a mutator that changes WHICH SDK session a key resolves to
   * (`setSdkSessionId`, `clearSdkSessionId`, `retireSdkSessionId`,
   * `migrateSessionKey`). Throws before anything is mutated in memory.
   *
   * These are hard refusals because getting them wrong is the data loss this
   * class is guarding against: a link silently rewritten from a registry we
   * could not read orphans a JSONL for good. A caller that cannot relink is
   * better off failing loudly than continuing against a link it invented.
   */
  private assertRegistryLoaded(): void {
    if (this.registryLoadError !== null) throw this.registryLoadError;
  }

  /**
   * Guard for a bookkeeping mutator (stats, timestamps, chat titles,
   * participants, reply target). Returns false when the registry is
   * unreadable, and the caller returns without touching memory or disk.
   *
   * These must NEVER throw. They sit on the inbound and turn-completion paths
   * — `addParticipant` runs before the message is appended to the transcript,
   * `updateStats` runs after the model has already produced its answer — and
   * a throw there drops an inbound message or fails a turn that actually
   * succeeded. A permanently unreadable registry would otherwise mean every
   * message fails, which is a far worse outage than stats going stale.
   *
   * Returning false (rather than mutating and hoping) also keeps memory and
   * disk consistent: a mutation applied but not persisted is a lie that the
   * next reader would act on.
   */
  private canWriteRegistry(op: string): boolean {
    if (this.registryLoadError === null) return true;
    if (!this.registryDeferredWriteLogged) {
      this.registryDeferredWriteLogged = true;
      log.warn(
        { file: this.registryPath, op },
        "Skipping session-registry bookkeeping writes while the file is unreadable",
      );
    }
    return false;
  }

  /**
   * Persist a bookkeeping change without letting ANY failure escape.
   *
   * The read-failure refusal is the expected case and is reported through
   * `canWriteRegistry` (once per streak). A genuine write error — ENOSPC,
   * EROFS, EACCES on the sessions directory — is not hidden either: it is
   * logged at error level, once per streak, with the cause. But it must not
   * propagate. `updateStats` runs after the model has already answered, and
   * `addParticipant` runs before an inbound message is appended: a throw there
   * fails a turn that succeeded or drops a message over a stat line. The
   * in-memory state keeps the change; the next successful save publishes it.
   */
  private saveRegistryBestEffort(op: string): void {
    try {
      this.saveRegistry();
    } catch (err) {
      if (err instanceof SessionRegistryReadError) {
        this.canWriteRegistry(op);
        return;
      }
      if (!this.registryWriteErrorLogged) {
        this.registryWriteErrorLogged = true;
        log.error(
          { err, file: this.registryPath, op },
          "Session-registry bookkeeping write failed; keeping the change in memory and retrying on the next save",
        );
      }
    }
  }

  /** Note, once per streak, that a read is being answered from stale state. */
  private noteStaleRead(op: string): void {
    if (this.registryLoadError === null || this.registryStaleReadLogged) return;
    this.registryStaleReadLogged = true;
    log.warn(
      { file: this.registryPath, op, entries: this.registry.length },
      "Answering session-registry reads from the last known-good in-memory state; " +
      "a short-lived process that never had a good read reports an empty list",
    );
  }

  private clearRegistryLoadError(): void {
    if (this.registryLoadError === null) return;
    this.registryLoadError = null;
    this.registryLoadErrorLogged = false;
    this.registryStaleReadLogged = false;
    this.registryDeferredWriteLogged = false;
    log.info({ file: this.registryPath }, "Session registry readable again");
  }

  private saveRegistry(): void {
    // Refuse to publish state we could not read. Loud beats silent here: the
    // alternative is writing `{version:1,sessions:[]}` over a file that still
    // holds every session→SDK-session link, which is unrecoverable and, as
    // shipped, had no log line at all.
    if (this.registryLoadError !== null) throw this.registryLoadError;
    const data: SessionRegistry = { version: 1, sessions: this.registry };
    writeJsonAtomicSync(this.registryPath, data);
    if (this.registryWriteErrorLogged) {
      this.registryWriteErrorLogged = false;
      log.info({ file: this.registryPath }, "Session-registry writes succeeding again");
    }
    // Record our own write's stat so the next loadRegistry() doesn't re-read
    // what we just wrote. An external writer landing in the stat window would
    // be missed until its next write — the same read-modify-write race the
    // uncached path had, so no new hazard.
    this.registryStat = this.statRegistry();
  }

  private statRegistry(): { mtimeMs: number; size: number } | null {
    try {
      const s = statSync(this.registryPath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  /** Migrate from the old simple key→value format */
  private migrateOldFormat(): void {
    const oldFile = join(this.dir, "_sdk_sessions.json");
    if (!existsSync(oldFile)) return;

    try {
      const data = JSON.parse(readFileSync(oldFile, "utf-8"));
      const now = Date.now();
      for (const [key, sessionId] of Object.entries(data)) {
        this.registry.push({
          sdkSessionId: sessionId as string,
          channelKey: key,
          createdAt: now,
          lastActiveAt: now,
          unlinkedAt: null,
          expiresAt: null,
          stats: {
            totalQueries: 0, totalCostUsd: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
            contextUsed: 0, contextMax: 0,
          },
        });
      }
      this.saveRegistry();
      unlinkSync(oldFile);
      log.info({ count: this.registry.length }, "Migrated old session format");
    } catch {
      // Ignore migration errors
    }
  }

  // --- Transcripts ---

  private safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private transcriptPath(key: string): string {
    return join(this.dir, `${this.safeKey(key)}.jsonl`);
  }

  private transcriptArchivePath(key: string, month: string): string {
    return join(this.dir, `_archive_${this.safeKey(key)}_${month}.jsonl`);
  }

  /** Monthly rotation archives for a key, newest month first. */
  private listTranscriptArchives(key: string): string[] {
    const prefix = `_archive_${this.safeKey(key)}_`;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}\.jsonl$/.test(n.slice(prefix.length)))
      .sort()
      .reverse()
      .map((n) => join(this.dir, n));
  }

  /** Load only the last tailLimit messages of the active transcript. */
  private loadTranscript(key: string): SessionMessage[] {
    const file = this.transcriptPath(key);
    if (!existsSync(file)) return [];

    return readJsonlTailSync<SessionMessage>(file, this.tailLimit);
  }

  /** Timestamp of the oldest surviving message across archives + active file. */
  private transcriptCreatedAt(key: string): number | undefined {
    const archives = this.listTranscriptArchives(key);
    const oldestFile = archives.length > 0 ? archives[archives.length - 1] : this.transcriptPath(key);
    return readFirstJsonlRecordSync<SessionMessage>(oldestFile)?.timestamp;
  }

  /** Count user messages in the active transcript without retaining them.
   *  Bounded by rotation; archived months are not counted. */
  countRecentUserMessages(key: string): number {
    let count = 0;
    for (const msg of iterateJsonlBackwardsSync<SessionMessage>(this.transcriptPath(key))) {
      if (msg.role === "user") count++;
    }
    return count;
  }

  /**
   * Roll messages from prior months out of the active transcript into
   * _archive_<key>_<YYYY-MM>.jsonl siblings once the active file outgrows
   * rotateBytes. Keeps the active file — and everything priced by its size:
   * first-access load, search of recent history, /status counts — bounded
   * for a daemon that runs for months.
   *
   * Crash safety: archives are appended before the active file is rewritten
   * (atomically, via rename). If we die in between, the next rotation skips
   * already-archived messages via isAfterMessage instead of duplicating them.
   */
  private maybeRotateTranscript(key: string): void {
    const file = this.transcriptPath(key);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < this.rotateBytes) return;

    const currentMonth = monthOf(Date.now());
    if (this.rotateSkipMonth.get(key) === currentMonth) return;

    // SERIALIZE ROTATORS ACROSS PROCESSES. `get()` triggers rotation, and
    // `get()` is called from a second process — `tomo config identities`
    // builds its own SessionStore while the daemon is up
    // (cli/config/identities.ts). Two rotators interleaving is not a thought
    // experiment: both read the same file, both write a temp, and both rename
    // it over the original, so the later rename either loses the earlier
    // rotator's work or, with the old FIXED temp name, fails with ENOENT
    // because the other process already renamed that exact path away.
    //
    // acquireRotationLock never throws: a lock that cannot be taken (a
    // read-only sessions directory, EACCES, EMFILE) must skip the rotation,
    // not propagate out of `get()` — which every inbound message goes through.
    const lock = acquireRotationLock(file, key);
    if (!lock) {
      log.debug({ key }, "Transcript rotation not started this pass (lock held elsewhere or unavailable)");
      return;
    }
    try {
      this.rotateTranscriptLocked(key, file, currentMonth, lock);
    } finally {
      lock.release();
    }
  }

  /**
   * The rotation itself, with the lock held.
   *
   * Two things beyond the plain read-modify-rename it replaces:
   *
   * - The file is read through a PINNED fd and the byte offset of the last
   *   complete line is remembered, so appends that land while we are working
   *   can be identified and spliced onto the replacement instead of being
   *   erased by the rename. The lock stops other rotators; it does not stop
   *   the daemon's `appendFileSync`, which is a different code path entirely
   *   and must not be blocked.
   * - Every read is tolerant of the file being replaced or removed underneath
   *   it (`tomo sessions clear`, another rotator that took over a stale lock):
   *   rotation is an optimization, so it gives up quietly rather than throwing
   *   out of `get()`.
   */
  private rotateTranscriptLocked(key: string, file: string, currentMonth: string, lock: RotationLock): void {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      // Vanished between the stat and here. Nothing to rotate.
      return;
    }

    try {
      let text: string;
      let bytesRead: number;
      try {
        ({ text, bytesRead } = readCompleteLinesFromFd(fd, 0));
      } catch (err) {
        log.warn({ err, key }, "Could not read transcript for rotation; skipping this pass");
        return;
      }

      // preserveUnparseable: rotation rewrites the active transcript, so a
      // line we could not parse has to come back out. It stays in the active
      // file rather than being archived — its timestamp is exactly the thing
      // we could not read, so there is no month to file it under.
      const all = parseJsonl<SessionMessage>(text, { preserveUnparseable: true });
      reportRawJsonlLines(all, { key, file, op: "transcript-rotate" });
      this.rotateFromSnapshot(key, file, currentMonth, fd, all, bytesRead, lock);
    } finally {
      closeSync(fd);
    }
  }

  private rotateFromSnapshot(
    key: string,
    file: string,
    currentMonth: string,
    fd: number,
    all: (SessionMessage | RawJsonlLine)[],
    bytesRead: number,
    lock: RotationLock,
  ): void {
    // Union element type: `keep` carries both real messages and the carriers
    // for lines nobody could parse.
    const keep: (SessionMessage | RawJsonlLine)[] = [];
    const byMonth = new Map<string, SessionMessage[]>();
    for (const msg of all) {
      if (isRawJsonlLine(msg)) {
        keep.push(msg);
        continue;
      }
      const month = monthOf(msg.timestamp);
      if (month >= currentMonth) {
        keep.push(msg);
        continue;
      }
      let bucket = byMonth.get(month);
      if (!bucket) byMonth.set(month, bucket = []);
      bucket.push(msg);
    }
    if (byMonth.size === 0) {
      // Everything is current-month; nothing can roll until the month turns.
      this.rotateSkipMonth.set(key, currentMonth);
      return;
    }

    for (const [month, msgs] of byMonth) {
      const archivePath = this.transcriptArchivePath(key, month);
      let lastArchived: SessionMessage | undefined;
      for (const record of iterateJsonlBackwardsSync<SessionMessage>(archivePath)) {
        lastArchived = record;
        break;
      }
      const fresh = lastArchived ? msgs.filter((m) => isAfterMessage(m, lastArchived)) : msgs;
      if (fresh.length === 0) continue;
      appendFileSync(archivePath, fresh.map((m) => JSON.stringify(m)).join("\n") + "\n");
    }

    // UNIQUE TEMP NAME. The old fixed `.rotate-tmp` was a shared mutable path:
    // two rotators wrote the same file and both renamed it into place, which
    // is how one of them ends up renaming a path the other already moved.
    // pid + random matches writeFileAtomicSync (fs-utils.ts) and pruneTools.
    const tmp = `${file}.rotate-tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, keep.length > 0 ? keep.map(serializeJsonlRecord).join("\n") + "\n" : "");

    // SPLICE LATE APPENDS. Everything appended between our read and this line
    // is not in `tmp` — on the old code the rename below erased it,
    // permanently and with no log line, and `getLastSeq` then re-derived seq
    // from the surviving tail so the next message reused a seq that was
    // already taken. Copy those bytes onto the replacement first.
    const spliced = spliceAppendsSince(fd, bytesRead, tmp, key);
    if (!spliced.ok) {
      // We could not carry the concurrent appends across, so installing the
      // rewrite would destroy them. Abandon this pass instead: the original
      // file still holds every message, and the already-written archive
      // entries are skipped next time by the isAfterMessage check. Until
      // that next pass succeeds, those records exist in BOTH files, and
      // searchTranscript reports them twice: a visible duplicate, chosen over
      // the alternative of archiving after the rename, which would leave a
      // crash between the two with the records in neither.
      log.warn({ key }, "Abandoning transcript rotation: concurrent appends could not be carried over");
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      return;
    }

    // MAY WE STILL INSTALL? The rename below is the one destructive step, and
    // two things can have changed since the lock was taken:
    //
    // - THE LOCK. A rotator that ran past ROTATE_LOCK_STALE_MS, or whose
    //   lock was displaced by a takeover made in error, no longer holds it,
    //   and whoever does is about to rename its own rewrite over this file.
    //   Two installs of two snapshots is the double-rotation the lock exists
    //   to prevent; the one that lost the lock steps aside.
    // - THE FILE. `tomo sessions clear` removes the transcript and the daemon
    //   recreates it; the pinned fd still reads the OLD inode, so nothing we
    //   spliced came from the new file, and renaming over it would erase
    //   everything written there. The open descriptor is what makes dev+ino
    //   trustworthy here: an inode with a descriptor on it cannot be freed,
    //   so it cannot be reused for the replacement.
    //
    // Both checks sit immediately before the rename: the gap between them
    // and it is a few syscalls, against a staleness window of minutes.
    if (!lock.stillHeld()) {
      log.warn({ key }, "Abandoning transcript rotation: the rotation lock is no longer ours");
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      return;
    }
    if (!sameInode(fd, file)) {
      log.warn({ key, file }, "Abandoning transcript rotation: the transcript was replaced underneath it");
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      return;
    }

    try {
      renameSync(tmp, file);
    } catch (err) {
      log.warn({ err, key }, "Transcript rotation could not install the rewritten file; leaving the original in place");
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      return;
    }

    // NARROWED, NOT CLOSED. A writer that opened the path just before the
    // rename holds the old inode and its append lands there, where no path
    // points any more. Draining it here recovers those bytes, but the window
    // is only bounded by how long that writer holds its descriptor: an append
    // that arrives after this read is unrecoverable, because the inode is
    // unlinked once we close our own fd. In practice appendFileSync opens,
    // writes and closes in one call, so the exposure is microseconds — but it
    // is a narrowing, not an elimination, and a lock the APPENDER also took
    // would be the only way to close it.
    const drained = spliceAppendsSince(fd, spliced.cursor, file, key);
    if (!drained.ok) {
      log.error(
        { key, file },
        "Messages appended during rotation could not be recovered from the replaced file; they are lost",
      );
    }
    log.info(
      { key, months: [...byMonth.keys()].sort(), archived: all.length - keep.length, kept: keep.length },
      "Transcript rotated: prior months moved to archive files",
    );
  }
}
