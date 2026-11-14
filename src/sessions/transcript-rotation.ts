import { appendFileSync, closeSync, fstatSync, linkSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SessionMessage } from "./types.js";
import { log } from "../logger.js";

/**
 * Monthly transcript rotation support: month bucketing, the cross-process
 * rotation lock, and carrying concurrent appends across the rewrite.
 */

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
export function monthOf(timestamp: unknown): string | null {
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
export function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Ordering guard for rotation crash recovery: prefer the monotonic seq,
 *  fall back to timestamps for legacy messages without one. */
export function isAfterMessage(msg: SessionMessage, last: SessionMessage): boolean {
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

export interface RotationLock {
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
export function acquireRotationLock(file: string, key: string): RotationLock | null {
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
export function sameInode(fd: number, path: string): boolean {
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
export function readCompleteLinesFromFd(fd: number, offset: number): { text: string; bytesRead: number } {
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
export function spliceAppendsSince(
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
