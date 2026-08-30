import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { defaultRuntimePaths } from "../runtime-paths.js";

const PID_FILE = defaultRuntimePaths.pidFile;

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID from the daemon's pid file, or null if absent/stale (stale files are removed). */
export function getRunningPid(pidFile = PID_FILE): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  if (isNaN(pid) || !isRunning(pid)) {
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return null;
  }
  return pid;
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

/** How long `tomo stop` waits for the daemon to actually exit. */
export const STOP_TIMEOUT_MS = 10_000;

/**
 * Poll until `pid` is gone, or `timeoutMs` elapses. Returns true iff the
 * process exited.
 *
 * Signals are asynchronous: `process.kill(pid, "SIGTERM")` returns as soon as
 * the signal is queued, long before the daemon has finished `agent.stop()`
 * (which can take tens of seconds when SIGTERM lands mid-turn) — and returns
 * just the same when the handler never runs at all. Anything reporting
 * "stopped" needs to observe the exit, not the send.
 */
export async function waitForExit(
  pid: number,
  timeoutMs = STOP_TIMEOUT_MS,
  pollMs = 100,
  alive: (p: number) => boolean = isRunning,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= deadline) return !alive(pid);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
