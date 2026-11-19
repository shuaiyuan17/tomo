export type McpConnectionState = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
export interface McpConnection { name: string; status: McpConnectionState }

const STATES: ReadonlySet<string> = new Set<McpConnectionState>(["connected", "failed", "needs-auth", "pending", "disabled"]);

/**
 * Bounded, validated connection rows from an SDK status list (the answer to
 * `mcpServerStatus()`, or a system/init message's `mcp_servers`). Only the
 * name and state survive: no config, OAuth or error text. Null when the
 * value is not a list at all.
 */
export function sanitizeMcpConnections(raw: unknown): McpConnection[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 128).flatMap((item): McpConnection[] => {
    if (!item || typeof item !== "object") return [];
    const { name, status } = item as { name?: unknown; status?: unknown };
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(name) || typeof status !== "string" || !STATES.has(status)) return [];
    return [{ name, status: status as McpConnectionState }];
  });
}

/** Only SDK-reported health is health. No probe, OAuth flow, config, or error
 * text is exposed. A hung query has at most one outstanding request. */
export class McpLiveStatus {
  private pending?: Promise<McpConnection[] | null>;
  constructor(private readonly query: { mcpServerStatus?: () => Promise<unknown> }) {}
  async read(timeoutMs = 1000): Promise<McpConnection[] | null> {
    if (!this.query.mcpServerStatus) return null;
    this.pending ??= Promise.resolve().then(() => this.query.mcpServerStatus!()).then(sanitizeMcpConnections)
      .catch(() => null).finally(() => { this.pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.pending, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
}
