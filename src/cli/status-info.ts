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
    uptimeMs = Date.now() - statSync(pidFile).mtimeMs;
  } catch { /* pid file raced away; report running without uptime */ }
  return { pid, uptimeMs };
}
