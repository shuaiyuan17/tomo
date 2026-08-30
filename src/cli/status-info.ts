import { statSync } from "node:fs";
import { defaultRuntimePaths } from "../runtime-paths.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  isPidAlive,
  isRecordedProcessLive,
  readLivePidFileRecord,
  readPidFileRecord,
  waitForExit,
  type PidFileRecord,
} from "./pidfile.js";

const PID_FILE = defaultRuntimePaths.pidFile;

// Liveness lives in exactly one place. There used to be three copies of a
// `kill(pid, 0)` wrapper (here, start.ts, service.ts) and they disagreed about
// EPERM, so a daemon owned by another uid was "dead" to two of them.
export { isPidAlive, isRecordedProcessLive, readPidFileRecord, waitForExit, DAEMON_STOP_TIMEOUT_MS };

/**
 * The record in the daemon's pid file, or null when it is absent or stale.
 * Stale files are removed — under the pid-file lock, so this can never delete
 * a claim that a starting daemon has just re-taken.
 *
 * "Stale" means the recorded process is gone — including the pid-reuse case,
 * where the pid is alive but is now some OTHER process (see
 * {@link isRecordedProcessLive}). It deliberately does NOT mean "we could not
 * prove it is alive": a cross-uid daemon answers EPERM and stays.
 */
export function getRunningPidRecord(pidFile = PID_FILE): PidFileRecord | null {
  return readLivePidFileRecord(pidFile);
}

/** PID from the daemon's pid file, or null if absent/stale (stale files are removed). */
export function getRunningPid(pidFile = PID_FILE): number | null {
  return getRunningPidRecord(pidFile)?.pid ?? null;
}

export interface DaemonStatus {
  pid: number | null;
  /** Milliseconds since the pid file was written. Null when not running. */
  uptimeMs: number | null;
}

export function getDaemonStatus(pidFile = PID_FILE): DaemonStatus {
  const pid = getRunningPid(pidFile);
  if (!pid) return { pid: null, uptimeMs: null };
  let uptimeMs: number | null = null;
  try {
    // Clamp: mtime can be a fraction ahead of Date.now() right after the
    // pid file is written (filesystem timestamp granularity).
    uptimeMs = Math.max(0, Date.now() - statSync(pidFile).mtimeMs);
  } catch { /* pid file raced away; report running without uptime */ }
  return { pid, uptimeMs };
}
