import { existsSync, statSync, unlinkSync } from "node:fs";
import { defaultRuntimePaths } from "../runtime-paths.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  isPidAlive,
  isRecordedProcessLive,
  readPidFileRecord,
  type PidFileRecord,
} from "./pidfile.js";

const PID_FILE = defaultRuntimePaths.pidFile;

// Liveness lives in exactly one place. There used to be three copies of a
// `kill(pid, 0)` wrapper (here, start.ts, service.ts) and they disagreed about
// EPERM, so a daemon owned by another uid was "dead" to two of them.
export { isPidAlive, isRecordedProcessLive, readPidFileRecord, DAEMON_STOP_TIMEOUT_MS };

/**
 * The record in the daemon's pid file, or null when it is absent or stale.
 * Stale files are removed.
 *
 * "Stale" means the recorded process is gone — including the pid-reuse case,
 * where the pid is alive but is now some OTHER process (see
 * {@link isRecordedProcessLive}). It deliberately does NOT mean "we could not
 * prove it is alive": a cross-uid daemon answers EPERM and stays.
 */
export function getRunningPidRecord(pidFile = PID_FILE): PidFileRecord | null {
  const record = readPidFileRecord(pidFile);
  if (record === null) {
    // Present but unparseable — garbage from a partial write. Nothing can be
    // done with it and leaving it blocks nothing, so clear it.
    if (existsSync(pidFile)) { try { unlinkSync(pidFile); } catch { /* raced */ } }
    return null;
  }
  if (!isRecordedProcessLive(record)) {
    try { unlinkSync(pidFile); } catch { /* raced */ }
    return null;
  }
  return record;
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

/**
 * Poll until `pid` is gone, or `timeoutMs` elapses. Returns true iff the
 * process exited.
 *
 * Signals are asynchronous: `process.kill(pid, "SIGTERM")` returns as soon as
 * the signal is queued, long before the daemon has finished `agent.stop()`
 * (which can take tens of seconds when SIGTERM lands mid-turn) — and returns
 * just the same when the handler never runs at all. Anything reporting
 * "stopped" needs to observe the exit, not the send.
 *
 * The poll uses plain liveness rather than the full identity check: the latter
 * spawns `ps`, and at 100ms intervals over a 60s budget that is 600 processes.
 * Callers that care about pid reuse confirm once, at the end (see
 * `performStopWith`).
 */
export async function waitForExit(
  pid: number,
  timeoutMs = DAEMON_STOP_TIMEOUT_MS,
  pollMs = 100,
  alive: (p: number) => boolean = isPidAlive,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= deadline) return !alive(pid);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
