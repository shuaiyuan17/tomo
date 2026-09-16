export type McpConnectionState = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
export interface McpConnection { name: string; status: McpConnectionState }
/** Only SDK-reported health is health. No probe, OAuth flow, config, or error
 * text is exposed. A hung query has at most one outstanding request. */
export class McpLiveStatus {
  private pending?: Promise<McpConnection[] | null>;
  constructor(private readonly query: { mcpServerStatus?: () => Promise<unknown> }) {}
  async read(timeoutMs = 1000): Promise<McpConnection[] | null> {
    if (!this.query.mcpServerStatus) return null;
    this.pending ??= Promise.resolve().then(() => this.query.mcpServerStatus!()).then((raw) => {
      if (!Array.isArray(raw)) return null;
      return raw.slice(0, 128).flatMap((item): McpConnection[] => {
        if (!item || typeof item !== "object" || typeof item.name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(item.name)
          || !["connected", "failed", "needs-auth", "pending", "disabled"].includes(item.status)) return [];
        return [{ name: item.name, status: item.status as McpConnectionState }];
      });
    }).catch(() => null).finally(() => { this.pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.pending, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
}
