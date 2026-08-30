import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Restart-reason persistence with initiator attribution.
 *
 * A restart reason often encodes "what I was doing and should resume", so on
 * boot it must be delivered to the session that initiated the restart — and
 * only there. Delivering it anywhere else both leaks that session's context
 * (worst case: private DM context into a group) and reads to the receiving
 * session like its own pending work.
 *
 * Attribution rides an env var: every live session's SDK child process is
 * spawned with TOMO_SESSION_KEY=<its session key> (see buildSdkEnv in
 * agent/sdk-options.ts), which the Bash tool inherits — so a `tomo restart
 * --reason ...` run from any session's shell knows its initiator with zero
 * model cooperation. Restarts with no attributable initiator (auto-update
 * from a terminal, a human typing `tomo restart`) stay unattributed and keep
 * the legacy delivery to the current blessed session.
 *
 * On-disk format: the reason file itself is ALWAYS plain text — identical to
 * the historical format in both directions, so an old binary reading a
 * new-binary file (rollback) and a new binary reading an old-binary file
 * (upgrade) are each trivially correct by construction. Attribution lives in
 * a sidecar file (`<reason-file>.session`) that only new binaries know
 * about. The sidecar echoes the reason text it was written for: an old
 * binary never cleans the sidecar up, so after a rollback a stale sidecar
 * could otherwise attach itself to a *different* reason written later — the
 * echo check degrades that case (and any missing/empty/garbage sidecar) to
 * an unattributed reason, never to a crash and never to a wrong session.
 */

/** Env var naming the session whose SDK child process (and Bash subshells)
 *  is running — the restart CLI reads it to attribute the initiator. */
export const TOMO_SESSION_KEY_ENV = "TOMO_SESSION_KEY";

/**
 * Env var carrying the PID of the daemon that spawned the session.
 *
 * Attribution (TOMO_SESSION_KEY) and liveness are different questions, and
 * the deferred-restart path needs the second one. An env var is inherited by
 * everything downstream and outlives its daemon: a `tomo restart` typed into
 * a terminal that once inherited a session's environment, or run by a script
 * that captured it, still carries a plausible session key. Deferring there
 * means writing a request file that no live daemon is watching, printing
 * "restart scheduled", and never restarting.
 *
 * Pairing the key with the spawning daemon's PID makes the claim checkable
 * against the pidfile: same PID and still running means a daemon that can
 * actually observe the request is the one that stamped this environment.
 */
export const TOMO_DAEMON_PID_ENV = "TOMO_DAEMON_PID";

export interface RestartReason {
  reason: string;
  /** Session key of the initiating session, when attributable. */
  sessionKey?: string;
}

/** Attribution sidecar path for a reason file. */
export function restartReasonSessionFile(reasonFile: string): string {
  return `${reasonFile}.session`;
}

/** Resolve the initiator for a CLI-invoked restart: an explicit --session
 *  value wins, else the TOMO_SESSION_KEY the daemon stamped into the
 *  invoking session's shell. Undefined (terminal, auto-update) = unattributed. */
export function resolveRestartInitiator(
  explicitSession: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitSession?.trim() || env[TOMO_SESSION_KEY_ENV]?.trim() || undefined;
}

/** Persist a restart reason: plain-text reason file (always), plus the
 *  attribution sidecar when a session key is known. An unattributed write
 *  removes any stale sidecar so it can never attach to the new reason. */
export function writeRestartReasonFile(file: string, entry: RestartReason): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, entry.reason, "utf-8");
  const sidecar = restartReasonSessionFile(file);
  if (entry.sessionKey) {
    writeFileSync(sidecar, JSON.stringify({ sessionKey: entry.sessionKey, reason: entry.reason }), "utf-8");
  } else {
    removeQuietly(sidecar);
  }
}

/**
 * Read-and-delete the reason file and its attribution sidecar. Returns null
 * when the reason is absent or blank (an orphaned sidecar is cleaned up
 * regardless). Attribution is best-effort: a missing, unreadable, malformed,
 * or reason-mismatched sidecar degrades to an unattributed reason.
 */
export function consumeRestartReasonFile(file: string): RestartReason | null {
  const sidecar = restartReasonSessionFile(file);
  const rawReason = readQuietly(file);
  const rawSidecar = readQuietly(sidecar);
  removeQuietly(file);
  removeQuietly(sidecar);

  const reason = rawReason?.trim();
  if (!reason) return null;

  const sessionKey = sidecarSessionKey(rawSidecar, reason);
  return sessionKey ? { reason, sessionKey } : { reason };
}

/** Extract the attributed session key from sidecar content, or undefined for
 *  anything less than a well-formed sidecar whose reason echo matches. */
function sidecarSessionKey(rawSidecar: string | null, reason: string): string | undefined {
  if (!rawSidecar) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawSidecar);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { sessionKey, reason: echo } = parsed as { sessionKey?: unknown; reason?: unknown };
    if (typeof sessionKey !== "string" || typeof echo !== "string") return undefined;
    // Stale-sidecar guard: only honor attribution written for THIS reason.
    if (echo.trim() !== reason) return undefined;
    const key = sessionKey.trim();
    // Session keys never contain whitespace; anything else is garbage.
    return key !== "" && !/\s/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

function readQuietly(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}
