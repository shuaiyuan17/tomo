import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimePaths } from "./runtime-paths.js";
import { TOMO_SESSION_KEY_ENV } from "./restart-reason.js";

export const RESTART_REQUEST_MARKER = "TOMO_RESTART_REQUEST:";
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_DIR = join(dirname(defaultRuntimePaths.restartReasonFile), "restart-requests");

/**
 * How long a request survives ACROSS turns.
 *
 * Deliberately NOT applied to the end-of-turn fallback. A turn ending is
 * positive evidence that its own request is current, however long the turn
 * ran: a tool loop can legitimately spend half an hour between the
 * `tomo restart` call and the end of the turn, and wall-clock age says
 * nothing about whether the owner is still waiting. Gating the fallback on
 * age meant a long turn silently broke the promise the CLI had already
 * printed — the exact failure this whole path exists to prevent.
 *
 * What the TTL is for is a request that outlived the turn that made it: the
 * daemon died before the turn ended, the session was torn down, the process
 * was killed. Those are swept at startup, and a marker surfacing that late
 * (necessarily in some LATER turn) is refused. There, age is the only signal
 * available, and restarting Tomo out of nowhere is worse than missing one.
 */
export const RESTART_REQUEST_TTL_MS = 10 * 60 * 1000;

/** Why a request file was thrown away. Surfaced so callers can log it. */
export type RestartRequestDiscardDetail =
  | { reason: "expired"; request: RestartRequest }
  | { reason: "malformed" }
  | { reason: "superseded"; request: RestartRequest };

export type RestartRequestDiscard = RestartRequestDiscardDetail & { path: string };

/**
 * Discard notifications. Deliberately a callback rather than a logger import:
 * this module is loaded by `tomo restart` on the CLI side, and nothing under
 * src/cli/ imports the logger — pulling pino (and the watch bus with it) into
 * every CLI invocation to report an event only the daemon can act on is a bad
 * trade. The daemon passes a callback that logs at warn.
 */
export type OnRestartRequestDiscard = (discard: RestartRequestDiscard) => void;

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

function discard(
  path: string,
  detail: RestartRequestDiscardDetail,
  onDiscard?: OnRestartRequestDiscard,
): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove — either way there is nothing to do.
    return;
  }
  // Only report what we actually removed, so the count a caller logs matches
  // the number of restarts that will not happen.
  onDiscard?.({ path, ...detail });
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
  onDiscard?: OnRestartRequestDiscard,
): number {
  let removed = 0;
  for (const name of listRequestFiles(requestDir)) {
    const path = join(requestDir, name);
    const request = readRequest(path);
    if (!request) {
      discard(path, { reason: "malformed" }, onDiscard);
      removed += 1;
      continue;
    }
    if (!isExpired(request, now)) continue;
    discard(path, { reason: "expired", request }, onDiscard);
    removed += 1;
  }
  return removed;
}

/**
 * Claim every request belonging to `sessionKey`, returning the one to act on.
 *
 * The end-of-turn fallback. `consumeRestartRequestFromToolResult` is the happy
 * path and fires mid-turn; this is what makes the CLI's "Tomo will restart"
 * true even when the marker never reached a tool result.
 *
 * NO TTL HERE, deliberately — see RESTART_REQUEST_TTL_MS. The turn ending is
 * the evidence that its request is current, and a turn is allowed to take as
 * long as it takes. Applying the TTL here made a >10-minute tool loop end with
 * the request silently deleted and no restart, after the CLI had already told
 * the owner one was scheduled.
 *
 * EVERY live request for the session is claimed, not just the returned one —
 * two `tomo restart` calls in one turn are one restart, and leaving the second
 * file behind would fire it again after the daemon came back. Callers that are
 * dropping rather than acting (a restart already in flight) pass
 * `reason: "superseded"` so the discard is reported that way.
 */
export function takePendingRestartRequest(
  sessionKey: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
  onDiscard?: OnRestartRequestDiscard,
): RestartRequest | null {
  const live: RestartRequest[] = [];
  for (const name of listRequestFiles(requestDir)) {
    const path = join(requestDir, name);
    const request = readRequest(path);
    if (!request) {
      discard(path, { reason: "malformed" }, onDiscard);
      continue;
    }
    // Another session's request is none of this turn's business, whatever its
    // age — its own session's turn end (or the startup sweep) will deal with it.
    if (request.sessionKey !== sessionKey) continue;
    live.push(request);
    // Claimed, so remove the file; the caller decides what to do with it. The
    // extras are reported as superseded — only `live[0]` is acted on.
    discard(path, { reason: "superseded", request }, undefined);
  }
  if (live.length === 0) return null;
  // Oldest first: it carries the reason the owner is actually waiting on.
  live.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  for (const superseded of live.slice(1)) {
    onDiscard?.({ path: requestPath(superseded.id, requestDir), reason: "superseded", request: superseded });
  }
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
  onDiscard?: OnRestartRequestDiscard,
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
    discard(path, { reason: "expired", request }, onDiscard);
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return request;
}
