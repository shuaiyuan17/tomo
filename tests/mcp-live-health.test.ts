import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockSdk, resetConfig } from "./helpers/agent-harness.js";
import { log } from "../src/logger.js";
import { McpHealthMonitor, MCP_AUTO_RECONNECT_BASE_BACKOFF_MS, MCP_DEFERRED_RECHECK_MS } from "../src/agent/mcp-health.js";
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
  const T0 = 1_000_000_000_000;
  let reconnect: ReturnType<typeof vi.fn>;
  let notifyOwner: ReturnType<typeof vi.fn>;
  let busy: Set<string>;
  let monitor: McpHealthMonitor;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    busy = new Set();
    reconnect = vi.fn(async () => { throw new Error("still down"); });
    notifyOwner = vi.fn(async () => true);
    monitor = new McpHealthMonitor({ reconnect, notifyOwner, isIdle: (key) => !busy.has(key), maxAttemptsPerHour: 3 });
  });
  afterEach(() => { monitor.stop(); vi.useRealTimers(); });
  const failed = [{ name: "tomo-internal", status: "failed" as const }];
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("retries on a timer with backoff even if nothing else happens, caps per hour, and tells the owner once", async () => {
    await monitor.observe("dm:owner", failed, "init");
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Status arriving inside the backoff does not add attempts.
    for (let i = 0; i < 5; i++) await monitor.observe("dm:owner", failed, "pre-turn");
    expect(reconnect).toHaveBeenCalledTimes(1);
    // No further status at all: the timer retries.
    await vi.advanceTimersByTimeAsync(MCP_AUTO_RECONNECT_BASE_BACKOFF_MS);
    expect(reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MCP_AUTO_RECONNECT_BASE_BACKOFF_MS); // doubled: not yet
    expect(reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MCP_AUTO_RECONNECT_BASE_BACKOFF_MS);
    expect(reconnect).toHaveBeenCalledTimes(3);
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0][0]).toContain('MCP server "tomo-internal" is down');
    // Capped for the rest of the hour, and no second notice.
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await monitor.observe("dm:owner", failed, "status-read");
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    // An hour after the first round it leaves the window: the budget returns.
    await vi.advanceTimersByTimeAsync(T0 + HOUR - Date.now());
    expect(reconnect).toHaveBeenCalledTimes(4);
  });

  it("the budget is per server across sessions, and closing a session does not reset it", async () => {
    busy.add("dm:owner"); busy.add("telegram:-1");
    await monitor.observe("dm:owner", failed, "init");
    await monitor.observe("telegram:-1", failed, "init");
    busy.clear();
    await vi.advanceTimersByTimeAsync(MCP_DEFERRED_RECHECK_MS);
    // One round reconnects it in both sessions, and counts once.
    expect(reconnect.mock.calls).toEqual([["dm:owner", "tomo-internal"], ["telegram:-1", "tomo-internal"]]);
    monitor.sessionClosed("telegram:-1");
    await monitor.observe("telegram:-2", failed, "init");
    expect(reconnect).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(MCP_AUTO_RECONNECT_BASE_BACKOFF_MS * 4);
    // 3 rounds in the hour, whatever the number of sessions.
    expect(reconnect.mock.calls.filter(([key]) => key === "dm:owner")).toHaveLength(3);
  });

  it("never reconnects under a running turn: it waits for the session to be idle", async () => {
    busy.add("dm:owner");
    await monitor.observe("dm:owner", failed, "status-read");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reconnect).not.toHaveBeenCalled();
    busy.delete("dm:owner");
    reconnect.mockResolvedValue(undefined);
    monitor.sessionIdle("dm:owner");
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(monitor.stateOf("dm:owner", "tomo-internal")).toBe("connected");
  });

  it("counts the notice cooldown only once the notice was delivered", async () => {
    notifyOwner.mockResolvedValueOnce(false);
    monitor = new McpHealthMonitor({ reconnect, notifyOwner, isIdle: () => true, maxAttemptsPerHour: 1 });
    await monitor.observe("dm:owner", failed, "init");
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    await monitor.observe("dm:owner", failed, "status-read");
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    await monitor.observe("dm:owner", failed, "status-read");
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("does not apply a reconnect result to a session that replaced the one asked", async () => {
    let release!: () => void;
    reconnect.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = monitor.observe("dm:owner", failed, "init");
    await settle();
    monitor.sessionClosed("dm:owner");
    void monitor.observe("dm:owner", failed, "init"); // the replacement, also failing; the round is still in flight
    release();
    await pending;
    expect(monitor.stateOf("dm:owner", "tomo-internal")).toBe("failed");
  });

  it("does not reconnect needs-auth, pending or disabled servers", async () => {
    await monitor.observe("dm:owner", [{ name: "a", status: "needs-auth" }, { name: "b", status: "pending" }, { name: "c", status: "disabled" }, { name: "d", status: "connected" }], "init");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("logs connect, disconnect and close", async () => {
    reconnect.mockResolvedValue(undefined);
    await monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "init");
    expect(messages(log.info)).toContain("MCP servers reported by live session");
    busy.add("dm:owner");
    await monitor.observe("dm:owner", [{ name: "docs", status: "failed" }], "status-read");
    expect(messages(log.warn)).toContain("MCP server disconnected");
    await monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "status-read");
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

const HOUR = 60 * 60_000;

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
    // The turn must not start until the reconnect has finished.
    const promptsWhenReconnected: string[][] = [];
    mockSdk.onMcpReconnect = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      promptsWhenReconnected.push(mockSdk.promptsBySession.map((p) => p.text));
    };
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "again" }));
    await drainQueue(agent);
    expect(mockSdk.mcpReconnects).toEqual(["tomo-internal", "docs"]);
    expect(promptsWhenReconnected).toHaveLength(1);
    expect(promptsWhenReconnected[0].some((text) => text.includes("again"))).toBe(false);
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("again"))).toBe(true);
    await agent.stop();
  });
});
