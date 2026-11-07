import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";

/**
 * The web supervisor's state, published by the daemon for `tomo status` (a
 * separate process). The file is advisory: the CLI also probes the port, and
 * ignores a record written by a daemon other than the one now running.
 */
export type WebState = "starting" | "running" | "backoff" | "failed" | "stopped";

export interface WebStatusRecord {
  state: WebState;
  /** The port the child has bound, while it is running. */
  port: number | null;
  /** The port the supervisor is trying to serve on (its config at daemon start). */
  targetPort: number;
  pid: number | null;
  /** Consecutive failed starts or crashes, cleared after a healthy period. */
  restarts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  daemonPid: number;
  updatedAt: number;
}

export const WEB_STATUS_FILE = "web-status.json";

export function writeWebStatus(tomoHome: string, record: WebStatusRecord): void {
  writeJsonAtomicSync(join(tomoHome, WEB_STATUS_FILE), record);
}

const STATES: readonly WebState[] = ["starting", "running", "backoff", "failed", "stopped"];

export function readWebStatus(tomoHome: string): WebStatusRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(tomoHome, WEB_STATUS_FILE), "utf8")) as Partial<WebStatusRecord>;
    if (!raw || typeof raw !== "object" || !STATES.includes(raw.state as WebState)) return null;
    if (typeof raw.daemonPid !== "number" || typeof raw.updatedAt !== "number" || !validPort(raw.targetPort)) return null;
    return {
      state: raw.state as WebState,
      port: validPort(raw.port) ? raw.port : null,
      targetPort: raw.targetPort,
      pid: typeof raw.pid === "number" ? raw.pid : null,
      restarts: typeof raw.restarts === "number" ? raw.restarts : 0,
      nextRetryAt: typeof raw.nextRetryAt === "number" ? raw.nextRetryAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      daemonPid: raw.daemonPid,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}
