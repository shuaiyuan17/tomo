import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimePaths } from "./runtime-paths.js";
import { TOMO_SESSION_KEY_ENV } from "./restart-reason.js";

export const RESTART_REQUEST_MARKER = "TOMO_RESTART_REQUEST:";
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_DIR = join(dirname(defaultRuntimePaths.restartReasonFile), "restart-requests");

/**
 * How long a written-but-unacknowledged restart request stays actionable.
 *
 * The handshake is best-effort by construction: it depends on the marker line
 * surviving into the Bash tool result, and the model controls the command, so
 * `tomo restart >/dev/null` or a pipe that keeps only the last line drops it.
 * The end-of-turn fallback catches those within the same turn; this bound
 * catches everything else (the daemon died before the turn ended, the session
 * was torn down, the process was killed). Past it a request is stale evidence
 * of an intent nobody is waiting on any more, and acting on it would restart
 * Tomo out of nowhere — so it is swept, not honoured.
 */
export const RESTART_REQUEST_TTL_MS = 10 * 60 * 1000;

function isExpired(request: RestartRequest, now: number): boolean {
  const requestedAt = Date.parse(request.requestedAt);
  // An unparseable timestamp fails closed: we cannot show the request is
  // recent, and a spurious restart is worse than a missed one.
  if (!Number.isFinite(requestedAt)) return true;
  return now - requestedAt >= RESTART_REQUEST_TTL_MS;
}

/** Read and validate one request file. Anything unreadable/malformed is null. */
function readRequest(path: string): RestartRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const request = parsed as RestartRequest;
  if (typeof request.id !== "string" || !REQUEST_ID_RE.test(request.id)) return null;
  if (typeof request.sessionKey !== "string" || request.sessionKey === "") return null;
  if (typeof request.requestedAt !== "string") return null;
  return request;
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove — either way there is nothing to do.
  }
}

function listRequestFiles(requestDir: string): string[] {
  try {
    return readdirSync(requestDir).filter((name) => name.endsWith(".json"));
  } catch {
    return []; // No directory yet: no requests.
  }
}

/**
 * Drop every request that can no longer be honoured — expired, or malformed.
 *
 * Called once at daemon startup. Without it the directory is append-only: a
 * request whose marker never came back (and whose turn never completed,
 * because the process went away) would sit there for the life of the install.
 * Returns the number of files removed, for the startup log.
 */
export function sweepStaleRestartRequests(
  requestDir: string = DEFAULT_REQUEST_DIR,
  now: number = Date.now(),
): number {
  let removed = 0;
  for (const name of listRequestFiles(requestDir)) {
    const path = join(requestDir, name);
    const request = readRequest(path);
    if (request && !isExpired(request, now)) continue;
    discard(path);
    removed += 1;
  }
  return removed;
}

/**
 * Claim any still-actionable request belonging to `sessionKey`.
 *
 * The end-of-turn fallback. `consumeRestartRequestFromToolResult` is the happy
 * path and fires mid-turn; this is what makes the CLI's "Tomo will restart"
 * true even when the marker never reached a tool result. EVERY live request
 * for the session is claimed, not just the returned one — two `tomo restart`
 * calls in one turn are one restart, and leaving the second file behind would
 * fire it again after the daemon came back.
 */
export function takePendingRestartRequest(
  sessionKey: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
  now: number = Date.now(),
): RestartRequest | null {
  const live: RestartRequest[] = [];
  for (const name of listRequestFiles(requestDir)) {
    const path = join(requestDir, name);
    const request = readRequest(path);
    if (!request || isExpired(request, now)) {
      discard(path);
      continue;
    }
    if (request.sessionKey !== sessionKey) continue;
    live.push(request);
    discard(path);
  }
  if (live.length === 0) return null;
  // Oldest first: it carries the reason the owner is actually waiting on.
  live.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  return live[0];
}

export interface RestartRequest {
  id: string;
  sessionKey: string;
  reason?: string;
  requestedAt: string;
}

function requestPath(id: string, requestDir: string): string {
  return join(requestDir, `${id}.json`);
}

/** Persist a session-originated restart until its Bash result is observed. */
export function createRestartRequest(
  sessionKey: string,
  reason?: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
): RestartRequest {
  mkdirSync(requestDir, { recursive: true });
  const request: RestartRequest = {
    id: randomUUID(),
    sessionKey,
    ...(reason ? { reason } : {}),
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(requestPath(request.id, requestDir), `${JSON.stringify(request)}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return request;
}

export function formatRestartRequestResult(request: RestartRequest): string {
  return [
    "Restart scheduled. Tomo restarts as soon as this Bash result is recorded, or at the end of this turn if it is not.",
    `${RESTART_REQUEST_MARKER}${request.id}`,
  ].join("\n");
}

export function restartWorkerInvocation(
  request: RestartRequest,
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const workerEnv = { ...env };
  delete workerEnv[TOMO_SESSION_KEY_ENV];
  return {
    command: process.execPath,
    args: [
      cliPath,
      "restart",
      ...(request.reason ? ["--reason", request.reason] : []),
      "--session",
      request.sessionKey,
    ],
    env: workerEnv,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/**
 * Consume only the request named by an observed Bash result from the same
 * session. Seeing this marker is the acknowledgement boundary: the SDK has
 * emitted the tool-result event, so restarting can no longer replace it with
 * the CLI's misleading interrupted/rejected fallback.
 */
export function consumeRestartRequestFromToolResult(
  content: unknown,
  sessionKey: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
  now: number = Date.now(),
): RestartRequest | null {
  const text = toolResultText(content);
  const markerIndex = text.indexOf(RESTART_REQUEST_MARKER);
  if (markerIndex === -1) return null;
  const id = text
    .slice(markerIndex + RESTART_REQUEST_MARKER.length)
    .split(/\s/, 1)[0];
  if (!REQUEST_ID_RE.test(id)) return null;

  const path = requestPath(id, requestDir);
  const request = readRequest(path);
  if (!request) return null;
  if (request.id !== id || request.sessionKey !== sessionKey) return null;
  // A marker that surfaces this late is not an acknowledgement of anything the
  // owner is still waiting on — drop the request rather than restart on it.
  if (isExpired(request, now)) {
    discard(path);
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return request;
}
