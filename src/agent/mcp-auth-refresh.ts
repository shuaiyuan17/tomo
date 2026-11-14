/** Recognising MCP authorization failures and the per-session refresh rate limit. */

import { log } from "../logger.js";

/** What the host's refresh attempt did. Mirrors McpOAuthManager's outcomes. */
export type McpAuthRefreshOutcome = "refreshed" | "failed" | "skipped" | "superseded";

/**
 * How many token exchanges one session may trigger from tool errors, per
 * server, within MCP_AUTH_REFRESH_WINDOW_MS.
 *
 * A RATE, not a lifetime quota. Its job is to bound the damage when
 * `isMcpAuthErrorText` misreads an unrelated upstream error — each refresh
 * re-mounts the server, so an unbounded path would exchange a token per
 * failing tool call. A lifetime quota would do that too, but it would also
 * strand a long-lived session permanently: a token stored without `expiresAt`
 * is invisible to the proactive sweep (`isExpiring` is false for it), so this
 * backstop is the ONLY thing that can renew it, and a session outliving the
 * quota would never recover.
 */
export const MAX_MCP_AUTH_REFRESHES_PER_WINDOW = 3;
export const MCP_AUTH_REFRESH_WINDOW_MS = 60 * 60 * 1000;

/**
 * Does a failed MCP tool result look like an expired/rejected access token?
 * Matched on the strings the CLI and MCP servers actually emit for 401s.
 * Kept narrow: a false positive spends one pointless token refresh.
 */
export function isMcpAuthErrorText(text: string): boolean {
  return /\b401\b|unauthoriz(?:ed|ation)|re-?authoriz|invalid_token|token (?:has )?expired/i.test(text);
}

/** `mcp__<server>__<tool>` → `<server>`, or null for a non-MCP tool name. */
export function mcpServerFromToolName(name: string | undefined): string | null {
  if (!name?.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const server = sep === -1 ? rest : rest.slice(0, sep);
  return server.length > 0 ? server : null;
}

/** One LiveSession's MCP auth-error reporting and its refresh rate window. */
export class McpAuthRefresher {
  /** Servers with a refresh attempt in flight — no duplicate concurrent asks. */
  private mcpAuthRefreshInFlight = new Set<string>();
  /** Per-server timestamps of exchanges actually triggered, pruned to the window. */
  private mcpAuthRefreshAttempts = new Map<string, number[]>();

  constructor(
    private readonly onMcpAuthError: ((serverName: string) => Promise<McpAuthRefreshOutcome> | McpAuthRefreshOutcome) | undefined,
    private readonly now: () => number,
  ) {}

  /**
   * A mounted MCP server just rejected a tool call for authorization reasons —
   * with harness-managed OAuth that means the Bearer token baked into this
   * session at build time has expired. Tell the host once per server so it can
   * refresh and re-mount; a repeat inside the same session would only queue
   * duplicate refreshes behind the first one.
   */
  report(toolName: string | undefined, resultText: string): void {
    const notify = this.onMcpAuthError;
    if (!notify) return;
    const serverName = mcpServerFromToolName(toolName);
    if (!serverName || !isMcpAuthErrorText(resultText)) return;
    if (this.mcpAuthRefreshInFlight.has(serverName)) return;
    if (this.recentMcpAuthRefreshes(serverName).length >= MAX_MCP_AUTH_REFRESHES_PER_WINDOW) return;

    this.mcpAuthRefreshInFlight.add(serverName);
    log.info({ serverName, tool: toolName }, "MCP tool rejected for authorization; requesting a token refresh");
    void (async () => {
      try {
        const outcome = await notify(serverName);
        // Charged only for an exchange that actually happened. `skipped`
        // (a login owns the credential, or there is nothing to refresh) and
        // `superseded` (a newer record landed first, and its own writer
        // already re-mounted) leave the budget untouched, so a transient
        // token-endpoint failure or a 401 during /mcp login does not cost
        // this session its ability to recover later.
        if (outcome === "refreshed" || outcome === "failed") this.chargeMcpAuthRefresh(serverName);
        log.info({ serverName, outcome }, "MCP token refresh after an auth error settled");
      } catch (err) {
        this.chargeMcpAuthRefresh(serverName);
        log.warn({ serverName, err }, "MCP auth-error notification threw");
      } finally {
        this.mcpAuthRefreshInFlight.delete(serverName);
      }
    })();
  }

  /** This server's exchanges inside the rate window, pruning older ones. */
  private recentMcpAuthRefreshes(serverName: string): number[] {
    const cutoff = this.now() - MCP_AUTH_REFRESH_WINDOW_MS;
    const recent = (this.mcpAuthRefreshAttempts.get(serverName) ?? []).filter((at) => at > cutoff);
    this.mcpAuthRefreshAttempts.set(serverName, recent);
    return recent;
  }

  private chargeMcpAuthRefresh(serverName: string): void {
    this.recentMcpAuthRefreshes(serverName).push(this.now());
  }
}
