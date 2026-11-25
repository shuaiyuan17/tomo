import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  // Knobs and records the tests set or read directly.
  background: boolean;
  ambient: boolean;
  bgWaits: Array<{ timeoutMs: number; resolve: (drained: boolean) => void }>;
  awaitingReport: boolean;
  awaitingReportAgeMs: number;
  turnWaits: Array<{ timeoutMs: number; resolve: (started: boolean) => void }>;
  backgroundMoves: Array<(moved: boolean) => void>;
  lastActivity: number;
  lastActivityAt(): number;
  interruptedWith: Error | null;
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
    sessionContexts: [] as Array<{ sessionKey: string; backgroundLaunchDenial?: () => string | null; spawnDenial?: () => string | null; onCompacted?: () => void }>,
    /** What the (mocked) prompt build hands the session as its snapshot. */
    buildContext: null as null | ((key: string) => { memory: string[]; people: string[] }),
    onInterrupt: null as null | ((err: Error, session: FakeSession) => void),
    /** When set, every closed session's whenClosed() waits on it (the CLI child still exiting). */
    closeGate: null as null | Promise<void>,
    /** When set, reconnectMcpServer() waits on it (a reconnect still running). */
    reconnectGate: null as null | Promise<void>,
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
    background = false;
    bgWaits: Array<{ timeoutMs: number; resolve: (drained: boolean) => void }> = [];
    hasActiveBackgroundTasks() { return this.background; }
    ambient = false;
    hasAnyLiveTasks() { return this.background || this.ambient; }
    lastActivity = Date.now();
    noteActivity() { this.lastActivity = Date.now(); }
    lastActivityAt() { return this.lastActivity; }
    activeBackgroundTaskCount() { return this.background ? 2 : 0; }
    /** How long ago the drain that set `awaitingReport` happened (for the bounded check). */
    awaitingReportAgeMs = 0;
    isAwaitingTaskReportWithin(maxAgeMs: number) { return this.awaitingReport && this.awaitingReportAgeMs < maxAgeMs; }
    backgroundMoves: Array<(moved: boolean) => void> = [];
    backgroundTask() { return new Promise<boolean>((resolve) => this.backgroundMoves.push(resolve)); }
    awaitingReport = false;
    turnWaits: Array<{ timeoutMs: number; resolve: (started: boolean) => void }> = [];
    isAwaitingTaskReport() { return this.awaitingReport; }
    waitForTurnStart(timeoutMs: number) {
      return new Promise<boolean>((resolve) => this.turnWaits.push({ timeoutMs, resolve }));
    }
    waitForBackgroundIdle(timeoutMs: number) {
      return new Promise<boolean>((resolve) => this.bgWaits.push({ timeoutMs, resolve }));
    }
    close() { this.closed = true; }
    interruptedWith: Error | null = null;
    interrupt(err: Error) { this.interruptedWith = err; this.closed = true; mockState.onInterrupt?.(err, this); }
    whenEventLoopDone() { return Promise.resolve(); }
    whenClosed() { return mockState.closeGate ?? Promise.resolve(); }
    async reconnectMcpServer(_name: string) { await mockState.reconnectGate; }
    steeredRequestCount() { return 0; }
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
    TurnInterruptedError: class TurnInterruptedError extends Error {
      constructor(message = "Turn stopped by /rewind.") {
        super(message);
        this.name = "TurnInterruptedError";
      }
    },
    SdkResultError: class SdkResultError extends Error {
      constructor(message: string, readonly subtype: string, readonly errors: string[] = [], readonly numTurns?: number) {
        super(message);
        this.name = "SdkResultError";
      }
      get isResumeMissing(): boolean {
        return this.subtype === "error_during_execution" && this.numTurns === 0
          && this.errors.length > 0 && this.errors.every((e) => e.includes("No conversation found"));
      }
    },
  };
});

vi.mock("../src/agent/sdk-options.js", () => ({
  makeTurnBudget: () => ({}),
  usesLcmCompact: (key: string) => !key.startsWith("task:"),
  sdkOptions: (_server: unknown, _resume: unknown, _model: unknown, ctx: {
    sessionKey: string;
    onPromptContext?: (c: { memory: string[]; people: string[] }) => void;
  }) => {
    mockState.sessionContexts.push(ctx);
    if (mockState.buildContext) ctx.onPromptContext?.(mockState.buildContext(ctx.sessionKey));
    return { model: "test-model" };
  },
}));

// A private SDK sessions dir per run (a shared /tmp/sdk-sessions collided
// across parallel runs and leaked compact triggers between them).
vi.mock("../src/config.js", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    config: { sdkSessionsDir: mkdtempSync(join(tmpdir(), "tomo-lsm-sdk-")), liveSessionTimeoutMs: 1000, liveSessionIdleTimeoutMs: 60 * 60 * 1000, lcm: { blockSpawnAtPct: 80 } },
  };
});

vi.mock("../src/sessions/repair.js", () => ({
  repairSdkSessionForResume: vi.fn(() => ({})),
}));

vi.mock("../src/lcm/index.js", () => ({
  checkAndClearCompactTrigger: vi.fn(() => mockState.compactTriggered),
}));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { config: mockConfig } = await import("../src/config.js") as unknown as { config: { liveSessionIdleTimeoutMs: number; sdkSessionsDir: string } };
afterAll(async () => {
  const { rmSync } = await import("node:fs");
  rmSync(mockConfig.sdkSessionsDir, { recursive: true, force: true });
});
const { LiveSessionManager, IDLE_REAP_SWEEP_MS, IDLE_REAP_CLOSE_WAIT_MS, SDK_CLI_KILL_MS, SHUTDOWN_FLUSH_TIMEOUT_MS, SHUTDOWN_NOT_PROCESSED, PROMPT_RETIRE_BACKGROUND_WAIT_MS, PROMPT_RETIRE_REPORT_WAIT_MS } = await import("../src/agent/live-session-manager.js");
const { log } = await import("../src/logger.js");
const { SdkResultError } = await import("../src/agent/live-session.js");
type Deps = ConstructorParameters<typeof LiveSessionManager>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    buildIdentityPrompt: () => "prompt-v1",
    getSdkSessionId: vi.fn(() => undefined),
    setSdkSessionId: vi.fn(),
    clearSdkSessionId: vi.fn(),
    retireSdkSessionId: vi.fn(),
    getUsageBaseline: vi.fn(() => undefined),
    updateStats: vi.fn(),
    getSessionMessages: () => [],
    getModelOverride: () => undefined,
    createInternalMcpServer: () => ({} as ReturnType<Deps["createInternalMcpServer"]>),
    buildExternalMcpServers: async () => ({}),
    buildGroupContext: () => undefined,
    isOwnAudienceTurn: () => true,
    scopedCallerKey: (key: string) => key,
    handleMcpElicitation: async () => ({ action: "decline" as const }),
    createUnownedTurnRequest: () => undefined,
    maybeNudgeCompact: vi.fn(),
    handleTurnComplete: vi.fn(),
    refreshExternalMcpToken: vi.fn(async () => "refreshed" as const),
    ...overrides,
  };
}

/** The mock behind a session the manager handed out (every one is a FakeSession here). */
function fake(session: unknown): FakeSession {
  return session as FakeSession;
}

/** Let `ticks` rounds of already-queued promise callbacks run (no timers). */
async function flushMicrotasks(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.instances = [];
  mockState.sendImpl = null;
  mockState.mcpSetCalls = [];
  mockState.mcpSetImpl = null;
  mockState.compactTriggered = false;
  mockState.sessionContexts = [];
  mockState.buildContext = null;
  mockState.onInterrupt = null;
  mockState.closeGate = null;
  mockState.reconnectGate = null;
  mockConfig.liveSessionIdleTimeoutMs = 60 * 60 * 1000;
});

describe("LiveSessionManager session lifecycle", () => {
  it("hands a resumed session its persisted usage baseline, and a fresh one nothing", async () => {
    const baseline = {
      sdkSessionId: "sdk-resumed", totalCostUsd: 275.47,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreated: 4 },
    };
    const manager = new LiveSessionManager(makeDeps({
      getSdkSessionId: vi.fn((key: string) => (key === "telegram:resumed" ? "sdk-resumed" : undefined)),
      getUsageBaseline: vi.fn((key: string) => (key === "telegram:resumed" ? baseline : undefined)),
    }));

    await manager.getOrCreateLiveSession("telegram:resumed");
    await manager.getOrCreateLiveSession("telegram:fresh");
    const [resumed, fresh] = mockState.instances as unknown as Array<{ settings: Record<string, unknown> }>;
    expect(resumed.settings.resumeFrom).toEqual({ sdkSessionId: "sdk-resumed", baseline });
    expect(fresh.settings.resumeFrom).toBeUndefined();
  });

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
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const first = mockState.instances[0];

    prompt = "v2";
    const second = fake(await manager.getOrCreateLiveSession("telegram:2"));

    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    // telegram:1 gets a fresh session with the new prompt on next use
    const replacement = fake(await manager.getOrCreateLiveSession("telegram:1"));
    expect(replacement).not.toBe(first);
  });

  // The same key asks again after the identity prompt changed: the check runs
  // on reuse too, not only when another key builds a session.
  it("still retires a live session when SOUL/AGENT/IDENTITY or the harness rules change, even when its key would just reuse it", async () => {
    let identity = "identity-v1";
    const manager = new LiveSessionManager(makeDeps({
      buildIdentityPrompt: () => identity,
      promptContextSnapshot: () => ({ memory: [], people: [] }),
    }));
    const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
    identity = "identity-v2";
    const second = fake(await manager.getOrCreateLiveSession("dm:owner"));
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
  });

  it("does not read the cache-boundary marker as a prompt change", async () => {
    const BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
    let prompt: string | string[] = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    const first = fake(await manager.getOrCreateLiveSession("telegram:1"));

    // Same workspace content, now handed over as blocks around the marker.
    prompt = ["v1", BOUNDARY];
    expect(await manager.getOrCreateLiveSession("telegram:1")).toBe(first);
    expect(first.isAlive()).toBe(true);

    // A real content change still retires it.
    prompt = ["v2", BOUNDARY];
    const second = fake(await manager.getOrCreateLiveSession("telegram:1"));
    expect(first.isAlive()).toBe(false);
    expect(second).not.toBe(first);
  });

  it("keeps a busy session serving its in-flight conversation across a prompt change", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

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
    const replacement = fake(await manager.getOrCreateLiveSession("telegram:1"));
    expect(replacement).not.toBe(busySession);
    expect(replacement.isAlive()).toBe(true);
  });

  it("does not retire sessions created after the change — they already have the fresh prompt", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    prompt = "v2";
    // Old session was idle → retired at this boundary; rebuilt with v2.
    const fresh = fake(await manager.getOrCreateLiveSession("telegram:1"));

    // Subsequent traffic with an unchanged prompt never touches it.
    await manager.getOrCreateLiveSession("telegram:2");
    expect(fresh.isAlive()).toBe(true);
    expect(await manager.getOrCreateLiveSession("telegram:1")).toBe(fresh);
  });

  it("waits for background tasks before retiring an idle prompt-stale session", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const session = mockState.instances[0];
    // Turn over, but a background subagent it launched is still running.
    session.background = true;

    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");
    await flushMicrotasks();

    expect(session.closed).toBe(false);
    expect(session.bgWaits).toHaveLength(1);
    expect(session.bgWaits[0].timeoutMs).toBeGreaterThan(0);
    expect(session.bgWaits[0].timeoutMs).toBeLessThanOrEqual(PROMPT_RETIRE_BACKGROUND_WAIT_MS);

    // Drained: the follow-up turn reporting the task's result hasn't started yet.
    session.background = false;
    session.awaitingReport = true;
    session.bgWaits[0].resolve(true);
    await flushMicrotasks();
    expect(session.closed).toBe(false);
    expect(session.turnWaits).toHaveLength(1);
    expect(session.turnWaits[0].timeoutMs).toBeLessThanOrEqual(PROMPT_RETIRE_REPORT_WAIT_MS);

    // It starts, runs, and ends: now the session retires.
    session.awaitingReport = false;
    session.busy = true;
    session.turnWaits[0].resolve(true);
    await flushMicrotasks();
    expect(session.closed).toBe(false);
    session.busy = false;
    session.releaseIdle();
    await flushMicrotasks();
    expect(session.closed).toBe(true);
  });

  it("retires without the report turn once the report wait runs out", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));
    await manager.getOrCreateLiveSession("telegram:1");
    const session = mockState.instances[0];
    // Drained while a turn was running (result folded into it): no follow-up comes.
    session.awaitingReport = true;
    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");
    await flushMicrotasks();
    expect(session.closed).toBe(false);
    session.turnWaits[0].resolve(false);
    await flushMicrotasks();
    expect(session.closed).toBe(true);
  });

  it("does not close a session whose new turn started while the background wait timed out", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));
    await manager.getOrCreateLiveSession("telegram:1");
    const session = mockState.instances[0];
    session.background = true;
    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");
    await flushMicrotasks();

    // A user turn starts during the wait, then the cap expires mid-turn.
    session.busy = true;
    session.bgWaits[0].resolve(false);
    await flushMicrotasks();
    expect(session.closed).toBe(false);

    // Retires at the turn's idle boundary, even with the task still live.
    session.busy = false;
    session.releaseIdle();
    await flushMicrotasks();
    expect(session.closed).toBe(true);
  });

  it("starts the background wait cap at foreground idle, not when retirement was scheduled", async () => {
    vi.useFakeTimers();
    try {
      let prompt = "v1";
      const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));
      await manager.getOrCreateLiveSession("telegram:1");
      const session = mockState.instances[0];
      session.busy = true;
      prompt = "v2";
      await manager.getOrCreateLiveSession("telegram:2");

      // A turn longer than the cap, which launches a subagent just before it ends.
      vi.setSystemTime(Date.now() + PROMPT_RETIRE_BACKGROUND_WAIT_MS + 60_000);
      session.background = true;
      session.busy = false;
      session.releaseIdle();
      await flushMicrotasks();

      expect(session.closed).toBe(false);
      expect(session.bgWaits).toHaveLength(1);
      expect(session.bgWaits[0].timeoutMs).toBe(PROMPT_RETIRE_BACKGROUND_WAIT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a prompt-stale session anyway when background tasks outlive the wait cap", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const session = mockState.instances[0];
    session.background = true;

    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");
    await flushMicrotasks();
    expect(session.closed).toBe(false);

    // Cap elapsed with the task still live.
    session.bgWaits[0].resolve(false);
    await flushMicrotasks();
    expect(session.closed).toBe(true);
  });

  it("stop() also closes sessions still retiring after a prompt change", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));

    await manager.getOrCreateLiveSession("telegram:1");
    const busySession = mockState.instances[0];
    busySession.busy = true;
    prompt = "v2";
    const current = fake(await manager.getOrCreateLiveSession("telegram:2"));

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

  it("reports background work by key, counting the report window like retireWhenIdle", async () => {
    const manager = new LiveSessionManager(makeDeps());
    expect(manager.backgroundState("telegram:1")).toEqual({ activeBackgroundTasks: 0, awaitingTaskReport: false, backgroundingInFlight: 0 });
    await manager.getOrCreateLiveSession("telegram:1");
    const s = mockState.instances[0];
    s.background = true;
    expect(manager.backgroundState("telegram:1")).toEqual({ activeBackgroundTasks: 2, awaitingTaskReport: false, backgroundingInFlight: 0 });
    s.background = false;
    s.awaitingReport = true;
    expect(manager.backgroundState("telegram:1")).toEqual({ activeBackgroundTasks: 0, awaitingTaskReport: true, backgroundingInFlight: 0 });
  });

  it("finds the key behind an SDK session id: the live id first, then the registry link", async () => {
    const manager = new LiveSessionManager(makeDeps({
      getSdkSessionId: vi.fn((key: string) => (key === "telegram:2" ? "sdk-linked" : undefined)),
    }));
    await manager.getOrCreateLiveSession("telegram:1");
    await manager.getOrCreateLiveSession("telegram:2");
    mockState.instances[1].sessionId = null; // not captured yet
    expect(manager.keyForSdkSession("sdk-1")).toBe("telegram:1");
    expect(manager.keyForSdkSession("sdk-linked")).toBe("telegram:2");
    expect(manager.keyForSdkSession("sdk-unknown")).toBeUndefined();
  });

  it("refuses a compact while background work runs or its report is due", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    const s = mockState.instances[0];
    s.background = true;
    expect(manager.reserveCompact("telegram:1", "sdk-1")).toMatchObject({ ok: false, reason: "background-tasks" });
    s.background = false;
    s.awaitingReport = true;
    expect(manager.reserveCompact("telegram:1", "sdk-1")).toMatchObject({ ok: false, reason: "awaiting-task-report" });
    expect(manager.isCompactPending("telegram:1")).toBe(false);
  });

  it("while a compact is pending, the session's hook denies background launches and the web cannot background a task", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    const ctx = mockState.sessionContexts.find((c) => c.sessionKey === "telegram:1")!;
    expect(ctx.backgroundLaunchDenial).toBeTypeOf("function");

    const r = manager.reserveCompact("telegram:1", "sdk-1");
    expect(r.ok).toBe(true);
    expect(manager.isCompactPending("telegram:1")).toBe(true);
    expect(ctx.backgroundLaunchDenial!()).toContain("rollup/compact is pending");
    expect(await manager.backgroundTask("telegram:1", "toolu_1")).toBe(false);

    // No trigger on disk (the suite's sdkSessionsDir): the rewrite did not happen, so
    // finishing releases the mark at once.
    if (r.ok) manager.finishCompact("telegram:1", r.reservationId);
    expect(manager.isCompactPending("telegram:1")).toBe(false);
    expect(ctx.backgroundLaunchDenial!()).toBeNull();
  });

  it("the spawn gate reads the live session's last turn result (the nudger's reading), per call", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    const ctx = mockState.sessionContexts.find((c) => c.sessionKey === "telegram:1")!;
    expect(ctx.spawnDenial).toBeTypeOf("function");
    // No reading yet (a fresh or just-reloaded session): open.
    expect(ctx.spawnDenial!()).toBeNull();
    const session = mockState.instances[0] as unknown as { lastResult: unknown };
    session.lastResult = { contextUsed: 870, contextMax: 1000 };
    expect(ctx.spawnDenial!()).toContain("Context is at 87%");
    // Usage back under the threshold: open again, no latch.
    session.lastResult = { contextUsed: 790, contextMax: 1000 };
    expect(ctx.spawnDenial!()).toBeNull();
    // An SDK compact since the reading was taken: the old number is stale, so
    // unknown — no block — until the next turn's reading replaces it.
    session.lastResult = { contextUsed: 950, contextMax: 1000 };
    expect(ctx.spawnDenial!()).toContain("95%");
    ctx.onCompacted!(); // the PostCompact hook
    expect(ctx.spawnDenial!()).toBeNull();
    (session as unknown as { compactedSinceLastResult: boolean }).compactedSinceLastResult = false;
    session.lastResult = { contextUsed: 790, contextMax: 1000 };
    // The threshold is read per call (a config reload applies at once).
    const lcm = (mockConfig as unknown as { lcm: { blockSpawnAtPct: number } }).lcm;
    lcm.blockSpawnAtPct = 75;
    try {
      expect(ctx.spawnDenial!()).toContain("79%");
    } finally {
      lcm.blockSpawnAtPct = 80;
    }
  });

  it("a move to the background in flight refuses a reservation that arrives meanwhile", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    const s = mockState.instances[0];
    const moving = manager.backgroundTask("telegram:1", "toolu_1");
    await flushMicrotasks();
    expect(s.backgroundMoves).toHaveLength(1);
    expect(manager.reserveCompact("telegram:1", "sdk-1")).toMatchObject({ ok: false, reason: "backgrounding" });

    s.backgroundMoves[0](true);
    expect(await moving).toBe(true);
    // Moved: the SDK has yet to report the task, so the settle window holds.
    expect(manager.reserveCompact("telegram:1", "sdk-1")).toMatchObject({ ok: false, reason: "recent-launch" });
  });

  it("after a rewrite, an idle session stays protected until its reload — however long that takes", async () => {
    vi.useFakeTimers();
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const sid = `sdk-${Math.random().toString(36).slice(2)}`;
    const trigger = `${mockConfig.sdkSessionsDir}/${sid}.compact-trigger`;
    try {
      const manager = new LiveSessionManager(makeDeps());
      await manager.getOrCreateLiveSession("telegram:1");
      mockState.instances[0].sessionId = sid;
      const r = manager.reserveCompact("telegram:1", sid);
      if (!r.ok) throw new Error("expected approval");
      mkdirSync(mockConfig.sdkSessionsDir, { recursive: true });
      writeFileSync(trigger, "x"); // the rewrite succeeded
      manager.finishCompact("telegram:1", r.reservationId);
      vi.advanceTimersByTime(48 * 60 * 60 * 1000);
      expect(manager.isCompactPending("telegram:1")).toBe(true);

      // The next turn consumes the trigger and reloads.
      rmSync(trigger, { force: true });
      mockState.compactTriggered = true;
      await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });
      expect(manager.isCompactPending("telegram:1")).toBe(false);
    } finally {
      rmSync(trigger, { force: true });
      vi.useRealTimers();
    }
  });

  it("the compact reload releases the pending mark", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.getOrCreateLiveSession("telegram:1");
    expect(manager.reserveCompact("telegram:1", "sdk-1").ok).toBe(true);
    mockState.compactTriggered = true;
    await manager.runWithRetry({ key: "telegram:1", prompt: "roll up" });
    expect(mockState.instances[0].closed).toBe(true);
    expect(manager.isCompactPending("telegram:1")).toBe(false);
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
    const original = fake(await manager.getOrCreateLiveSession("telegram:1"));
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
    const original = fake(await manager.getOrCreateLiveSession("telegram:1"));

    const mounting = manager.hotMountExternalMcpServer("docs", {
      type: "http",
      url: "https://docs.example/mcp",
    });
    await flushMicrotasks();
    expect(mockState.mcpSetCalls).toHaveLength(1);

    manager.closeLiveSession("telegram:1");
    const replacement = fake(await manager.getOrCreateLiveSession("telegram:1"));
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

describe("LiveSessionManager idle reaper", () => {
  const HOUR = 60 * 60 * 1000;

  async function idleSession(key = "telegram:-100") {
    const manager = new LiveSessionManager(makeDeps());
    const session = await manager.getOrCreateLiveSession(key);
    const fake = mockState.instances[mockState.instances.length - 1];
    return { manager, session, fake, key };
  }

  it("closes a session idle past the timeout, and the next message builds a fresh one", async () => {
    const { manager, fake, key } = await idleSession();
    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR - 1)).toEqual([]);
    expect(fake.closed).toBe(false);

    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
    expect(fake.closed).toBe(true);
    expect(manager.isAlive(key)).toBe(false);

    const next = await manager.getOrCreateLiveSession(key);
    expect(next).not.toBe(fake);
    expect(mockState.instances).toHaveLength(2);
  });

  it("measures idleness from the last hand-out, not from creation", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, key } = await idleSession();
      const created = fake.lastActivityAt();
      vi.advanceTimersByTime(HOUR - 1000);
      await manager.getOrCreateLiveSession(key); // a turn reuses it
      expect(manager.reapIdleSessions(created + HOUR + 1)).toEqual([]);
      expect(fake.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a turn is running", (f: FakeSession) => { f.busy = true; }],
    ["background tasks are live", (f: FakeSession) => { f.background = true; }],
    ["an ambient watcher is live", (f: FakeSession) => { f.ambient = true; }],
    ["a task report is still due", (f: FakeSession) => { f.awaitingReport = true; }],
  ])("keeps an idle-looking session while %s, and restarts its clock", async (_label, arrange) => {
    const { manager, fake } = await idleSession();
    arrange(fake);
    const later = fake.lastActivityAt() + 2 * HOUR;
    expect(manager.reapIdleSessions(later)).toEqual([]);
    expect(fake.closed).toBe(false);
    // The clock restarted at that sweep: settling down does not reap at once.
    Object.assign(fake, { busy: false, background: false, ambient: false, awaitingReport: false });
    expect(manager.reapIdleSessions(fake.lastActivityAt() + 1000)).toEqual([]);
    expect(fake.closed).toBe(false);
  });

  it("stops waiting for a task report once the report window has passed", async () => {
    // The report was folded into a turn that was already running, so the flag
    // never clears: past the window it must not keep the session alive.
    const { manager, fake, key } = await idleSession();
    Object.assign(fake, { awaitingReport: true, awaitingReportAgeMs: PROMPT_RETIRE_REPORT_WAIT_MS });
    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
    expect(fake.closed).toBe(true);
  });

  it("keeps a session whose SDK id the registry has not stored yet, and restarts its clock", async () => {
    // The registry refused the link after a turn: the live session holds the
    // only usable id, and closing it would resume an older one or start fresh.
    const deps = makeDeps();
    deps.setSdkSessionId = vi.fn(() => { throw new Error("session registry could not be read"); });
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => "hello";
    await manager.runWithRetry({ key: "telegram:1", prompt: "hi" });
    const fake = mockState.instances[0];
    const later = fake.lastActivityAt() + 2 * HOUR;
    expect(manager.reapIdleSessions(later)).toEqual([]);
    expect(fake.closed).toBe(false);
    expect(manager.reapIdleSessions(fake.lastActivityAt() + 1000)).toEqual([]);
  });

  it("keeps a session whose compact is waiting on its reload", async () => {
    const { manager, fake, key } = await idleSession();
    expect(manager.reserveCompact(key, "sdk-1").ok).toBe(true);
    expect(manager.reapIdleSessions(fake.lastActivityAt() + 2 * HOUR)).toEqual([]);
    expect(fake.closed).toBe(false);
  });

  it("leaves a prompt-stale session to its own retirement", async () => {
    let prompt = "v1";
    const manager = new LiveSessionManager(makeDeps({ buildIdentityPrompt: () => prompt }));
    await manager.getOrCreateLiveSession("telegram:1");
    const stale = mockState.instances[0];
    stale.busy = true;
    prompt = "v2";
    await manager.getOrCreateLiveSession("telegram:2");
    stale.busy = false; // idle, but retireWhenIdle is still parked on waitForIdle
    expect(manager.reapIdleSessions(stale.lastActivityAt() + 2 * HOUR)).not.toContain("telegram:1");
  });

  it("does nothing when the timeout is 0", async () => {
    mockConfig.liveSessionIdleTimeoutMs = 0;
    const { manager, fake } = await idleSession();
    expect(manager.reapIdleSessions(fake.lastActivityAt() + 100 * HOUR)).toEqual([]);
    expect(fake.closed).toBe(false);
  });

  it("a message that arrives while a reaped session is still exiting waits for it, then resumes", async () => {
    let exited!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exited = r; });
    try {
      const { manager, fake, key } = await idleSession();
      expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
      let resumed = false;
      const next = manager.getOrCreateLiveSession(key).then((s) => { resumed = true; return s; });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 10));
      // The old CLI may still append exit-time records: no second child on the same transcript yet.
      expect(resumed).toBe(false);
      expect(mockState.instances).toHaveLength(1);
      exited();
      const session = await next;
      expect(session).not.toBe(fake);
      expect(mockState.instances).toHaveLength(2);
    } finally {
      mockState.closeGate = null;
    }
  });

  it("a rewind that starts while a reaped session is exiting still holds the key", async () => {
    let exited!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exited = r; });
    const { manager, fake, key } = await idleSession();
    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
    let resumed = false;
    const next = manager.getOrCreateLiveSession(key).then((s) => { resumed = true; return s; });
    await flushMicrotasks(); // parked on the reap close
    const suspending = manager.suspendForRewind(key); // takes the hold now, then waits on the same close
    exited();
    const { release } = await suspending;
    await new Promise((r) => setTimeout(r, 10));
    // Woken by the close, it must see the rewind's hold: nothing built on the pre-rewind conversation.
    expect(resumed).toBe(false);
    expect(mockState.instances).toHaveLength(1);
    release();
    expect(await next).not.toBe(fake);
    expect(mockState.instances).toHaveLength(2);
  });

  it("waits out a child that takes until the SDK's SIGKILL to exit", async () => {
    vi.useFakeTimers();
    try {
      // close → ~2s grace → SIGTERM → 5s → SIGKILL: a child can take ~7s.
      mockState.closeGate = new Promise<void>((r) => { setTimeout(r, SDK_CLI_KILL_MS + 500); });
      const { manager, fake, key } = await idleSession();
      expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
      let resumed = false;
      const next = manager.getOrCreateLiveSession(key).then((s) => { resumed = true; return s; });
      await vi.advanceTimersByTimeAsync(SDK_CLI_KILL_MS + 400);
      expect(resumed).toBe(false);
      expect(mockState.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).not.toBe(fake);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rewind of a reaped key waits for its CLI to exit before snapshotting", async () => {
    let exited!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exited = r; });
    const { manager, fake, key } = await idleSession();
    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
    let suspended = false;
    const suspend = manager.suspendForRewind(key).then((r) => { suspended = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(suspended).toBe(false); // the old CLI may still be writing the transcript being forked
    exited();
    (await suspend).release();
    expect(suspended).toBe(true);
  });

  it("refuses a compact reservation while a reaped session is exiting, and approves it once it is gone", async () => {
    let exited!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exited = r; });
    const { manager, fake, key } = await idleSession();
    expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
    // The CLI rollup would rename the transcript the old child is still writing.
    expect(manager.reserveCompact(key, "sdk-1")).toMatchObject({ ok: false, reason: "session-closing" });
    exited();
    await flushMicrotasks();
    expect(manager.reserveCompact(key, "sdk-1").ok).toBe(true); // the retry
  });

  it("keeps the closing entry where the next lookup finds it", async () => {
    let exited!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exited = r; });
    const { manager, fake, key } = await idleSession();
    manager.reapIdleSessions(fake.lastActivityAt() + HOUR);
    expect(manager.keyForSdkSession("sdk-1")).toBe(key);
    manager.closeLiveSession(key); // e.g. a model switch: must not drop the closing entry
    let resumed = false;
    const next = manager.getOrCreateLiveSession(key).then((s) => { resumed = true; return s; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resumed).toBe(false);
    exited();
    expect(await next).not.toBe(fake);
  });

  it("gives up waiting on a reaped session that never finishes exiting", async () => {
    vi.useFakeTimers();
    mockState.closeGate = new Promise<void>(() => {});
    try {
      const { manager, fake, key } = await idleSession();
      expect(manager.reapIdleSessions(fake.lastActivityAt() + HOUR)).toEqual([key]);
      const next = manager.getOrCreateLiveSession(key);
      await vi.advanceTimersByTimeAsync(IDLE_REAP_CLOSE_WAIT_MS);
      expect(await next).not.toBe(fake);
    } finally {
      mockState.closeGate = null;
      vi.useRealTimers();
    }
  });

  it("keeps a session while an explicit MCP reconnect is running on it", async () => {
    let done!: () => void;
    mockState.reconnectGate = new Promise<void>((r) => { done = r; });
    try {
      const { manager, fake, key } = await idleSession();
      const reconnect = manager.reconnectMcpServer(key, "github");
      await flushMicrotasks();
      expect(manager.reapIdleSessions(fake.lastActivityAt() + 2 * HOUR)).toEqual([]);
      expect(fake.closed).toBe(false);
      done();
      await reconnect;
    } finally {
      mockState.reconnectGate = null;
    }
  });

  it("stops its timer once no session is alive, even if a dead one is still in the map", async () => {
    vi.useFakeTimers();
    try {
      mockConfig.liveSessionIdleTimeoutMs = 5 * IDLE_REAP_SWEEP_MS;
      const { fake } = await idleSession();
      fake.closed = true; // died on its own (crash, error path): nothing reaps it
      vi.advanceTimersByTime(IDLE_REAP_SWEEP_MS);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs on its own timer, and stop() ends it", async () => {
    vi.useFakeTimers();
    try {
      mockConfig.liveSessionIdleTimeoutMs = 5 * IDLE_REAP_SWEEP_MS;
      const { manager, fake } = await idleSession();
      vi.advanceTimersByTime(5 * IDLE_REAP_SWEEP_MS);
      expect(fake.closed).toBe(true);
      await flushMicrotasks(); // the (bounded) wait for the closed CLI to exit settles
      expect(vi.getTimerCount()).toBe(0); // nothing left to watch: the timer stops itself

      await manager.getOrCreateLiveSession("telegram:2");
      expect(vi.getTimerCount()).toBe(1);
      await manager.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LiveSessionManager memory change notes", () => {
  type Lines = { memory: string[]; people: string[] };
  /** Prompt build and the before-turn re-read see the same files by default;
   *  `strictRead` overrides what the strict re-read returns (or throws). */
  function setup(initial: Lines, opts: { strictRead?: () => Lines; identity?: () => string } = {}) {
    let files = initial;
    mockState.buildContext = () => files;
    const manager = new LiveSessionManager(makeDeps({
      ...(opts.identity ? { buildIdentityPrompt: opts.identity } : {}),
      promptContextSnapshot: (_key, { strict }) => (strict && opts.strictRead ? opts.strictRead() : files),
    }));
    return { manager, set: (next: Lines) => { files = next; } };
  }
  const mem = (...memory: string[]): Lines => ({ memory, people: [] });

  it("tells each live session a small added line once, and keeps it", async () => {
    const { manager, set } = setup(mem("- [Travel](travel.md)"));
    const dm = fake(await manager.getOrCreateLiveSession("dm:owner"));
    const group = fake(await manager.getOrCreateLiveSession("telegram:-1"));
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();

    set(mem("- [Travel](travel.md)", "- [Coffee](coffee.md)"));
    expect(await manager.getOrCreateLiveSession("dm:owner")).toBe(dm);
    const ticket = manager.takePromptContextNote("dm:owner")!;
    expect(ticket.prefix).toContain('<tomo-event type="memory" name="changed"');
    expect(ticket.prefix).toContain("+ - [Coffee](coffee.md)");
    expect(ticket.prefix.endsWith("\n\n")).toBe(true);
    manager.settlePromptContextNote(ticket);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    expect(manager.takePromptContextNote("telegram:-1")?.prefix).toContain("Coffee");
    expect(dm.closed).toBe(false);
    expect(group.closed).toBe(false);
    // No live session for the key: the next one is built with the current text.
    expect(manager.takePromptContextNote("telegram:2")).toBeUndefined();
  });

  it("snapshots the lines the prompt was built from, not a second read", async () => {
    let built = mem("- a");
    mockState.buildContext = () => built;
    const manager = new LiveSessionManager(makeDeps({
      promptContextSnapshot: () => mem("- a", "- b"),
    }));
    await manager.getOrCreateLiveSession("dm:owner");
    built = mem("- a", "- b");
    // The prompt holds only "- a": "- b" must be told.
    expect(manager.takePromptContextNote("dm:owner")?.prefix).toContain("+ - b");
  });

  it("tells a change again when its turn did not complete; stale tickets cross nothing", async () => {
    const { manager, set } = setup(mem("- a"));
    await manager.getOrCreateLiveSession("dm:owner");
    set(mem("- a", "- b"));
    const t1 = manager.takePromptContextNote("dm:owner")!;
    manager.restorePromptContextNote(t1);
    const t2 = manager.takePromptContextNote("dm:owner")!;
    expect(t2.prefix).toContain("+ - b");
    set(mem("- a", "- b", "- c"));
    // One note in flight: a steered turn gets none, and t1's late settle
    // does not release t2.
    manager.settlePromptContextNote(t1);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    manager.settlePromptContextNote(t2);
    const t3 = manager.takePromptContextNote("dm:owner")!;
    expect(t3.prefix).toContain("+ - c");
    expect(t3.prefix).not.toContain("+ - b");
    // A stale restore must not roll t3 back to the snapshot before b.
    manager.restorePromptContextNote(t1);
    manager.restorePromptContextNote(t2);
    manager.settlePromptContextNote(t3);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
  });

  it("a ticket from a replaced session does not touch its replacement", async () => {
    const { manager, set } = setup(mem("- a"));
    const old = fake(await manager.getOrCreateLiveSession("dm:owner"));
    set(mem("- a", "- b"));
    const stale = manager.takePromptContextNote("dm:owner")!;
    old.closed = true;
    await manager.getOrCreateLiveSession("dm:owner");
    set(mem("- a", "- b", "- c"));
    const fresh = manager.takePromptContextNote("dm:owner")!;
    expect(fresh.prefix).toContain("+ - c");
    expect(fresh.prefix).not.toContain("+ - b");
    manager.settlePromptContextNote(stale);
    manager.restorePromptContextNote(fresh);
    expect(manager.takePromptContextNote("dm:owner")?.prefix).toContain("+ - c");
  });

  it.each([
    ["lines reordered", mem("## Work", "- a", "## Home"), mem("## Work", "## Home", "- a")],
    ["a heading added", mem("- a"), mem("## New", "- a")],
    ["a heading removed", mem("## Work", "- a"), mem("- a")],
    ["more lines than a note may carry", mem("- a"),
      mem("- a", ...Array.from({ length: 11 }, (_, i) => `- n${i}`))],
  ])("retires the session instead of noting %s", async (_what, before, after) => {
    const { manager, set } = setup(before);
    const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
    set(after);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    // Idle: retired at once, so the turn runs on a session built from the
    // current files.
    expect(first.closed).toBe(true);
    const second = fake(await manager.getOrCreateLiveSession("dm:owner"));
    expect(second).not.toBe(first);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
  });

  it("gives a summoned group's turn on the dm: session no note, and keeps the change for the owner's next turn", async () => {
    let own = true;
    let files = mem("- a");
    mockState.buildContext = () => files;
    const manager = new LiveSessionManager(makeDeps({
      isOwnAudienceTurn: () => own,
      promptContextSnapshot: () => files,
    }));
    await manager.getOrCreateLiveSession("dm:owner");
    files = mem("- a", "- [Secret](private/secret.md)");
    own = false;
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    own = true;
    expect(manager.takePromptContextNote("dm:owner")?.prefix).toContain("+ - [Secret](private/secret.md)");
  });

  it("notes up to the line limit", async () => {
    const { manager, set } = setup(mem("- a"));
    const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
    set(mem("- a", ...Array.from({ length: 10 }, (_, i) => `- n${i}`)));
    expect(manager.takePromptContextNote("dm:owner")?.prefix).toContain("+ - n9");
    expect(first.closed).toBe(false);
  });

  it("a busy session too big to note is retired once its turn ends, and gets no note meanwhile", async () => {
    const { manager, set } = setup(mem("- a"));
    const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
    first.busy = true;
    set(mem("- a", "# Heading"));
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    expect(first.closed).toBe(false);
    expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
    first.busy = false;
    first.releaseIdle();
    await flushMicrotasks();
    expect(first.closed).toBe(true);
  });

  describe("when the strict re-read fails", () => {
    const failing = () => { throw new Error("EACCES"); };

    it("sends no note, and keeps the session when a rebuilt prompt would be the same", async () => {
      const { manager } = setup(mem("- a"), { strictRead: failing });
      const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
      expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
      expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
      expect(first.closed).toBe(false);
    });

    it("sends no note, and retires the session when a rebuilt prompt would differ", async () => {
      const { manager, set } = setup(mem("- a"), { strictRead: failing });
      const first = fake(await manager.getOrCreateLiveSession("dm:owner"));
      set(mem("- a", "- b"));
      expect(manager.takePromptContextNote("dm:owner")).toBeUndefined();
      expect(first.closed).toBe(true);
    });
  });

  describe("on a session that gets replaced", () => {
    function recordSends() {
      const sent: Array<{ prompt: string; session: unknown }> = [];
      return sent;
    }

    it("keeps the note when the turn runs on the session it was written for", async () => {
      const { manager, set } = setup(mem("- a"));
      await manager.getOrCreateLiveSession("dm:owner");
      set(mem("- a", "- b"));
      const ticket = manager.takePromptContextNote("dm:owner")!;
      const sent = recordSends();
      mockState.sendImpl = async (prompt, session) => { sent.push({ prompt, session }); return "ok"; };
      await manager.runWithRetry({ key: "dm:owner", prompt: `${ticket.prefix}hi`, contextNote: ticket });
      expect(sent.map((x) => x.prompt)).toEqual([`${ticket.prefix}hi`]);
    });

    it("drops it when an identity change retires the session before the turn reaches it", async () => {
      let identity = "identity-v1";
      const { manager, set } = setup(mem("- a"), { identity: () => identity });
      const old = fake(await manager.getOrCreateLiveSession("dm:owner"));
      set(mem("- a", "- b"));
      identity = "identity-v2";
      const ticket = manager.takePromptContextNote("dm:owner")!;
      const sent = recordSends();
      mockState.sendImpl = async (prompt, session) => { sent.push({ prompt, session }); return "ok"; };
      await manager.runWithRetry({ key: "dm:owner", prompt: `${ticket.prefix}hi`, contextNote: ticket });
      expect(sent).toHaveLength(1);
      expect(sent[0].session).not.toBe(old);
      expect(sent[0].prompt).toBe("hi");
    });

    it("drops it from the retry after a session error", async () => {
      const { manager, set } = setup(mem("- a"));
      await manager.getOrCreateLiveSession("dm:owner");
      set(mem("- a", "- b"));
      const ticket = manager.takePromptContextNote("dm:owner")!;
      const sent = recordSends();
      mockState.sendImpl = async (prompt, session) => {
        sent.push({ prompt, session });
        if (sent.length === 1) throw new Error("Session is closed");
        return "ok";
      };
      await manager.runWithRetry({ key: "dm:owner", prompt: `${ticket.prefix}hi`, contextNote: ticket });
      expect(sent).toHaveLength(2);
      expect(sent[0].prompt).toBe(`${ticket.prefix}hi`);
      expect(sent[1].session).not.toBe(sent[0].session);
      expect(sent[1].prompt).toBe("hi");
    });
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

  // Every way a turn can end in an error still ends a turn: a restart deferred
  // to the end of this turn must fire. The timeout path retires the session
  // and rethrows from `dispatchTurn`, never reaching `recordTurnCompletion`;
  // the legacy max-turns throw is settled as an answer, not rethrown.
  it.each([
    ["an SDK result error", () => new SdkResultError("boom", "error_during_execution"), "throws"],
    ["a query timeout", () => new Error("Query timed out after 10 minutes"), "throws"],
    ["the legacy max-turns throw", () => new Error("Reached maximum number of turns"), "settles"],
    ["an unrecoverable session error", () => new Error("something entirely unrecognised"), "throws"],
  ] as const)("signals turn completion when the turn ends in %s", async (_label, error, outcome) => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => { throw error(); };

    const run = manager.runWithRetry({ key: "telegram:1", prompt: "hi" });
    if (outcome === "throws") await expect(run).rejects.toThrow();
    else await expect(run).resolves.toBeDefined();

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

  it("retries once when the SDK reports the missing conversation as an error result", async () => {
    // Current SDKs don't throw on a failed resume: they yield an
    // error_during_execution result with turns 0 and put the reason in
    // `errors`, while the message is our generic execution-error text. A group
    // whose stored session had been archived failed every turn this way.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let calls = 0;
    mockState.sendImpl = async () => {
      calls++;
      if (calls === 1) {
        throw new SdkResultError("Something went wrong", "error_during_execution", [
          "No conversation found with session ID: 5a54ee9f-67d2-4ea7-963d-22f68076c89b",
        ], 0);
      }
      return "recovered";
    };

    await expect(manager.runWithRetry({ key: "imessage:group", prompt: "hi" })).resolves.toBe("recovered");
    expect(deps.clearSdkSessionId).toHaveBeenCalledWith("imessage:group");
    expect(mockState.instances).toHaveLength(2);
    expect(mockState.instances[0].closed).toBe(true);
  });

  it("does not retry a missing-conversation result from a turn that ran", async () => {
    // Only a zero-turn result proves nothing ran; anything else may have run
    // tools, and re-running it would repeat them.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => {
      throw new SdkResultError("Something went wrong", "error_during_execution", ["No conversation found with session ID: x"], 3);
    };

    await expect(manager.runWithRetry({ key: "imessage:group", prompt: "hi" })).rejects.toThrow();
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
  });

  it("counts a retried failed resume as one turn", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    let calls = 0;
    mockState.sendImpl = async () => {
      calls++;
      if (calls === 1) throw new SdkResultError("x", "error_during_execution", ["No conversation found with session ID: y"], 0);
      return "recovered";
    };
    const statsBefore = vi.mocked(deps.updateStats).mock.calls.length;

    await manager.runWithRetry({ key: "imessage:group", prompt: "hi" });

    expect(deps.maybeNudgeCompact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.updateStats).mock.calls.length - statsBefore).toBeLessThanOrEqual(1);
  });

  it("does not retry other SDK error results, even ones that mention a closed session", async () => {
    // An error result usually means the turn ran; re-running it would repeat
    // its side effects. Only the missing-conversation reason is retried.
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async () => {
      throw new SdkResultError("Something went wrong", "error_during_execution", ["Session is closed"], 0);
    };

    await expect(manager.runWithRetry({ key: "imessage:group", prompt: "hi" })).rejects.toThrow();
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
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
      onBlock: async (b: string) => { shipped = true; received.push(b); },
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
      onBlock: async (b: string) => { received.push(b); },
      hasShipped: () => received.length > 0,
    } as never);

    expect(response).toBe("A");
    expect(attempts).toBe(2);
    expect(received).toEqual(["A"]);
  });

  it("a /rewind interrupt stops the running turn without retrying it, and holds new turns until released", async () => {
    const deps = makeDeps();
    const manager = new LiveSessionManager(deps);
    const prompts: string[] = [];
    mockState.sendImpl = (prompt, session) => {
      prompts.push(prompt);
      if (prompt !== "stuck") return Promise.resolve("next answer");
      session.busy = true;
      return new Promise<string>((_resolve, reject) => {
        mockState.onInterrupt = (err) => { session.busy = false; reject(err); };
      });
    };

    const stuck = manager.runWithRetry({ key: "dm:owner", prompt: "stuck", hasShipped: () => false });
    await vi.waitFor(() => expect(manager.isBusy("dm:owner")).toBe(true));
    const suspension = await manager.suspendForRewind("dm:owner");
    expect(suspension.stoppedTurn).toBe(true);
    await expect(stuck).rejects.toMatchObject({ name: "TurnInterruptedError" });
    // Not retried: one prompt, one session, and nothing reset.
    expect(prompts).toEqual(["stuck"]);
    expect(mockState.instances).toHaveLength(1);
    expect(deps.clearSdkSessionId).not.toHaveBeenCalled();

    // A turn arriving during the rewind waits, then runs on a fresh session.
    const next = manager.runWithRetry({ key: "dm:owner", prompt: "after" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["stuck"]);
    expect(mockState.instances).toHaveLength(1);
    suspension.release();
    await expect(next).resolves.toBe("next answer");
    expect(prompts).toEqual(["stuck", "after"]);
    expect(mockState.instances).toHaveLength(2);
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

describe("LiveSessionManager forced compaction", () => {
  it("asks onContextOverflow after every turn and skips the nudge when a forced compaction started", async () => {
    const onContextOverflow = vi.fn(() => true);
    const deps = makeDeps({ onContextOverflow });
    const manager = new LiveSessionManager(deps);
    mockState.sendImpl = async (_p, session) => { session.lastResult = { contextUsed: 96, contextMax: 100 }; return "ok"; };
    await manager.runWithRetry({ key: "telegram:-1", prompt: "hi" });
    expect(onContextOverflow).toHaveBeenCalledWith("telegram:-1", { contextUsed: 96, contextMax: 100 }, "threshold");
    expect(deps.maybeNudgeCompact).not.toHaveBeenCalled();

    onContextOverflow.mockReturnValue(false);
    await manager.runWithRetry({ key: "telegram:-1", prompt: "again" });
    expect(deps.maybeNudgeCompact).toHaveBeenCalledTimes(1);
  });

  it("reports a turn the CLI refused with \"Prompt is too long\" as prompt-too-long", async () => {
    const onContextOverflow = vi.fn(() => false);
    const manager = new LiveSessionManager(makeDeps({ onContextOverflow }));
    mockState.sendImpl = async () => { throw new SdkResultError("Prompt is too long", "success"); };
    await expect(manager.runWithRetry({ key: "dm:owner", prompt: "hi" })).rejects.toThrow("Prompt is too long");
    expect(onContextOverflow.mock.calls).toEqual([["dm:owner", null, "prompt-too-long"]]);

    onContextOverflow.mockClear();
    mockState.sendImpl = async () => { throw new SdkResultError("API Error: 500 overloaded", "success"); };
    await expect(manager.runWithRetry({ key: "dm:owner", prompt: "hi" })).rejects.toThrow("overloaded");
    // Reported once, as what it was: neither a normal end nor a size refusal.
    expect(onContextOverflow.mock.calls.map((c) => c[2])).toEqual(["turn-failed"]);
  });

  it("holds the key: a turn waits, the live session is closed after beforeClose, and the turn runs on a new session after release", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    const first = mockState.instances[0];
    first.background = true;

    const hold = manager.holdForForceCompact("dm:owner")!;
    expect(hold).not.toBeNull();
    const sent: string[] = [];
    mockState.sendImpl = async (prompt) => { sent.push(prompt); return "ok"; };
    const queued = manager.runWithRetry({ key: "dm:owner", prompt: "queued" });
    await flushMicrotasks(20);
    expect(sent).toEqual([]);

    const order: string[] = [];
    const beforeClose = vi.fn(() => { order.push(first.closed ? "closed" : "open"); return true; });
    const sid = await manager.quiesceForForceCompact(hold, beforeClose);
    expect(sid).toBe("sdk-1");
    // The background work was recorded while the session (and its tasks) still ran, then it was closed.
    expect(order).toEqual(["open"]);
    expect(first.closed).toBe(true);
    await flushMicrotasks(20);
    expect(sent).toEqual([]);

    hold.release();
    await queued;
    expect(sent).toEqual(["queued"]);
    expect(mockState.instances.length).toBe(2);
  });

  it("rewrites nothing while the closed session's CLI has not exited (bounded wait, then null)", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    let exit!: () => void;
    mockState.closeGate = new Promise<void>((r) => { exit = r; });
    vi.useFakeTimers();
    let hold!: NonNullable<ReturnType<typeof manager.holdForForceCompact>>;
    try {
      hold = manager.holdForForceCompact("dm:owner")!;
      const result = manager.quiesceForForceCompact(hold, () => true);
      await vi.advanceTimersByTimeAsync(IDLE_REAP_CLOSE_WAIT_MS + 10);
      expect(await result).toBeNull();
      expect(mockState.instances[0].closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Released, but the key stays held until that CLI is really gone.
    hold.release();
    const sent: string[] = [];
    mockState.sendImpl = async (prompt) => { sent.push(prompt); return "ok"; };
    const next = manager.runWithRetry({ key: "dm:owner", prompt: "after" });
    await flushMicrotasks(20);
    expect(sent).toEqual([]);
    expect(manager.holdForForceCompact("dm:owner")).toBeNull();
    exit();
    await next;
    expect(sent).toEqual(["after"]);
  });

  it("records the background work BEFORE interrupting a turn that would not end (interrupting empties the task set)", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    const first = mockState.instances[0];
    first.busy = true;
    const hold = manager.holdForForceCompact("dm:owner")!;
    const seen: Array<boolean> = [];
    const sid = await manager.quiesceForForceCompact(hold, () => { seen.push(first.interruptedWith === null && !first.closed); return true; }, 5);
    expect(seen).toEqual([true]);
    expect(first.interruptedWith).not.toBeNull();
    expect(sid).toBe("sdk-1");
    hold.release();
  });

  it("does not compact a session whose SDK id the registry has not stored (the next session could not resume it)", async () => {
    const setSdkSessionId = vi.fn(() => { throw new Error("registry unreadable"); });
    const manager = new LiveSessionManager(makeDeps({ setSdkSessionId }));
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    const hold = manager.holdForForceCompact("dm:owner")!;
    const beforeClose = vi.fn(() => true);
    expect(await manager.quiesceForForceCompact(hold, beforeClose)).toBeNull();
    expect(beforeClose).not.toHaveBeenCalled();
    expect(mockState.instances[0].closed).toBe(false);
    hold.release();
  });

  it("aborts with the session untouched when beforeClose refuses", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    const hold = manager.holdForForceCompact("dm:owner")!;
    expect(await manager.quiesceForForceCompact(hold, () => false)).toBeNull();
    expect(mockState.instances[0].closed).toBe(false);
    hold.release();
  });

  it("never runs two rewrites of a session at once: forced and normal reservations exclude each other", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    // A `tomo lcm` rewrite in flight blocks a forced compaction…
    const normal = manager.reserveCompact("dm:owner", "sdk-1");
    expect(normal.ok).toBe(true);
    expect(manager.holdForForceCompact("dm:owner")).toBeNull();
    if (normal.ok) manager.finishCompact("dm:owner", normal.reservationId);

    // …and a forced one blocks every other rewrite (and a second forced one) until released.
    const hold = manager.holdForForceCompact("dm:owner")!;
    expect(hold).not.toBeNull();
    expect(manager.holdForForceCompact("dm:owner")).toBeNull();
    const refused = manager.reserveCompact("dm:owner", "sdk-1");
    expect(refused).toMatchObject({ ok: false, reason: "already-pending" });
    hold.release();
    expect(manager.reserveCompact("dm:owner", "sdk-1").ok).toBe(true);
  });

  it("is not blocked by background work (that is what it stops)", async () => {
    const manager = new LiveSessionManager(makeDeps());
    await manager.runWithRetry({ key: "dm:owner", prompt: "first" });
    mockState.instances[0].background = true;
    expect(manager.reserveCompact("dm:owner", "sdk-1")).toMatchObject({ ok: false, reason: "background-tasks" });
    const hold = manager.holdForForceCompact("dm:owner");
    expect(hold).not.toBeNull();
    hold!.release();
  });
});
