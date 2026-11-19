import type { McpConnection, McpConnectionState } from "./live-status.js";
import type { ExternalMcpServerStatus } from "./oauth.js";

/**
 * One session's SDK-reported connections: a list when the live session
 * answered, `null` when it is live but did not answer (timed out, or an SDK
 * without `mcpServerStatus`), `undefined` when there is no live session.
 */
export type McpLiveRead = McpConnection[] | null | undefined;

/** What the live session says about a server, or why it says nothing. */
export type McpLiveLabel = McpConnectionState | "no-live-session" | "unknown" | "not-reported";

/** Tomo's own OAuth bookkeeping for a configured OAuth server. */
export type McpOAuthLabel = "ready" | "login-required" | "auth-pending" | "auth-failed";

export interface MergedMcpStatus {
  name: string;
  /** In config.json (an external server) rather than only reported by the session (tomo-internal, plugins). */
  configured: boolean;
  live: McpLiveLabel;
  oauth?: { state: McpOAuthLabel; expiresAt?: number; lastError?: string };
  /** What would fix it: sign in again, or reconnect. */
  action?: "login" | "reconnect";
}

/** Tomo's OAuth bookkeeping for one configured server, as a single label. */
export function oauthLabel(status: ExternalMcpServerStatus): McpOAuthLabel {
  if (status.state === "auth-pending") return "auth-pending";
  if (status.state === "auth-failed") return "auth-failed";
  return status.authRequired ? "login-required" : "ready";
}

/**
 * The live session's real connection state, merged with tomo's OAuth state.
 * Connection health comes ONLY from the SDK: "mounted" is never reported as
 * "connected", and with no live session every row says so rather than guess.
 * Configured servers come first in config order, then servers only the
 * session reports (tomo-internal among them), by name.
 */
export function mergeMcpStatus(live: McpLiveRead, configured: readonly ExternalMcpServerStatus[]): MergedMcpStatus[] {
  const byName = new Map((live ?? []).map((connection) => [connection.name, connection.status]));
  const liveLabel = (name: string): McpLiveLabel =>
    live === undefined ? "no-live-session" : live === null ? "unknown" : byName.get(name) ?? "not-reported";
  const rows: MergedMcpStatus[] = configured.map((status) => {
    const state = liveLabel(status.name);
    const oauth = status.oauth ? {
      state: oauthLabel(status),
      ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
    } : undefined;
    const needsLogin = state === "needs-auth" || oauth?.state === "login-required" || oauth?.state === "auth-failed";
    const action = needsLogin ? "login" as const : state === "failed" ? "reconnect" as const : undefined;
    return { name: status.name, configured: true, live: state, ...(oauth ? { oauth } : {}), ...(action ? { action } : {}) };
  });
  const known = new Set(configured.map((status) => status.name));
  for (const name of [...byName.keys()].filter((name) => !known.has(name)).sort()) {
    const state = byName.get(name)!;
    // `/mcp login` only knows configured servers; a session-only one can still be reconnected.
    rows.push({ name, configured: false, live: state, ...(state === "failed" ? { action: "reconnect" as const } : {}) });
  }
  return rows;
}
