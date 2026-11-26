import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadNodeSqlite, type SqliteDatabase } from "./sqlite.js";

/**
 * The one lock the daemon and the maintenance commands (`tomo db repair`,
 * `tomo db export`, `tomo backup restore`) share: while one of them holds it,
 * none of the others runs. The daemon takes it at start and keeps it until it
 * exits; a maintenance command takes it for as long as it runs.
 *
 * Without it, the only guard was a pid-file check at the start of each
 * command, and launchd's KeepAlive could respawn the daemon (after a crash)
 * halfway through a repair or a restore.
 *
 * HOW. The lock file is a scratch SQLite database (rollback journal, never
 * WAL), and holding the lock is holding `BEGIN EXCLUSIVE` on it. That is a
 * POSIX record lock in the kernel, so it goes away with the process however
 * the process ends: a crash, SIGKILL or a power cut never leaves a stale lock
 * to clean up, and there is no pid to check or age to guess. The file holds no
 * data; deleting it while nothing holds it is harmless.
 *
 * It lives in `~/.tomo` itself, not in `data/`, because `tomo backup restore`
 * swaps the whole `data/` directory: a lock file inside it would be swapped
 * out from under its holder.
 *
 * One holder per process: the daemon opens it once. (POSIX record locks are
 * per process, and SQLite keeps track of its own connections, but nothing
 * else in Tomo should open this file.)
 */
export const MAINTENANCE_LOCK_FILENAME = "tomo.lock";

export function maintenanceLockPath(tomoHome: string): string {
  return join(tomoHome, MAINTENANCE_LOCK_FILENAME);
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export interface MaintenanceLock {
  readonly path: string;
  /** Let go of the lock. Idempotent. Exiting the process releases it too. */
  release(): void;
}

/**
 * Every lock this process holds, until released. Without a strong reference
 * a lock nobody keeps a variable for (the daemon only stores it) can be
 * garbage-collected, and collecting the connection closes it, which lets go
 * of the lock while its holder is still running. (Seen: a holder that kept no
 * reference lost its lock to a waiter a few seconds later, at the next GC.)
 */
const held = new Set<SqliteDatabase>();

function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/**
 * Take the lock at `path`, waiting up to `waitMs` for a holder to let go.
 * Returns null when it is still held after that (by the daemon, or by another
 * maintenance command). Any other failure (the directory cannot be created,
 * the file is not ours) throws.
 */
export function acquireMaintenanceLock(path: string, opts: { waitMs?: number } = {}): MaintenanceLock | null {
  mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  let db: SqliteDatabase | null = new DatabaseSync(path, { timeout: Math.max(0, opts.waitMs ?? 0) });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    db.close();
    if (isBusy(err)) return null;
    throw err;
  }
  held.add(db);
  return {
    path,
    release() {
      if (!db) return;
      const conn = db;
      db = null;
      held.delete(conn);
      try {
        conn.exec("ROLLBACK");
      } catch {
        /* closing releases it anyway */
      }
      conn.close();
    },
  };
}

/** The message a maintenance command prints when the lock is taken. */
export function maintenanceLockBusyMessage(path: string): string {
  return `Tomo is running, or another maintenance command is (${path} is locked). Stop Tomo first (\`tomo stop\`), or wait for the other command to finish.`;
}
