import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, statSync, readdirSync, openSync, closeSync, readSync, fstatSync, linkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Session, SessionMessage, SessionEntry, SessionRegistry, ReplyTarget } from "./types.js";
import { isDmSessionKey } from "./keys.js";
import { log } from "../logger.js";
import {
  parseJsonl, readJsonlFileSync, readJsonlTailSync, readFirstJsonlRecordSync, iterateJsonlBackwardsSync,
  isRawJsonlLine, reportRawJsonlLines, serializeJsonlRecord, type RawJsonlLine,
} from "../jsonl.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { FileLockTimeoutError, isFileLockHeldSync, withFileLockSync, type FileLockOptions } from "../file-lock.js";
import { watchBus } from "../watch/bus.js";
import { clip, TRANSCRIPT_TEXT_LIMIT } from "../watch/protocol.js";

const UNLINKED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Registry critical sections are a read, an in-memory edit and an atomic write
 * — sub-millisecond. Two seconds is already far beyond any honest contention;
 * past that the holder is wedged, and waiting longer just blocks an inbound
 * message. A lock still held after 30s whose owner cannot be proven alive is
 * reclaimed (see src/file-lock.ts).
 */
const REGISTRY_LOCK_OPTIONS: FileLockOptions = { timeoutMs: 2_000 };

/**
 * The transcript-migration critical section is a handful of `rename`s that run
 * once per key per process, so contention past a second means the holder is
 * wedged — and waiting longer just blocks an inbound message for a migration
 * the next start can redo.
 */
const TRANSCRIPT_LOCK_OPTIONS: FileLockOptions = { timeoutMs: 1_000 };

/**
 * The legacy-stem ledger critical section is a read, a set union and an atomic
 * write of a file with one line per session key — the registry's own profile,
 * so the registry's budget.
 */
const LEGACY_STEM_LEDGER_LOCK_OPTIONS: FileLockOptions = { timeoutMs: 2_000 };

/**
 * How long a key whose transcript migration could not be completed (the
 * transcript lock was held elsewhere, a rename raced, the merge failed
 * mid-way) waits before the next inbound message retries it.
 *
 * The key is deliberately NOT marked as checked in that case — marking it is
 * what orphaned the legacy file permanently — but "not marked" must not mean
 * "take a 1s lock timeout on every single message either". So the retry is
 * throttled rather than abandoned, and the work still happens inside this
 * process run instead of waiting for a restart.
 */
const TRANSCRIPT_MIGRATION_RETRY_MS = 60_000;

/** Rename `from` onto `to`, treating "it is already gone" as done: another
 *  process running the same migration is the expected reason. */
function renameIfPresent(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The tail both suffixed-file families share: `-<YYYYMMDD-HHmmss>[-<n>].jsonl`.
 *
 * `-<n>` appears only when two of them would land in the same second, and it
 * sorts after the bare form — so a plain lexicographic sort of these names is
 * chronological, which is what the readers rely on.
 */
const SUFFIXED_FILE_TAIL = String.raw`-\d{8}-\d{6}(?:-\d+)?\.jsonl`;

/** The ledger's own filename; its `.corrupt-<ts>` copies are siblings. */
const LEGACY_STEM_LEDGER_FILENAME = "_legacy_stems.json";

/**
 * `<base>.legacy-<ts>.jsonl` — a READ-ONLY LEGACY SIDECAR.
 *
 * This is what the migration leaves when the destination filename is already
 * taken: the legacy bytes, renamed once and never rewritten. READERS INCLUDE
 * IT, WRITERS CANNOT SEE IT. `loadTranscript`, `searchTranscript`,
 * `transcriptCreatedAt` and `countRecentUserMessages` read sidecars; `append`,
 * `getLastSeq`, rotation and `archivesForStem` do not — which is what lets the
 * whole pre-migration history stay reachable without renumbering a single
 * `seq`, and keeps seq unique where uniqueness is actually required (inside the
 * active file and its rotation family).
 */
const LEGACY_SIDECAR_REMAINDER_RE = new RegExp(`^\\.legacy${SUFFIXED_FILE_TAIL}$`);
const LEGACY_SIDECAR_NAME_RE = new RegExp(`\\.legacy${SUFFIXED_FILE_TAIL}$`);

/**
 * `<base>.ambiguous-<ts>.jsonl` — PRESERVED BUT UNREACHABLE.
 *
 * Only for a key that keeps its legacy stem and turns out to share it: its own
 * active filename IS the mixed file, so "leave it where it is" is not available
 * the way it is for a key that moves. Nothing reads these; they exist so a
 * human can, and so the decision is recorded on disk (see
 * `quarantineAmbiguousFamily` for why that record is load-bearing).
 */
const AMBIGUOUS_REMAINDER_RE = new RegExp(`^\\.ambiguous${SUFFIXED_FILE_TAIL}$`);
const AMBIGUOUS_NAME_RE = new RegExp(`\\.ambiguous${SUFFIXED_FILE_TAIL}$`);

/**
 * Is anything in `names` (already lower-cased) named after `stem`?
 *
 * Case-folded, like every other stem comparison here, and deliberately
 * over-inclusive on the archive prefix: `_archive_dm_a_` also matches
 * `_archive_dm_a_b_2026-01.jsonl`, which keeps a ledger row that could have been
 * dropped. Erring toward keeping a row costs a line of JSON; erring the other
 * way costs a collision warning.
 */
function stemHasFilesOnDisk(stem: string, names: ReadonlySet<string>): boolean {
  const folded = stem.toLowerCase();
  for (const name of names) {
    if (name === `${folded}.jsonl`) return true;
    if (name.startsWith(`${folded}.legacy-`) && name.endsWith(".jsonl")) return true;
    if (name.startsWith(`${folded}.ambiguous-`) && name.endsWith(".jsonl")) return true;
    if (name.startsWith(`_archive_${folded}_`)) return true;
  }
  return false;
}

/** `YYYYMMDD-HHmmss` in UTC: sortable, filename-safe, second resolution. */
function fileTimestamp(at: Date = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${p(at.getUTCFullYear(), 4)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}`
    + `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
}

/**
 * A free `<base>.<kind>-<ts>[-<n>].jsonl` in `dir`, or null when the first
 * hundred candidates are all taken.
 *
 * CHECKED, NOT ASSUMED. The rename that uses this name must never land on an
 * existing sidecar or quarantine file: each one is the only copy of the history
 * inside it, so overwriting one is exactly the loss this whole scheme avoids.
 */
function freeSuffixedName(dir: string, base: string, kind: "legacy" | "ambiguous"): string | null {
  const ts = fileTimestamp();
  for (let n = 0; n < 100; n++) {
    const name = n === 0 ? `${base}.${kind}-${ts}.jsonl` : `${base}.${kind}-${ts}-${n}.jsonl`;
    const path = join(dir, name);
    if (!existsSync(path)) return path;
  }
  return null;
}

// Floor for the in-memory transcript tail: enough to cover historyLimit user
// turns with generous margin (a turn is typically 2-3 messages) while keeping
// months of history out of daemon memory.
const TRANSCRIPT_TAIL_MIN = 200;
// Rotate the active transcript once it outgrows this; prior months move to
// _archive_<key>_<YYYY-MM>.jsonl siblings.
const TRANSCRIPT_ROTATE_BYTES = 2 * 1024 * 1024;

/**
 * `YYYY-MM` for a record's timestamp, or null when it does not have a usable
 * one.
 *
 * `new Date(x).toISOString()` THROWS RangeError on an invalid date, and a
 * transcript record's timestamp is not guaranteed to be a number: a partial
 * write, a hand-edited file or an older writer can leave the field missing, a
 * string, or out of the ±8.64e15 range JSON.parse will happily hand back. The
 * one caller is rotation, which runs inside `get()`, which every inbound
 * message goes through — so "this record has no month" has to be a value the
 * caller can keep, not an exception that stops the session from receiving.
 *
 * A STRING IS A SHAPE THIS HAS TO ARCHIVE, not one to give up on. An ISO
 * timestamp is exactly what the older-writer case above names, `new Date(x)`
 * has always parsed it, and rejecting it on type alone moved those records
 * from "archived under their real month" to "undated, kept in the active
 * file forever" — a transcript that can never shrink below the rows a former
 * version of Tomo wrote. Numbers and parseable strings both resolve; only a
 * missing, non-finite or unparseable value is null.
 */
function monthOf(timestamp: unknown): string | null {
  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) return null;
  } else if (typeof timestamp !== "string") {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

/** The month the wall clock is in. Separate from `monthOf` so the caller that
 *  cannot fail is not made to narrow a null it can never be handed. */
function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
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

/**
 * `_legacy_stems.json`: legacy transcript filename stem → every session key
 * ever seen to own it.
 *
 * WHY A FILE AND NOT A DERIVATION. Deciding whether a legacy-named transcript
 * belongs to one key or several is a question about the PAST, and the registry
 * is a record of the present: `cleanupExpiredLocked` drops an unlinked entry
 * 30 days on (the transcript file outlives it), `clearSdkSessionId` removes a
 * metadata-only stub outright, and `migrateSessionKeyLocked` re-keys an entry
 * in place, keeping `migratedFrom` only for a non-DM→DM unification. Every one
 * of those erases the evidence that a second key ever shared the file, so an
 * inference from the live registry alone answers "only this key" for a file
 * that holds two people's messages — and `store.get()` then serves one
 * person's history to the other with no warning at all. So each of those
 * paths writes the key down here BEFORE forgetting it, and
 * `otherKeysSharingLegacyStem` reads this as well as the registry.
 */
interface LegacyStemLedgerFile {
  version: 1;
  /** Legacy stem → session keys, sorted, deduplicated. */
  stems: Record<string, string[]>;
}

/**
 * What `probeLegacyStemOwnership` concluded.
 *
 * `unknown` is the whole reason this is a union rather than a `string[]`: an
 * empty answer and an unanswerable one are different states, and conflating
 * them is what adopts a shared transcript off an unreadable registry.
 */
type OwnershipProbe =
  | { kind: "sole" }
  | { kind: "shared"; others: string[] }
  | { kind: "unknown"; source: string };

/**
 * What the `_legacy_stems.json.corrupt-*` copies in the sessions directory
 * still hold hostage.
 *
 * A QUARANTINE IS NOT A RESOLUTION, AND IT OUTLIVES THE PROCESS THAT MADE ONE.
 * Healing a malformed row moves it into a `.corrupt-` copy and rewrites the
 * ledger without it, so from then on the LEDGER looks clean while the fact that
 * some stem's owners were once unreadable lives only in that copy — and a stem
 * whose partner was named in the moved row would otherwise read as
 * single-owner to the next process, which adopts the shared file. So the copies
 * are part of the read path: `stems` maps every case-folded stem a copy still
 * names to the copy naming it, and `unparseable` is a copy that could not be
 * read row-wise at all (a crash mid-write, a mangled repair), which may name
 * ANY stem and therefore holds every stem the healed ledger has no row for.
 */
type CorruptLedgerHold = { stems: Map<string, string>; unparseable: string | null };

/** No `.corrupt-` copy on disk — the steady state, and the one the scan must
 *  reach with a readdir and no file read. */
const NO_CORRUPT_LEDGER_HOLD: CorruptLedgerHold = { stems: new Map(), unparseable: null };

/** What one pass of `carryLegacyTranscriptFamily` did, with the lock held. */
type CarryOutcome =
  /** `carried` files moved; `sidecars` of them became read-only sidecars. */
  | { kind: "done"; carried: number; sidecars: string[] }
  /** The in-lock ownership re-check found another owner; nothing was moved. */
  | { kind: "ambiguous"; others: string[] }
  /** An ownership source became unreadable; nothing was moved, retry later. */
  | { kind: "deferred" };

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
 * Stricter than `isAfterMessage`, which accepts any non-null value: a
 * hand-edited `seq: "12"` is invisible to a search bound here but would still
 * be compared as a string there. Nothing that has to ORDER by seq may accept a
 * string (`"12" + 1` is `"121"`), so both places where the next seq to hand out
 * is decided — `getLastSeq`'s scan of the tail AND its archive fallback — use
 * this; the remaining leniency in `isAfterMessage` is pre-existing and left
 * alone.
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
 * The instant a record is ORDERED BY when a read set mixes files whose relative
 * order cannot be inferred from their names (see `transcriptReadSet`).
 *
 * A record with no usable timestamp sorts as older than every placeable one: it
 * cannot be interleaved honestly, and the only alternative — dropping it —
 * loses history. Ties (including a whole run of undated records) are broken by
 * file order, so the result is deterministic.
 */
function orderTimestamp(msg: SessionMessage): number {
  return usableTimestamp(msg) ?? -Infinity;
}

/**
 * Sort records oldest-first by their own timestamps, ties by their position in
 * the input.
 *
 * Index-tiebroken rather than trusting `Array.sort` to be stable, and it never
 * SUBTRACTS the two keys: `-Infinity - -Infinity` is `NaN`, which makes a
 * comparator inconsistent and the result unspecified.
 */
function sortByRecordTime(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages
    .map((msg, index) => ({ msg, index }))
    .sort((a, b) => {
      const ta = orderTimestamp(a.msg);
      const tb = orderTimestamp(b.msg);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.msg);
}

/**
 * The UTC instant encoded in a `-<YYYYMMDD-HHmmss>[-<n>].jsonl` suffix, or null
 * when the name does not carry one. Second resolution, like the names.
 */
function suffixedNameTime(name: string): number | null {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.jsonl$/.exec(name);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * Are these two names the SAME FILE — same device, same inode?
 *
 * This is what tells "the destination is another key's live transcript" from
 * "the destination is the hard link this very migration created before it was
 * interrupted" (see `moveWithoutClobber`).
 */
function sameFileOnDisk(from: string, to: string): "same" | "different" | "missing-source" {
  let source: ReturnType<typeof statSync>;
  try {
    source = statSync(from);
  } catch {
    return "missing-source";
  }
  try {
    const target = statSync(to);
    return source.dev === target.dev && source.ino === target.ino ? "same" : "different";
  } catch {
    return "different";
  }
}

/** Unlink `path`, treating "it is already gone" as success — the second half of
 *  a link+unlink move is idempotent by construction. */
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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

/**
 * The filename stem Tomo used for a transcript before the collision fix, and
 * the one it still uses for every key it safely can.
 *
 * MANY-TO-ONE, which is the whole problem: every character outside
 * `[A-Za-z0-9_-]` becomes `_`, so `imessage:any;-;alex.smith@example.com` and
 * `imessage:any;-;alex_smith@example.com` — two different people — name the
 * same file. Kept as a named helper because the lazy migration in
 * `SessionStore` has to be able to find files written under the old scheme.
 */
export function legacyTranscriptFileStem(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Keys made only of these characters keep their legacy stem.
 *
 * `_` is deliberately absent: a `_` in the key is indistinguishable from an
 * encoded `:`, so `dm:a_b` and `dm:a:b` would still collide.
 *
 * `A-Z` IS DELIBERATELY ABSENT TOO, and it is not a nicety. The sessions
 * directory lives on whatever filesystem the user has, and the defaults on
 * both platforms Tomo runs on — APFS on macOS, NTFS on Windows — are
 * case-INSENSITIVE. Allowing uppercase into the unsuffixed family made
 * `imessage:AbC` and `imessage:abc` name the stems `imessage_AbC` and
 * `imessage_abc`, which are the same file there: the exact leak this whole
 * scheme exists to close, reintroduced one letter at a time. Any key with an
 * uppercase character therefore takes the hash suffix, and the hash is what
 * separates it from its case-folded twin (hex digits are lowercase, so the
 * suffix itself survives case folding intact).
 *
 * Nothing everyday moves because of this: `dm:*` keys are lowercased at
 * construction (`dmSessionKeyForIdentity`), `telegram:-100…` and other numeric
 * chat ids have no letters, and `heartbeat` is lowercase. The keys that gain a
 * suffix are the ones that already had to — iMessage chat GUIDs, which carry
 * `;`, `+` or `@` as well.
 */
const LEGACY_STABLE_KEY_CHAR = /[^a-z0-9:-]/;

/** Bits of SHA-256 kept as the disambiguating suffix — 48, i.e. ~16.7M keys
 *  before a 50% birthday chance, against a personal assistant's dozens. */
const KEY_HASH_HEX_CHARS = 12;

/**
 * The filename stem for a session key's transcript: `<stem>.jsonl` for the
 * active file, `_archive_<stem>_<YYYY-MM>.jsonl` for rotation archives.
 *
 * INJECTIVE, which `legacyTranscriptFileStem` is not — and injective UP TO
 * CASE FOLDING, because the filesystem underneath is usually case-insensitive
 * (see `LEGACY_STABLE_KEY_CHAR`):
 *
 * - A key drawn only from `[a-z0-9:-]` keeps its legacy stem, so `dm:alice`,
 *   `telegram:123` and `telegram:-100123` name exactly the files they always
 *   did and never need migrating. On that alphabet the legacy replacement is
 *   `: → _` and identity elsewhere, and `_` is not in the alphabet — so it is
 *   injective there; and every such stem is already lowercase, so folding
 *   changes nothing.
 * - Any other key gets `<legacy stem>.<hash of the FULL key>`. The hash is over
 *   the key, not the stem, so the two iMessage addresses above differ — and so
 *   do two keys differing only in case, whose legacy stems would fold together.
 * - The two sets cannot meet: `.` is outside the legacy safe set, so a legacy
 *   stem never contains one, and a suffixed stem always does.
 *
 * ARCHIVE LISTING DOES NOT RELY ON ANY OF THAT. `_archive_<stem>_` is only a
 * prefix, and `dm:a` is a prefix of `dm:ab` — what stops `dm:a` from claiming
 * `dm:ab`'s archives is the strict remainder test in `archivesForStem`: after
 * the prefix, the name must be exactly `YYYY-MM.jsonl`. A suffixed stem
 * carrying a `.` is neither necessary nor sufficient for that.
 */
export function transcriptFileStem(key: string): string {
  const legacy = legacyTranscriptFileStem(key);
  if (!LEGACY_STABLE_KEY_CHAR.test(key)) return legacy;
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, KEY_HASH_HEX_CHARS);
  return `${legacy}.${hash}`;
}

/**
 * One file in a key's read set, and whether it is a READ-ONLY LEGACY SIDECAR —
 * a different seq run that no writer will touch again, and one whose position
 * in time cannot be read off its filename.
 */
interface TranscriptReadFile {
  path: string;
  sidecar: boolean;
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
  /** Ditto for a bookkeeping write skipped because the registry lock was held
   *  by another process for the whole wait budget. */
  private registryLockErrorLogged = false;
  /**
   * A bookkeeping change is applied in memory but not on disk (the save failed
   * — ENOSPC, EROFS, EACCES). While this is set, the forced re-read that
   * `mutateRegistry` normally does is suppressed: it would discard the very
   * change we are holding for the next attempt. Cleared by the next successful
   * save, which is what publishes it.
   */
  private registryDirty = false;
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
  /** Keys whose legacy-named transcript files have been fully settled — carried
   *  over, refused as ambiguous, or never there (see
   *  `ensureTranscriptMigrated`). Never holds a key whose migration was merely
   *  ATTEMPTED: that is the bug this set used to carry. */
  private transcriptMigrationChecked = new Set<string>();
  /** Keys with a migration attempt on the stack, so a nested `transcriptPath`
   *  cannot recurse into it. */
  private transcriptMigrationInFlight = new Set<string>();
  /** Keys whose last migration attempt did not complete, and the wall-clock
   *  time from which the next inbound message may try again. */
  private transcriptMigrationRetryAt = new Map<string, number>();
  /** Legacy stems already reported as shared by more than one key — one warn
   *  per collision per process, not one per message. */
  private transcriptCollisionWarned = new Set<string>();
  /** Ditto for a migration skipped because the transcript lock was held. */
  private transcriptLockWarned = new Set<string>();
  /** Ditto for a quarantine pass that left part of a shared family readable. */
  private transcriptQuarantineIncompleteWarned = new Set<string>();
  /** Ditto for an ownership source (`_sessions.json`, `_legacy_stems.json`)
   *  that could not be read, which defers every key's migration. */
  private transcriptSourceWarned = new Set<string>();
  /** Case-folded legacy stems found to be shared by more than one key — the
   *  `ambiguous` half of `migrationStatus()`. */
  private transcriptAmbiguousStems = new Set<string>();
  /** The ledger's read failure is logged once per streak, not once per key. */
  private legacyStemLedgerErrorLogged = false;
  /**
   * The last answer `probeLegacyStemOwnership` gave for a key, while its
   * migration is unsettled. `shared` on a key that KEEPS its legacy stem is the
   * one state in which reading the file would mix two sessions (see `get()`);
   * dropped as soon as the key settles.
   */
  private transcriptProbeAnswer = new Map<string, "shared" | "unknown">();
  /** Keys being served an empty session because their own transcript file is
   *  known-mixed and not parked yet — tracked so an `append()` inside that
   *  window keeps appending to one session rather than restarting it. */
  private transcriptWithheld = new Set<string>();
  /** One warn per key per streak for that withholding, and one for a deferral
   *  we keep serving through. */
  private transcriptWithheldWarned = new Set<string>();
  private transcriptDeferredServeWarned = new Set<string>();
  /** Case-folded legacy stems whose ledger ROW could not be parsed. Their
   *  ownership is unknown, so only their migrations defer — the rest of the
   *  ledger is still good evidence (see `loadLegacyStemLedger`). */
  private legacyStemLedgerMalformedStems = new Set<string>();
  /** The whole ledger file was unparseable and has been moved aside. Fail
   *  closed for the rest of the streak: the file is ABSENT now, and "absent"
   *  otherwise reads as "fresh install, nothing was ever shared". */
  private legacyStemLedgerUnparseable = false;
  /** One row-healing attempt per streak, not one per key touch. */
  private legacyStemLedgerHealAttempted = false;
  /**
   * The last `_legacy_stems.json.corrupt-*` scan, keyed by a signature over the
   * copies' names, sizes and mtimes.
   *
   * DERIVED FROM THE DIRECTORY, NEVER REMEMBERED ACROSS THE FACT: the hold those
   * copies place on a stem has to outlive the process that created them (see
   * `corruptLegacyStemLedgerHold`), and it is released by an operator deleting
   * or repairing the file — which the signature notices.
   */
  private legacyStemLedgerCorruptCache: { signature: string; hold: CorruptLedgerHold } | null = null;
  /** One warn per (corrupt copy, stem) pair, not one per inbound message. */
  private legacyStemLedgerCorruptWarned = new Set<string>();
  /**
   * The move primitive the migration uses, once the FILESYSTEM has answered
   * whether it can hard-link a transcript (see `moveWithoutClobber`). Null until
   * then; `carryModeLogged` is only about saying it once.
   */
  private carryMode: "link" | "rename" | null = null;
  private carryModeLogged: "link" | "rename" | null = null;
  /**
   * Messages loaded from a READ-ONLY LEGACY SIDECAR.
   *
   * They sit in `session.messages` so the model and `searchTranscript` see that
   * history, but they are a different seq run that no writer will ever touch
   * again — so `getLastSeq` must skip them, or the next append continues from a
   * number that has nothing to do with the active file. Identity-keyed rather
   * than a flag on the record: nothing about a sidecar may change the bytes
   * that would be written back for it, and nothing is written back for it.
   */
  private sidecarMessages = new WeakSet<SessionMessage>();

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
    // BEFORE the cache lookup, not after. A migration can move the bytes behind
    // this key's transcript (the active file arrives under a new name, or an
    // older file appears beside it as a read-only sidecar) and it drops the
    // cached session when it does, so running it first is what makes the reload
    // below pick the new content up. Reaching it only through `safeKey` would
    // instead let it fire midway through `append`, after the message's seq had
    // been derived from the stale tail. Memoized per key, so for a settled key
    // this is a `Set.has`.
    //
    // AND ITS ANSWER IS USED. A `false` means "we do not yet know which files
    // are this key's", and for one shape of that — a key whose own active
    // filename is KNOWN to hold another key's history too, whose quarantine
    // could not be completed (the ledger write failed, the transcript lock was
    // held) — loading the file anyway serves one person's history to another,
    // which is the whole defect this scheme exists to close. Such a key gets an
    // EMPTY session until the quarantine lands; every other deferral keeps
    // serving what is on disk, because there the alternative is losing sight of
    // the key's own messages.
    const settled = this.ensureTranscriptMigrated(key);
    if (!settled) {
      if (this.servesMixedTranscript(key)) return this.withheldSession(key);
      this.warnOnce(this.transcriptDeferredServeWarned, key, () => log.warn(
        { key },
        "Serving this session from the files it names while its legacy transcript migration is deferred: the "
        + "ownership sources could not be read, and the alternative — withholding the history — loses sight of "
        + "messages that are almost certainly this key's own. Retried on the next message",
      ));
    }

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
  searchTranscript(key: string, opts: {
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
    if (this.withholdsTranscript(key)) return [];
    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];
    const queryLower = opts.query?.toLowerCase();
    // Sidecars included: a legacy file the migration could not rename is still
    // this key's history, and a search that cannot see it is the exact defect
    // the sidecar rule exists to avoid.
    const readSet = this.transcriptReadSet(key);
    if (readSet.hasSidecars) return this.searchTranscriptUnordered(readSet.files, opts, limit, queryLower);
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
  private searchTranscriptUnordered(
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
    // THE MAX OVER THE TAIL, not the last one in it. Normally identical — seq
    // is handed out monotonically — but a hand-edited or hand-repaired
    // transcript can hold a stretch of records whose seq is out of order, and
    // taking the newest record's value there hands the SAME seq out twice.
    // Rotation treats a seq it has already archived as "already archived" and
    // drops the record, so a reused seq is data loss, not cosmetics.
    //
    // SIDECARS ARE NOT PART OF THIS SEQUENCE. A read-only legacy sidecar is
    // loaded into the tail so history is visible, but it is a separate run that
    // no writer touches again, and seq only has to be unique inside the active
    // file and its rotation family. Continuing from a sidecar would skip a
    // stretch of numbers for nothing — and, worse, would make the number handed
    // out depend on a file the rotation dedupe cannot see.
    let max: number | null = null;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (this.sidecarMessages.has(msg)) continue;
      const seq = usableSeq(msg);
      if (seq !== null && (max === null || seq > max)) max = seq;
    }
    if (max !== null) return max;
    // No seq in the tail — rotation may have moved every active message into
    // monthly archives (e.g. a session idle across a month boundary).
    // Continue the sequence from the newest archived record so seq stays
    // monotonic across the whole transcript history. MAX OVER THE NEWEST
    // ARCHIVE, for the same reason as the tail above and with the same
    // `usableSeq` strictness: a `seq: "12"` read straight off the record used
    // to seed the next append with a string, and `"12" + 1` is `"121"`.
    for (const file of this.listTranscriptArchives(session.key)) {
      let archiveMax: number | null = null;
      for (const record of iterateJsonlBackwardsSync<SessionMessage>(file)) {
        const seq = usableSeq(record);
        if (seq !== null && (archiveMax === null || seq > archiveMax)) archiveMax = seq;
      }
      if (archiveMax !== null) return archiveMax;
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
    // Link change: mutateRegistry refuses (throws) before anything is mutated
    // in memory, both for an unreadable file and for a lock we could not take.
    this.mutateRegistry("setSdkSessionId", "link", () => {
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

      // Unlink any existing session for this key. Nested inside our lock (which
      // is re-entrant within one process) and nothing of ours is mutated yet,
      // so its own save publishes a consistent state for us to build on.
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
    });
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
    // Bookkeeping: this runs after the model has already answered. Skipping it
    // costs a stale stat line; throwing would fail a turn that succeeded.
    // mutateRegistry re-reads under the lock first, so other processes (tomo
    // sessions clear, tomo config) cannot have their changes reverted by the
    // stale in-memory copy we would otherwise publish.
    this.mutateRegistry("updateStats", "bookkeeping", () => {
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
    });
  }

  /** Touch the active session (update lastActiveAt) */
  touchSession(key: string): void {
    this.mutateRegistry("touchSession", "bookkeeping", () => {
      const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
      if (entry) {
        entry.lastActiveAt = Date.now();
        this.saveRegistryBestEffort("touchSession");
      }
    });
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
    this.mutateRegistry("clearSdkSessionId", "link", () => {
      const now = Date.now();
      /** A metadata-only stub we refused to drop (see below) must not be TTL'd
       *  either: an expiring stub is the same forgetting, 30 days later. */
      let deferredStub = false;
      this.registry = this.registry.filter((entry) => {
        if (entry.channelKey === key && entry.unlinkedAt === null && !entry.sdkSessionId) {
          // Removed outright, not TTL'd — so record the legacy-stem ownership
          // BEFORE the entry goes (see LegacyStemLedgerFile). If that cannot be
          // persisted the stub STAYS: dropping it is what makes a shared legacy
          // transcript silently adoptable, and a metadata-only stub kept for one
          // more pass costs nothing — it carries no SDK file and the next
          // `clearSdkSessionId` (or daemon start) retries.
          if (!this.rememberLegacyStemOwners([key, ...(entry.migratedFrom ? [entry.migratedFrom] : [])])) {
            log.warn(
              { key },
              "Keeping the metadata-only session entry: its legacy transcript stem ownership could not be recorded",
            );
            deferredStub = true;
            return true;
          }
          log.info({ key }, "Metadata-only session entry removed");
          return false;
        }
        return true;
      });
      for (const entry of this.registry) {
        if (entry.channelKey === key && entry.unlinkedAt === null) {
          if (deferredStub && !entry.sdkSessionId) continue;
          entry.unlinkedAt = now;
          entry.expiresAt = now + UNLINKED_TTL_MS;
          log.info(
            { key, sessionId: entry.sdkSessionId, expiresAt: new Date(entry.expiresAt).toISOString() },
            "Session unlinked, will be deleted in 30 days",
          );
        }
      }
      this.saveRegistry();
    });
  }

  /**
   * Retire a poisoned SDK resume chain while preserving active routing/group
   * metadata. Use this when the SDK JSONL likely ended mid-turn (for example a
   * local query timeout): resuming that file can continue stale tool work, but
   * the chat title, participants, and reply target are still valid.
   */
  retireSdkSessionId(key: string): string | undefined {
    return this.mutateRegistry("retireSdkSessionId", "link", () => {
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
    });
  }

  /** Delete expired unlinked sessions and their SDK JSONL files */
  private cleanupExpired(): void {
    // Runs from the constructor, so it must not throw — hence "bookkeeping",
    // which turns both an unreadable registry and an unavailable lock into a
    // skip. It also unlinks SDK JSONL files, which is irreversible: never do
    // that from a registry we could not read, or while another process might
    // be re-linking one.
    this.mutateRegistry("cleanupExpired", "bookkeeping", () => this.cleanupExpiredLocked());
  }

  private cleanupExpiredLocked(): void {
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
      // WRITE IT DOWN BEFORE FORGETTING IT. These entries are about to leave
      // the registry for good, while their transcript files stay on disk — and
      // for a legacy-named file shared with another key, the registry entry was
      // the only thing that said so. Dropping the entry without recording the
      // ownership is what let the surviving key silently adopt the other
      // person's messages (see LegacyStemLedgerFile). If the ledger cannot be
      // written, the entries stay: this whole pass is housekeeping that the
      // next daemon start redoes, and the SDK files it already unlinked are
      // TTL'd data, not history.
      const forgotten = expired.flatMap((e) => [e.channelKey, ...(e.migratedFrom ? [e.migratedFrom] : [])]);
      if (!this.rememberLegacyStemOwners(forgotten)) return;

      this.registry = this.registry.filter((e) => e.expiresAt === null || e.expiresAt > now);
      // BEST-EFFORT, because of the header above: this runs from the
      // constructor, and a bare `saveRegistry()` throws on any write failure
      // (ENOSPC, EACCES, a read-only volume) — which means `new
      // SessionStore()` throws, which means the daemon does not start and
      // cannot receive a message on any channel, over housekeeping that was
      // never urgent. The SDK files are already unlinked at this point, so
      // the entries left on disk name transcripts that no longer exist:
      // harmless, and swept again on the next start once the write works.
      this.saveRegistryBestEffort("cleanupExpired");
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
    // mutateRegistry's guards run BEFORE ensureActiveEntry, which would
    // otherwise push a stub into the in-memory registry we cannot persist.
    this.mutateRegistry("setReplyTarget", "bookkeeping", () => {
      const entry = this.ensureActiveEntry(key);
      const prev = entry.replyTarget;
      if (prev && prev.channelName === target.channelName && prev.chatId === target.chatId) return;
      entry.replyTarget = target;
      this.saveRegistryBestEffort("setReplyTarget");
    });
  }

  /** Persist a friendly chat title for a session (mainly groups). No-op if unchanged. */
  setChatTitle(key: string, title: string): void {
    this.mutateRegistry("setChatTitle", "bookkeeping", () => {
      const entry = this.ensureActiveEntry(key);
      if (entry.chatTitle !== title) {
        entry.chatTitle = title;
        this.saveRegistryBestEffort("setChatTitle");
      }
    });
  }

  /** Add a participant name (and, when known, its stable sender id) to a
   *  session. No-op if nothing new was learned. */
  addParticipant(key: string, name: string, senderId?: string): void {
    // Bookkeeping, and on the INBOUND path: updateGroupContext calls this
    // before the message is appended to the transcript, and the rejection is
    // swallowed upstream — a throw here silently drops the message.
    this.mutateRegistry("addParticipant", "bookkeeping", () => {
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
    });
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
    this.mutateRegistry("migrateSessionKey", "link", () => this.migrateSessionKeyLocked(oldKey, newKey));
  }

  private migrateSessionKeyLocked(oldKey: string, newKey: string): void {
    const idx = this.registry.findIndex((e) => e.channelKey === oldKey && e.unlinkedAt === null);
    if (idx === -1) return;
    const entry = this.registry[idx];

    // Settle the old key's filenames BEFORE the entry is re-keyed: the renames
    // below move whatever `transcriptPath(oldKey)` names, and the ownership
    // check wants to see the registry as it stands now, with `oldKey` still on
    // its own entry. (`transcriptPath` would trigger this anyway; doing it here
    // is what makes the order deliberate rather than incidental.)
    //
    // AND IT HAS TO HAVE SETTLED. "Not settled" means we do not yet know which
    // files are `oldKey`'s — the legacy name may still hold another key's
    // history, or `oldKey`'s history may still be under a legacy name that a
    // later pass would carry onto a file we have already renamed away. Re-keying
    // is not reversible; refusing is, and it is retried on the next message.
    // `migrateSessionKey` is a "link" mutator, so every caller already handles a
    // throw (see `IdentityRouter.maybeMigrate`, which keeps routing to the old
    // key and retries).
    if (!this.ensureTranscriptMigrated(oldKey)) {
      throw new Error(
        `cannot re-key session ${oldKey} to ${newKey}: its legacy transcript migration has not settled`,
      );
    }

    // Re-keying is the registry forgetting `oldKey`: the `migratedFrom`
    // breadcrumb below is only kept for a non-DM→DM unification, so for every
    // other re-key nothing would remember that `oldKey` once owned its legacy
    // transcript name. Record it FIRST, and refuse the re-key if it cannot be
    // recorded (see LegacyStemLedgerFile). An earlier version treated this as
    // best-effort on the grounds that a session which cannot be unified is a
    // visible breakage where a missing ledger row is not — but the row is what
    // stops the OTHER key from adopting a file holding this one's messages, and
    // that loss is silent and permanent. A refused unification is loud and
    // retried. Warned inside `rememberLegacyStemOwners` too.
    if (!this.rememberLegacyStemOwners([oldKey])) {
      throw new Error(
        `cannot re-key session ${oldKey} to ${newKey}: its legacy transcript stem ownership could not be recorded`,
      );
    }

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

    // Rename the transcript and its monthly rotation archives, so search and
    // createdAt keep covering the pre-migration history.
    //
    // WHEN THE DESTINATION IS TAKEN, SIDECAR IT. The old code was
    // `existsSync(old) && !existsSync(new)` and then nothing — a `dm:alex` that
    // had already received a message kept its own file and `oldKey`'s whole
    // history stayed on disk, reachable from no path. Same hole as the legacy
    // migration's, same answer: one more rename, no rewriting, and the bytes land
    // where every reader of `newKey` picks them up (`transcriptReadSet`).
    const oldStem = this.safeKey(oldKey);
    const newStem = this.safeKey(newKey);
    const sidecars: string[] = [];
    for (const { from, base, sidecarOnly } of this.transcriptFamilyMoves(oldStem, newStem)) {
      const landed = this.carryOntoBase(from, base, sidecarOnly);
      if (landed !== null && LEGACY_SIDECAR_NAME_RE.test(landed)) sidecars.push(landed);
    }
    if (sidecars.length > 0) {
      log.warn(
        { oldKey, newKey, sidecars },
        "Unified session: the old key's transcript was kept as a read-only sidecar because the unified name was "
        + "already in use. It is searched and loaded with the rest of the history, and never appended to or rotated",
      );
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

    // Clear the in-memory session cache for BOTH keys: the old one is gone, and
    // the new one's files just changed underneath it (it gained the old key's
    // active file, or a read-only sidecar beside its own). A cached session there
    // would keep serving the pre-unification tail.
    this.dropCachedSession(oldKey);
    this.dropCachedSession(newKey);

    this.saveRegistry();
    log.info({ oldKey, newKey, sdkSessionId: entry.sdkSessionId }, "Session migrated to unified key");
  }

  // --- Registry persistence ---

  private get registryPath(): string {
    return join(this.dir, "_sessions.json");
  }

  /** Advisory lock serializing registry read-modify-write against other processes. */
  private get registryLockPath(): string {
    return `${this.registryPath}.lock`;
  }

  /**
   * Run one registry read-modify-write: lock, re-read, guard, mutate, save.
   *
   * Every mutator goes through here, because "load, change it in memory, write
   * the whole snapshot back" is a read-modify-write with no concurrency control
   * of its own, and this registry has short-lived writers (`tomo sessions
   * clear`, the identity migration in `tomo config`) racing a daemon that
   * writes on every inbound message. The daemon loading the file, the CLI
   * clearing an SDK link, and the daemon then publishing its earlier snapshot
   * restores the link the CLI just cleared — a lost update no atomic rename can
   * prevent, since both writes are individually atomic.
   *
   * Two things close it. The lock keeps any other process out of its own
   * read-modify-write for the whole cycle. And the read inside is FORCED past
   * the mtime/size stat cache, so the snapshot we publish is the file we just
   * read: same-size writes landing inside one mtime tick (a `sdkSessionId`
   * swapped for another of equal length, say) used to be invisible.
   *
   * The mode is the existing split, extended to cover a lock we could not take:
   * - `"link"` — changes WHICH SDK session a key resolves to. Throws
   *   (`SessionRegistryReadError`, `FileLockTimeoutError`) before touching
   *   anything, because inventing a link orphans a JSONL for good.
   * - `"bookkeeping"` — stats, timestamps, titles, participants, reply target.
   *   Logs and skips, never throws: these sit on the inbound and
   *   turn-completion paths where a throw drops a message or fails a good turn.
   *
   * Re-entrant: `setSdkSessionId` calls `clearSdkSessionId`, and every
   * `saveRegistry` takes the same lock. The nested frames skip the forced
   * re-read — the outer frame already did it, and re-reading would discard the
   * mutation the outer frame is in the middle of making.
   */
  private mutateRegistry<T>(op: string, mode: "link" | "bookkeeping", fn: () => T): T | undefined {
    const strict = mode === "link";
    const nested = isFileLockHeldSync(this.registryLockPath);
    const body = (): T | undefined => {
      if (!nested && !this.registryDirty) {
        // Force a real read: the stat cache exists to skip re-parsing a file
        // nothing has touched, and "nothing has touched it" is exactly what a
        // concurrent writer falsifies (a same-size write inside one mtime tick
        // is invisible to it). Skipped while we are holding a change that could
        // not be saved yet — re-reading would drop it, and the next successful
        // save is what publishes it.
        this.registryStat = null;
      }
      this.loadRegistry();
      if (strict) this.assertRegistryLoaded();
      else if (!this.canWriteRegistry(op)) return undefined;
      return fn();
    };

    let entered = false;
    try {
      return withFileLockSync(this.registryLockPath, () => {
        entered = true;
        this.registryLockErrorLogged = false;
        return body();
      }, REGISTRY_LOCK_OPTIONS);
    } catch (err) {
      // Anything `fn` itself threw keeps its existing meaning.
      if (entered) throw err;
      if (err instanceof FileLockTimeoutError) {
        if (strict) throw err;
        this.noteRegistryLockFailure(
          op, err,
          "Skipping session-registry bookkeeping write: another process is holding the registry lock",
        );
        return undefined;
      }
      // The lock could not be CREATED (EACCES/EROFS on the sessions directory,
      // something occupying the lock path). Degrade to an unlocked cycle rather
      // than refusing: the lock lives beside the registry, so a directory that
      // will not take the lock will not take the atomic write's temp file
      // either — the save fails the same way it did before this lock existed,
      // and bookkeeping keeps its change in memory for the next attempt.
      this.noteRegistryLockFailure(
        op, err,
        "Session-registry write proceeding without exclusion: the lock could not be created",
      );
      return body();
    }
  }

  /** Log a lock failure once per streak, like the read/write failure paths. */
  private noteRegistryLockFailure(op: string, err: unknown, msg: string): void {
    if (this.registryLockErrorLogged) return;
    this.registryLockErrorLogged = true;
    log.warn({ err, file: this.registryPath, op }, msg);
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

  // --- Legacy stem ownership ledger (see LegacyStemLedgerFile) ---

  private get legacyStemLedgerPath(): string {
    return join(this.dir, LEGACY_STEM_LEDGER_FILENAME);
  }

  /** Advisory lock for the ledger's read-modify-write.
   *
   *  ALWAYS THE INNERMOST LOCK. The registry lock and the transcript lock are
   *  both taken with this one still free, and nothing here reaches back for
   *  either, so the acquisition order is fixed (registry → transcript →
   *  ledger) and no two processes can build a cycle. */
  private get legacyStemLedgerLockPath(): string {
    return `${this.legacyStemLedgerPath}.lock`;
  }

  /**
   * Legacy stem → owning keys, as recorded on disk.
   *
   * ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS, and this is the one place in
   * the store where getting that wrong costs someone else's history: a missing
   * file legitimately means "nothing has been recorded yet", while a file that
   * exists and will not parse may name the very owner that makes a legacy
   * transcript ambiguous. So the second case says so, and every caller refuses
   * rather than proceeding on `{}`. Never throws — this runs under `get()`.
   *
   * A MALFORMED ROW IS NOT A MALFORMED FILE. The first version refused the whole
   * file for one bad row, which deferred EVERY key's migration, and the write
   * path then quarantined the file and rebuilt from `{}` — discarding the
   * ownership evidence in all the rows that were perfectly readable. Rows are
   * parsed one at a time now: the good ones are returned and used, the bad ones
   * are reported in `malformed` so that only THEIR stems defer, and
   * `healLegacyStemLedgerRows` moves them verbatim into a `.corrupt-<ts>`
   * sibling so the wedge clears without waiting for a write.
   *
   * PURE, DELIBERATELY: callers may hold locks or be mid-cycle, so nothing is
   * written from here. The read path triggers the healing explicitly.
   */
  private loadLegacyStemLedger():
    { ok: true; stems: Record<string, string[]>; malformed: string[] } | { ok: false } {
    if (this.legacyStemLedgerUnparseable && !existsSync(this.legacyStemLedgerPath)) {
      // The bytes were moved to `.corrupt-<ts>` on the read path, so the file is
      // absent now — and "absent" is the one answer we must not give here, since
      // it reads as "nothing was ever recorded". Fail closed until a ledger that
      // parses is back in place.
      return { ok: false };
    }
    if (!existsSync(this.legacyStemLedgerPath)) return { ok: true, stems: {}, malformed: [] };
    let data: Partial<LegacyStemLedgerFile>;
    try {
      data = JSON.parse(readFileSync(this.legacyStemLedgerPath, "utf-8")) as Partial<LegacyStemLedgerFile>;
    } catch (err) {
      this.noteLegacyStemLedgerUnreadable(err);
      return { ok: false };
    }
    const stems = data?.stems;
    if (!stems || typeof stems !== "object" || Array.isArray(stems)) {
      this.noteLegacyStemLedgerUnreadable(new Error("missing or malformed `stems` object"));
      return { ok: false };
    }
    const good: Record<string, string[]> = {};
    const malformed: string[] = [];
    for (const [stem, owners] of Object.entries(stems)) {
      if (Array.isArray(owners) && owners.every((key) => typeof key === "string")) {
        good[stem] = owners as string[];
        continue;
      }
      malformed.push(stem);
      // Remembered for the rest of the process: the healing below takes the row
      // out of the file, and after that nothing on disk says this stem's owners
      // were once unreadable. Its migrations keep deferring here rather than
      // adopting a file whose other owner may be exactly what that row held.
      this.legacyStemLedgerMalformedStems.add(stem.toLowerCase());
    }
    if (malformed.length > 0) {
      this.noteLegacyStemLedgerUnreadable(
        new Error(`malformed owner list for ${malformed.length} stem(s): ${malformed.map((x) => JSON.stringify(x)).join(", ")}`),
      );
    } else {
      this.legacyStemLedgerErrorLogged = false;
      this.legacyStemLedgerHealAttempted = false;
      this.legacyStemLedgerUnparseable = false;
    }
    return { ok: true, stems: good, malformed };
  }

  /**
   * The ledger as the OWNERSHIP PROBE reads it: the same parse, plus the two
   * repairs that can only safely be attempted from a path that is not already
   * mid-write.
   *
   * This is the read path the brief calls for. A wedged ledger used to sit there
   * until some write path happened to come along — and since the write paths
   * refuse when the ledger is unreadable, "some write path" could be never.
   */
  private readLegacyStemLedger():
    { ok: true; stems: Record<string, string[]>; malformed: string[] } | { ok: false } {
    const loaded = this.loadLegacyStemLedger();
    if (loaded.ok && loaded.malformed.length === 0) return loaded;
    if (loaded.ok) {
      if (!this.healLegacyStemLedgerRows()) return loaded;
      const reread = this.loadLegacyStemLedger();
      // The stems whose rows were bad stay in `legacyStemLedgerMalformedStems`,
      // so they keep deferring even though the re-read no longer lists them.
      return reread.ok ? { ...reread, malformed: loaded.malformed } : reread;
    }
    this.quarantineUnparseableLedger();
    return { ok: false };
  }

  /**
   * Move every unparseable ROW into a `.corrupt-<ts>` sibling and rewrite the
   * good ones, atomically, under the ledger lock. Returns true when the file on
   * disk no longer holds a bad row.
   *
   * ORDERED SO A CRASH CANNOT LOSE A ROW: the quarantine copy is written first,
   * so the worst interruption leaves the bad rows in two places rather than
   * none. One attempt per failure streak — it is reached from every key's first
   * touch, and a lock we could not take is not a reason to try again per
   * message.
   */
  private healLegacyStemLedgerRows(): boolean {
    if (this.legacyStemLedgerHealAttempted) return false;
    this.legacyStemLedgerHealAttempted = true;
    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read the RAW file inside the lock: another process may have
        // repaired or replaced it while we waited.
        let data: Partial<LegacyStemLedgerFile>;
        try {
          data = JSON.parse(readFileSync(this.legacyStemLedgerPath, "utf-8")) as Partial<LegacyStemLedgerFile>;
        } catch {
          return false;
        }
        const stems = data?.stems;
        if (!stems || typeof stems !== "object" || Array.isArray(stems)) return false;
        const good: Record<string, unknown> = {};
        const bad: Record<string, unknown> = {};
        for (const [stem, owners] of Object.entries(stems)) {
          if (Array.isArray(owners) && owners.every((key) => typeof key === "string")) good[stem] = owners;
          else bad[stem] = owners;
        }
        if (Object.keys(bad).length === 0) return true;
        const to = this.freeLegacyStemLedgerCorruptName();
        if (to === null) return false;
        // Verbatim: whatever was in the row is what a human gets to look at.
        writeJsonAtomicSync(to, { version: 1, stems: bad });
        writeJsonAtomicSync(this.legacyStemLedgerPath, { version: 1, stems: good });
        log.warn(
          { file: this.legacyStemLedgerPath, to, stems: Object.keys(bad) },
          "Moved unreadable rows out of the legacy transcript stem ledger into a `.corrupt-` sibling and kept the "
          + "readable ones; only the sessions named by those rows stay deferred, and the quarantined copy is the "
          + "only record of the owners they held",
        );
        return true;
      }, LEGACY_STEM_LEDGER_LOCK_OPTIONS);
    } catch (err) {
      log.warn(
        { err, file: this.legacyStemLedgerPath },
        "Could not move the unreadable rows out of the legacy transcript stem ledger; every session named by a bad "
        + "row stays deferred",
      );
      return false;
    }
  }

  /**
   * Quarantine a ledger whose JSON is unparseable as a whole, from the READ
   * path, and keep failing closed afterwards.
   *
   * The bytes are preserved (they may be the only record that some key owned a
   * stem) and nothing is rebuilt from `{}` — `rememberLegacyStemOwners` refuses
   * while `legacyStemLedgerUnparseable` is set, because a rebuild from `{}` here
   * would turn "I cannot read the owners" into "there are no owners" with the
   * evidence already moved aside. Within this process that means every migration
   * stays deferred until a readable ledger is back; the `.corrupt-` file and the
   * warning are what a human acts on.
   */
  private quarantineUnparseableLedger(): void {
    if (this.legacyStemLedgerUnparseable) return;
    try {
      withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-checked inside the lock: another process may have replaced the file
        // with a good one, and quarantining THAT would throw away real rows.
        try {
          const data = JSON.parse(readFileSync(this.legacyStemLedgerPath, "utf-8")) as Partial<LegacyStemLedgerFile>;
          const stems = data?.stems;
          if (stems && typeof stems === "object" && !Array.isArray(stems)) return;
        } catch {
          // Still unparseable — go on.
        }
        if (!existsSync(this.legacyStemLedgerPath)) return;
        this.legacyStemLedgerUnparseable = true;
        this.quarantineLegacyStemLedger();
      }, LEGACY_STEM_LEDGER_LOCK_OPTIONS);
    } catch (err) {
      log.warn(
        { err, file: this.legacyStemLedgerPath },
        "Could not quarantine the unparseable legacy transcript stem ledger; migrations stay deferred",
      );
    }
  }

  /** A free `_legacy_stems.json.corrupt-<ts>[-<n>]`, or null when a hundred of
   *  them are taken. */
  private freeLegacyStemLedgerCorruptName(): string | null {
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const to = n === 0
        ? `${this.legacyStemLedgerPath}.corrupt-${ts}`
        : `${this.legacyStemLedgerPath}.corrupt-${ts}-${n}`;
      if (!existsSync(to)) return to;
    }
    return null;
  }

  /**
   * Which stems the `.corrupt-` copies of the ledger still hold, read off the
   * DIRECTORY on every probe rather than off this process's memory.
   *
   * THIS IS WHAT MAKES THE QUARANTINE SURVIVE A RESTART. Row healing and
   * whole-file quarantine both leave a ledger that parses cleanly and a copy of
   * the unreadable part beside it; the "these stems' owners were unreadable"
   * fact lived only in the healing process's fields, so a SECOND process read
   * the healed ledger, saw no partner, answered `sole`, and adopted a file whose
   * other owner was named in nothing but the quarantined rows. Reading the
   * copies back closes that without a format change.
   *
   * CHEAP WHEN THERE IS NOTHING TO FIND, which is always, on every install that
   * has never had a bad row: one `readdir` and a prefix filter, no file opened.
   * When a copy does exist the parse is cached against a signature over the
   * copies' names, sizes and mtimes — so an operator who DELETES or REPAIRS one
   * releases the hold on the next message, which is the documented way out.
   */
  private corruptLegacyStemLedgerHold(): CorruptLedgerHold {
    const prefix = `${LEGACY_STEM_LEDGER_FILENAME}.corrupt-`;
    const files = this.dirNames().filter((name) => name.startsWith(prefix)).sort();
    if (files.length === 0) {
      this.legacyStemLedgerCorruptCache = null;
      return NO_CORRUPT_LEDGER_HOLD;
    }
    const signature = files.map((name) => {
      try {
        const st = statSync(join(this.dir, name));
        return `${name}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${name}:gone`;
      }
    }).join("|");
    const cached = this.legacyStemLedgerCorruptCache;
    if (cached !== null && cached.signature === signature) return cached.hold;

    const stems = new Map<string, string>();
    let unparseable: string | null = null;
    for (const name of files) {
      // ROW-WISE AND BEST EFFORT: a copy written by `healLegacyStemLedgerRows`
      // is valid JSON whose VALUES are the unreadable part, so its keys are
      // exactly the stems to hold. Anything we cannot get keys out of at all
      // falls through to `unparseable`.
      let rows: unknown;
      try {
        rows = (JSON.parse(readFileSync(join(this.dir, name), "utf-8")) as Partial<LegacyStemLedgerFile> | null)?.stems;
      } catch {
        unparseable ??= name;
        continue;
      }
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) {
        unparseable ??= name;
        continue;
      }
      for (const [stem, owners] of Object.entries(rows as Record<string, unknown>)) {
        // A row that parses as a valid owner list has been REPAIRED in place
        // (the documented recovery): it no longer holds anything. Only rows
        // whose value is still unreadable name a stem to defer.
        if (Array.isArray(owners) && owners.every((owner) => typeof owner === "string" && owner.length > 0)) continue;
        const folded = stem.toLowerCase();
        if (!stems.has(folded)) stems.set(folded, name);
      }
    }
    const hold: CorruptLedgerHold = { stems, unparseable };
    this.legacyStemLedgerCorruptCache = { signature, hold };
    return hold;
  }

  /**
   * The `.corrupt-` copy that makes `target` (a case-folded legacy stem)
   * unknown, or null when none does.
   *
   * `stems` is the HEALED ledger's rows: a stem it still carries a row for has
   * readable owners on disk, so even a copy we cannot read row-wise cannot make
   * it ambiguous. Every other stem is held by such a copy, because "this copy
   * might name your partner" is the only honest reading of bytes nobody can
   * parse.
   */
  private legacyStemHeldByCorruptLedger(target: string, stems: Record<string, string[]>): string | null {
    const hold = this.corruptLegacyStemLedgerHold();
    const named = hold.stems.get(target);
    if (named !== undefined) return named;
    if (hold.unparseable === null) return null;
    for (const stem of Object.keys(stems)) {
      if (stem.toLowerCase() === target) return null;
    }
    return hold.unparseable;
  }

  /** One line per failure streak: the ledger is read on every key's first
   *  touch, so a corrupt file must not write a line per message. */
  private noteLegacyStemLedgerUnreadable(err: unknown): void {
    if (this.legacyStemLedgerErrorLogged) return;
    this.legacyStemLedgerErrorLogged = true;
    log.warn(
      { err, file: this.legacyStemLedgerPath },
      "Could not load the legacy transcript stem ledger; the migrations that depend on what it says are deferred "
      + "until it reads again, and the part that could not be read is moved to a `.corrupt-<ts>` sibling from here "
      + "— a whole unparseable file, or just the rows that would not parse",
    );
  }

  /**
   * Move an unparseable ledger aside so a rewrite can start from `{}`.
   *
   * QUARANTINED, NEVER OVERWRITTEN IN PLACE. Whatever is in there may be the
   * only remaining record that some key owned a legacy stem, and the rewrite
   * below cannot preserve what it could not parse — so the bytes go to a name no
   * reader matches, and a failure to move them means nothing is written at all.
   */
  private quarantineLegacyStemLedger(): boolean {
    const to = this.freeLegacyStemLedgerCorruptName();
    if (to === null) return false;
    try {
      renameSync(this.legacyStemLedgerPath, to);
    } catch (err) {
      log.warn(
        { err, file: this.legacyStemLedgerPath },
        "Could not quarantine the unparseable legacy transcript stem ledger; nothing was recorded",
      );
      return false;
    }
    log.warn(
      { from: this.legacyStemLedgerPath, to },
      "The legacy transcript stem ledger could not be parsed and was quarantined. NOTHING is rebuilt from `{}` on "
      + "top of it — every transcript migration in this process stays deferred — and the quarantined copy is the "
      + "only record of any owner it still named",
    );
    return true;
  }

  /**
   * Record that `keys` have owned their legacy transcript stems, so a later
   * migration can still see them after the registry has forgotten them.
   *
   * Returns false when nothing could be persisted — the caller is about to
   * forget the key, so it should NOT: a lost record here is the silent
   * cross-session leak this ledger exists to prevent, and every caller's work
   * is bookkeeping that the next daemon start redoes for free.
   *
   * Only keys whose legacy stem is not already recorded cause a write, so the
   * steady state is a read of a small JSON file.
   */
  private rememberLegacyStemOwners(keys: readonly string[]): boolean {
    const wanted = new Map<string, Set<string>>();
    for (const key of keys) {
      if (!key) continue;
      const stem = legacyTranscriptFileStem(key);
      let bucket = wanted.get(stem);
      if (!bucket) wanted.set(stem, bucket = new Set());
      bucket.add(key);
    }
    if (wanted.size === 0) return true;

    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read inside the lock: another process may have recorded keys of
        // its own since we last looked, and this is a read-modify-write.
        let loaded = this.loadLegacyStemLedger();
        // NEVER REBUILD FROM `{}`. That is what discarded the ownership evidence
        // of every row that was readable, and the quarantined copy a human would
        // have to restore it from does not come back on its own. An unreadable
        // ledger means this write does not happen, and the caller keeps whatever
        // it was about to forget.
        if (!loaded.ok) return false;
        if (loaded.malformed.length > 0) {
          // Rewriting now would drop the bad rows silently — they are not in
          // `stems`. Carry them to the `.corrupt-` sibling first.
          if (!this.healLegacyStemLedgerRows()) return false;
          loaded = this.loadLegacyStemLedger();
          if (!loaded.ok || loaded.malformed.length > 0) return false;
        }
        const stems = loaded.stems;
        let changed = false;
        for (const [stem, owners] of wanted) {
          const existing = new Set(stems[stem] ?? []);
          const before = existing.size;
          for (const owner of owners) existing.add(owner);
          if (existing.size === before) continue;
          stems[stem] = [...existing].sort();
          changed = true;
        }
        if (changed) {
          writeJsonAtomicSync(this.legacyStemLedgerPath, { version: 1, stems } satisfies LegacyStemLedgerFile);
        }
        return true;
      }, LEGACY_STEM_LEDGER_LOCK_OPTIONS);
    } catch (err) {
      log.warn(
        { err, file: this.legacyStemLedgerPath, keys: [...keys] },
        "Could not record legacy transcript stem ownership; keeping the session entries for the next pass",
      );
      return false;
    }
  }

  /**
   * Drop every ledger row whose stem has nothing left on disk.
   *
   * A row exists to make a legacy-named file ambiguous. Once no file is named
   * after the stem — no `<stem>.jsonl`, no `_archive_<stem>_*`, no sidecar and
   * no quarantine — the row can never change an answer: `migrateLegacyTranscript`
   * returns "settled" on the absence of those files, before it ever looks at
   * the ledger. So pruning is safe, and it is what keeps the file from growing a
   * permanent row for every key the registry ever forgot.
   *
   * Returns the stems dropped. Best-effort, like every other ledger write.
   */
  pruneLegacyStemLedger(): string[] {
    let names: Set<string>;
    try {
      names = new Set(readdirSync(this.dir).map((n) => n.toLowerCase()));
    } catch {
      return [];
    }
    const before = this.loadLegacyStemLedger();
    if (!before.ok || before.malformed.length > 0) return [];
    const candidates = Object.keys(before.stems).filter((stem) => !stemHasFilesOnDisk(stem, names));
    if (candidates.length === 0) return [];

    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read inside the lock for the same reason every other writer does,
        // and re-filter against it: another process may have added a row.
        const loaded = this.loadLegacyStemLedger();
        // An unreadable row would be dropped by the rewrite below, and pruning is
        // an optimization — it waits for the read path to carry the row aside.
        if (!loaded.ok || loaded.malformed.length > 0) return [];
        const stems = loaded.stems;
        const dropped = candidates.filter((stem) => stem in stems);
        if (dropped.length === 0) return [];
        for (const stem of dropped) delete stems[stem];
        writeJsonAtomicSync(this.legacyStemLedgerPath, { version: 1, stems } satisfies LegacyStemLedgerFile);
        log.debug({ stems: dropped }, "Pruned legacy transcript stem ledger rows with nothing left on disk");
        return dropped;
      }, LEGACY_STEM_LEDGER_LOCK_OPTIONS);
    } catch (err) {
      log.warn({ err, file: this.legacyStemLedgerPath }, "Could not prune the legacy transcript stem ledger");
      return [];
    }
  }

  /** Prune just the rows for one legacy stem, after its migration settled.
   *  Cheap enough to run on the settle path; the directory-wide sweep above is
   *  what catches rows written by a key that never had a legacy file. */
  private pruneLegacyStemLedgerFor(legacy: string): void {
    let names: Set<string>;
    try {
      names = new Set(readdirSync(this.dir).map((n) => n.toLowerCase()));
    } catch {
      return;
    }
    if (stemHasFilesOnDisk(legacy, names)) return;
    const loaded = this.loadLegacyStemLedger();
    if (!loaded.ok) return;
    const folded = legacy.toLowerCase();
    if (!Object.keys(loaded.stems).some((stem) => stem.toLowerCase() === folded)) return;
    this.pruneLegacyStemLedger();
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
      // The change lives on in memory only — see `registryDirty`.
      this.registryDirty = true;
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
    // Normally a re-entry (mutateRegistry already holds it), so this costs
    // nothing; it is here so that no path can publish the registry without the
    // lock — `migrateOldFormat` saves straight out of `loadRegistry`. A lock
    // that cannot be created falls through to the bare write, which then
    // reports the real reason the directory is unusable.
    let written = false;
    try {
      withFileLockSync(this.registryLockPath, () => {
        written = true;
        writeJsonAtomicSync(this.registryPath, data);
      }, REGISTRY_LOCK_OPTIONS);
    } catch (err) {
      // Past the lock: the write itself failed, and that is the caller's news.
      if (written) throw err;
      // A live holder is a refusal, not a reason to publish anyway.
      if (err instanceof FileLockTimeoutError) throw err;
      writeJsonAtomicSync(this.registryPath, data);
    }
    this.registryDirty = false;
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

  /**
   * The filename stem for `key`, after making sure anything this key wrote
   * under the old many-to-one scheme has been carried over to it.
   *
   * Every transcript path in the store is built here, so the migration cannot
   * be forgotten at a call site — a backstop rather than the main trigger,
   * which is `get()`. Settled keys are memoized, so this is normally a
   * `Set.has`.
   */
  private safeKey(key: string): string {
    this.ensureTranscriptMigrated(key);
    return transcriptFileStem(key);
  }

  private transcriptPath(key: string): string {
    return join(this.dir, `${this.safeKey(key)}.jsonl`);
  }

  private transcriptArchivePath(key: string, month: string): string {
    return join(this.dir, `_archive_${this.safeKey(key)}_${month}.jsonl`);
  }

  /** Monthly rotation archives for a key, newest month first. */
  private listTranscriptArchives(key: string): string[] {
    return this.archivesForStem(this.safeKey(key));
  }

  /** Monthly rotation archive paths for a filename stem, newest month first.
   *  Stem-based (not key-based) so the migration can list the legacy set.
   *
   *  THE WRITER'S LIST, and deliberately narrower than `transcriptReadSet`.
   *  The strict remainder test keeps three different things out of it: `dm:a`
   *  must not claim `dm:ab`'s archives (a prefix match alone would let it), and
   *  neither a `.legacy-<ts>.jsonl` sidecar nor an `.ambiguous-<ts>.jsonl`
   *  quarantine may ever appear here — rotation appends to what this returns
   *  and `migrateSessionKeyLocked` renames it, and both of those files are
   *  read-only by construction. */
  private archivesForStem(stem: string, names: readonly string[] = this.dirNames()): string[] {
    const prefix = `_archive_${stem}_`;
    return names
      .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}\.jsonl$/.test(n.slice(prefix.length)))
      .sort()
      .reverse()
      .map((n) => join(this.dir, n));
  }

  /**
   * Read-only legacy sidecars for one transcript filename base — `<stem>` for
   * the active file, `_archive_<stem>_<YYYY-MM>` for a rotation archive —
   * OLDEST FIRST, by the timestamp in the name.
   *
   * Matched by prefix plus an anchored remainder rather than a built regex,
   * because a migrated stem contains a `.` of its own (`<legacy>.<hash>`) and
   * interpolating that into a pattern would make it a wildcard.
   */
  private legacySidecarsFor(base: string, names: readonly string[] = this.dirNames()): string[] {
    const prefix = `${base}.legacy-`;
    return names
      .filter((n) => n.startsWith(prefix) && LEGACY_SIDECAR_REMAINDER_RE.test(n.slice(base.length)))
      .sort()
      .map((n) => join(this.dir, n));
  }

  /** `.ambiguous-<ts>.jsonl` files already parked for `stem` — the on-disk
   *  record that a shared stable stem was quarantined. Names only, sorted. */
  private quarantinedNamesFor(stem: string, names: readonly string[] = this.dirNames()): string[] {
    const archivePrefix = `_archive_${stem}_`;
    return names.filter((n) => {
      if (n.startsWith(`${stem}.`) && AMBIGUOUS_REMAINDER_RE.test(n.slice(stem.length))) return true;
      if (!n.startsWith(archivePrefix)) return false;
      const rest = n.slice(archivePrefix.length);
      const month = /^\d{4}-\d{2}/.exec(rest);
      return month !== null && AMBIGUOUS_REMAINDER_RE.test(rest.slice(month[0].length));
    }).sort();
  }

  /**
   * Every file a READ of `key`'s history covers, in FILENAME ORDER: the active
   * file, its read-only legacy sidecars, then each rotation archive (newest
   * month first) with its own sidecars behind it — each tagged with whether it
   * is a sidecar.
   *
   * FILENAME ORDER IS NOT TIME ORDER WHEN A SIDECAR IS PRESENT. The original
   * version of this claimed it was ("a sidecar is strictly older than the file
   * it sits beside"), and two reviewers found it false twice over:
   *
   * - `migrateSessionKeyLocked` sidecars a transcript that ran IN PARALLEL with
   *   the one it lands beside — a `dm:alex` session and the `imessage:…` channel
   *   session it unifies with were both live, so the sidecar's records interleave
   *   with the active file's rather than preceding them.
   * - A legacy active file that an unmigrated process kept appending to is newer
   *   than parts of the archive it ends up beside.
   *
   * So callers must not assume it: `searchTranscript` gives up its cross-file
   * early exit, `loadTranscript` sorts what it merged, and `transcriptCreatedAt`
   * takes a minimum instead of the first hit. `hasSidecars` is what selects
   * between that and the cheap ordered path — with no sidecar on disk the order
   * IS chronological and nothing changes.
   *
   * THE MONTH SET IS THE UNION of canonical archives and archive sidecars. An
   * interrupted re-key can leave `_archive_<stem>_<M>.legacy-<ts>.jsonl` with no
   * `_archive_<stem>_<M>.jsonl` beside it (the archive moved on before its
   * sidecars did), and enumerating sidecars only inside the canonical-archive
   * loop made that month invisible to every reader while
   * `transcriptFamilyMoves` still knew about it.
   *
   * THE WRITER-SIDE LIST IS `transcriptPath` + `archivesForStem`, and it must
   * stay strictly narrower than this one.
   */
  private transcriptReadSet(key: string): { files: TranscriptReadFile[]; hasSidecars: boolean } {
    const stem = this.safeKey(key);
    // ONE listing for the whole family. Resolving each archive's sidecars with
    // its own `readdirSync` made this O(archives) directory scans per search.
    const names = this.dirNames();
    const files: TranscriptReadFile[] = [{ path: join(this.dir, `${stem}.jsonl`), sidecar: false }];
    for (const sidecar of this.legacySidecarsFor(stem, names).reverse()) {
      files.push({ path: sidecar, sidecar: true });
    }
    const months = new Set<string>();
    for (const archive of this.archivesForStem(stem, names)) {
      const month = /_(\d{4}-\d{2})\.jsonl$/.exec(archive)?.[1];
      if (month) months.add(month);
    }
    for (const month of this.monthsWithArchiveSidecars(stem, names)) months.add(month);
    for (const month of [...months].sort().reverse()) {
      const base = `_archive_${stem}_${month}`;
      const archive = join(this.dir, `${base}.jsonl`);
      if (existsSync(archive)) files.push({ path: archive, sidecar: false });
      for (const sidecar of this.legacySidecarsFor(base, names).reverse()) {
        files.push({ path: sidecar, sidecar: true });
      }
    }
    return { files, hasSidecars: files.some((file) => file.sidecar) };
  }

  /** The sessions directory, or `[]` when it cannot be listed. Every caller
   *  treats an unlistable directory as "nothing there", which is the same
   *  degradation the readers and the migration already make. */
  private dirNames(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  /** Advisory lock serializing transcript renames against other processes. */
  private get transcriptLockPath(): string {
    return join(this.dir, "_transcripts.lock");
  }

  /**
   * Carry `key`'s transcript and archives from the legacy filename to the
   * collision-free one, once per key per process. Returns true when the
   * question is SETTLED for this key, false when it must be retried.
   *
   * Only a key whose stem actually changed has files to MOVE — but every key is
   * checked for OWNERSHIP, including the ones that keep their legacy stem.
   * `dm:a:b` keeps `dm_a_b.jsonl` while `dm:a_b` takes a hash suffix, so the
   * STABLE key is the one left sitting on the shared file, and the version that
   * skipped the check for stable stems left it reading a mixed transcript
   * forever. That check reaches the registry and the session cache in memory
   * and reads one small JSON file; it takes no lock, opens no transcript and
   * renames nothing, and it is memoized per key.
   *
   * OWNERSHIP IS THE HARD PART. The legacy name is many-to-one, so a legacy
   * file may hold one key's history or several keys' histories interleaved, and
   * nothing on disk says which. So:
   *
   * - NO OTHER KNOWN KEY maps to that legacy stem, compared CASE-FOLDED
   *   because APFS and NTFS are (`imessage:A.b` and `imessage:a.b` are one file
   *   there) → the files are unambiguously this key's, and they are RENAMED.
   * - SOME OTHER KEY DOES → ambiguous. Nothing is merged and nothing is
   *   guessed. A key that moves leaves the legacy file exactly where it is — it
   *   is the only record of the mixed history — and starts fresh. A key that
   *   keeps its legacy stem cannot do that, because the mixed file IS its own
   *   active filename, so the family is parked under `.ambiguous-<ts>.jsonl`:
   *   unreachable but preserved, which beats silently serving one person's
   *   history to another.
   * - A SOURCE WE COULD NOT READ (an unparseable `_sessions.json` or
   *   `_legacy_stems.json`) → NOT SETTLED, retried later. "I cannot see the
   *   other owner" must never be allowed to read as "there is no other owner".
   *
   * NEVER THROWS: this sits under `get()`/`append()`, i.e. under every inbound
   * message. A lock we cannot take, an EACCES, a rename that races another
   * process — all degrade to "don't migrate", logged once, and RETRIED: see
   * below for why "retried" is load-bearing.
   *
   * AN INCOMPLETE ATTEMPT MUST NOT BE RECORDED AS A CHECK. The first version of
   * this marked the key before doing the work, so the one failure mode that
   * actually happens in the field — the transcript lock held by a second
   * process, `tomo config identities` running against a live daemon — marked
   * the key, returned, and let the triggering message `append()` under the NEW
   * stem. From then on both files existed, and the legacy one was never looked
   * at again: `loadTranscript`, `searchTranscript`, `transcriptCreatedAt` and
   * `getLastSeq` all resolve through the new stem, so every message before the
   * failed migration was gone from the product while sitting intact on disk.
   * So the key is marked only when the migration actually finished, the retry
   * is throttled (`TRANSCRIPT_MIGRATION_RETRY_MS`) rather than dropped, and
   * when the retry finally runs and finds the destination taken, the legacy
   * file becomes a READ-ONLY SIDECAR rather than being abandoned or merged.
   */
  private ensureTranscriptMigrated(key: string): boolean {
    if (this.transcriptMigrationChecked.has(key)) return true;
    // Re-entrancy, not memoization: `migrateLegacyTranscript` must be able to
    // call anything on the store (it reaches the registry and the ledger)
    // without a stray `transcriptPath` recursing back into here. Reported as
    // settled because the only caller that can see it is the migration itself,
    // which is mid-decision; cleared in `finally`, so an incomplete attempt
    // stays retryable.
    if (this.transcriptMigrationInFlight.has(key)) return true;
    const retryAt = this.transcriptMigrationRetryAt.get(key);
    // Throttled, and still UNSETTLED: `migrateSessionKeyLocked` refuses to
    // re-key on a false, and a deferred migration is exactly a case where we do
    // not yet know which files are this key's.
    if (retryAt !== undefined && Date.now() < retryAt) return false;

    this.transcriptMigrationInFlight.add(key);
    try {
      if (this.migrateLegacyTranscript(key)) {
        this.transcriptMigrationChecked.add(key);
        this.transcriptMigrationRetryAt.delete(key);
        this.transcriptProbeAnswer.delete(key);
        this.releaseWithheldSession(key);
        return true;
      }
      this.transcriptMigrationRetryAt.set(key, Date.now() + TRANSCRIPT_MIGRATION_RETRY_MS);
      return false;
    } catch (err) {
      log.warn({ err, key }, "Could not migrate legacy transcript files to the collision-free name; will retry");
      this.transcriptMigrationRetryAt.set(key, Date.now() + TRANSCRIPT_MIGRATION_RETRY_MS);
      return false;
    } finally {
      this.transcriptMigrationInFlight.delete(key);
    }
  }

  /**
   * Is this key's OWN active filename known to hold more than one key's
   * history, with the quarantine not yet done?
   *
   * Only a key that KEEPS its legacy stem can be in that state: a key whose stem
   * changed leaves the mixed file behind under a name it no longer reads (see
   * `refuseSharedLegacyStem`), so serving it is serving its own fresh file. The
   * `.ambiguous-` marker means the decision was taken and the active name is the
   * key's own fresh transcript from then on, so its presence ends the
   * withholding even while `quarantineAmbiguousFamily` is still parking archives.
   */
  private withholdsTranscript(key: string): boolean {
    return !this.ensureTranscriptMigrated(key) && this.servesMixedTranscript(key);
  }

  private servesMixedTranscript(key: string): boolean {
    if (this.transcriptProbeAnswer.get(key) !== "shared") return false;
    const stem = transcriptFileStem(key);
    // Not `safeKey`: that would re-enter the migration we are reporting on.
    if (stem !== legacyTranscriptFileStem(key)) return false;
    return this.quarantinedNamesFor(stem).length === 0;
  }

  /**
   * The empty session a key is served while its own transcript is known-mixed.
   *
   * CACHED, and remembered as withheld, so an `append()` in this window keeps
   * appending to one session instead of restarting from an empty tail on every
   * message. THE APPEND ITSELF STILL LANDS IN THE MIXED FILE — `append` writes
   * `transcriptPath(key)`, which is that name — so this is the one window in
   * which a file we know to be shared can still grow. It is bounded by
   * `TRANSCRIPT_MIGRATION_RETRY_MS`, the records are parked with the rest of the
   * family when the quarantine lands, and the alternative (dropping the
   * message) is the one outcome worse than writing it somewhere awkward.
   */
  private withheldSession(key: string): Session {
    const cached = this.sessions.get(key);
    if (cached && this.transcriptWithheld.has(key)) return cached;
    this.warnOnce(this.transcriptWithheldWarned, key, () => log.warn(
      { key, file: this.transcriptPath(key) },
      "Withholding this session's transcript: the file is shared with another session key and could not be parked "
      + "yet, so reading it would serve another session's history. The session starts empty until the quarantine "
      + "lands; new messages are still recorded, and are parked with the rest of the family when it does",
    ));
    const now = Date.now();
    const session: Session = { key, messages: [], createdAt: now, updatedAt: now };
    this.sessions.set(key, session);
    this.transcriptWithheld.add(key);
    return session;
  }

  /**
   * Stop serving the EMPTY session a key was withheld, now that it is no longer
   * withheld.
   *
   * THE CACHE IS WHAT MADE AN EXTERNALLY COMPLETED QUARANTINE INVISIBLE. Another
   * process can park the family and write fresh history between two of this
   * process's attempts; this one's retry then parks zero files, sees the marker,
   * and settles — with the empty withheld session still in `this.sessions`. It
   * kept serving that empty history, and because `getLastSeq` reads the cached
   * tail, the next `append()` handed out seq 1 over a file that already had one.
   * So every transition out of the withheld state drops the cache and the next
   * `get()` reloads the tail (and re-derives seq) from disk.
   */
  private releaseWithheldSession(key: string): void {
    if (!this.transcriptWithheld.has(key)) return;
    this.dropCachedSession(key);
  }

  /** Forget a cached session whose files moved underneath it, including the
   *  withheld-session bookkeeping and the rotation skip. */
  private dropCachedSession(key: string): void {
    this.sessions.delete(key);
    this.rotateSkipMonth.delete(key);
    this.transcriptWithheld.delete(key);
  }

  /**
   * One migration attempt. Returns true when the question is settled for this
   * key — everything carried over, deliberately refused, or nothing there to
   * begin with — and false when it should be tried again.
   */
  private migrateLegacyTranscript(key: string): boolean {
    const legacy = legacyTranscriptFileStem(key);
    const stem = transcriptFileStem(key);
    // NOTHING NAMED AFTER THE LEGACY STEM, so there is no shared file and no
    // ownership question: a fresh key, or one migrated on an earlier run. The
    // same predicate decides "settled" at the bottom, so entry and exit cannot
    // disagree — and the `existsSync` is first so the cheap answer comes first:
    // a key whose transcript is already there (every `dm:`/`telegram:`/
    // `heartbeat` key on a live install) spends one `stat` here and one more on
    // the ledger, then returns at `stem === legacy` below. No lock, no rename,
    // no transcript opened. A key with nothing costs one directory listing.
    if (!existsSync(join(this.dir, `${legacy}.jsonl`))
      && this.transcriptFamilyMoves(legacy, stem).length === 0) return true;

    const owners = this.probeLegacyStemOwnership(key, legacy);
    if (owners.kind === "unknown") {
      this.warnOnce(this.transcriptSourceWarned, owners.source, () => log.warn(
        { key, legacy, source: owners.source },
        "Deferring legacy transcript migration: an ownership source could not be read, and adopting a "
        + "legacy-named transcript while blind to its other owners is how one session starts serving another's "
        + "history",
      ));
      return false;
    }
    if (owners.kind === "shared") return this.refuseSharedLegacyStem(key, legacy, stem, owners.others);

    // A KEY THAT KEEPS ITS LEGACY STEM HAS NOTHING TO MOVE — its files are
    // already at their final names, and `from === to` would read as "the
    // destination is taken" and sidecar the live transcript. The ownership probe
    // above is the entire reason such a key reaches this far.
    if (stem === legacy) return true;

    let outcome: CarryOutcome;
    try {
      outcome = withFileLockSync(
        this.transcriptLockPath,
        () => this.carryLegacyTranscriptFamily(key, legacy, stem),
        TRANSCRIPT_LOCK_OPTIONS,
      );
    } catch (err) {
      if (!(err instanceof FileLockTimeoutError)) throw err;
      // Another process is mid-migration for this directory. Skipping is the
      // only safe answer on a message path — but NOT forgetting: see the header
      // of `ensureTranscriptMigrated`.
      this.warnOnce(this.transcriptLockWarned, legacy, () => log.warn(
        { err, key }, "Deferring legacy transcript migration: another process holds the transcript lock",
      ));
      return false;
    }

    if (outcome.kind === "deferred") return false;
    if (outcome.kind === "ambiguous") return this.refuseSharedLegacyStem(key, legacy, stem, outcome.others);

    if (outcome.carried > 0) {
      log.info(
        { key, from: legacy, to: stem, files: outcome.carried, sidecars: outcome.sidecars },
        "Migrated transcript files to a collision-free name",
      );
      // The bytes behind this key's paths moved underneath any cached session.
      // Drop the cache so the next `get()` reloads the tail (and `getLastSeq`
      // re-derives) from what is on disk.
      this.dropCachedSession(key);
    }
    if (outcome.sidecars.length > 0) {
      log.warn(
        { key, from: legacy, to: stem, sidecars: outcome.sidecars },
        "Legacy transcript kept as a read-only sidecar beside the migrated file, because the migrated name was "
        + "already in use: it is searched and loaded like the rest of the history, and never appended to or rotated",
      );
    }

    // Settled only if nothing legacy-named is left behind. Every step above is
    // a single rename and every one of them is idempotent, so when something
    // did survive (an EACCES on one archive, a name collision we could not
    // resolve) the honest answer is "try again".
    const settled = this.transcriptFamilyMoves(legacy, stem).length === 0;
    if (settled) this.pruneLegacyStemLedgerFor(legacy);
    return settled;
  }

  /**
   * The legacy stem is shared. Record it, warn once, and either leave the file
   * alone (a key that moves) or park it (a key that does not).
   *
   * Returns true when the refusal is final. Ambiguity only ever grows — a
   * second owner is never un-learned — so retrying would re-derive the same
   * refusal once per message; the only reason to come back is a ledger write
   * that did not land.
   */
  private refuseSharedLegacyStem(key: string, legacy: string, stem: string, others: string[]): boolean {
    // WRITE IT DOWN THE MOMENT WE SEE IT, wherever we saw it — including the
    // in-memory session cache, which the next process does not have. The ledger
    // is the only source that survives every key involved being forgotten, so a
    // collision detected and not persisted is a collision the next daemon
    // cannot see.
    if (!this.rememberLegacyStemOwners([key, ...others])) return false;
    this.transcriptAmbiguousStems.add(legacy.toLowerCase());

    if (stem !== legacy) {
      this.warnOnce(this.transcriptCollisionWarned, legacy.toLowerCase(), () => log.warn(
        { file: join(this.dir, `${legacy}.jsonl`), keys: [key, ...others] },
        "Transcript filename collision: this file was shared by more than one session key and cannot be "
        + "split automatically. It is left in place for manual inspection; the sessions continue in "
        + "separate files from now on",
      ));
      return true;
    }
    return this.quarantineAmbiguousFamily(key, legacy, others);
  }

  /**
   * Park a shared transcript family that a STABLE-STEM key is sitting on, under
   * `.ambiguous-<ts>.jsonl`.
   *
   * `dm:a:b` and `dm:a_b` both resolve to `dm_a_b.jsonl`, and `dm:a:b` keeps
   * that name — so "leave the mixed file where it is and start fresh", which is
   * what a key that moves does, would leave this key reading and APPENDING to
   * the mixed file forever. The family is renamed out of every read and write
   * path instead: unreachable, but preserved for
   * `cat ~/.tomo/data/sessions/dm_a_b.ambiguous-*.jsonl` (the records carry
   * `channel` and `senderName`).
   *
   * THE PARKED FILE IS ALSO THE RECORD THAT THIS HAPPENED, and it has to be:
   * the fresh file this key opens next has the very same name as the mixed one,
   * so without a marker the next process start would park the fresh history
   * too, and the one after that, forever.
   *
   * BUT THE MARKER ONLY SAYS THE DECISION WAS TAKEN — NOT THAT THE WORK
   * FINISHED. Treating it as "done" (which the first version did, on the first
   * `.ambiguous-` name it found anywhere in the family) meant one failed archive
   * rename, or a crash between two of them, left the remaining MIXED ARCHIVES
   * under readable names with the key marked settled — a `searchTranscript` that
   * still answers out of two people's history, and nothing left that would ever
   * revisit it. So the family is RESCANNED on every attempt, and settled means
   * "no file of this family is left under a name a reader resolves".
   *
   * What separates a mixed file from the fresh history this key has written
   * since is the decision's own timestamp, which is in the marker's name: a file
   * whose NEWEST record predates it is pre-decision and is parked, a file that
   * has grown since is this key's own and is left alone. On the first attempt
   * there is no marker and the whole family is pre-decision by definition. A
   * file with nothing readable in it counts as pre-decision, which is the
   * preserve-rather-than-serve direction this whole path errs in.
   */
  private quarantineAmbiguousFamily(key: string, stem: string, others: string[]): boolean {
    const decidedAt = this.quarantineDecisionTime(stem);
    let parked: string[];
    try {
      parked = withFileLockSync(this.transcriptLockPath, () => {
        const moved: string[] = [];
        // Re-listed inside the lock, like every other mover here.
        const targets = this.mixedFamilyTargets(stem, decidedAt);
        for (const { from, base, active } of targets) {
          const to = freeSuffixedName(this.dir, base, "ambiguous");
          if (to && renameIfPresent(from, to)) {
            moved.push(basename(to));
            continue;
          }
          // THE ACTIVE FILE IS PARKED FIRST AND NOTHING ELSE MOVES IF IT CANNOT
          // BE. A marker beside an archive while the mixed active file is still
          // live would read as "the decision was taken" on the next attempt, and
          // the active file — which has kept growing since — would then look
          // post-decision and never be parked at all.
          if (active) return moved;
        }
        return moved;
      }, TRANSCRIPT_LOCK_OPTIONS);
    } catch (err) {
      if (!(err instanceof FileLockTimeoutError)) throw err;
      this.warnOnce(this.transcriptLockWarned, stem, () => log.warn(
        { err, key }, "Deferring legacy transcript migration: another process holds the transcript lock",
      ));
      return false;
    }

    if (parked.length > 0) this.dropCachedSession(key);
    // Rescanned against the marker we have NOW: anything still readable and
    // pre-decision means the work is unfinished, whatever the marker says.
    const left = this.mixedFamilyTargets(stem, this.quarantineDecisionTime(stem));
    if (left.length > 0) {
      // Once per stem per process, like every other line on this path: the retry
      // runs every `TRANSCRIPT_MIGRATION_RETRY_MS` until it lands.
      this.warnOnce(this.transcriptQuarantineIncompleteWarned, stem.toLowerCase(), () => log.warn(
        { stem, key, files: left.map((target) => basename(target.from)), parked },
        "Deferring legacy transcript migration: part of a shared transcript family could not be parked as "
        + "`.ambiguous-*.jsonl` and is still readable, so the collision is not settled yet",
      ));
      return false;
    }
    if (parked.length === 0 && decidedAt === null) return false;
    this.warnOnce(this.transcriptCollisionWarned, stem.toLowerCase(), () => log.warn(
      { stem, keys: [key, ...others], files: parked },
      parked.length > 0
        ? "Transcript filename collision: this stem was shared by more than one session key, and this key keeps that "
          + "filename — so the mixed history was parked beside it as `.ambiguous-*.jsonl` for manual inspection "
          + "rather than left where both keys would keep reading and appending to it. Every session involved starts "
          + "fresh from here"
        : "Transcript filename collision: this stem was shared by more than one session key and its mixed history "
          + "is already parked beside it as `.ambiguous-*.jsonl`; the sessions continue in separate files",
    ));
    return true;
  }

  /**
   * When the decision to park `stem`'s family was FIRST taken, read off the
   * OLDEST `.ambiguous-<ts>` name in it, or null when it has not been taken yet.
   *
   * Oldest, not newest, and that is the whole point: this is the line between
   * "mixed history from before the decision" and "what this key has written
   * since", so it has to be the same line on every attempt. Reading the newest
   * marker instead moves the line forward to the moment of the latest rename —
   * after which the key's own post-decision history looks older than the
   * decision, and a retry would park it.
   *
   * Second resolution, like the names. The comparison it feeds is "older than
   * the decision", so the truncation errs toward calling a file post-decision,
   * i.e. toward leaving it alone.
   */
  private quarantineDecisionTime(stem: string): number | null {
    let oldest: number | null = null;
    for (const name of this.quarantinedNamesFor(stem)) {
      const at = suffixedNameTime(name);
      if (at !== null && (oldest === null || at < oldest)) oldest = at;
    }
    return oldest;
  }

  /**
   * Every file of `stem`'s family that is still under a READABLE name and holds
   * only pre-decision records — i.e. everything a quarantine attempt still owes.
   * The active file comes first; see the caller for why that matters.
   */
  private mixedFamilyTargets(
    stem: string,
    decidedAt: number | null,
  ): { from: string; base: string; active: boolean }[] {
    const names = this.dirNames();
    const targets: { from: string; base: string; active: boolean }[] = [];
    const consider = (from: string, base: string, active = false): void => {
      if (decidedAt !== null && !this.predatesQuarantine(from, decidedAt)) return;
      targets.push({ from, base, active });
    };
    const active = join(this.dir, `${stem}.jsonl`);
    if (existsSync(active)) consider(active, stem, true);
    for (const sidecar of this.legacySidecarsFor(stem, names)) consider(sidecar, stem);
    const months = new Set<string>();
    for (const archive of this.archivesForStem(stem, names)) {
      const month = /_(\d{4}-\d{2})\.jsonl$/.exec(archive)?.[1];
      if (month) months.add(month);
    }
    for (const month of this.monthsWithArchiveSidecars(stem, names)) months.add(month);
    for (const month of [...months].sort().reverse()) {
      const base = `_archive_${stem}_${month}`;
      const archive = join(this.dir, `${base}.jsonl`);
      if (existsSync(archive)) consider(archive, base);
      for (const sidecar of this.legacySidecarsFor(base, names)) consider(sidecar, base);
    }
    return targets;
  }

  /** Is every record in `file` older than the quarantine decision? Read from the
   *  back, so it costs one chunk rather than the file. A record we cannot place
   *  counts as older: preserved-and-unreachable beats readable-and-mixed. */
  private predatesQuarantine(file: string, decidedAt: number): boolean {
    for (const record of iterateJsonlBackwardsSync<SessionMessage>(file)) {
      const newest = usableTimestamp(record);
      return newest === null ? true : newest < decidedAt;
    }
    return true;
  }

  /**
   * Move `legacy`'s active transcript and monthly archives onto `stem`, with
   * the transcript lock held.
   *
   * RENAMES ONLY. NOTHING IS EVER REWRITTEN. When the destination is free it is
   * a plain rename; when it is taken the legacy file is renamed to
   * `<base>.legacy-<ts>.jsonl` and becomes a read-only sidecar instead. There
   * is no merge, no seq renumbering and no backup copy, which is the point:
   * every defect review found on this path lived in the merge — an `append()`
   * from a second process erased between the merge's read and its rename, seq
   * shifted under rotation's "already archived" dedupe, a pass that died
   * half-applied and duplicated records on re-run, offsets recomputed after an
   * interrupted run. A single `rename` has none of those states. Each file is
   * one atomic operation, so every crash point leaves a state this function
   * converges on when it runs again.
   */
  private carryLegacyTranscriptFamily(key: string, legacy: string, stem: string): CarryOutcome {
    // RE-CHECKED INSIDE THE LOCK. The probe before the lock is a read of three
    // sources, two of which another process can change while we wait for the
    // lock (it can record a second owner in the ledger, or link a session key
    // into the registry), and what happens below is irreversible.
    const owners = this.probeLegacyStemOwnership(key, legacy);
    if (owners.kind === "shared") return { kind: "ambiguous", others: owners.others };
    if (owners.kind === "unknown") return { kind: "deferred" };

    // Re-listed inside the lock: another process may have done some or all of
    // this between our scan and here.
    const moves = this.transcriptFamilyMoves(legacy, stem);
    if (moves.length === 0) return { kind: "done", carried: 0, sidecars: [] };

    let carried = 0;
    const sidecars: string[] = [];
    for (const { from, base, sidecarOnly } of moves) {
      const landed = this.carryOntoBase(from, base, sidecarOnly);
      if (landed === null) continue;
      carried++;
      if (LEGACY_SIDECAR_NAME_RE.test(landed)) sidecars.push(landed);
    }
    return { kind: "done", carried, sidecars };
  }

  /**
   * Every file named after `from` that has to end up named after `to`: the
   * active file, its read-only sidecars, then each rotation archive and its own
   * sidecars. Exactly `transcriptReadSet`'s coverage, which is the point — a
   * file a reader can see and a migration cannot is a file that goes missing.
   */
  private transcriptFamilyMoves(from: string, to: string): { from: string; base: string; sidecarOnly: boolean }[] {
    const moves: { from: string; base: string; sidecarOnly: boolean }[] = [];
    const names = this.dirNames();
    const active = join(this.dir, `${from}.jsonl`);
    if (existsSync(active)) moves.push({ from: active, base: to, sidecarOnly: false });
    for (const sidecar of this.legacySidecarsFor(from, names)) {
      moves.push({ from: sidecar, base: to, sidecarOnly: true });
    }
    // Months from BOTH sources, unioned: a month can have a sidecar and no
    // archive of its own (the archive was carried on an earlier pass and the
    // sidecar landed beside it, then the archive moved again), and iterating only
    // `archivesForStem` would leave that sidecar behind under the old name where
    // nothing reads it.
    const months = new Set<string>();
    for (const archive of this.archivesForStem(from, names)) {
      const month = /_(\d{4}-\d{2})\.jsonl$/.exec(archive)?.[1];
      if (month) months.add(month);
    }
    for (const month of this.monthsWithArchiveSidecars(from, names)) months.add(month);
    for (const month of [...months].sort().reverse()) {
      const base = `_archive_${to}_${month}`;
      const archive = join(this.dir, `_archive_${from}_${month}.jsonl`);
      if (existsSync(archive)) moves.push({ from: archive, base, sidecarOnly: false });
      for (const sidecar of this.legacySidecarsFor(`_archive_${from}_${month}`, names)) {
        moves.push({ from: sidecar, base, sidecarOnly: true });
      }
    }
    return moves;
  }

  /** Months for which a `_archive_<stem>_<YYYY-MM>.legacy-<ts>.jsonl` sidecar
   *  exists, whether or not the archive itself still does. */
  private monthsWithArchiveSidecars(stem: string, names: readonly string[] = this.dirNames()): string[] {
    const prefix = `_archive_${stem}_`;
    const months = new Set<string>();
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const month = /^\d{4}-\d{2}/.exec(rest);
      if (month && LEGACY_SIDECAR_REMAINDER_RE.test(rest.slice(month[0].length))) months.add(month[0]);
    }
    return [...months];
  }

  /**
   * THE ONE RENAME THE WHOLE MIGRATION IS BUILT OUT OF.
   *
   * `from` lands on `<base>.jsonl` when that name is free, and on a fresh
   * `<base>.legacy-<ts>.jsonl` read-only sidecar when it is not. Returns the
   * basename it landed on, or null when nothing moved.
   *
   * THE DESTINATION BEING TAKEN IS THE INTERESTING CASE, and it is reached by a
   * migration that was deferred (transcript lock held, EACCES) while the message
   * that triggered it went on to `append()` under the new name. Refusing there is
   * what stranded the whole pre-migration history — on disk, reachable from no
   * read path. MERGING the two files is what the previous version did, and every
   * defect review found lived in the merge: a second process's `append()` erased
   * between the merge's read and its rename, `seq` shifted under rotation's
   * "already archived" dedupe, a pass that died half-applied and duplicated
   * records on re-run, offsets recomputed after an interrupted run. One more
   * rename has none of those states.
   *
   * `sidecarOnly` is for a source that is ALREADY a sidecar: it must never be
   * promoted into a writable name.
   */
  private carryOntoBase(from: string, base: string, sidecarOnly: boolean): string | null {
    if (!sidecarOnly) {
      const to = join(this.dir, `${base}.jsonl`);
      const outcome = this.moveWithoutClobber(from, to);
      if (outcome === "moved") return basename(to);
      if (outcome === "gone") return null;
      // "taken" — fall through to the sidecar name.
    }
    // OUR OWN INTERRUPTED CLAIM FIRST. `link` to `<base>.legacy-T1.jsonl`
    // succeeding and the `unlink` of the source not running is a reachable crash
    // point (and `moveWithoutClobber` only recognises it for the ONE name it was
    // asked about), so a retry in a later second used to claim
    // `<base>.legacy-T2.jsonl` and leave BOTH of them readable — every record in
    // that file then read twice, forever, because sidecars are never rewritten.
    // The source's device+inode identifies the sidecar it already landed on, and
    // the only work left is the `unlink`.
    for (const sidecar of this.legacySidecarsFor(base)) {
      if (sidecar === from) continue;
      const same = sameFileOnDisk(from, sidecar);
      if (same === "missing-source") return null;
      if (same !== "same") continue;
      unlinkIfPresent(from);
      return basename(sidecar);
    }

    // CLAIMED BY THE MOVE ITSELF, not picked and then used. A free name is only
    // free until another process takes it, and every sidecar is the single copy
    // of the history inside it.
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const name = n === 0 ? `${base}.legacy-${ts}.jsonl` : `${base}.legacy-${ts}-${n}.jsonl`;
      const outcome = this.moveWithoutClobber(from, join(this.dir, name));
      if (outcome === "moved") return name;
      if (outcome === "gone") return null;
    }
    log.error(
      { from, base },
      "Could not find a free legacy-sidecar name beside the transcript; the file is left where it is and the "
      + "migration will be retried",
    );
    return null;
  }

  /**
   * Move `from` to `to` WITHOUT EVER OVERWRITING `to`, atomically.
   *
   * `existsSync(to)` then `renameSync(from, to)` is a check-then-act with a
   * window in it, and the window is reachable: `append()` in another process
   * (`tomo config identities` → `pickChatId` → `store.get()`, `tomo lcm search
   * --channel-key`) creates `to` between the two calls, and `rename` then
   * replaces that brand-new live transcript with the legacy file, silently. A
   * `link` cannot do that — it fails with EEXIST if the name is taken — so the
   * move is `link` then `unlink`, and the destination's existence is decided by
   * the kernel rather than by a stat we took a moment ago.
   *
   * CRASHING BETWEEN THE TWO LEAVES BOTH NAMES ON ONE INODE, which is a state
   * this converges on: the re-run's `link` fails EEXIST, the inodes match, and
   * the only work left is the `unlink`. (Under the old rename it looked like
   * "the destination is taken", so the re-run made a SIDECAR out of the same
   * bytes and every record in the file was read twice.)
   *
   * Filesystems without hard links (FAT/exFAT over a fuse mount, some network
   * mounts) report EPERM / ENOSYS / ENOTSUP / EOPNOTSUPP; EXDEV means the two
   * names are not even on one filesystem. There the old check-then-rename is the
   * only thing available, so it is used — and the whole-filesystem answers latch,
   * so the fallback is decided once rather than probed per file. Which mode is
   * in use is logged once, because the fallback carries the race the rest of this
   * does not.
   */
  private moveWithoutClobber(from: string, to: string): "moved" | "taken" | "gone" {
    if (this.carryMode !== "rename") {
      try {
        linkSync(from, to);
        this.noteCarryMode("link", true);
        unlinkIfPresent(from);
        return "moved";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return "gone";
        if (code === "EEXIST") {
          // Still the link path, and still proof that this filesystem links.
          this.noteCarryMode("link", true);
          const same = sameFileOnDisk(from, to);
          if (same === "missing-source") return "gone";
          if (same === "same") {
            // Our own interrupted move. Finish it; nothing is copied or merged.
            unlinkIfPresent(from);
            return "moved";
          }
          return "taken";
        }
        if (code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
          throw err;
        }
        // EPERM can be about this one file (an immutable flag, a restricted
        // directory), so it does not latch; the rest are properties of the
        // filesystem and do.
        this.noteCarryMode("rename", code !== "EPERM");
      }
    }
    if (existsSync(to)) return "taken";
    return renameIfPresent(from, to) ? "moved" : "gone";
  }

  /** Say which move primitive is in use, once per mode. `latch` is for the
   *  filesystem-wide answers only — a per-file EPERM must not disable hard links
   *  for every other transcript in the directory. */
  private noteCarryMode(mode: "link" | "rename", latch: boolean): void {
    if (latch) this.carryMode = mode;
    if (this.carryModeLogged === mode) return;
    this.carryModeLogged = mode;
    if (mode === "link") {
      log.debug(
        { dir: this.dir },
        "Transcript migration moves files with link+unlink: a destination that appears mid-move cannot be overwritten",
      );
      return;
    }
    log.warn(
      { dir: this.dir },
      "Transcript migration is falling back to check-then-rename: this filesystem would not hard-link a transcript. "
      + "A destination created by another process between the check and the rename can still be overwritten there",
    );
  }

  /**
   * Every OTHER session key we know of that shares `legacy` as its legacy
   * filename stem — i.e. every key whose history could be mixed into the same
   * legacy file — or an explicit "a source could not be read".
   *
   * CASE-FOLDED, because the filesystem underneath usually is: `imessage:A.b`
   * and `imessage:a.b` have legacy stems differing only in case, and on APFS
   * and NTFS those are ONE file. Comparing the stems verbatim answered "sole
   * owner" for a file two keys share.
   *
   * Three sources, because no one of them remembers enough:
   *
   * - THE LEDGER (`_legacy_stems.json`), which is the only source that survives
   *   a key being forgotten. See `LegacyStemLedgerFile` for what erases the
   *   other two.
   * - THE REGISTRY, active and unlinked entries alike, `channelKey` and
   *   `migratedFrom` — the live picture, and the only one that knows about a
   *   key this process has never routed a message for.
   * - THE IN-MEMORY SESSION CACHE, for a key touched in this process before the
   *   registry had an entry for it.
   *
   * AN UNREADABLE SOURCE IS NOT AN EMPTY ONE. Either file existing and failing
   * to parse yields `unknown`, which defers the migration: reading "I cannot
   * tell" as "no other owner" is precisely how a shared file gets adopted.
   *
   * WHAT THIS STILL CANNOT SEE: a key whose registry entry aged out before the
   * ledger existed — i.e. before this code first ran on the install — left no
   * trace anywhere, so its partner's legacy file looks unambiguously
   * single-owner and will be adopted. Nothing in the data can distinguish that
   * from a genuinely single-owner file; the ledger closes the window from here
   * on, it cannot reconstruct what was already discarded.
   */
  private probeLegacyStemOwnership(key: string, legacy: string): OwnershipProbe {
    const answer = this.probeLegacyStemOwnershipUncached(key, legacy);
    // REMEMBERED, because `get()` has to be able to tell the one deferral that
    // must not be served (a known-shared file under this key's own name) from
    // every other one. Keyed by session key and dropped when the key settles.
    const previous = this.transcriptProbeAnswer.get(key);
    if (answer.kind === "sole") this.transcriptProbeAnswer.delete(key);
    else if (answer.kind === "unknown" && previous === "shared") {
      // An unreadable source cannot un-share a file we already saw shared:
      // `unknown` means "cannot tell", and the last thing we could tell was
      // that another owner is in there. Keep withholding until a readable
      // probe answers `sole` or the family is parked.
    } else this.transcriptProbeAnswer.set(key, answer.kind);
    // Only a readable `sole` answer ends the withholding here (the settle
    // path above it is the other exit). `unknown` must not: dropping the
    // withheld cache on it would reload the still-mixed file.
    if (answer.kind === "sole") this.releaseWithheldSession(key);
    return answer;
  }

  private probeLegacyStemOwnershipUncached(key: string, legacy: string): OwnershipProbe {
    const others = new Set<string>();
    const target = legacy.toLowerCase();
    const consider = (candidate: string | undefined): void => {
      if (!candidate || candidate === key) return;
      if (legacyTranscriptFileStem(candidate).toLowerCase() !== target) return;
      others.add(candidate);
    };

    const ledger = this.readLegacyStemLedger();
    if (!ledger.ok) return { kind: "unknown", source: this.legacyStemLedgerPath };
    // ONE BAD ROW DEFERS ONE STEM. The rest of the ledger is evidence we can
    // still act on, so only a key whose own stem's row could not be read is
    // blind to its partners — and the warn token is per stem, so the line names
    // the row rather than the file.
    if (this.legacyStemLedgerMalformedStems.has(target)) {
      return { kind: "unknown", source: `${this.legacyStemLedgerPath} (row ${target})` };
    }
    for (const [stem, recorded] of Object.entries(ledger.stems)) {
      if (stem.toLowerCase() !== target) continue;
      for (const owner of recorded) consider(owner);
    }

    // Not while a registry critical section is open: `mutateRegistry` has
    // already forced a fresh read, and re-reading would discard the in-memory
    // mutation it is in the middle of making (`migrateSessionKey` reaches here).
    if (!isFileLockHeldSync(this.registryLockPath)) this.loadRegistry();
    if (this.registryLoadError !== null) return { kind: "unknown", source: this.registryPath };
    for (const entry of this.registry) {
      consider(entry.channelKey);
      consider(entry.migratedFrom);
    }
    for (const cached of this.sessions.keys()) consider(cached);
    // A NAMED OWNER BEATS AN UNREADABLE ONE. Ambiguity only ever grows, so a
    // partner we CAN see settles the question whatever else is unreadable — and
    // `shared` is the answer that parks the family, while `unknown` would leave a
    // stable-stem key reading the mixed file.
    if (others.size > 0) return { kind: "shared", others: [...others].sort() };

    // AND A HEALED LEDGER IS NOT A CLEAN ONE. The `_legacy_stems.json.corrupt-*`
    // copies beside it are the only record that some stem's owners were ever
    // unreadable, and they outlive the process that made them — which is the
    // whole point: the malformed-row set above is empty in every OTHER process,
    // so without this, `sole` is exactly what the next process answers for a file
    // whose partner was named in nothing but the rows that were moved aside.
    const heldBy = this.legacyStemHeldByCorruptLedger(target, ledger.stems);
    if (heldBy !== null) {
      const file = join(this.dir, heldBy);
      this.warnOnce(this.legacyStemLedgerCorruptWarned, `${heldBy}\u0000${target}`, () => log.warn(
        { file, stem: target },
        "Deferring legacy transcript migration: a quarantined copy of the legacy transcript stem ledger may name "
        + "another owner of this transcript's stem, and the healed ledger no longer records that it ever did. "
        + "RELEASE THE HOLD BY DELETING THAT `.corrupt-` FILE once its rows have been read (or by repairing it into "
        + "valid JSON); until then every migration it covers stays deferred",
      ));
      return { kind: "unknown", source: file };
    }
    return { kind: "sole" };
  }

  /** Emit `body` the first time `token` is seen — one line per collision per
   *  process, not one per inbound message. */
  private warnOnce(seen: Set<string>, token: string, body: () => void): void {
    if (seen.has(token)) return;
    seen.add(token);
    body();
  }

  /**
   * What the legacy-transcript migration still owes, for an operator.
   *
   * TWO HALVES WITH DIFFERENT LIFETIMES, and mixing them up is what made the
   * daemon's start-up line misleading. `ambiguous`, `sidecars` and `orphans` are
   * read off the DIRECTORY, so they are accurate before any key has been
   * touched. `settled` and `deferred` are what THIS PROCESS tried and could not
   * finish — necessarily empty until keys start arriving, which is why the
   * daemon logs the disk half at start and the whole thing again a few minutes
   * in (see `Agent.start`).
   *
   * `orphans` are sidecars with no canonical file beside them
   * (`<base>.legacy-<ts>.jsonl` with no `<base>.jsonl`): the residue of a re-key
   * interrupted between moving an archive and moving its sidecars. Readers do
   * cover them — that is what the union month set in `transcriptReadSet` is for
   * — so this is an operator hint about an unfinished pass, not lost history.
   *
   * TODO(tomo status): surface this as a `tomo status` field. Deliberately not
   * built here — the shape is what this PR owes, the CLI is a separate change.
   */
  migrationStatus(): {
    settled: boolean;
    deferred: string[];
    ambiguous: string[];
    sidecars: string[];
    orphans: string[];
  } {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      names = [];
    }
    const ambiguous = new Set(this.transcriptAmbiguousStems);
    for (const name of names) {
      if (!AMBIGUOUS_NAME_RE.test(name)) continue;
      const base = name.replace(AMBIGUOUS_NAME_RE, "");
      const archive = /^_archive_(.+)_\d{4}-\d{2}$/.exec(base);
      ambiguous.add((archive ? archive[1] : base).toLowerCase());
    }
    const deferred = [...this.transcriptMigrationRetryAt.keys()].sort();
    const present = new Set(names);
    const sidecars = names.filter((n) => LEGACY_SIDECAR_NAME_RE.test(n)).sort();
    return {
      settled: deferred.length === 0,
      deferred,
      ambiguous: [...ambiguous].sort(),
      sidecars,
      orphans: sidecars.filter((n) => !present.has(`${n.replace(LEGACY_SIDECAR_NAME_RE, "")}.jsonl`)),
    };
  }

  /** Load only the last tailLimit messages of the active transcript, plus as
   *  much of its read-only legacy sidecars as the remaining room allows.
   *
   *  Sidecars fill from the newest backwards, and the merge is then ORDERED BY
   *  THE RECORDS' OWN TIMESTAMPS rather than prepended wholesale: a sidecar is
   *  not necessarily older than the file it sits beside (a re-key sidecars a
   *  transcript that ran in parallel — see `transcriptReadSet`), and a
   *  positional merge put a July record after a September one, which is what
   *  `session.updatedAt` then read as the session's last activity. Each sidecar
   *  record is marked in `sidecarMessages` so `getLastSeq` can tell history from
   *  the active seq run. With no sidecar on disk this is byte-for-byte the old
   *  path: one tail read, no sort.
   */
  private loadTranscript(key: string): SessionMessage[] {
    const stem = this.safeKey(key);
    const messages = readJsonlTailSync<SessionMessage>(join(this.dir, `${stem}.jsonl`), this.tailLimit);
    if (messages.length >= this.tailLimit) return messages;
    const sidecarFiles = this.legacySidecarsFor(stem).reverse();
    if (sidecarFiles.length === 0) return messages;
    const older: SessionMessage[] = [];
    for (const sidecar of sidecarFiles) {
      const room = this.tailLimit - messages.length - older.length;
      if (room <= 0) break;
      const chunk = readJsonlTailSync<SessionMessage>(sidecar, room);
      for (const msg of chunk) this.sidecarMessages.add(msg);
      older.unshift(...chunk);
    }
    return sortByRecordTime([...older, ...messages]);
  }

  /** Timestamp of the oldest surviving message across archives, sidecars and
   *  the active file.
   *
   *  Without a sidecar the read set is chronological, so this walks oldest-first
   *  and stops at the first file that has a record — an empty archive (or an
   *  empty sidecar) must not read as "no history at all". WITH a sidecar the
   *  order is not time order, so it takes the MINIMUM over every file's first
   *  record instead: a July sidecar sitting between a September active file and
   *  an August archive used to hand back August. */
  private transcriptCreatedAt(key: string): number | undefined {
    const { files, hasSidecars } = this.transcriptReadSet(key);
    const oldestFirst = [...files].reverse();
    if (!hasSidecars) {
      for (const file of oldestFirst) {
        const timestamp = readFirstJsonlRecordSync<SessionMessage>(file.path)?.timestamp;
        if (timestamp !== undefined) return timestamp;
      }
      return undefined;
    }
    let oldest: number | undefined;
    let unplaceable: number | undefined;
    for (const file of oldestFirst) {
      const first = readFirstJsonlRecordSync<SessionMessage>(file.path);
      if (first === undefined) continue;
      const usable = usableTimestamp(first);
      if (usable === null) {
        // Kept only as a fallback: a record we cannot place must not win a
        // minimum (a `timestamp: 0` legacy row would always win it).
        if (unplaceable === undefined && first.timestamp !== undefined) unplaceable = first.timestamp;
        continue;
      }
      if (oldest === undefined || usable < oldest) oldest = usable;
    }
    return oldest ?? unplaceable;
  }

  /** Count user messages in the active transcript and the NEWEST of its
   *  read-only legacy sidecars, without retaining them.
   *
   *  Bounded by rotation — which is the point of the cap. Archived months are
   *  not counted, and a sidecar is never rotated either, so counting all of them
   *  made this the one reader whose cost grows with every deferred migration
   *  that ever happened on the install. `/status` shows an approximate recent
   *  count; the newest sidecar is the one that approximates it. */
  countRecentUserMessages(key: string): number {
    let count = 0;
    const stem = this.safeKey(key);
    const newestSidecar = this.legacySidecarsFor(stem).slice(-1);
    for (const file of [join(this.dir, `${stem}.jsonl`), ...newestSidecar]) {
      for (const msg of iterateJsonlBackwardsSync<SessionMessage>(file)) {
        if (msg.role === "user") count++;
      }
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

    const currentMonth = monthNow();
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
    // ROTATION MAY NOT THROW OUT OF HERE. The header above states the
    // contract — degrade to "don't rotate", never to "don't receive" — but
    // the body only honoured it for the failures it anticipated one at a
    // time. The unguarded ones are ordinary: `appendFileSync` onto an archive
    // and `writeFileSync` of the rewrite are bare calls (ENOSPC, EACCES,
    // EROFS, EMFILE), and `monthOf` used to raise RangeError on a record with
    // an unusable timestamp. Any of them escaped through `get()` and
    // `append()`, so every inbound message for that key was dropped until
    // someone hand-fixed the file. One catch around the whole pass, at the
    // boundary the contract is written on.
    try {
      this.rotateTranscriptLocked(key, file, currentMonth, lock);
    } catch (err) {
      log.warn({ err, key }, "Transcript rotation failed; leaving the active transcript in place");
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
    let undated = 0;
    for (const msg of all) {
      if (isRawJsonlLine(msg)) {
        keep.push(msg);
        continue;
      }
      const month = monthOf(msg.timestamp);
      if (month === null) {
        // No usable timestamp means no month to file it under — the same
        // position a line nobody could parse is in, and it is kept for the
        // same reason: rotation rewrites the active file, so anything not
        // archived has to come back out of it. Counted so the file can be
        // repaired rather than silently accumulating unarchivable records.
        undated++;
        keep.push(msg);
        continue;
      }
      if (month >= currentMonth) {
        keep.push(msg);
        continue;
      }
      let bucket = byMonth.get(month);
      if (!bucket) byMonth.set(month, bucket = []);
      bucket.push(msg);
    }
    if (undated > 0) {
      log.warn(
        { key, file, undated },
        "Transcript records without a usable timestamp were kept in the active file; they cannot be archived",
      );
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
    // A FAILED WRITE STILL LEAVES A FILE. ENOSPC/EACCES/EIO can throw after
    // the path has been created, and with a unique name per pass nothing ever
    // overwrites the corpse — every failing rotation drops another
    // `.rotate-tmp.<pid>.<uuid>` beside the transcript. The caller's catch
    // (see `rotateTranscript`) turns the throw into "don't rotate", so this
    // is the only place that still knows the name. Every other abandon path
    // below unlinks; so does this one, then rethrows unchanged.
    try {
      writeFileSync(tmp, keep.length > 0 ? keep.map(serializeJsonlRecord).join("\n") + "\n" : "");
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw err;
    }

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
