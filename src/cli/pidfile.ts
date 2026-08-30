import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { defaultRuntimePaths } from "../runtime-paths.js";

const PID_FILE = defaultRuntimePaths.pidFile;

/** True when a process with this pid exists (any owner we may signal). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PidFileAcquisition =
  /**
   * We own the pid file. `tookOverStale` is the dead pid whose file we
   * removed, or null when the file simply did not exist.
   */
  | { ok: true; tookOverStale: number | null }
  /** Another live daemon holds it; `holder` is its pid. */
  | { ok: false; holder: number };

/**
 * Claim the daemon pid file, atomically.
 *
 * This is the whole reason the function exists: `existsSync` + `readFileSync`
 * + `writeFileSync` is a check-then-act with a window between the two halves,
 * and the daemon's window used to be the entire startup sequence (config load,
 * mkdirs, a recursive skills copy, channel construction, `metricsExporter
 * .start()`). A login-time autostart firing while the user runs `tomo start`
 * put two daemons past the check — both long-polling the same bot token, both
 * reading chat.db, both writing the session registry — and the pid file named
 * only one of them, so `tomo stop` orphaned the other permanently.
 *
 * The claim is made by writing the pid into a private temp file and then
 * `link()`ing it into place. `link` fails with EEXIST rather than overwriting,
 * so exactly one racer can win — and, unlike `open(…, "wx")` followed by a
 * separate `write`, the pid file is never observable as an EXISTING BUT EMPTY
 * file. That window is not theoretical: with six processes racing, a loser
 * that read the winner's file between its create and its write saw no pid,
 * concluded "stale", unlinked the live winner's claim and took over. Four of
 * six processes won that way.
 *
 * A file left behind by a crashed daemon (or one whose contents are garbage)
 * is taken over: the recorded pid is probed with `kill(pid, 0)` and, if dead,
 * the file is unlinked and the link retried. The retry loop is bounded because
 * the unlink→link pair is NOT atomic — two processes both finding the same
 * stale file can interleave — and losing that sub-race just means the other
 * one is now the live holder, which the next iteration observes.
 *
 * Call this as the FIRST action of daemon startup, before any `await`.
 */
export function acquirePidFile(pidFile: string = PID_FILE, pid: number = process.pid): PidFileAcquisition {
  let tookOverStale: number | null = null;

  mkdirSync(dirname(pidFile), { recursive: true });
  const staging = `${pidFile}.${pid}.${randomUUID()}`;
  writeFileSync(staging, String(pid));

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(staging, pidFile);
        return { ok: true, tookOverStale };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }

      const holder = readPid(pidFile);
      // `holder === pid` is us: a pid file we already own (or one left by a
      // recycled pid that happens to be ours). Either way it is not a second
      // daemon, so take it over rather than refusing to start.
      if (holder !== null && holder !== pid && isPidAlive(holder)) {
        return { ok: false, holder };
      }

      tookOverStale = holder;
      try {
        unlinkSync(pidFile);
      } catch (err) {
        // Someone else cleaned it up first; the next link attempt settles it.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Five EEXIST rounds with no live holder means another process is churning
    // the same file. Refusing is safer than looping: the caller exits non-zero.
    return { ok: false, holder: readPid(pidFile) ?? 0 };
  } finally {
    try { unlinkSync(staging); } catch { /* already gone */ }
  }
}

/**
 * Drop the pid file — but only if it still names `pid`.
 *
 * The guard matters on the shutdown path: a slow-exiting daemon can still be
 * running its `shutdown()` when its replacement has already acquired the file,
 * and an unconditional `unlink` there would delete the live successor's claim
 * and re-open the double-start hole this module closes.
 */
export function releasePidFile(pidFile: string = PID_FILE, pid: number = process.pid): void {
  try {
    if (readPid(pidFile) !== pid) return;
    unlinkSync(pidFile);
  } catch {
    /* best effort — a missing or unreadable pid file needs no cleanup */
  }
}

function readPid(pidFile: string): number | null {
  try {
    const n = Number(readFileSync(pidFile, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
