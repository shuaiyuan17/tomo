import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * Is `pid` a process we can see? EPERM means it exists and is simply owned by
 * someone else — very much alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock older than this whose owner cannot be proven alive is reclaimed. */
const DEFAULT_STALE_MS = 30_000;
/** How long a contender waits for a live holder before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 5;

export interface FileLockOptions {
  /**
   * Age past which a lock is reclaimable even though its owner *might* still
   * be alive (a different host, an unreadable owner record). A lock whose
   * owner pid is provably dead is reclaimed immediately, whatever its age.
   */
  staleMs?: number;
  /** Wait budget before `FileLockTimeoutError`. */
  timeoutMs?: number;
  /** Sleep between acquisition attempts. */
  pollMs?: number;
}

/** The lock was held by someone else for the whole wait budget. */
export class FileLockTimeoutError extends Error {
  readonly path: string;
  /** The pid recorded in the lock, when it could be read. */
  readonly holderPid: number | null;

  constructor(path: string, timeoutMs: number, holderPid: number | null) {
    super(
      `could not acquire the lock at ${path} within ${timeoutMs}ms`
      + (holderPid === null ? "" : ` (held by pid ${holderPid})`),
    );
    this.name = "FileLockTimeoutError";
    this.path = path;
    this.holderPid = holderPid;
  }
}

interface LockOwner {
  pid: number;
  ts: number;
  host: string;
}

/**
 * Locks this process holds, by lock path → nesting depth. Synchronous code
 * cannot interleave inside one process, so a same-process re-entry is never a
 * race — it is a nested call (`setSdkSessionId` → `clearSdkSessionId`,
 * `mutateRegistry` → `saveRegistry`), and blocking it would be a guaranteed
 * self-deadlock rather than mutual exclusion. Re-entry therefore just bumps
 * the depth; only the outermost frame touches the filesystem.
 */
const heldLocks = new Map<string, number>();

/** Does THIS process already hold `lockPath` (i.e. would an acquire be a re-entry)? */
export function isFileLockHeldSync(lockPath: string): boolean {
  return (heldLocks.get(lockPath) ?? 0) > 0;
}

/**
 * Run `fn` with the advisory lock at `lockPath` held, then release it.
 *
 * The point is cross-PROCESS mutual exclusion for a synchronous
 * read-modify-write on a shared JSON file. Tomo writes both the cron store and
 * the session registry from a long-running daemon AND from short-lived CLI
 * processes; an atomic `rename` alone only makes each publish indivisible, it
 * does not stop a writer from publishing a snapshot it read before someone
 * else's publish. That is a lost update, and no re-check inside the write can
 * close it (the check and the rename are still two syscalls).
 *
 * The protocol is the one `withPidFileLock` (src/cli/pidfile.ts) already uses
 * here, generalized: the lock is a DIRECTORY whose sole entry `owner.<token>`
 * names the holder, and it is only ever created by `rename(prepared, lockPath)`
 * — never by `mkdir` at the path itself. Rename onto a non-empty directory
 * fails with ENOTEMPTY (held), onto an empty one replaces it atomically, and
 * onto nothing succeeds. So the lock is never observable as "present but
 * ownerless" except mid-reclaim, and reclaiming is a single `unlink` of an
 * owner entry whose token is unique to that lock INSTANCE — a reclaimer can
 * only ever empty the instance it judged abandoned, never a newer one that
 * took the path in between (the ABA a plain rmdir would allow).
 *
 * Throws `FileLockTimeoutError` when a live holder keeps it for the whole
 * budget. Callers decide what that means: the same split the stores use for an
 * unreadable file — loud for anything that changes a link, skipped for
 * bookkeeping that must never fail a turn.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const depth = heldLocks.get(lockPath) ?? 0;
  if (depth > 0) {
    heldLocks.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      const next = (heldLocks.get(lockPath) ?? 1) - 1;
      if (next > 0) heldLocks.set(lockPath, next);
      else heldLocks.delete(lockPath);
    }
  }

  const ownerName = acquire(lockPath, opts);
  heldLocks.set(lockPath, 1);
  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    release(lockPath, ownerName);
  }
}

/** Take the lock, returning the name of our owner entry. */
function acquire(lockPath: string, opts: FileLockOptions): string {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const token = randomUUID();
  const prepared = `${lockPath}.${process.pid}.${token}`;
  const ownerName = `owner.${token}`;
  mkdirSync(dirname(lockPath), { recursive: true });
  mkdirSync(prepared);
  try {
    const owner: LockOwner = { pid: process.pid, ts: Date.now(), host: hostname() };
    writeFileSync(join(prepared, ownerName), `${JSON.stringify(owner)}\n`);
  } catch (err) {
    rmSync(prepared, { recursive: true, force: true });
    throw err;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      renameSync(prepared, lockPath);
      return ownerName;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTEMPTY (POSIX) / EEXIST (some platforms) both mean "held".
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        rmSync(prepared, { recursive: true, force: true });
        throw err;
      }
    }

    const abandoned = abandonedOwner(lockPath, staleMs);
    if (abandoned !== null) {
      let reclaimed = true;
      try {
        unlinkSync(join(lockPath, abandoned.name));
      } catch (err) {
        // ENOENT: another reclaimer got there first, or the instance changed
        // under us — either way retry. Anything else (EACCES on the lock
        // directory) is not going to fix itself, so fall through to the
        // deadline rather than spinning on it.
        reclaimed = (err as NodeJS.ErrnoException).code === "ENOENT";
      }
      // The rename now either replaces the emptied lock or finds a new holder.
      if (reclaimed) continue;
    }

    if (Date.now() >= deadline) {
      rmSync(prepared, { recursive: true, force: true });
      throw new FileLockTimeoutError(lockPath, timeoutMs, holderPid(lockPath));
    }
    sleepSync(pollMs);
  }
}

function release(lockPath: string, ownerName: string): void {
  // Our entry's name carries a token only we know: after it is gone the
  // (empty) directory is either removed here or atomically replaced by the
  // next contender's rename, which makes the rmdir fail with ENOTEMPTY.
  try { unlinkSync(join(lockPath, ownerName)); } catch { /* reclaimed as abandoned */ }
  try { rmdirSync(lockPath); } catch { /* replaced by a contender, or already gone */ }
}

/**
 * The owner entry to remove if the lock at `lockPath` is abandoned, else null.
 *
 * Two things say abandoned: the owner pid is dead (checked only for a lock
 * written by this host — pids from another machine mean nothing here), or the
 * lock is older than `staleMs` and we cannot prove it is alive. A live owner
 * that is merely slow keeps its lock; contenders time out rather than steal,
 * because stealing is exactly the lost update the lock exists to prevent.
 */
function abandonedOwner(lockPath: string, staleMs: number): { name: string; pid: number | null } | null {
  const entry = ownerEntry(lockPath);
  // 0 entries: a reclaim is mid-flight. More than one: garbage we did not
  // write. Neither is ours to adjudicate — the rename settles it.
  if (entry === null) return null;
  const sameHost = entry.owner !== null && entry.owner.host === hostname();
  if (sameHost && entry.owner !== null && !isPidAlive(entry.owner.pid)) {
    return { name: entry.name, pid: entry.owner.pid };
  }
  let ageMs: number;
  try {
    ageMs = Date.now() - (entry.owner?.ts ?? statSync(lockPath).mtimeMs);
  } catch {
    return null;
  }
  if (ageMs > staleMs) return { name: entry.name, pid: entry.owner?.pid ?? null };
  return null;
}

function holderPid(lockPath: string): number | null {
  return ownerEntry(lockPath)?.owner?.pid ?? null;
}

function ownerEntry(lockPath: string): { name: string; owner: LockOwner | null } | null {
  let names: string[];
  try {
    names = readdirSync(lockPath).filter((n) => n.startsWith("owner."));
  } catch {
    return null;
  }
  if (names.length !== 1) return null;
  return { name: names[0], owner: readOwner(join(lockPath, names[0])) };
}

function readOwner(file: string): LockOwner | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<LockOwner>;
    if (typeof data?.pid !== "number" || !Number.isInteger(data.pid)) return null;
    if (typeof data.ts !== "number" || typeof data.host !== "string") return null;
    return { pid: data.pid, ts: data.ts, host: data.host };
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
