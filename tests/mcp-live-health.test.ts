import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockSdk, resetConfig } from "./helpers/agent-harness.js";
import { log } from "../src/logger.js";
import { McpHealthMonitor, MCP_AUTO_RECONNECT_BASE_BACKOFF_MS } from "../src/agent/mcp-health.js";
import { mergeMcpStatus } from "../src/mcp/status-merge.js";
import { sanitizeMcpConnections } from "../src/mcp/live-status.js";
import type { ExternalMcpServerStatus } from "../src/mcp/oauth.js";

installAgentTestHooks();

const messages = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);

describe("mergeMcpStatus", () => {
  const configured: ExternalMcpServerStatus[] = [
    { name: "docs", state: "connected", oauth: false, mounted: true },
    { name: "drive", state: "not-mounted", oauth: true, mounted: false, authRequired: true },
    { name: "mail", state: "connected", oauth: true, mounted: true, authRequired: false, expiresAt: 5_000 },
  ];

  it("takes connection state from the live session and OAuth state from tomo", () => {
    const rows = mergeMcpStatus([
      { name: "docs", status: "failed" },
      { name: "drive", status: "needs-auth" },
      { name: "mail", status: "connected" },
      { name: "tomo-internal", status: "connected" },
    ], configured);
    expect(rows).toEqual([
      // Mounted, but the SDK says failed: failed it is.
      { name: "docs", configured: true, live: "failed", action: "reconnect" },
      { name: "drive", configured: true, live: "needs-auth", oauth: { state: "login-required" }, action: "login" },
      { name: "mail", configured: true, live: "connected", oauth: { state: "ready", expiresAt: 5_000 } },
      { name: "tomo-internal", configured: false, live: "connected" },
    ]);
  });

  it("labels every row 'no live session' rather than guess, and 'unknown' when the session did not answer", () => {
    expect(mergeMcpStatus(undefined, configured).map((row) => row.live)).toEqual(["no-live-session", "no-live-session", "no-live-session"]);
    expect(mergeMcpStatus(null, configured).map((row) => row.live)).toEqual(["unknown", "unknown", "unknown"]);
    // A configured server the session does not report is not loaded there.
    expect(mergeMcpStatus([], configured)[0]).toMatchObject({ live: "not-reported" });
    // OAuth still shows without a session.
    expect(mergeMcpStatus(undefined, configured)[1]).toMatchObject({ oauth: { state: "login-required" }, action: "login" });
  });

  it("init's mcp_servers is sanitized like the status call", () => {
    expect(sanitizeMcpConnections([{ name: "a", status: "failed", error: "secret", config: { url: "x" } }, { name: "b c", status: "connected" }, { name: "c", status: "weird" }]))
      .toEqual([{ name: "a", status: "failed" }]);
    expect(sanitizeMcpConnections("nope")).toBeNull();
  });
});

describe("McpHealthMonitor", () => {
  let now = 1_000_000;
  let reconnect: ReturnType<typeof vi.fn>;
  let notifyOwner: ReturnType<typeof vi.fn>;
  let monitor: McpHealthMonitor;
  beforeEach(() => {
    now = 1_000_000;
    reconnect = vi.fn(async () => { throw new Error("still down"); });
    notifyOwner = vi.fn(async () => true);
    monitor = new McpHealthMonitor({ reconnect, notifyOwner, now: () => now, maxAttemptsPerHour: 3 });
  });
  const failed = [{ name: "tomo-internal", status: "failed" as const }];

  it("reconnects a failed server with backoff, at most N times an hour, then tells the owner once", async () => {
    await monitor.observe("dm:owner", failed, "init");
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenLastCalledWith("dm:owner", "tomo-internal");
    // Inside the backoff: no new attempt, however often the status arrives.
    for (let i = 0; i < 5; i++) await monitor.observe("dm:owner", failed, "pre-turn");
    expect(reconnect).toHaveBeenCalledTimes(1);
    now += MCP_AUTO_RECONNECT_BASE_BACKOFF_MS;
    await monitor.observe("dm:owner", failed, "pre-turn");
    expect(reconnect).toHaveBeenCalledTimes(2);
    // The backoff doubles.
    now += MCP_AUTO_RECONNECT_BASE_BACKOFF_MS;
    await monitor.observe("dm:owner", failed, "pre-turn");
    expect(reconnect).toHaveBeenCalledTimes(2);
    now += MCP_AUTO_RECONNECT_BASE_BACKOFF_MS;
    await monitor.observe("dm:owner", failed, "pre-turn");
    expect(reconnect).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    expect(notifyOwner.mock.calls[0][0]).toContain('MCP server "tomo-internal" is down');
    // Capped: no fourth attempt within the hour, and no second notice.
    for (let i = 0; i < 10; i++) { now += 10 * 60_000 / 10; await monitor.observe("dm:owner", failed, "status-read"); }
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    // An hour after the first attempt the budget comes back.
    now = 1_000_000 + 60 * 60_000 + 1;
    await monitor.observe("dm:owner", failed, "status-read");
    expect(reconnect).toHaveBeenCalledTimes(4);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect needs-auth, pending or disabled servers", async () => {
    await monitor.observe("dm:owner", [{ name: "a", status: "needs-auth" }, { name: "b", status: "pending" }, { name: "c", status: "disabled" }, { name: "d", status: "connected" }], "init");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("a success is logged and recorded; one attempt runs at a time", async () => {
    let release!: () => void;
    reconnect.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = monitor.observe("dm:owner", failed, "init");
    const second = monitor.observe("dm:owner", failed, "status-read");
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(monitor.stateOf("dm:owner", "tomo-internal")).toBe("connected");
    expect(messages(log.info)).toContain("MCP reconnect succeeded");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("logs connect, disconnect and close", async () => {
    await monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "init");
    expect(messages(log.info)).toContain("MCP servers reported by live session");
    await monitor.observe("dm:owner", [{ name: "docs", status: "failed" }], "pre-turn");
    expect(messages(log.warn)).toContain("MCP server disconnected");
    await monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "pre-turn");
    expect(messages(log.info)).toContain("MCP server connected");
    monitor.sessionClosed("dm:owner");
    expect(messages(log.info)).toContain("MCP connections closed with live session");
    expect(monitor.stateOf("dm:owner", "docs")).toBeUndefined();
  });

  it("an explicit reconnect is outside the automatic budget", async () => {
    reconnect.mockResolvedValue(undefined);
    expect(await monitor.reconnectNow("dm:owner", "docs")).toBe(true);
    reconnect.mockRejectedValue(new Error("no"));
    expect(await monitor.reconnectNow("dm:owner", "docs")).toBe(false);
    expect(messages(log.warn)).toContain("MCP reconnect failed");
  });
});

describe("automatic MCP recovery in a live session", () => {
  it("reconnects a server system/init reports failed, and checks again before a later turn", async () => {
    resetConfig({ identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "hello" }));
    await drainQueue(agent);
    expect(mockSdk.mcpReconnects).toEqual([]);

    // The SDK's own report: the in-process server dropped.
    mockSdk.queryControllers[0].pushEvent({ type: "system", subtype: "init", mcp_servers: [{ name: "tomo-internal", status: "failed" }] });
    await vi.waitFor(() => expect(mockSdk.mcpReconnects).toEqual(["tomo-internal"]));

    // Before the next turn: the status call says another server failed.
    mockSdk.mcpStatus = [{ name: "tomo-internal", status: "connected" }, { name: "docs", status: "failed" }];
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "again" }));
    await drainQueue(agent);
    expect(mockSdk.mcpReconnects).toEqual(["tomo-internal", "docs"]);
    await agent.stop();
  });
});
