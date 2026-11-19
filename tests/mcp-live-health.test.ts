import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockSdk, resetConfig } from "./helpers/agent-harness.js";
import { log } from "../src/logger.js";
import { McpHealthMonitor } from "../src/agent/mcp-health.js";
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
  let notifyOwner: ReturnType<typeof vi.fn>;
  let monitor: McpHealthMonitor;
  const failing = vi.fn(async (_server: string) => { throw new Error("still down"); });
  beforeEach(() => {
    now = 1_000_000;
    failing.mockClear();
    notifyOwner = vi.fn(async () => true);
    monitor = new McpHealthMonitor({ notifyOwner, now: () => now, intervalMs: 10 * 60_000, failuresBeforeNotice: 3 });
  });
  const failed = [{ name: "tomo-internal", status: "failed" as const }];
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("N sessions wanting the same server reconnected make one call, and at most one per interval", async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = monitor.beforeTurn("dm:owner", failed, slow);
    const others = [monitor.beforeTurn("telegram:-1", failed, slow), monitor.beforeTurn("telegram:-2", failed, slow)];
    await Promise.all(others); // they skip it rather than run a second call alongside
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
    // Within the interval nobody reconnects it again; after it, one session does.
    await monitor.beforeTurn("telegram:-1", failed, slow);
    expect(slow).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    const again = monitor.beforeTurn("telegram:-1", failed, slow);
    release();
    await again;
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("never reconnects needs-auth, pending or disabled servers", async () => {
    await monitor.beforeTurn("dm:owner", [{ name: "a", status: "needs-auth" }, { name: "b", status: "pending" }, { name: "c", status: "disabled" }, { name: "d", status: "connected" }], failing);
    expect(failing).not.toHaveBeenCalled();
  });

  it("a hung reconnect lets the turn start after the wait, and still counts as running", async () => {
    vi.useFakeTimers();
    try {
      monitor = new McpHealthMonitor({ notifyOwner, now: () => now, intervalMs: 0, preTurnWaitMs: 20_000 });
      const hung = vi.fn(() => new Promise<void>(() => {}));
      const turn = monitor.beforeTurn("dm:owner", failed, hung);
      await vi.advanceTimersByTimeAsync(20_000);
      await turn;
      expect(messages(log.warn)).toContain("MCP reconnect still running; starting the turn anyway");
      await monitor.beforeTurn("dm:owner", failed, hung); // interval 0, but one is still in flight
      expect(hung).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("tells the owner after K failures in a row, once, counted only when delivered", async () => {
    monitor = new McpHealthMonitor({ notifyOwner, now: () => now, intervalMs: 0, failuresBeforeNotice: 3 });
    notifyOwner.mockResolvedValueOnce(false);
    for (let i = 0; i < 2; i++) await monitor.beforeTurn("dm:owner", failed, failing);
    await settle();
    expect(notifyOwner).not.toHaveBeenCalled();
    await monitor.beforeTurn("dm:owner", failed, failing);
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(1); // not delivered
    await monitor.beforeTurn("telegram:-1", failed, failing); // any session counts
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(notifyOwner.mock.calls[1][0]).toContain('MCP server "tomo-internal" is down');
    await monitor.beforeTurn("dm:owner", failed, failing);
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    // A success ends the streak; a new streak can notify again.
    await monitor.reconnectNow("dm:owner", "tomo-internal", async () => {});
    for (let i = 0; i < 3; i++) await monitor.beforeTurn("dm:owner", failed, failing);
    await settle();
    expect(notifyOwner).toHaveBeenCalledTimes(3);
  });

  it("an explicit reconnect waits for a running one instead of overlapping it", async () => {
    let release!: () => void;
    const order: string[] = [];
    const auto = monitor.beforeTurn("dm:owner", failed, () => new Promise<void>((resolve) => { release = () => { order.push("auto done"); resolve(); }; }));
    const manual = monitor.reconnectNow("telegram:-1", "tomo-internal", async () => { order.push("manual start"); });
    await settle();
    expect(order).toEqual([]);
    release();
    await Promise.all([auto, manual]);
    expect(order).toEqual(["auto done", "manual start"]);
  });

  it("logs only state changes", async () => {
    monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "init");
    expect(messages(log.info)).toContain("MCP servers reported by live session");
    const before = (log.info as ReturnType<typeof vi.fn>).mock.calls.length;
    monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "status-read");
    expect((log.info as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    monitor.observe("dm:owner", [{ name: "docs", status: "failed" }], "status-read");
    expect(messages(log.warn)).toContain("MCP server disconnected");
    monitor.observe("dm:owner", [{ name: "docs", status: "connected" }], "status-read");
    expect(messages(log.info)).toContain("MCP server connected");
    monitor.sessionClosed("dm:owner");
    expect(messages(log.info)).toContain("MCP connections closed with live session");
  });
});

describe("MCP reconnect in a live session", () => {
  const owner = () => resetConfig({ identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }] });

  it("reconnects before the turn, and the turn waits for it; status reads and init never reconnect", async () => {
    owner();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "hello" }));
    await drainQueue(agent);

    // The SDK reporting a failure on its own (init) or on a read starts nothing.
    mockSdk.mcpStatus = [{ name: "tomo-internal", status: "connected" }, { name: "docs", status: "failed" }];
    mockSdk.queryControllers[0].pushEvent({ type: "system", subtype: "init", mcp_servers: [{ name: "docs", status: "failed" }] });
    await agent.readMcpStatuses();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSdk.mcpReconnects).toEqual([]);

    const promptsWhenReconnected: string[][] = [];
    mockSdk.onMcpReconnect = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      promptsWhenReconnected.push(mockSdk.promptsBySession.map((p) => p.text));
    };
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "again" }));
    await drainQueue(agent);
    expect(mockSdk.mcpReconnects).toEqual(["docs"]);
    // Serialized: the reconnect finished before the turn's prompt reached the SDK.
    expect(promptsWhenReconnected).toHaveLength(1);
    expect(promptsWhenReconnected[0].some((text) => text.includes("again"))).toBe(false);
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("again"))).toBe(true);
    await agent.stop();
  });

  it("an explicit reconnect is refused while a turn runs, and a turn waits for one that is running", async () => {
    owner();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "hello" }));
    await drainQueue(agent);

    // A turn in flight: busy.
    let finishTurn!: () => void;
    mockSdk.responseFn = () => new Promise<string>((resolve) => { finishTurn = () => resolve("done"); });
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "long one" }));
    await vi.waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.text.includes("long one"))).toBe(true));
    expect(await agent.reconnectOwnerMcpServer("docs")).toBe("busy");
    expect(mockSdk.mcpReconnects).toEqual([]);
    finishTurn();
    await drainQueue(agent);
    mockSdk.responseFn = () => "ok";

    // Idle: it runs, and a turn arriving meanwhile waits for it.
    let releaseReconnect!: () => void;
    mockSdk.onMcpReconnect = () => new Promise<void>((resolve) => { releaseReconnect = resolve; });
    const manual = agent.reconnectOwnerMcpServer("docs");
    await vi.waitFor(() => expect(mockSdk.mcpReconnects).toEqual(["docs"]));
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "during" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("during"))).toBe(false);
    releaseReconnect();
    expect(await manual).toBe("reconnected");
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("during"))).toBe(true);
    await agent.stop();
  });
});
