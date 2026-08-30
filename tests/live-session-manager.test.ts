import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — a controllable LiveSession double so the manager's lifecycle
// and retry policy can be tested without the SDK.
// ---------------------------------------------------------------------------

interface FakeSession {
  key: string;
  settings: Record<string, unknown>;
  closed: boolean;
  busy: boolean;
  lastResult: unknown;
  sessionId: string | null;
  releaseIdle(): void;
  isAlive(): boolean;
  isBusy(): boolean;
  close(): void;
  waitForIdle(): Promise<void>;
  getSessionId(): string | null;
  setMcpServers(servers: Record<string, unknown>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  } | null>;
  send(prompt: string, images?: unknown, documents?: unknown, onBlock?: (b: string) => void | Promise<void>): Promise<string>;
  steer(prompt: string, images?: unknown, documents?: unknown, onBlock?: (b: string) => void | Promise<void>): Promise<string>;
}

const { mockState } = vi.hoisted(() => ({
  mockState: {
    instances: [] as FakeSession[],
    sendImpl: null as null | ((
      prompt: string,
      session: FakeSession,
      onBlock?: (b: string) => void | Promise<void>,
    ) => Promise<string>),
    mcpSetCalls: [] as Array<{ session: FakeSession; servers: Record<string, unknown> }>,
    mcpSetImpl: null as null | ((servers: Record<string, unknown>, session: FakeSession) => Promise<{
      added: string[];
      removed: string[];
      errors: Record<string, string>;
    } | null>),
    compactTriggered: false,
  },
}));

vi.mock("../src/agent/live-session.js", () => {
  class FakeLiveSession implements FakeSession {
    key: string;
    closed = false;
    busy = false;
    lastResult: unknown = null;
    sessionId: string | null = "sdk-1";
    private idleResolvers: Array<() => void> = [];

    settings: Record<string, unknown>;

    constructor(_opts: unknown, key: string, _b?: unknown, _f?: unknown, settings: Record<string, unknown> = {}) {
      this.key = key;
      this.settings = settings;
      mockState.instances.push(this);
    }
    releaseIdle() { for (const r of this.idleResolvers.splice(0)) r(); }
    isAlive() { return !this.closed; }
    isBusy() { return this.busy; }
    close() { this.closed = true; }
    waitForIdle() { return new Promise<void>((r) => this.idleResolvers.push(r)); }
    getSessionId() { return this.sessionId; }
    async setMcpServers(servers: Record<string, unknown>) {
      mockState.mcpSetCalls.push({ session: this, servers });
      const result = mockState.mcpSetImpl
        ? await mockState.mcpSetImpl(servers, this)
        : { added: Object.keys(servers), removed: [], errors: {} };
      // The real control request dies with its session: closing the query
      // while a request is outstanding never delivers a response.
      if (this.closed) throw new Error("Session is closed");
      return result;
    }
    async send(prompt: string, _i?: unknown, _d?: unknown, onBlock?: (b: string) => void | Promise<void>) {
      return mockState.sendImpl ? mockState.sendImpl(prompt, this, onBlock) : "ok";
    }
    async steer(prompt: string, _i?: unknown, _d?: unknown, onBlock?: (b: string) => void | Promise<void>) {
      return mockState.sendImpl ? mockState.sendImpl(prompt, this, onBlock) : "steered";
    }
  }
  return {
    LiveSession: FakeLiveSession,
    QUERY_TIMEOUT_ERROR_PREFIX: "Query timed out after",
    STEER_MERGED: "",
    DELIVERY_TIMEOUT_MS: 60_000,
    MAX_TURNS_RESPONSE: "I ran out of steps trying to complete that. Can you try a simpler request?",
    SdkResultError: class SdkResultError extends Error {
      constructor(message: string, readonly subtype: string, readonly errors: string[] = []) {
        super(message);
        this.name = "SdkResultError";
      }
    },
  };
});

vi.mock("../src/agent/sdk-options.js", () => ({
  makeTurnBudget: () => ({}),
  sdkOptions: () => ({ model: "test-model" }),
}));

vi.mock("../src/config.js", () => ({
  config: { sdkSessionsDir: "/tmp/sdk-sessions", liveSessionTimeoutMs: 1000 },
}));

vi.mock("../src/sessions/repair.js", () => ({
  repairSdkSessionForResume: vi.fn(() => ({})),
}));

vi.mock("../src/lcm/index.js", () => ({
  checkAndClearCompactTrigger: vi.fn(() => mockState.compactTriggered),
}));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LiveSessionManager, SHUTDOWN_FLUSH_TIMEOUT_MS, SHUTDOWN_NOT_PROCESSED } = await import("../src/agent/live-session-manager.js");
const { log } = await import("../src/logger.js");
const { SdkResultError } = await import("../src/agent/live-session.js");
type Deps = ConstructorParameters<typeof LiveSessionManager>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    buildSystemPrompt: () => "prompt-v1",
    getSdkSessionId: vi.fn(() => undefined),
    setSdkSessionId: vi.fn(),
    clearSdkSessionId: vi.fn(),
    retireSdkSessionId: vi.fn(),
    updateStats: vi.fn(),
    getSessionMessages: () => [],
    getModelOverride: () => undefined,
    createInternalMcpServer: () => ({} as ReturnType<Deps["createInternalMcpServer"]>),
    buildExternalMcpServers: async () => ({}),
    buildGroupContext: () => undefined,
    handleMcpElicitation: async () => ({ action: "decline" as const }),
    createUnownedTurnRequest: () => undefined,
    maybeNudgeCompact: vi.fn(),
    handleTurnComplete: vi.fn(),
    refreshExternalMcpToken: vi.fn(async () => "refreshed" as const),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.instances = [];
  mockState.sendImpl = null;
  mockState.mcpSetCalls = [];
  mockState.mcpSetImpl = null;
  mockState.compactTriggered = false;
});

describe("LiveSessionManager session lifecycle", () => {
  it("reuses an alive session and dedupes concurrent creation", async () => {
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((r) => { releaseBuild = r; });
    let buildCalls = 0;
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => { buildCalls++; await buildGate; return {}; },
    }));

    const p1 = manager.getOrCreateLiveSession("telegram:1");
    const p2 = manager.getOrCreateLiveSession("telegram:1");
    releaseBuild();
    const [s1, s2] = await Promise.all([p1, p2]);

    expect(s2).toBe(s1);
    expect(buildCalls).toBe(1);
    expect(await manager.getOrCreateLiveSession("telegram:1")).toBe(s1);
    expect(mockState.instances).toHaveLength(1);
  });

  it("retires idle sessions immediately when the system prompt changes", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const first = mockState.instances[0];

    prompt = "v2";
    const second = await manager.getOrCreateLiveSession("telegram:2");

    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    // telegram:1 gets a fresh session with the new prompt on next use
    const replacement = await manager.getOrCreateLiveSession("telegram:1");
    expect(replacement).not.toBe(first);
  });

  it("notices a prompt change even when the session would just be reused", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    const first = await manager.getOrCreateLiveSession("telegram:1");

    prompt = "v2";
    const second = await manager.getOrCreateLiveSession("telegram:1");

    expect(first.isAlive()).toBe(false);
    expect(second).not.toBe(first);
  });

  it("keeps a busy session serving its in-flight conversation across a prompt change", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const busySession = mockState.instances[0];
    busySession.busy = true;

    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");

    // Not retired mid-turn: still alive, still the target for its key so
    // mid-turn messages steer into the running conversation instead of
    // spawning a parallel fresh session.
    expect(busySession.closed).toBe(false);
    expect(manager.isAlive("telegram:1")).toBe(true);
    expect(await manager.getOrCreateLiveSession("telegram:1")).toBe(busySession);

    // Retired at its idle boundary; the next message gets a fresh session.
    busySession.busy = false;
    busySession.releaseIdle();
    await flushMicrotasks();
    expect(busySession.closed).toBe(true);
    const replacement = await manager.getOrCreateLiveSession("telegram:1");
    expect(replacement).not.toBe(busySession);
    expect(replacement.isAlive()).toBe(true);
  });

  it("does not retire sessions created after the change — they already have the fresh prompt", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    prompt = "v2";
    // Old session was idle → retired at this boundary; rebuilt with v2.
    const fresh = await manager.getOrCreateLiveSession("telegram:1");

    // Subsequent traffic with an unchanged prompt never touches it.
    await manager.getOrCreateLiveSession("telegram:2");
    expect(fresh.isAlive()).toBe(true);
    expect(await manager.getOrCreateLiveSession("telegram:1")).toBe(fresh);
  });

  it("defers closing a busy retired session until it goes idle", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const busySession = mockState.instances[0];
    busySession.busy = true;

    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");

    expect(busySession.closed).toBe(false);

    busySession.busy = false;
    busySession.releaseIdle();
    await flushMicrotasks();
    expect(busySession.closed).toBe(true);
  });

  it("stop() also closes sessions still retiring after a prompt change", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildSystemPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const busySession = mockState.instances[0];
    busySession.busy = true;
    prompt = "v2";
    const current = await manager.getOrCreateLiveSession("telegram:2");

    await manager.stop();

    expect(busySession.closed).toBe(true);
    expect(current.isAlive()).toBe(false);
  });

  it("reports busy/alive/lastResult from the mapped session", async () => {
    const manager = new LiveSessionManager(makeDeps());
    expect(manager.isAlive("telegram:1")).toBe(false);
    expect(manager.isBusy("telegram:1")).toBe(false);
    expect(manager.lastResult("telegram:1")).toBeNull();

    await manager.getOrCreateLiveSession("telegram:1");
    const session = mockState.instances[0];
    session.busy = true;
    session.lastResult = { contextUsed: 10, contextMax: 100 };

    expect(manager.isAlive("telegram:1")).toBe(true);
    expect(manager.isBusy("telegram:1")).toBe(true);
    expect(manager.lastResult("telegram:1")).toEqual({ contextUsed: 10, contextMax: 100 });
  });

  it("hot-mounts an authenticated server with the complete existing MCP map", async () => {
    const existing = { type: "http" as const, url: "https://existing.example/mcp" };
    const fresh = {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer fresh" },
    };
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => ({ existing }),
    }));
    await manager.getOrCreateLiveSession("telegram:1");

    await manager.hotMountExternalMcpServer("docs", fresh);

    expect(mockState.mcpSetCalls).toHaveLength(1);
    expect(mockState.mcpSetCalls[0].servers).toMatchObject({
      existing,
      docs: fresh,
      "tomo-internal": expect.any(Object),
    });
    expect(manager.mountedExternalMcpServers("telegram:1")).toEqual(new Set(["existing", "docs"]));
  });

  it("routes a live session's MCP auth error to the host token refresh", async () => {
    const refreshExternalMcpToken = vi.fn();
    const manager = new LiveSessionManager(makeDeps({ refreshExternalMcpToken }));
    await manager.getOrCreateLiveSession("telegram:1");

    const onMcpAuthError = mockState.instances[0].settings.onMcpAuthError as (name: string) => void;
    expect(onMcpAuthError).toBeTypeOf("function");
    onMcpAuthError("cloudflare-api");

    expect(refreshExternalMcpToken).toHaveBeenCalledWith("cloudflare-api");
  });

  it("does not remount a server whose live config is unchanged", async () => {
    const docs = {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer existing" },
    };
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => ({ docs }),
    }));
    await manager.getOrCreateLiveSession("telegram:1");

    await manager.hotMountExternalMcpServer("docs", { ...docs });

    expect(mockState.mcpSetCalls).toHaveLength(0);
    expect(manager.mountedExternalMcpServers("telegram:1")).toEqual(new Set(["docs"]));
  });

  // Issue #299 defect 2: after `/mcp login`, the server is already in the
  // session's mounted set, so the hot-mount used to be skipped outright and
  // the session kept the expired Bearer token until a daemon restart.
  it("re-mounts an already-mounted server when its OAuth header changed", async () => {
    const docs = {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer expired" },
    };
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => ({ docs }),
    }));
    await manager.getOrCreateLiveSession("telegram:1");
    const refreshed = { ...docs, headers: { Authorization: "Bearer refreshed" } };

    await manager.hotMountExternalMcpServer("docs", refreshed);

    // Codex review, objection 2: ONE call, so there is no window in which an
    // in-flight tool call finds the server missing. Verified against the CLI
    // bundle (2.1.251): a name present in both maps whose config fingerprint
    // changed goes on the reconcile's "will replace" list, and the
    // fingerprint covers `headers`.
    expect(mockState.mcpSetCalls).toHaveLength(1);
    expect(mockState.mcpSetCalls[0].servers).toMatchObject({ docs: refreshed });
    expect(manager.mountedExternalMcpServers("telegram:1")).toEqual(new Set(["docs"]));
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { serverName: "docs", sessions: 1 },
      "External MCP server hot-mounted into live sessions",
    );
  });

  it("never drops the server from any pushed map while re-authenticating", async () => {
    const docs = {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer expired" },
    };
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => ({ docs }),
    }));
    await manager.getOrCreateLiveSession("telegram:1");

    await manager.hotMountExternalMcpServer("docs", {
      ...docs,
      headers: { Authorization: "Bearer refreshed" },
    });

    // The invariant the outage window would have broken.
    for (const call of mockState.mcpSetCalls) {
      expect(call.servers).toHaveProperty("docs");
    }
  });

  it("leaves bookkeeping alone when the session is replaced during a re-mount", async () => {
    const docs = {
      type: "http" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer expired" },
    };
    let releaseSet!: () => void;
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => ({ docs }),
    }));
    const original = await manager.getOrCreateLiveSession("telegram:1");
    mockState.mcpSetImpl = async () => {
      await setGate;
      return { added: ["docs"], removed: [], errors: {} };
    };

    const mounting = manager.hotMountExternalMcpServer("docs", {
      ...docs,
      headers: { Authorization: "Bearer refreshed" },
    });
    await flushMicrotasks();
    manager.closeLiveSession("telegram:1");
    releaseSet();
    await mounting;

    expect(manager.isAlive("telegram:1")).toBe(false);
    expect(original.isAlive()).toBe(false);
  });

  // Codex review, objection 4.
  it("refuses new hot-mounts once shutdown has started", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    await manager.stop();
    mockState.mcpSetCalls = [];

    await manager.hotMountExternalMcpServer("docs", { type: "http", url: "https://docs.example/mcp" });

    expect(mockState.mcpSetCalls).toHaveLength(0);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { serverName: "docs" },
      "Ignoring an external MCP hot-mount during shutdown",
    );
  });

  it("drains an in-flight hot-mount before stop() closes its session", async () => {
    let releaseSet!: () => void;
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    const order: string[] = [];
    mockState.mcpSetImpl = async () => {
      await setGate;
      order.push("hot-mount");
      return { added: ["docs"], removed: [], errors: {} };
    };
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");

    const mounting = manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });
    await flushMicrotasks();

    const stopping = manager.stop().then(() => order.push("stop"));
    // A stop() that does not drain first resolves inside this window, and —
    // because the fake's close() invalidates the outstanding control request,
    // as the real one does — the hot-mount then fails instead of completing.
    await flushMicrotasks(50);
    releaseSet();
    await stopping;
    await mounting;

    expect(order).toEqual(["hot-mount", "stop"]);
    // The mount completed against a live session, so it was never recorded
    // as a failure.
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "docs" }),
      "External MCP hot-mount failed for live sessions; a later session will retry",
    );
  });

  it("discards a hot-mount result when its session was replaced in flight", async () => {
    let releaseSet!: () => void;
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    mockState.mcpSetImpl = async () => {
      await setGate;
      return { added: ["docs"], removed: [], errors: {} };
    };
    const manager = new LiveSessionManager(makeDeps());
    const original = await manager.getOrCreateLiveSession("telegram:1");

    const mounting = manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });
    await flushMicrotasks();
    expect(mockState.mcpSetCalls).toHaveLength(1);

    manager.closeLiveSession("telegram:1");
    const replacement = await manager.getOrCreateLiveSession("telegram:1");
    expect(replacement).not.toBe(original);
    releaseSet();
    await mounting;

    expect(manager.mountedExternalMcpServers("telegram:1")).toEqual(new Set());
    mockState.mcpSetImpl = null;
    await manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });
    expect(mockState.mcpSetCalls).toHaveLength(2);
    expect(mockState.mcpSetCalls[1].session).toBe(replacement);
  });

  it("serializes simultaneous hot-mounts so neither replacement drops the other", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");

    await Promise.all([
      manager.hotMountExternalMcpServer("alpha", { type: "http", url: "https://alpha.example/mcp" }),
      manager.hotMountExternalMcpServer("beta", { type: "http", url: "https://beta.example/mcp" }),
    ]);

    expect(mockState.mcpSetCalls).toHaveLength(2);
    expect(mockState.mcpSetCalls[0].servers).toHaveProperty("alpha");
    expect(mockState.mcpSetCalls[1].servers).toMatchObject({
      alpha: expect.any(Object),
      beta: expect.any(Object),
      "tomo-internal": expect.any(Object),
    });
    expect(manager.mountedExternalMcpServers("telegram:1")).toEqual(new Set(["alpha", "beta"]));
  });

  it("waits for an already-started session creation before hot-mounting", async () => {
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => {
        await buildGate;
        return {};
      },
    }));

    const creating = manager.getOrCreateLiveSession("telegram:1");
    const mounting = manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });
    await flushMicrotasks();
    expect(mockState.mcpSetCalls).toHaveLength(0);

    releaseBuild();
    await creating;
    await mounting;
    expect(mockState.mcpSetCalls).toHaveLength(1);
    expect(manager.mountedExternalMcpServers("telegram:1")).toContain("docs");
  });

  it("keeps next-session fallback when the runtime lacks MCP updates", async () => {
    mockState.mcpSetImpl = async () => null;
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");

    await manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });

    expect(manager.mountedExternalMcpServers("telegram:1")).not.toContain("docs");
    expect(log.warn).toHaveBeenCalledWith(
      { serverName: "docs", sessions: 1 },
      "Agent SDK does not support live MCP updates; a later session will mount the server",
    );
  });

  it("keeps bookkeeping unchanged and logs once when the control request fails", async () => {
    mockState.mcpSetImpl = async () => { throw new Error("control unavailable"); };
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");

    await manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });

    expect(manager.mountedExternalMcpServers("telegram:1")).not.toContain("docs");
    const failureMessage = "External MCP hot-mount failed for live sessions; a later session will retry";
    expect(log.warn).toHaveBeenCalledWith(
      { serverName: "docs", failures: [{ key: "telegram:1", error: "control unavailable" }] },
      failureMessage,
    );
    expect(vi.mocked(log.warn).mock.calls.filter(([, message]) => message === failureMessage)).toHaveLength(1);
  });
});

describe("LiveSessionManager.runWithRetry", () => {
  it("records the new SDK session id, stats, and context nudge on success", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async (_prompt, session) => {
      session.lastResult = { contextUsed: 5, contextMax: 100 };
      return "hello";
    };

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toBe("hello");
    expect(deps.setSdkSessionId).toHaveBeenCalledWith("telegram:1", "sdk-1");
    expect(deps.updateStats).toHaveBeenCalledWith("telegram:1", { contextUsed: 5, contextMax: 100 });
    expect(deps.maybeNudgeCompact).toHaveBeenCalledWith("telegram:1", { contextUsed: 5, contextMax: 100 });
    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("signals turn completion even when the turn compacted (deferred restarts must not be stranded)", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.compactTriggered = true;
    mockState.sendImpl = async () => "hello";

    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    // The compact path returns early — before the context-pressure check —
    // but a turn still ended, so the end-of-turn restart fallback must fire.
    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
    expect(deps.maybeNudgeCompact).not.toHaveBeenCalled();
  });

  it("signals turn completion when the turn ends in an SDK result error", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new SdkResultError("boom", "error_during_execution"); };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).rejects.toThrow();

    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("signals turn completion on a query timeout", async () => {
    // The timeout path retires the session and rethrows from `dispatchTurn`;
    // it never reaches `recordTurnCompletion`. A restart deferred to the end
    // of this turn must still fire.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("Query timed out after 10 minutes"); };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).rejects.toThrow();

    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("signals turn completion on the legacy max-turns throw", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("Reached maximum number of turns"); };

    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("signals turn completion on an unrecoverable session error", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("something entirely unrecognised"); };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).rejects.toThrow();

    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("signals turn completion for a turn refused during shutdown", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);

    await manager.stop();
    expect(await manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).toBe(SHUTDOWN_NOT_PROCESSED);

    expect(deps.handleTurnComplete).toHaveBeenCalledWith("telegram:1");
  });

  it("keeps the answer when the registry refuses the link, and persists it on a later turn", async () => {
    // setSdkSessionId throws while the registry file is unreadable
    // (SessionRegistryReadError). That happens AFTER the model answered, so
    // it must not fail the turn — and it must be retried even once the
    // registry's last-good state reports some other (stale) link for the
    // key, which the plain "no link yet" guard would treat as done.
    const deps = makeDeps();
    let refuse = true;
    deps.setSdkSessionId = vi.fn(() => { if (refuse) throw new Error("session registry could not be read"); });
    deps.getSdkSessionId = vi.fn(() => undefined);
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => "hello";

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).resolves.toBe("hello");
    expect(deps.setSdkSessionId).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: "telegram:1", sessionId: "sdk-1" }),
      expect.stringContaining("will retry"),
    );

    // Still refusing: another turn, another attempt, still a good answer.
    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "again" })).resolves.toBe("hello");
    expect(deps.setSdkSessionId).toHaveBeenCalledTimes(2);

    // Registry readable again — but its last-good state names a stale link.
    refuse = false;
    deps.getSdkSessionId = vi.fn(() => "sdk-stale");
    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "third" })).resolves.toBe("hello");
    expect(deps.setSdkSessionId).toHaveBeenCalledTimes(3);
    expect(deps.setSdkSessionId).toHaveBeenLastCalledWith("telegram:1", "sdk-1");
    expect(log.info).toHaveBeenCalledWith({ sessionId: "sdk-1", key: "telegram:1" }, "Session ID persisted on retry");

    // Persisted: a fourth turn does not touch the link again.
    await manager.runWithRetry({ key: "telegram:1", prompt: "fourth" });
    expect(deps.setSdkSessionId).toHaveBeenCalledTimes(3);
  });

  it("skips per-turn bookkeeping when a steered message merges (STEER_MERGED)", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => "";

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi", steer: true });

    expect(response).toBe("");
    expect(deps.setSdkSessionId).not.toHaveBeenCalled();
    expect(deps.maybeNudgeCompact).not.toHaveBeenCalled();
    // The owning turn does this session's bookkeeping, including the restart
    // fallback — a merged steer must not fire it a second time.
    expect(deps.handleTurnComplete).not.toHaveBeenCalled();
  });

  it("clears the persisted SDK session id and retries once on 'No conversation found'", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let calls = 0;
    mockState.sendImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("No conversation found with session ID abc");
      return "recovered";
    };

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toBe("recovered");
    expect(deps.clearSdkSessionId).toHaveBeenCalledWith("telegram:1");
    expect(mockState.instances).toHaveLength(2);
    expect(mockState.instances[0].closed).toBe(true);
  });

  /**
   * Delivery is IRREVERSIBLE, so the retry policy has to know about it.
   *
   * A recoverable session error re-runs the whole prompt. That was free while
   * delivery happened at end of turn — nothing had left the machine, so the
   * re-run produced the one message the owner ever saw. With per-block
   * delivery a turn can die AFTER putting text on his phone, and the re-run
   * regenerates that text. Asked the same question twice, the model says the
   * same thing twice.
   *
   * Skipping the first N blocks of the retry by index was rejected: the retry
   * is a fresh sampling, not a replay, so index is not identity. Refusing to
   * retry cannot double-send by construction, which is the property that
   * matters here.
   */
  it("refuses to retry once a block has shipped, so the owner receives it exactly once", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    const received: string[] = [];
    let shipped = false;
    let attempts = 0;

    mockState.sendImpl = async (_prompt, _session, onBlock) => {
      attempts++;
      // Both attempts would produce the same first block — the whole hazard.
      await onBlock?.("A");
      if (attempts === 1) throw new Error("process exited");
      return "A";
    };

    const outcome = await manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      // The real sink (TurnRunner.makeBlockSink) marks the turn shipped as it
      // attempts each send; mirrored here.
      onBlock: async (b) => { shipped = true; received.push(b); },
      hasShipped: () => shipped,
    } as never).then(() => "resolved", (e: Error) => `rejected: ${e.message}`);

    // THE assertion: the owner has exactly one copy of A. Without the guard
    // this reads ["A", "A"].
    expect(received).toEqual(["A"]);
    // Because there was no second attempt...
    expect(attempts).toBe(1);
    // ...and the failure is surfaced instead. He already has A, and an error
    // note beats a duplicate he cannot tell apart from the original.
    expect(outcome).toBe("rejected: process exited");
  });

  it("still retries a recoverable error that happens before anything shipped", async () => {
    // The overwhelmingly common case: the child dies while starting or
    // resuming, before any content block exists. Refusing to retry there would
    // be a regression, so the guard must be about DELIVERY, not about failure.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    const received: string[] = [];
    let attempts = 0;

    mockState.sendImpl = async (_prompt, _session, onBlock) => {
      attempts++;
      if (attempts === 1) throw new Error("Session is closed");
      await onBlock?.("A");
      return "A";
    };

    const response = await manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      onBlock: async (b) => { received.push(b); },
      hasShipped: () => received.length > 0,
    } as never);

    expect(response).toBe("A");
    expect(attempts).toBe(2);
    expect(received).toEqual(["A"]);
  });

  it("keeps the SDK session id on 'Session is closed' errors and retries once", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let calls = 0;
    mockState.sendImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("Session is closed");
      return "recovered";
    };

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toBe("recovered");
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(2);
  });

  it("rethrows without retrying when an error merely mentions a session", async () => {
    // Retrying re-runs the whole turn (duplicating its side effects), so only
    // genuine session-lifecycle failures may trip the reset-and-retry branch —
    // not any MCP/tool/API error whose message happens to contain "session".
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("MCP tool failed: invalid session parameter"); };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" }))
      .rejects.toThrow("MCP tool failed");

    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].closed).toBe(false);
  });

  it("retires the SDK session id and rethrows on query timeouts", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("Query timed out after 10 minutes"); };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" }))
      .rejects.toThrow("Query timed out after 10 minutes");

    expect(deps.retireSdkSessionId).toHaveBeenCalledWith("telegram:1");
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    expect(mockState.instances[0].closed).toBe(true);
    expect(mockState.instances).toHaveLength(1);
  });

  it("refuses a turn admitted after stop(), instead of building a session and running it", async () => {
    // This test used to assert `NO_REPLY` and one constructed session, which
    // LOOKED like refusal but wasn't: the mock's `send` threw "Session is
    // closed", so the NO_REPLY came from the shutdown CONVERSION, not from the
    // manager declining the work. A real newly-constructed LiveSession has a
    // live SDK child and would have run the turn to completion while the
    // daemon was trying to exit. Admission is what has to close.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let ran = false;
    mockState.sendImpl = async () => { ran = true; return "ran anyway"; };

    await manager.stop();
    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toBe(SHUTDOWN_NOT_PROCESSED);
    expect(ran).toBe(false);
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    // Not "one session and no retry" — NO session. The turn never reached one.
    expect(mockState.instances).toHaveLength(0);
  });

  it("flushes a refused turn's block transcript so nothing delivered is lost", async () => {
    const manager = new LiveSessionManager(makeDeps());
    const events: string[] = [];

    await manager.stop();
    const response = await manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      flushOnShutdown: () => { events.push("flush"); return false; },
    });

    expect(events).toEqual(["flush"]);
    expect(response).toBe(SHUTDOWN_NOT_PROCESSED);
  });

  it("closes a session built after stop() began instead of publishing it", async () => {
    // The turn was admitted BEFORE stop() and is parked inside
    // buildExternalMcpServers when shutdown sweeps the map. Without the
    // post-await re-check it publishes a brand-new, ALIVE session into the map
    // stop() has already cleared, and runs its turn past the daemon's exit.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const manager = new LiveSessionManager(makeDeps({
      buildExternalMcpServers: async () => { await gate; return {}; },
    }));
    let ran = false;
    let flushed = false;
    mockState.sendImpl = async () => { ran = true; return "ran anyway"; };

    const turn = manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      flushOnShutdown: () => { flushed = true; return false; },
    });
    await flushMicrotasks();

    const stopping = manager.stop();
    release();
    await stopping;

    expect(await turn).toBe(SHUTDOWN_NOT_PROCESSED);
    expect(ran).toBe(false);
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].closed).toBe(true);
    expect(manager.isAlive("telegram:1")).toBe(false);
    expect(flushed).toBe(true);
  });

  it("flushes the turn's block transcript BEFORE converting a shutdown rejection to NO_REPLY", async () => {
    // Resolving with NO_REPLY makes this a successful turn, which skips
    // TurnRunner's rejection flush and records the fabricated NO_REPLY as the
    // turn's outcome. Anything already delivered has to reach the transcript
    // first, or the shutdown reads back as silence.
    const manager = new LiveSessionManager(makeDeps());
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    mockState.sendImpl = async () => { await parked; throw new Error("Session is closed"); };
    const events: string[] = [];

    const turn = manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      flushOnShutdown: () => { events.push("flush"); return true; },
    });
    await flushMicrotasks();

    const stopping = manager.stop();
    release();
    await stopping;
    events.push(`resolved:${await turn}`);

    expect(events).toEqual(["flush", "resolved:NO_REPLY"]);
  });

  it("keeps draining turns that join the in-flight set after the first snapshot", async () => {
    // Admission is closed, so a late arrival should now be unreachable — this
    // is defence in depth, and it is injected directly for exactly that
    // reason: the drain must not depend on the set being COMPLETE at snapshot
    // time, so that a future path which finds a way in is still waited on
    // rather than abandoned mid-flush.
    const manager = new LiveSessionManager(makeDeps());
    const inFlight = (manager as unknown as { inFlightTurns: Set<Promise<string>> }).inFlightTurns;

    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => { releaseFirst = r; });
    let releaseLate!: () => void;
    const late = new Promise<void>((r) => { releaseLate = r; });
    let lateFlushed = false;
    mockState.sendImpl = async () => { await first; throw new Error("Session is closed"); };

    const turn = manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      // Lands DURING the first turn's flush — after stop() took its snapshot.
      flushOnShutdown: () => {
        inFlight.add(late.then(() => { lateFlushed = true; return "NO_REPLY"; }));
        return true;
      },
    });
    await flushMicrotasks();

    let stopped = false;
    const stopping = manager.stop().then(() => { stopped = true; });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    releaseFirst();
    expect(await turn).toBe("NO_REPLY");
    // A real timer tick, not just microtasks: a snapshot-once drain resolves
    // here, and only a macrotask yield is slow enough to catch it doing so.
    await new Promise((r) => setTimeout(r, 5));
    // The first turn is done; the late arrival is not, and stop() must still
    // be waiting on it rather than having exited on the stale snapshot.
    expect(lateFlushed).toBe(false);
    expect(stopped).toBe(false);

    releaseLate();
    await stopping;
    expect(lateFlushed).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Gave up waiting for in-flight turns"),
    );
  });

  it("waits for an in-flight turn to settle before stop() resolves", async () => {
    const manager = new LiveSessionManager(makeDeps());
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    let flushed = false;
    mockState.sendImpl = async () => { await parked; throw new Error("Session is closed"); };

    const turn = manager.runWithRetry({
      key: "telegram:1",
      prompt: "hi",
      flushOnShutdown: () => { flushed = true; return true; },
    });
    await flushMicrotasks();

    let stopped = false;
    const stopping = manager.stop().then(() => { stopped = true; });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(flushed).toBe(true);
    expect(await turn).toBe("NO_REPLY");
  });

  it("gives up on a turn that never settles instead of blocking the exit", async () => {
    vi.useFakeTimers();
    try {
      const manager = new LiveSessionManager(makeDeps());
      mockState.sendImpl = () => new Promise<string>(() => {}); // never settles

      void manager.runWithRetry({ key: "telegram:1", prompt: "hi" });
      await flushMicrotasks();

      const stopping = manager.stop();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS);
      await expect(stopping).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ turns: 1 }),
        expect.stringContaining("Gave up waiting for in-flight turns"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a turn that ended on an SDK error result, then rethrows without retrying", async () => {
    const { SdkResultError } = await import("../src/agent/live-session.js");
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async (_prompt, session) => {
      session.lastResult = { costUsd: 0.2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 0, contextMax: 0 };
      throw new SdkResultError("I ran out of steps trying to complete that. Can you try a simpler request?", "error_max_turns", ["too many turns"]);
    };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).rejects.toMatchObject({ subtype: "error_max_turns" });

    // Not a session error: no reset, no second attempt.
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].closed).toBe(false);
    // The turn happened: its SDK session id and stats are recorded like a
    // completed turn's, so a first turn that fails is still resumable.
    expect(deps.setSdkSessionId).toHaveBeenCalledWith("telegram:1", expect.any(String));
    expect(deps.updateStats).toHaveBeenCalledWith("telegram:1", expect.objectContaining({ costUsd: 0.2 }));
  });

  it("records a retry attempt that ends on an SDK error result", async () => {
    const { SdkResultError } = await import("../src/agent/live-session.js");
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let attempt = 0;
    mockState.sendImpl = async (_prompt, session) => {
      attempt++;
      if (attempt === 1) throw new Error("Session is closed");
      session.sessionId = "sdk-retry";
      session.lastResult = { costUsd: 0.3, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 0, contextMax: 0 };
      throw new SdkResultError("I ran out of steps trying to complete that. Can you try a simpler request?", "error_max_turns");
    };

    await expect(manager.runWithRetry({ key: "telegram:1", prompt: "hi" })).rejects.toMatchObject({ subtype: "error_max_turns" });

    // One reset-and-retry, then the typed error propagates — and the retry's
    // NEW session id and stats are kept, exactly as on the first attempt.
    expect(mockState.instances).toHaveLength(2);
    expect(deps.setSdkSessionId).toHaveBeenCalledWith("telegram:1", "sdk-retry");
    expect(deps.updateStats).toHaveBeenCalledWith("telegram:1", expect.objectContaining({ costUsd: 0.3 }));
  });

  it("returns the max-turns fallback message without retrying", async () => {
    const manager = new LiveSessionManager(makeDeps());
    mockState.sendImpl = async () => { throw new Error("Reached maximum number of turns"); };

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toContain("I ran out of steps");
    expect(mockState.instances).toHaveLength(1);
  });

  it("defers the post-compact reload past a busy (steered) turn", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.compactTriggered = true;
    mockState.sendImpl = async (_prompt, session) => {
      session.busy = true; // a promoted steered turn is still running
      return "done";
    };

    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });
    const session = mockState.instances[0];
    expect(session.closed).toBe(false);

    session.busy = false;
    session.releaseIdle();
    await flushMicrotasks();
    expect(session.closed).toBe(true);
    expect(manager.isAlive("telegram:1")).toBe(false);
  });

  it("reloads immediately after a compact when the session is idle", async () => {
    const manager = new LiveSessionManager(makeDeps());
    mockState.compactTriggered = true;
    mockState.sendImpl = async () => "done";

    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(mockState.instances[0].closed).toBe(true);
    expect(manager.isAlive("telegram:1")).toBe(false);
  });

  it("skips the context-pressure check on the turn that compacted", async () => {
    // The compact/prune rewrote the file mid-turn, but this turn's context
    // reading was measured against the old in-memory session — it's stale-high.
    // Nudging on it would falsely escalate the ladder (e.g. queue a daily
    // rollup right after a prune that already freed enough space).
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.compactTriggered = true;
    mockState.sendImpl = async () => "done";

    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(deps.maybeNudgeCompact).not.toHaveBeenCalled();
  });
});
