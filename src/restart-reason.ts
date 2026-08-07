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
 * File format: attributed reasons persist as JSON `{"reason", "sessionKey"}`;
 * unattributed reasons stay plain text, byte-identical to the historical
 * format — so a file written by an older binary (or by hand) still parses on
 * the first boot after an upgrade.
 */

/** Env var naming the session whose SDK child process (and Bash subshells)
 *  is running — the restart CLI reads it to attribute the initiator. */
export const TOMO_SESSION_KEY_ENV = "TOMO_SESSION_KEY";

export interface RestartReason {
  reason: string;
  /** Session key of the initiating session, when attributable. */
  sessionKey?: string;
}

/** Serialize for the reason file: JSON when attributed, legacy plain text
 *  otherwise (keeps unattributed writes byte-identical to the old format). */
export function serializeRestartReason(entry: RestartReason): string {
  return entry.sessionKey
    ? JSON.stringify({ reason: entry.reason, sessionKey: entry.sessionKey })
    : entry.reason;
}

/**
 * Parse reason-file content. Accepts both formats:
 *  - JSON `{"reason": string, "sessionKey"?: string}` (current, attributed)
 *  - plain text (legacy, and current unattributed writes)
 * A JSON-looking payload that doesn't carry a string `reason` falls back to
 * being treated as a plain-text reason. Returns null for blank content.
 */
export function parseRestartReason(raw: string): RestartReason | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { reason?: unknown }).reason === "string") {
        const { reason, sessionKey } = parsed as { reason: string; sessionKey?: unknown };
        if (!reason.trim()) return null;
        return typeof sessionKey === "string" && sessionKey.trim() !== ""
          ? { reason: reason.trim(), sessionKey: sessionKey.trim() }
          : { reason: reason.trim() };
      }
    } catch {
      // Not JSON after all — treat as a legacy plain-text reason that
      // happens to start with "{".
    }
  }
  return { reason: trimmed };
}

export function writeRestartReasonFile(file: string, entry: RestartReason): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeRestartReason(entry), "utf-8");
}

/** Read-and-delete the reason file. Returns null when absent or blank. */
export function consumeRestartReasonFile(file: string): RestartReason | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  try { unlinkSync(file); } catch { /* ignore */ }
  return parseRestartReason(raw);
}
