import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — a controllable LiveSession double so the manager's lifecycle
// and retry policy can be tested without the SDK.
// ---------------------------------------------------------------------------

interface FakeSession {
  key: string;
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
  send(prompt: string): Promise<string>;
  steer(prompt: string): Promise<string>;
}

const { mockState } = vi.hoisted(() => ({
  mockState: {
    instances: [] as FakeSession[],
    sendImpl: null as null | ((prompt: string, session: FakeSession) => Promise<string>),
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

    constructor(_opts: unknown, key: string) {
      this.key = key;
      mockState.instances.push(this);
    }
    releaseIdle() { for (const r of this.idleResolvers.splice(0)) r(); }
    isAlive() { return !this.closed; }
    isBusy() { return this.busy; }
    close() { this.closed = true; }
    waitForIdle() { return new Promise<void>((r) => this.idleResolvers.push(r)); }
    getSessionId() { return this.sessionId; }
    async send(prompt: string) { return mockState.sendImpl ? mockState.sendImpl(prompt, this) : "ok"; }
    async steer(prompt: string) { return mockState.sendImpl ? mockState.sendImpl(prompt, this) : "steered"; }
  }
  return {
    LiveSession: FakeLiveSession,
    QUERY_TIMEOUT_ERROR_PREFIX: "Query timed out after",
    STEER_MERGED: "",
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

const { LiveSessionManager } = await import("../src/agent/live-session-manager.js");
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
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  mockState.instances = [];
  mockState.sendImpl = null;
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

    manager.stop();

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
  });

  it("skips per-turn bookkeeping when a steered message merges (STEER_MERGED)", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => "";

    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi", steer: true });

    expect(response).toBe("");
    expect(deps.setSdkSessionId).not.toHaveBeenCalled();
    expect(deps.maybeNudgeCompact).not.toHaveBeenCalled();
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

  it("never resets or retries during shutdown", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw new Error("Session is closed"); };

    manager.stop();
    const response = await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });

    expect(response).toBe("NO_REPLY");
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    // Only the initial creation — no retry session
    expect(mockState.instances).toHaveLength(1);
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
