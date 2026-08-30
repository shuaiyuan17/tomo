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
  /** Filed by a session of a daemon that is no longer this process. */
  | { reason: "foreign-daemon"; request: RestartRequest }
  /** A restart for this session is already in flight. */
  | { reason: "superseded"; request: RestartRequest }
  /** The daemon is going down on purpose; a restart would resurrect it. */
  | { reason: "shutting-down"; request: RestartRequest };

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
  // Fail closed: a request we cannot attribute to a daemon cannot be shown to
  // belong to THIS one, and acting on it is the spurious-restart bug.
  if (!Number.isInteger(request.daemonPid) || request.daemonPid <= 0) return null;
  return request;
}

/** Remove a request file. False when it was already gone. */
function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Already gone, or not ours to remove — either way there is nothing to do.
    return false;
  }
}

function discard(
  path: string,
  detail: RestartRequestDiscardDetail,
  onDiscard?: OnRestartRequestDiscard,
): void {
  // Only report what we actually removed, so the count a caller logs matches
  // the number of restarts that will not happen.
  if (removeFile(path)) onDiscard?.({ path, ...detail });
}

function listRequestFiles(requestDir: string): string[] {
  try {
    return readdirSync(requestDir).filter((name) => name.endsWith(".json"));
  } catch {
    return []; // No directory yet: no requests.
  }
}

/**
 * Drop every request this daemon can never honour.
 *
 * Called once at daemon startup, and the ONLY thing standing between a
 * previous daemon's pending requests and a spurious restart. A request that
 * was still inside the TTL when its daemon died is otherwise indistinguishable
 * from a live one, so the next daemon's first unrelated turn end would claim
 * it and restart — announcing a reason from before the outage, possibly for a
 * different session entirely. `daemonPid` is what makes them distinguishable:
 * anything not filed by THIS process is gone, whatever its age.
 *
 * Returns the number of files removed, for the startup log.
 */
export function sweepStaleRestartRequests(
  requestDir: string = DEFAULT_REQUEST_DIR,
  now: number = Date.now(),
  onDiscard?: OnRestartRequestDiscard,
  currentDaemonPid: number = process.pid,
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
    if (request.daemonPid !== currentDaemonPid) {
      discard(path, { reason: "foreign-daemon", request }, onDiscard);
      removed += 1;
      continue;
    }
    if (!isExpired(request, now)) continue;
    discard(path, { reason: "expired", request }, onDiscard);
    removed += 1;
  }
  return removed;
}

/** A request file that has been removed from disk and is now ours to decide on. */
interface ClaimedRequest {
  request: RestartRequest;
  /** The path it was actually read from — what a log line should name. */
  path: string;
}

/**
 * Take every request for `sessionKey` off disk, oldest first.
 *
 * Malformed files encountered on the way are discarded and reported; other
 * sessions' requests are left alone (their own session's turn end, or the next
 * startup sweep, deals with them). Reporting the claimed ones is the caller's
 * job, because only the caller knows whether it is about to act on one.
 */
function claimForSession(
  sessionKey: string,
  requestDir: string,
  onDiscard?: OnRestartRequestDiscard,
): ClaimedRequest[] {
  const claimed: ClaimedRequest[] = [];
  for (const name of listRequestFiles(requestDir)) {
    const path = join(requestDir, name);
    const request = readRequest(path);
    if (!request) {
      discard(path, { reason: "malformed" }, onDiscard);
      continue;
    }
    if (request.sessionKey !== sessionKey) continue;
    if (removeFile(path)) claimed.push({ request, path });
  }
  // Oldest first: it carries the reason the owner is actually waiting on.
  claimed.sort((a, b) => Date.parse(a.request.requestedAt) - Date.parse(b.request.requestedAt));
  return claimed;
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
 * EVERY request for the session is claimed, not just the returned one — two
 * `tomo restart` calls in one turn are one restart, and leaving the second
 * file behind would fire it again after the daemon came back. The extras are
 * reported as superseded; the returned one is the caller's to report or act on.
 */
export function takePendingRestartRequest(
  sessionKey: string,
  requestDir: string = DEFAULT_REQUEST_DIR,
  onDiscard?: OnRestartRequestDiscard,
): RestartRequest | null {
  const claimed = claimForSession(sessionKey, requestDir, onDiscard);
  if (claimed.length === 0) return null;
  for (const extra of claimed.slice(1)) {
    onDiscard?.({ path: extra.path, reason: "superseded", request: extra.request });
  }
  return claimed[0].request;
}

/**
 * Claim every request for `sessionKey` and honour none of them.
 *
 * For the two cases where a restart must not happen but the files must not
 * survive either: one is already in flight, or the daemon is deliberately
 * going down. Every claimed request is reported — the whole point is that a
 * restart the owner was promised never disappears without a line saying so.
 * Returns how many were dropped.
 */
export function drainRestartRequests(
  sessionKey: string,
  reason: "superseded" | "shutting-down",
  requestDir: string = DEFAULT_REQUEST_DIR,
  onDiscard?: OnRestartRequestDiscard,
): number {
  const claimed = claimForSession(sessionKey, requestDir, onDiscard);
  for (const { request, path } of claimed) {
    onDiscard?.({ path, reason, request });
  }
  return claimed.length;
}

export interface RestartRequest {
  id: string;
  /**
   * The session that can CLAIM this request — always the one whose shell ran
   * the command, because that is the only session whose turn end and tool
   * results the daemon will match it against.
   */
  sessionKey: string;
  /**
   * PID of the daemon whose session filed this. A request is only actionable
   * by that exact process: once it is gone, nothing is waiting on the promise
   * the CLI printed, and honouring the file on a NEW daemon means a restart
   * out of nowhere at the end of some unrelated turn.
   */
  daemonPid: number;
  reason?: string;
  /**
   * Session the reason is ABOUT, when `tomo restart --session <other>` names
   * one explicitly. Kept apart from `sessionKey` so an explicit attribution
   * cannot file the request under a session that will never claim it.
   */
  attributedSessionKey?: string;
  requestedAt: string;
}

function requestPath(id: string, requestDir: string): string {
  return join(requestDir, `${id}.json`);
}

/** Persist a session-originated restart until its Bash result is observed. */
export function createRestartRequest(
  opts: {
    /** Session whose shell ran the command — the only one that can claim it. */
    sessionKey: string;
    /** Daemon that owns that session, from TOMO_DAEMON_PID. */
    daemonPid: number;
    reason?: string;
    /** Explicit `--session` attribution, when it names a different session. */
    attributedSessionKey?: string;
  },
  requestDir: string = DEFAULT_REQUEST_DIR,
): RestartRequest {
  mkdirSync(requestDir, { recursive: true });
  const request: RestartRequest = {
    id: randomUUID(),
    sessionKey: opts.sessionKey,
    daemonPid: opts.daemonPid,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.attributedSessionKey && opts.attributedSessionKey !== opts.sessionKey
      ? { attributedSessionKey: opts.attributedSessionKey }
      : {}),
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
      // Attribution, not the claim key: an explicit `--session` names where the
      // reason should be delivered, which need not be the session that ran the
      // command. Defaults to the filing session.
      "--session",
      request.attributedSessionKey ?? request.sessionKey,
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
