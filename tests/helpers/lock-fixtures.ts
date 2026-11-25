import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Fixtures for the advisory directory locks (`src/file-lock.ts`, and the pid
 * file's own lock in `src/cli/pidfile.ts`), shared by the storage tests.
 */

/**
 * A pid that is guaranteed dead: spawn a process that exits immediately.
 * Checked, not `.pid!`: under a loaded full-suite run a spawn can fail
 * (EAGAIN), and an `undefined` pid slips past `isPidAlive` (false) only to
 * fail a later `toEqual` as an inexplicable flake.
 */
export function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = spawnSync(process.execPath, ["-e", ""]);
    if (!res.error && typeof res.pid === "number" && res.pid > 0) return res.pid;
  }
  throw new Error("could not spawn a throwaway process to obtain a dead pid");
}

export interface PlantedOwner {
  pid: number;
  /** When the owner says it took the lock (default: now). */
  ts?: number;
  /** The owner's host (default: this one). */
  host?: string;
}

/**
 * Plant a `withFileLockSync` lock exactly as another process would leave one:
 * a directory holding a single `owner.<name>` record. Same-process re-entry
 * is deliberately free (see withFileLockSync), so this is the only honest way
 * to play a contender. Returns the lock directory, so a test can `rmSync` it
 * to let the store through again.
 */
export function plantFileLock(lockPath: string, owner: PlantedOwner, name = "owner.planted"): string {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, name),
    `${JSON.stringify({ pid: owner.pid, ts: owner.ts ?? Date.now(), host: owner.host ?? hostname() })}\n`,
  );
  return lockPath;
}

/** Another LIVE process (this one, as far as the lock can tell) inside the critical section. */
export function holdFileLockAsLiveOwner(lockPath: string): string {
  return plantFileLock(lockPath, { pid: process.pid }, "owner.other");
}

/** Write `content` at `path` and backdate its mtime by `ageMs` (negative: the future). */
export function writeAged(path: string, content: string, ageMs: number): void {
  writeFileSync(path, content);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}
