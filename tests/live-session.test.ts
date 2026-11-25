import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controllable mock SDK — the test pushes events by hand and inspects the
// user messages LiveSession feeds through its input generator. Mirrors the
// real SDK's eager input pump: messages are consumed from the generator as
// soon as they're yielded, independent of turn state (that's what makes
// mid-turn steering possible).
// ---------------------------------------------------------------------------

type AnyEvent = Record<string, unknown>;

interface Harness {
  inputs: string[];
  uuids: Array<string | undefined>;
  priorities: Array<string | undefined>;
  origins: Array<unknown>;
  pushEvent: (e: AnyEvent) => void;
  fail: (err: Error) => void;
}

const harnessRef = vi.hoisted(() => ({ current: null as Harness | null }));
const mcpRuntime = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<Record<string, unknown>>,
}));

const interruptState = vi.hoisted(() => ({ calls: 0, fail: false }));
/** The CLI child's exit, as the SDK's asyncDispose waits for it; null: already exited. */
const exitState = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  /** The CLI child the runtime Query holds (q.transport.process); undefined: none exposed. */
  child: undefined as undefined | { exitCode: number | null; signalCode: string | null; once(e: string, l: () => void): unknown },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> }; priority?: string; origin?: unknown; uuid?: string }> }) => {
    const inputs: string[] = [];
    const uuids: Array<string | undefined> = [];
    const priorities: Array<string | undefined> = [];
    const origins: Array<unknown> = [];
    const eventQueue: AnyEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    // Eager input pump, like the real SDK's streamInput.
    (async () => {
      for await (const msg of prompt) {
        let text = "";
        for (const b of msg.message.content) {
          if (b.type === "text") text += b.text ?? "";
        }
        inputs.push(text);
        uuids.push(msg.uuid);
        priorities.push(msg.priority);
        origins.push(msg.origin);
      }
    })().catch(() => {});

    harnessRef.current = {
      inputs,
      uuids,
      priorities,
      origins,
      pushEvent: (e) => { eventQueue.push(e); wake?.(); },
      fail: (err) => { error = err; wake?.(); },
    };

    const queryHandle: Record<string, unknown> = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (eventQueue.length === 0 && !done && !error) {
            await new Promise<void>((r) => { wake = r; });
            wake = null;
          }
          if (eventQueue.length > 0) { yield eventQueue.shift()!; continue; }
          if (error) throw error;
          return;
        }
      },
      close: () => { done = true; wake?.(); },
      [Symbol.asyncDispose]: async () => { await exitState.gate; },
      transport: { process: exitState.child },
      interrupt: async () => { interruptState.calls++; if (interruptState.fail) throw new Error("not connected"); },
      getContextUsage: async () => ({ totalTokens: 100, maxTokens: 1000, percentage: 10, categories: [] }),
      getTaskOutput: async (taskId: string) => taskId === "b1" ? { output: "line 1\nline 2", size: 4096 } : { output: 7 },
    };
    if (mcpRuntime.available) {
      queryHandle.setMcpServers = async (servers: Record<string, unknown>) => {
        mcpRuntime.calls.push(servers);
        return { added: Object.keys(servers), removed: [], errors: {} };
      };
    }
    return queryHandle;
  }),
}));

vi.mock("../src/agent/sdk-options.js", () => ({
  resetTurnBudget: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  LiveSession,
  MAX_MCP_AUTH_REFRESHES_PER_WINDOW,
  MCP_AUTH_REFRESH_WINDOW_MS,
  EMPTY_REPLY,
  STEER_MERGED,
  SdkResultError,
} = await import("../src/agent/live-session.js");
const { log } = await import("../src/logger.js");
type UsageLedgerRow = import("../src/usage/ledger.js").UsageLedgerRow;
type ModelCounters = import("../src/sessions/types.js").ModelCounters;
const TIMEOUT_MS = 10 * 60 * 1000;

function makeSession(settings?: {
  timeoutMs?: number;
  showThinking?: boolean;
  onMcpAuthError?: (serverName: string) => Promise<string> | string;
  now?: () => number;
  onToolResult?: (toolName: string, content: unknown, isError: boolean) => void;
  resumeFrom?: {
    sdkSessionId: string;
    baseline?: {
      sdkSessionId: string;
      totalCostUsd: number;
      tokens: { input: number; output: number; cacheRead: number; cacheCreated: number };
      models?: Record<string, ModelCounters>;
    };
  };
  recordUsage?: (build: () => UsageLedgerRow | undefined, onWritten: () => void) => void;
  onInformational?: (message: import("@anthropic-ai/claude-agent-sdk").SDKInformationalMessage) => void;
}) {
  const session = new LiveSession({} as never, "test:session", undefined, undefined, settings);
  const harness = harnessRef.current!;
  return { session, harness };
}

describe("LiveSession.interrupt (/rewind)", () => {
  it("rejects the turn with TurnInterruptedError and ships nothing the SDK hands over afterwards", async () => {
    const { TurnInterruptedError } = await import("../src/agent/live-session.js");
    const unownedBlocks: string[] = [];
    const factory = vi.fn(() => ({
      resolve: () => {},
      reject: () => {},
      onBlock: (block: string) => { unownedBlocks.push(block); },
    }));
    const session = new LiveSession({} as never, "dm:owner", undefined, factory);
    const harness = harnessRef.current!;
    const shipped: string[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const turn = session.send("Work", undefined, undefined, async (block) => {
      shipped.push(block);
      if (shipped.length === 1) await blocked; // a slow channel send, mid-turn
    });
    const outcome = turn.then(() => null, (err: Error) => err);

    harness.pushEvent(assistantEvent("First block"));
    await waitFor(() => shipped.length === 1);
    // Already buffered when /rewind arrives.
    harness.pushEvent(assistantEvent("Second block"));
    session.interrupt(new TurnInterruptedError());
    expect(await outcome).toBeInstanceOf(TurnInterruptedError);

    unblock();
    await session.whenEventLoopDone();
    expect(shipped).toEqual(["First block"]);
    expect(factory).not.toHaveBeenCalled();
    expect(unownedBlocks).toEqual([]);
  });
});

describe("LiveSession tool-result observation", () => {
  it("notifies after the SDK emits a named tool result", async () => {
    const onToolResult = vi.fn();
    const { session, harness } = makeSession({ onToolResult });

    harness.pushEvent(assistantToolEvent("Bash", "tool-1"));
    harness.pushEvent(toolResultEvent("tool-1", "scheduled"));

    await waitFor(() => onToolResult.mock.calls.length === 1);
    // No turn is running here, so there is no reply context to hand over.
    expect(onToolResult).toHaveBeenCalledWith("Bash", "scheduled", false, undefined);
    session.close();
  });
});

describe("LiveSession background-task tracking", () => {
  it("tracks non-ambient tasks from background_tasks_changed and wakes waiters when the set empties", async () => {
    const { session, harness } = makeSession({});
    expect(session.hasActiveBackgroundTasks()).toBe(false);

    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
      tasks: [
        { task_id: "a1", task_type: "local_agent", description: "review" },
        { task_id: "w1", task_type: "monitor", description: "watcher", ambient: true },
      ],
    });
    await waitFor(() => session.hasActiveBackgroundTasks());

    const drained = session.waitForBackgroundIdle(5_000);
    // Only the ambient watcher left: that is not activity.
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u2",
      tasks: [{ task_id: "w1", task_type: "monitor", description: "watcher", ambient: true }],
    });
    expect(await drained).toBe(true);
    expect(session.hasActiveBackgroundTasks()).toBe(false);
    session.close();
  });

  it("counts ambient watchers as live tasks for the idle reaper, and SDK events as activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { session, harness } = makeSession({});
      const created = session.lastActivityAt();
      expect(session.hasAnyLiveTasks()).toBe(false);

      vi.setSystemTime(created + 60_000);
      harness.pushEvent({
        type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
        tasks: [{ task_id: "w1", task_type: "monitor", description: "watcher", ambient: true }],
      });
      await waitFor(() => session.hasAnyLiveTasks());
      expect(session.hasActiveBackgroundTasks()).toBe(false);
      expect(session.lastActivityAt()).toBe(created + 60_000);

      harness.pushEvent({ type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u2", tasks: [] });
      await waitFor(() => !session.hasAnyLiveTasks());

      vi.setSystemTime(created + 120_000);
      session.noteActivity();
      expect(session.lastActivityAt()).toBe(created + 120_000);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("whenClosed() waits for the CLI child to exit after close()", async () => {
    let exit!: () => void;
    exitState.gate = new Promise<void>((r) => { exit = r; });
    try {
      const { session } = makeSession({});
      session.close();
      let gone = false;
      void session.whenClosed().then(() => { gone = true; });
      await session.whenEventLoopDone();
      await new Promise((r) => setTimeout(r, 5));
      expect(gone).toBe(false); // event loop over, child still exiting
      exit();
      await session.whenClosed();
      expect(gone).toBe(true);
    } finally {
      exitState.gate = null;
    }
  });

  it("whenClosed() waits for the CLI child itself, past the SDK's own bounded exit wait", async () => {
    const { EventEmitter } = await import("node:events");
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
    exitState.child = child;
    try {
      const { session } = makeSession({});
      session.close(); // the SDK's dispose resolves at once (its ~2s wait already gave up)
      let gone = false;
      void session.whenClosed().then(() => { gone = true; });
      await new Promise((r) => setTimeout(r, 5));
      expect(gone).toBe(false); // the child is still running: it may still write the transcript
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await session.whenClosed();
      expect(gone).toBe(true);
    } finally {
      exitState.child = undefined;
    }
  });

  it("whenClosed() does not wait on a child that has already exited", async () => {
    exitState.child = { exitCode: 0, signalCode: null, once: () => undefined };
    try {
      const { session } = makeSession({});
      session.close();
      await session.whenClosed();
    } finally {
      exitState.child = undefined;
    }
  });

  it("marks a drain as awaiting the report turn; a user turn doesn't clear it, an SDK-initiated one does", async () => {
    const factory = vi.fn(() => ({ resolve: () => {}, reject: () => {}, onBlock: () => {} }));
    const session = new LiveSession({} as never, "dm:owner", undefined, factory);
    const harness = harnessRef.current!;
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
      tasks: [{ task_id: "a1", task_type: "local_agent", description: "review" }],
    });
    await waitFor(() => session.hasActiveBackgroundTasks());
    expect(session.isAwaitingTaskReport()).toBe(false);
    harness.pushEvent({ type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u2", tasks: [] });
    await waitFor(() => !session.hasActiveBackgroundTasks());
    expect(session.isAwaitingTaskReport()).toBe(true);

    // A user message claims the session first: waiters wake, flag stays.
    const started = session.waitForTurnStart(5_000);
    const turn = session.send("hi", undefined, undefined, () => {});
    expect(await started).toBe(true);
    expect(session.isAwaitingTaskReport()).toBe(true);
    harness.pushEvent(assistantEvent("hello"));
    harness.pushEvent(resultEvent());
    await turn;

    // The SDK-initiated report turn clears it.
    harness.pushEvent(assistantEvent("the review finished"));
    await waitFor(() => factory.mock.calls.length === 1);
    expect(session.isAwaitingTaskReport()).toBe(false);
    session.close();
  });

  it("publishes full task records to the watch bus, REPLACE per change, and an empty set on close", async () => {
    const { watchBus } = await import("../src/watch/bus.js");
    const seen: Array<{ tasks: Array<Record<string, unknown>>; ended?: unknown }> = [];
    const unsubscribe = watchBus.subscribe((e) => { if (e.type === "tasks" && e.sessionKey === "test:session") seen.push(e); });
    const { session, harness } = makeSession({});
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
      tasks: [
        { task_id: "a1", run_id: "r1", task_type: "local_agent", subagent_type: "Explore", description: "review", parent_task_id: "p0" },
        { task_id: "w1", task_type: "monitor", description: "watcher", ambient: true },
      ],
    });
    await waitFor(() => seen.length === 1);
    expect(seen[0].tasks).toMatchObject([
      { taskId: "a1", runId: "r1", taskType: "local_agent", subagentType: "Explore", description: "review", parentTaskId: "p0", ambient: false },
      { taskId: "w1", taskType: "monitor", ambient: true },
    ]);
    expect(typeof seen[0].tasks[0].startedAt).toBe("number");
    harness.pushEvent({ type: "system", subtype: "task_progress", session_id: "s", uuid: "u2", task_id: "a1", run_id: "r1",
      description: "review", last_tool_name: "Grep", usage: { total_tokens: 5, tool_uses: 1, duration_ms: 1 } });
    await waitFor(() => seen.length === 2);
    expect(seen[1].tasks[0]).toMatchObject({ lastTool: "Grep", toolUses: 1 });
    harness.pushEvent({ type: "system", subtype: "task_notification", session_id: "s", uuid: "u3", task_id: "a1", status: "completed",
      output_file: "", summary: "" });
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u4",
      tasks: [{ task_id: "w1", task_type: "monitor", description: "watcher", ambient: true }],
    });
    await waitFor(() => seen.length === 4);
    expect(seen[3]).toMatchObject({ tasks: [{ taskId: "w1" }], ended: [{ taskId: "a1", status: "completed" }] });
    // The ambient watcher is not activity for the retire logic.
    expect(session.hasActiveBackgroundTasks()).toBe(false);
    session.close();
    expect(seen.at(-1)!.tasks).toEqual([]);
    unsubscribe();
  });

  it("reads a shell task's output tail through the runtime Query, and nothing once closed", async () => {
    const { session } = makeSession({});
    expect(await session.getTaskOutput("b1")).toEqual({ output: "line 1\nline 2", size: 4096 });
    expect(await session.getTaskOutput("bad-shape")).toBeUndefined();
    session.close();
    expect(await session.getTaskOutput("b1")).toBeUndefined();
  });

  it("close() wakes a pending background waiter", async () => {
    const { session, harness } = makeSession({});
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
      tasks: [{ task_id: "a1", task_type: "local_agent", description: "review" }],
    });
    await waitFor(() => session.hasActiveBackgroundTasks());
    const waiting = session.waitForBackgroundIdle(60_000);
    session.close();
    expect(await waiting).toBe(true);
  });

  it("waitForBackgroundIdle times out while a task is still live", async () => {
    const { session, harness } = makeSession({});
    harness.pushEvent({
      type: "system", subtype: "background_tasks_changed", session_id: "s", uuid: "u1",
      tasks: [{ task_id: "a1", task_type: "local_agent", description: "review" }],
    });
    await waitFor(() => session.hasActiveBackgroundTasks());
    expect(await session.waitForBackgroundIdle(5)).toBe(false);
    session.close();
  });
});

async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking, signature: "sig" });
const assistantEvent = (text: string) => ({ type: "assistant", message: { content: [textBlock(text)] } });
const toolUseBlock = (name: string, id: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const assistantToolEvent = (name: string, id: string, input?: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [toolUseBlock(name, id, input)] },
});
const toolResultEvent = (id: string, content = "ok") => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
// The CLI only echoes consumed steered messages as isReplay user events
// (and only with --replay-user-messages); plain user events are tool
// results or synthetic context and must never trigger merge detection.
const userEcho = (text: string) => ({ type: "user", isReplay: true, message: { content: [textBlock(text)] } });
const nonReplayUserEvent = (text: string) => ({ type: "user", message: { content: [textBlock(text)] } });
const resultEvent = () => ({
  type: "result",
  subtype: "success",
  session_id: "sid-1",
  total_cost_usd: 0,
  num_turns: 1,
  duration_ms: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  harnessRef.current = null;
  mcpRuntime.available = true;
  mcpRuntime.calls = [];
  interruptState.calls = 0;
  interruptState.fail = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// Issue #299 defect 1: a live session's Bearer header is minted once, at
// session build time. When the mounted server rejects a call because that
// token expired, the host has to hear about it or the session stays broken
// until a restart.
describe("LiveSession MCP authorization errors", () => {
  const errorResult = (id: string, content: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] },
  });

  it("reports an expired-token tool failure to the host and re-mounts", async () => {
    const onMcpAuthError = vi.fn(async () => "refreshed");
    const { session, harness } = makeSession({ onMcpAuthError });

    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t1"));
    harness.pushEvent(errorResult("t1", 'MCP server "cloudflare-api" requires re-authorization (token expired)'));
    await waitFor(() => onMcpAuthError.mock.calls.length > 0);
    expect(onMcpAuthError).toHaveBeenCalledWith("cloudflare-api");
    session.close();
  });

  // Codex review, objection 3: the latch used to be set before the outcome
  // was known, so a 401 arriving during /mcp login (or a transient token
  // endpoint failure) permanently consumed the session's only attempt.
  it("does not charge the retry budget when the host skips the refresh", async () => {
    const onMcpAuthError = vi.fn(async () => "skipped");
    const { session, harness } = makeSession({ onMcpAuthError });

    for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
      harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", id));
      harness.pushEvent(errorResult(id, "HTTP 401 Unauthorized"));
      await waitFor(() => onMcpAuthError.mock.calls.length >= Number(id.slice(1)));
    }

    // Every one of them got through: `skipped` costs nothing.
    expect(onMcpAuthError).toHaveBeenCalledTimes(5);
    session.close();
  });

  it("recovers after a transient refresh failure instead of latching forever", async () => {
    const outcomes = ["failed", "refreshed"];
    const onMcpAuthError = vi.fn(async () => outcomes.shift() ?? "refreshed");
    const { session, harness } = makeSession({ onMcpAuthError });

    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t1"));
    harness.pushEvent(errorResult("t1", "HTTP 401 Unauthorized"));
    await waitFor(() => onMcpAuthError.mock.calls.length === 1);

    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t2"));
    harness.pushEvent(errorResult("t2", "HTTP 401 Unauthorized"));
    await waitFor(() => onMcpAuthError.mock.calls.length === 2);

    expect(onMcpAuthError).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("bounds refreshes per server inside the rate window", async () => {
    const onMcpAuthError = vi.fn(async () => "refreshed");
    const { session, harness } = makeSession({ onMcpAuthError, now: () => 1_000_000 });

    for (let i = 0; i < MAX_MCP_AUTH_REFRESHES_PER_WINDOW + 3; i++) {
      harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", `t${i}`));
      harness.pushEvent(errorResult(`t${i}`, "unauthorized"));
      await flushMicrotasks(10);
    }
    await flushMicrotasks(20);

    expect(onMcpAuthError).toHaveBeenCalledTimes(MAX_MCP_AUTH_REFRESHES_PER_WINDOW);
    // A different server keeps its own budget.
    harness.pushEvent(assistantToolEvent("mcp__docs__search", "d1"));
    harness.pushEvent(errorResult("d1", "unauthorized"));
    await waitFor(() => onMcpAuthError.mock.calls.some((c) => c[0] === "docs"));
    session.close();
  });

  // Codex round 3, finding 3: a lifetime quota would strand a long-lived
  // session forever — a token stored without `expiresAt` is invisible to the
  // proactive sweep, so this backstop is the only thing that can renew it.
  it("allows refreshes again once the rate window has rolled over", async () => {
    let clock = 1_000_000;
    const onMcpAuthError = vi.fn(async () => "refreshed");
    const { session, harness } = makeSession({ onMcpAuthError, now: () => clock });

    for (let i = 0; i < MAX_MCP_AUTH_REFRESHES_PER_WINDOW + 2; i++) {
      harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", `t${i}`));
      harness.pushEvent(errorResult(`t${i}`, "unauthorized"));
      await flushMicrotasks(10);
    }
    await flushMicrotasks(20);
    expect(onMcpAuthError).toHaveBeenCalledTimes(MAX_MCP_AUTH_REFRESHES_PER_WINDOW);

    // Hours later, the same session hits an expired token again.
    clock += MCP_AUTH_REFRESH_WINDOW_MS + 1;
    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "later"));
    harness.pushEvent(errorResult("later", "unauthorized"));
    await waitFor(() => onMcpAuthError.mock.calls.length === MAX_MCP_AUTH_REFRESHES_PER_WINDOW + 1);

    expect(onMcpAuthError).toHaveBeenCalledTimes(MAX_MCP_AUTH_REFRESHES_PER_WINDOW + 1);
    session.close();
  });

  it("does not ask twice while a refresh is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onMcpAuthError = vi.fn(async () => { await gate; return "refreshed"; });
    const { session, harness } = makeSession({ onMcpAuthError });

    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t1"));
    harness.pushEvent(errorResult("t1", "HTTP 401 Unauthorized"));
    await waitFor(() => onMcpAuthError.mock.calls.length === 1);
    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t2"));
    harness.pushEvent(errorResult("t2", "HTTP 401 Unauthorized"));
    await flushMicrotasks(20);

    expect(onMcpAuthError).toHaveBeenCalledTimes(1);
    release();
    session.close();
  });

  it("ignores tool failures that are not MCP authorization errors", async () => {
    const onMcpAuthError = vi.fn();
    const { session, harness } = makeSession({ onMcpAuthError });

    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t1"));
    harness.pushEvent(errorResult("t1", "zone not found"));
    harness.pushEvent(assistantToolEvent("Bash", "t2"));
    harness.pushEvent(errorResult("t2", "401 Unauthorized"));
    harness.pushEvent(assistantToolEvent("mcp__cloudflare-api__docs", "t3"));
    harness.pushEvent(toolResultEvent("t3", "401 Unauthorized"));
    await flushMicrotasks(20);

    expect(onMcpAuthError).not.toHaveBeenCalled();
    session.close();
  });
});

describe("LiveSession runtime MCP management", () => {
  it("delegates the complete server map to a capable live query", async () => {
    const { session } = makeSession();
    const servers = {
      docs: { type: "http" as const, url: "https://docs.example/mcp" },
      internal: { type: "sdk" as const, name: "internal", instance: {} as never },
    };

    await expect(session.setMcpServers(servers)).resolves.toEqual({
      added: ["docs", "internal"],
      removed: [],
      errors: {},
    });
    expect(mcpRuntime.calls).toEqual([servers]);
    session.close();
  });

  it("returns null when an older live query lacks setMcpServers", async () => {
    mcpRuntime.available = false;
    const { session } = makeSession();

    await expect(session.setMcpServers({})).resolves.toBeNull();
    expect(mcpRuntime.calls).toHaveLength(0);
    session.close();
  });
});

describe("LiveSession timeouts", () => {
  it("uses a configured inactivity timeout", async () => {
    vi.useFakeTimers();
    const { session, harness } = makeSession({ timeoutMs: 250 });

    const p = session.send("short timeout");
    const rejected = expect(p).rejects.toThrow("Query timed out after 250ms");
    await flushMicrotasks();
    expect(harness.inputs).toEqual(["short timeout"]);

    await vi.advanceTimersByTimeAsync(249);
    expect(session.isAlive()).toBe(true);
    expect(session.isBusy()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(session.isAlive()).toBe(false);
    expect(session.isBusy()).toBe(false);
  });

  it("closes the live session when a send times out", async () => {
    vi.useFakeTimers();
    const { session, harness } = makeSession();

    const p = session.send("slow");
    const rejected = expect(p).rejects.toThrow("Query timed out after 10 minutes");
    await flushMicrotasks();
    expect(harness.inputs).toEqual(["slow"]);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await rejected;

    expect(session.isAlive()).toBe(false);
    expect(session.isBusy()).toBe(false);
    await expect(session.send("next")).rejects.toThrow("Session is closed");
    expect(harness.inputs).toEqual(["slow"]);
  });

  it("resets the timeout when SDK activity arrives during a long send", async () => {
    vi.useFakeTimers();
    const { session, harness } = makeSession();

    const p = session.send("research");
    await flushMicrotasks();
    expect(harness.inputs).toEqual(["research"]);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 2000);
    harness.pushEvent(assistantToolEvent("WebSearch", "tool-1", { query: "long research" }));
    await flushMicrotasks(20);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith({ tool: "WebSearch" }, "WebSearch: long research");
    await vi.advanceTimersByTimeAsync(1000);

    expect(session.isAlive()).toBe(true);
    expect(session.isBusy()).toBe(true);
    await flushMicrotasks(20);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 2000);
    harness.pushEvent(toolResultEvent("tool-1", "done"));
    await flushMicrotasks(20);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { tool: "WebSearch" },
      "WebSearch result: done",
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(session.isAlive()).toBe(true);
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("done"));
    harness.pushEvent(resultEvent());
    await expect(p).resolves.toBe("done");
    expect(session.isBusy()).toBe(false);
  });

  it("closes the live session when a promoted steered turn goes inactive", async () => {
    vi.useFakeTimers();
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await flushMicrotasks();
    expect(harness.inputs).toEqual(["first"]);

    const p2 = session.steer("second");
    const p2Rejected = expect(p2).rejects.toThrow("Query timed out after 10 minutes");
    await flushMicrotasks();
    expect(harness.inputs).toEqual(["first", "second"]);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");
    expect(session.isBusy()).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(session.isAlive()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await p2Rejected;

    expect(session.isAlive()).toBe(false);
    expect(session.isBusy()).toBe(false);
    await expect(session.send("third")).rejects.toThrow("Session is closed");
    expect(harness.inputs).toEqual(["first", "second"]);
  });
});

describe("LiveSession steering", () => {
  it("merges a steered message into the in-flight turn when the CLI echoes it", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("part one"));
    harness.pushEvent(userEcho("second"));
    harness.pushEvent(assistantEvent("part two"));
    harness.pushEvent(resultEvent());

    await expect(p1).resolves.toBe("part one\npart two");
    await expect(p2).resolves.toBe(STEER_MERGED);
    expect(session.isBusy()).toBe(false);
    // Plain sends carry no priority; steered messages are explicit "next".
    expect(harness.priorities[0]).toBeUndefined();
    expect(harness.priorities[1]).toBe("next");
  });

  /**
   * A user message steered into a turn whose OWN output is suppressed
   * (heartbeat, LCM rollup, context nudge) is answered in that turn's reply
   * text — which the host drops before it reaches the chat ("Cron output
   * suppressed from chat delivery"). The model has to be told, on the message
   * itself, that send_message is the only way to answer it.
   */
  it("tells a steered message it landed in a silent turn", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("heartbeat", undefined, undefined, undefined, undefined, undefined, true);
    await waitFor(() => harness.inputs.length === 1);

    const p2 = session.steer("what's on my calendar?");
    await waitFor(() => harness.inputs.length === 2);

    expect(harness.inputs[1]).toBe(
      "what's on my calendar?\n[harness: this message arrived during a silent turn — "
      + "your reply text will NOT be delivered. Answer it with send_message "
      + "(target: test:session, mode: direct).]",
    );

    // The CLI echoes back what it received — note included — so merge
    // detection still recognises it.
    harness.pushEvent(userEcho(harness.inputs[1]));
    harness.pushEvent(assistantEvent("done"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("done");
    await expect(p2).resolves.toBe(STEER_MERGED);
  });

  it("leaves a steered message alone when the in-flight turn does deliver", async () => {
    const { session, harness } = makeSession();

    // No silentDelivery: an ordinary user (or plain cron) turn ships its
    // reply text, so the steered question is answered in the chat as before.
    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    const p2 = session.steer("what's on my calendar?");
    await waitFor(() => harness.inputs.length === 2);

    expect(harness.inputs[1]).toBe("what's on my calendar?");
    expect(harness.inputs[1]).not.toContain("[harness:");

    harness.pushEvent(userEcho("what's on my calendar?"));
    harness.pushEvent(assistantEvent("nothing until 3pm"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("nothing until 3pm");
    await expect(p2).resolves.toBe(STEER_MERGED);
  });

  it("ignores non-replay user events for merge detection", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    // Same text but not an isReplay event — must not count as merged.
    harness.pushEvent(nonReplayUserEvent("second"));
    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");

    // The steer spills to its own follow-up turn instead.
    expect(session.isBusy()).toBe(true);
    harness.pushEvent(assistantEvent("reply two"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two");
  });

  it("resolves doubly-spilled steers in order across separate follow-up turns", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    const p3 = session.steer("third");
    await waitFor(() => harness.inputs.length === 3);

    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");

    // No echoes — the CLI ran each spilled steer as its own turn. The
    // second steer must NOT be mis-resolved as merged into the first
    // follow-up turn.
    harness.pushEvent(assistantEvent("reply two"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two");
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("reply three"));
    harness.pushEvent(resultEvent());
    await expect(p3).resolves.toBe("reply three");
    expect(session.isBusy()).toBe(false);
  });

  it("folds remaining steers into the promoted turn when its batch echo arrives", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    const p3 = session.steer("third");
    await waitFor(() => harness.inputs.length === 3);

    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");

    // Turn 2 starts with the CLI batching the queued steers into one turn;
    // the batch echo includes the promoted steer's own text.
    harness.pushEvent(userEcho("second"));
    harness.pushEvent(assistantEvent("reply two+three"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two+three");
    await expect(p3).resolves.toBe(STEER_MERGED);
    expect(session.isBusy()).toBe(false);
  });

  it("runs a steered message as its own follow-up turn when it misses the in-flight turn", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    // Turn 1 ends without the steered message being echoed → it spilled to
    // the CLI's queue and becomes the next turn, owned by the steered request.
    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("reply two"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two");
    expect(session.isBusy()).toBe(false);
  });

  it("send() waits for a promoted steered turn to finish before dispatching", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    // End turn 1 — the steered request is promoted to own the next turn.
    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");

    // A queued send() must not stomp the promoted turn.
    const p3 = session.send("third");
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.inputs.length).toBe(2);

    harness.pushEvent(assistantEvent("reply two"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two");

    await waitFor(() => harness.inputs.length === 3);
    harness.pushEvent(assistantEvent("reply three"));
    harness.pushEvent(resultEvent());
    await expect(p3).resolves.toBe("reply three");
  });

  it("steer() on an idle session behaves like send()", async () => {
    const { session, harness } = makeSession();

    const p = session.steer("solo");
    await waitFor(() => harness.inputs.length === 1);
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("hi"));
    harness.pushEvent(resultEvent());
    await expect(p).resolves.toBe("hi");
    expect(session.isBusy()).toBe(false);
  });

  it("a stream failure rejects the owner and all steered requests", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    harness.fail(new Error("boom"));

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    await waitFor(() => !session.isAlive());
  });

  it("multiple steered messages can merge and spill independently", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    const p3 = session.steer("third");
    await waitFor(() => harness.inputs.length === 3);

    // "second" merges into turn 1; "third" misses it and spills.
    harness.pushEvent(userEcho("second"));
    harness.pushEvent(assistantEvent("reply one+two"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one+two");
    await expect(p2).resolves.toBe(STEER_MERGED);
    expect(session.isBusy()).toBe(true);

    harness.pushEvent(assistantEvent("reply three"));
    harness.pushEvent(resultEvent());
    await expect(p3).resolves.toBe("reply three");
    expect(session.isBusy()).toBe(false);
  });
});

// Subagent events carry parent_tool_use_id. Their narration must never reach
// the channel callbacks or the resolved response — only the main agent's own
// blocks are deliverable.
const subagentAssistantEvent = (text: string) => ({
  type: "assistant",
  parent_tool_use_id: "toolu_parent",
  message: { content: [textBlock(text)] },
});

describe("LiveSession subagent events", () => {
  it("keeps subagent narration out of the response", async () => {
    const { session, harness } = makeSession();

    const p = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    harness.pushEvent(subagentAssistantEvent("inner monologue"));
    harness.pushEvent(assistantEvent("real reply"));
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("real reply");
  });

  it("keeps a subagent's thinking out of the response even when showThinking is on", async () => {
    const { session, harness } = makeSession({ showThinking: true });

    const p = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    harness.pushEvent({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: { content: [thinkingBlock("subagent reasoning")] },
    });
    harness.pushEvent(assistantEvent("real reply"));
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("real reply");
  });

  it("ignores subagent replay echoes for steer merge detection", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    // Same text, replay-flagged, but from inside a subagent — must not merge.
    harness.pushEvent({
      type: "user",
      isReplay: true,
      parent_tool_use_id: "toolu_parent",
      message: { content: [textBlock("second")] },
    });
    harness.pushEvent(assistantEvent("reply one"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply one");

    // The steer spills to its own follow-up turn instead of resolving merged.
    expect(session.isBusy()).toBe(true);
    harness.pushEvent(assistantEvent("reply two"));
    harness.pushEvent(resultEvent());
    await expect(p2).resolves.toBe("reply two");
  });
});

// ---------------------------------------------------------------------------
// Thinking blocks
//
// Delivery is decided by SDK content-block TYPE, never by inspecting text.
// `text` blocks always ship, even when their text happens to look like
// thinking (`Thinking:`) or like tool debris (`count`). A `thinking` block with the
// flag OFF is judged by its length, still never by its prose: empty is the
// signature-only residue of `display: "omitted"` and is dropped; non-empty
// under `omitted` has only ever been a misplaced message, so it is kept as
// one, unmarked. With the flag ON, thinking is kept and marked.
// ---------------------------------------------------------------------------

describe("LiveSession thinking blocks", () => {
  it("drops an empty thinking block, keeping only the text block", async () => {
    const { session, harness } = makeSession();

    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({
      type: "assistant",
      message: { content: [thinkingBlock(""), textBlock("Sure — here's X.")] },
    });
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("Sure — here's X.");
  });

  it("drops a non-empty thinking block from the response when showThinking is off — under `omitted` it is a summary", async () => {
    const { session, harness } = makeSession();

    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({
      type: "assistant",
      message: { content: [thinkingBlock("the user probably wants X"), textBlock("Sure — here's X.")] },
    });
    harness.pushEvent(resultEvent());

    // It was DELIVERED as a message, so it must also be in the turn response
    // the transcript and the silence checks read — otherwise recall would not
    // hold a message the owner is looking at.
    await expect(p).resolves.toBe("Sure — here's X.");
  });

  it("includes thinking blocks, marked, when showThinking is on", async () => {
    const { session, harness } = makeSession({ showThinking: true });

    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({
      type: "assistant",
      message: { content: [thinkingBlock("the user probably wants X"), textBlock("Sure — here's X.")] },
    });
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("💭 the user probably wants X\nSure — here's X.");
  });

  it("never truncates a text block that looks like thinking or tool debris", async () => {
    const { session, harness } = makeSession();

    const p = session.send("translate Zählung to English, one word");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantEvent("count"));
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("count");
  });

  it("skips redacted_thinking blocks even when showThinking is on", async () => {
    const { session, harness } = makeSession({ showThinking: true });

    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({
      type: "assistant",
      message: { content: [{ type: "redacted_thinking", data: "opaque" }, textBlock("done")] },
    });
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Per-block filtering
//
// The scaffold filter and the bare-NO_REPLY rule run on each block BEFORE the
// join, because that is where the streaming predecessor ran them (one block,
// one channel send). Applied to the joined string instead, the scaffold cut
// swallows every later block and the NO_REPLY drop only fires when the token
// is the whole turn.
// ---------------------------------------------------------------------------

describe("LiveSession per-block filtering", () => {
  const multiBlockTurn = async (blockTexts: string[]) => {
    const { session, harness } = makeSession();
    const p = session.send("go");
    await waitFor(() => harness.inputs.length === 1);
    for (const text of blockTexts) harness.pushEvent(assistantEvent(text));
    harness.pushEvent(resultEvent());
    return p;
  };

  // A trailing NO_REPLY stays on the END of the response; stripTrailingNoReply
  // then silences the whole turn, narration included (owner decision
  // 2026-07-08). Only a mid-turn NO_REPLY block is dropped here.
  it.each([
    ["drops a mid-turn block whose trailing line is NO_REPLY, keeping the rest", ["A", "housekeeping\nNO_REPLY", "B"], "A\nB"],
    ["drops a mid-turn NO_REPLY block that also carried an attachment tag", ["A", "MEDIA:/tmp/x.png\nNO_REPLY", "B"], "A\nB"],
    ["keeps a trailing NO_REPLY so the delivery layer suppresses the turn", ["did the housekeeping", "NO_REPLY"], "did the housekeeping\nNO_REPLY"],
    ["cuts only the block that leaked scaffold", ["A", "leaked\n_end_of_dialog_\nUser: hi", "B"], "A\nleaked\nB"],
  ])("%s", async (_title, blocks, joined) => {
    await expect(multiBlockTurn(blocks)).resolves.toBe(joined);
  });

  it("warns once when any block leaked scaffold", async () => {
    vi.mocked(log.warn).mockClear();
    await multiBlockTurn(["A", "<system-reminder>note</system-reminder>", "B", "<system-reminder>again</system-reminder>"]);
    // Two blocks leaked; the turn still warns exactly once.
    expect(vi.mocked(log.warn).mock.calls.filter(([, msg]) => msg === "model scaffold leak filtered")).toHaveLength(1);
  });
});

describe("LiveSession close during an outstanding block delivery", () => {
  it("abandons the open block synchronously and rejects the turn without waiting out the delivery budget", async () => {
    // Shutdown's whole budget is a few seconds. A block whose send is parked
    // holds an open transcript slot (and every slot behind it), and the only
    // other thing that closes it is the 60s per-block delivery timeout — which
    // is also what keeps the event loop parked, so `consumeEvents` cannot end
    // and reject the turn either. Both have to happen inside close() itself.
    const { session, harness } = makeSession();
    const events: string[] = [];
    let releaseSend!: () => void;
    const parked = new Promise<void>((r) => { releaseSend = r; });

    const turn = session.send(
      "go",
      undefined,
      undefined,
      async () => { events.push("send-parked"); await parked; events.push("send-late-completed"); },
      () => events.push("abandoned"),
    );
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantEvent("A"));
    await waitFor(() => events.includes("send-parked"));

    session.close();

    // Synchronous: the slot is closed before close() returns, not a microtask
    // or a minute later.
    expect(events).toEqual(["send-parked", "abandoned"]);
    await expect(turn).rejects.toThrow("Session is closed");

    // The parked send has no cancellation to be handed; it completes late and
    // must not be reported as this block's outcome a second time.
    releaseSend();
    await flushMicrotasks(10);
    expect(events).toEqual(["send-parked", "abandoned", "send-late-completed"]);
  });
});

// ---------------------------------------------------------------------------
// Turn-ending results that are NOT clean successes. The SDK yields these like
// any other result (nothing throws), so the handler has to read `subtype` /
// `is_error` itself — before, every one of them resolved as an ordinary turn.
// The turn REJECTS with a typed SdkResultError so the failure travels the
// same path as any other turn error: TurnRunner's error policy decides what
// the chat sees, and cron records the run as failed.
// ---------------------------------------------------------------------------

describe("LiveSession error results", () => {
  const errorResult = (subtype: string, extra: Record<string, unknown> = {}) => ({
    ...resultEvent(),
    subtype,
    is_error: true,
    errors: [`${subtype} happened`],
    ...extra,
  });

  it("rejects error_max_turns with a typed error after the blocks that did ship", async () => {
    const { session, harness } = makeSession();
    const blocks: string[] = [];
    const p = session.send("do a lot", undefined, undefined, async (b) => { blocks.push(b); });
    await waitFor(() => harness.inputs.length === 1);

    harness.pushEvent(assistantEvent("partial progress"));
    harness.pushEvent(errorResult("error_max_turns"));

    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SdkResultError);
    expect(err).toMatchObject({
      subtype: "error_max_turns",
      errors: ["error_max_turns happened"],
      message: "I ran out of steps trying to complete that. Can you try a simpler request?",
    });
    // Blocks already shipped stay shipped; nothing fabricated is delivered here.
    expect(blocks).toEqual(["partial progress"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subtype: "error_max_turns", errors: ["error_max_turns happened"] }),
      "SDK turn ended on an error result",
    );
    // The turn is over: stats recorded, session idle and reusable.
    expect(session.lastResult).not.toBeNull();
    expect(session.isBusy()).toBe(false);
    expect(session.isAlive()).toBe(true);
  });

  // Every other error_* subtype is a failed turn; the budget one names its
  // limit. (The max-turns test above shows the session stays reusable.)
  it.each([
    ["error_max_budget_usd", "I hit the spending limit for this turn before finishing."],
    ["error_during_execution", /stopped early/],
    ["error_max_structured_output_retries", /stopped early/],
  ])("rejects a %s result as a failed turn", async (subtype, message) => {
    const { session, harness } = makeSession();
    const p = session.send("go");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(errorResult(subtype));
    await expect(p).rejects.toThrow(message);
  });

  it("rejects a success result flagged is_error with the API error text, even after earlier blocks", async () => {
    const { session, harness } = makeSession();
    const blocks: string[] = [];
    const p = session.send("hi", undefined, undefined, async (b) => { blocks.push(b); });
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantEvent("working on it"));
    harness.pushEvent({ ...resultEvent(), is_error: true, result: "API Error: 429 rate limited" });

    await expect(p).rejects.toMatchObject({ subtype: "success", message: "API Error: 429 rate limited" });
    expect(blocks).toEqual(["working on it"]);
  });

  it("resolves merged steers and promotes pending ones after a failed turn", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("second");
    await waitFor(() => harness.inputs.length === 2);

    harness.pushEvent(userEcho("second"));
    harness.pushEvent(errorResult("error_max_turns"));

    await expect(p1).rejects.toBeInstanceOf(SdkResultError);
    await expect(p2).resolves.toBe(STEER_MERGED);
    expect(session.isBusy()).toBe(false);
  });

  it("leaves a clean success result untouched", async () => {
    const { session, harness } = makeSession();
    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantEvent("fine"));
    harness.pushEvent({ ...resultEvent(), is_error: false });
    await expect(p).resolves.toBe("fine");
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), "SDK turn ended on an error result");
  });
});

describe("LiveSession token accounting", () => {
  const modelUsage = (n: number) => ({
    "claude-x": { inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 100 * n, cacheCreationInputTokens: n },
    "claude-sub": { inputTokens: 1000 * n, outputTokens: 500 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  });

  it("differences cumulative modelUsage per turn across every model, not the main-loop-only usage", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("one");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({ ...resultEvent(), usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: modelUsage(1) });
    await p1;
    expect(session.lastResult).toMatchObject({ inputTokens: 1010, outputTokens: 505, cacheReadTokens: 100, cacheCreationTokens: 1 });

    const p2 = session.send("two");
    await waitFor(() => harness.inputs.length === 2);
    harness.pushEvent({ ...resultEvent(), usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: modelUsage(3) });
    await p2;
    // Cumulative 3× minus the 1× already recorded.
    expect(session.lastResult).toMatchObject({ inputTokens: 2020, outputTokens: 1010, cacheReadTokens: 200, cacheCreationTokens: 2 });
  });

  it("never records a negative turn cost when the cumulative total resets", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("one");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({ ...resultEvent(), total_cost_usd: 0.5 });
    await p1;
    expect(session.lastResult?.costUsd).toBeCloseTo(0.5);

    // A crash result carries zeroed totals; a /clear restarts the running sum.
    const p2 = session.send("two");
    await waitFor(() => harness.inputs.length === 2);
    harness.pushEvent({ ...resultEvent(), total_cost_usd: 0.1 });
    await p2;
    expect(session.lastResult?.costUsd).toBeCloseTo(0.1);
  });

  // Totals of modelUsage(n) summed across both models.
  const tokensAt = (n: number) => ({ input: 1010 * n, output: 505 * n, cacheRead: 100 * n, cacheCreated: n });

  async function runTurn(
    session: InstanceType<typeof LiveSession>,
    harness: Harness,
    n: number,
    result: Record<string, unknown>,
  ) {
    const p = session.send(`turn ${n}`);
    await waitFor(() => harness.inputs.length === n);
    harness.pushEvent({ ...resultEvent(), ...result });
    await p;
    return session.lastResult!;
  }

  describe("resumed sessions (SDK totals carry the transcript's earlier turns)", () => {
    it("differences the first result against the persisted baseline, not zero", async () => {
      const { session, harness } = makeSession({
        resumeFrom: {
          sdkSessionId: "sid-1",
          baseline: { sdkSessionId: "sid-1", totalCostUsd: 275.47, tokens: tokensAt(50) },
        },
      });

      // The carried total is exactly what we last recorded: this turn (e.g.
      // a crash-free restart and a turn that cost nothing new) is ~0.
      const r1 = await runTurn(session, harness, 1, { total_cost_usd: 275.47, modelUsage: modelUsage(50) });
      expect(r1.costUsd).toBeCloseTo(0, 10);
      expect(r1).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const r2 = await runTurn(session, harness, 2, { total_cost_usd: 276.0, modelUsage: modelUsage(51) });
      expect(r2.costUsd).toBeCloseTo(0.53, 10);
      expect(r2).toMatchObject({ inputTokens: 1010, outputTokens: 505, cacheReadTokens: 100, cacheCreationTokens: 1 });
      expect(r2.usageBaseline).toEqual({ sdkSessionId: "sid-1", totalCostUsd: 276.0, tokens: tokensAt(51), models: expect.any(Object) });
    });

    it("does not charge the carried total when there is no baseline yet", async () => {
      const { session, harness } = makeSession({ resumeFrom: { sdkSessionId: "sid-1" } });

      const r1 = await runTurn(session, harness, 1, {
        total_cost_usd: 275.47,
        modelUsage: modelUsage(50),
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
      });
      // Cost unknown for this one turn: 0, not the session's lifetime.
      // Tokens from `usage`, which the SDK reports per turn.
      expect(r1.costUsd).toBe(0);
      expect(r1).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 0 });
      // ... and that first result becomes the baseline.
      expect(r1.usageBaseline).toEqual({ sdkSessionId: "sid-1", totalCostUsd: 275.47, tokens: tokensAt(50), models: expect.any(Object) });

      const r2 = await runTurn(session, harness, 2, { total_cost_usd: 276.0, modelUsage: modelUsage(51) });
      expect(r2.costUsd).toBeCloseTo(0.53, 10);
      expect(r2).toMatchObject({ inputTokens: 1010, outputTokens: 505, cacheReadTokens: 100, cacheCreationTokens: 1 });
    });

    it("ignores a baseline recorded for a different SDK session", async () => {
      const { session, harness } = makeSession({
        resumeFrom: {
          sdkSessionId: "sid-1",
          baseline: { sdkSessionId: "sid-old", totalCostUsd: 1, tokens: tokensAt(1) },
        },
      });
      const r1 = await runTurn(session, harness, 1, { total_cost_usd: 275.47, modelUsage: modelUsage(50) });
      expect(r1.costUsd).toBe(0);
    });

    it("treats a first result BELOW the baseline as unknown, not as a reset charging the whole total", async () => {
      const { session, harness } = makeSession({
        resumeFrom: {
          sdkSessionId: "sid-1",
          baseline: { sdkSessionId: "sid-1", totalCostUsd: 275.47, tokens: tokensAt(50) },
        },
      });
      const r1 = await runTurn(session, harness, 1, { total_cost_usd: 270.0, modelUsage: modelUsage(49) });
      expect(r1.costUsd).toBe(0);
      const r2 = await runTurn(session, harness, 2, { total_cost_usd: 270.25, modelUsage: modelUsage(50) });
      expect(r2.costUsd).toBeCloseTo(0.25, 10);
    });

    it("still treats a total that goes backwards mid-session as a reset (/clear), and drops the baseline", async () => {
      const { session, harness } = makeSession({
        resumeFrom: {
          sdkSessionId: "sid-1",
          baseline: { sdkSessionId: "sid-1", totalCostUsd: 275.47, tokens: tokensAt(50) },
        },
      });
      await runTurn(session, harness, 1, { total_cost_usd: 276.0, modelUsage: modelUsage(51) });

      // A mid-session /clear restarts the SDK's running sum.
      const r2 = await runTurn(session, harness, 2, { total_cost_usd: 0.2, modelUsage: modelUsage(1) });
      expect(r2.costUsd).toBeCloseTo(0.2, 10);
      expect(r2).toMatchObject({ inputTokens: 1010, outputTokens: 505 });
      // What total the transcript now holds is unknown: persist no baseline.
      expect(r2.usageBaseline).toBeNull();

      const r3 = await runTurn(session, harness, 3, { total_cost_usd: 0.5, modelUsage: modelUsage(2) });
      expect(r3.costUsd).toBeCloseTo(0.3, 10);
      expect(r3.usageBaseline).toEqual({ sdkSessionId: "sid-1", totalCostUsd: 0.5, tokens: tokensAt(2), models: expect.any(Object) });
    });
  });

  it("after a reset, every cumulative counter is the turn's own — even one that came back larger", async () => {
    const { session, harness } = makeSession();
    await runTurn(session, harness, 1, { total_cost_usd: 1.0, modelUsage: modelUsage(1) });
    // /clear: cost and input restart, but this first cleared turn happens to
    // read more cache than the whole previous run did (100 → 1000).
    const r2 = await runTurn(session, harness, 2, {
      total_cost_usd: 0.2,
      modelUsage: {
        "claude-x": { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 },
      },
    });
    expect(r2.costUsd).toBeCloseTo(0.2, 10);
    expect(r2).toMatchObject({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1000, cacheCreationTokens: 0 });
  });

  it("keeps a zero-cost result with real tokens as a baseline (a route that reports no price)", async () => {
    const { session, harness } = makeSession({ resumeFrom: { sdkSessionId: "sid-1" } });
    const r1 = await runTurn(session, harness, 1, { total_cost_usd: 0, modelUsage: modelUsage(3) });
    expect(r1.costUsd).toBe(0);
    expect(r1.usageBaseline).toEqual({ sdkSessionId: "sid-1", totalCostUsd: 0, tokens: tokensAt(3), models: expect.any(Object) });
  });

  it("a fresh session charges the first result in full and reports it as the baseline", async () => {
    const { session, harness } = makeSession();
    const r1 = await runTurn(session, harness, 1, { total_cost_usd: 0.5, modelUsage: modelUsage(1) });
    expect(r1.costUsd).toBeCloseTo(0.5, 10);
    expect(r1).toMatchObject({ inputTokens: 1010, outputTokens: 505, cacheReadTokens: 100, cacheCreationTokens: 1 });
    expect(r1.usageBaseline).toEqual({ sdkSessionId: "sid-1", totalCostUsd: 0.5, tokens: tokensAt(1), models: expect.any(Object) });

    const r2 = await runTurn(session, harness, 2, { total_cost_usd: 0.75, modelUsage: modelUsage(2) });
    expect(r2.costUsd).toBeCloseTo(0.25, 10);
  });

  it("falls back to usage when a result carries no modelUsage", async () => {
    const { session, harness } = makeSession();
    const p = session.send("one");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent({ ...resultEvent(), usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });
    await p;
    expect(session.lastResult).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 0 });
  });
});

describe("LiveSession message origin", () => {
  it("stamps the given origin on send() and steer() messages and omits it otherwise", async () => {
    const { session, harness } = makeSession();

    const p1 = session.send("typed", undefined, undefined, undefined, undefined, { kind: "human" });
    await waitFor(() => harness.inputs.length === 1);
    const p2 = session.steer("more", undefined, undefined, undefined, undefined, { kind: "unclassified" });
    await waitFor(() => harness.inputs.length === 2);
    expect(harness.origins).toEqual([{ kind: "human" }, { kind: "unclassified" }]);

    harness.pushEvent(assistantEvent("ok"));
    harness.pushEvent(userEcho("more"));
    harness.pushEvent(resultEvent());
    await p1;
    await p2;

    const p3 = session.send("bare");
    await waitFor(() => harness.inputs.length === 3);
    expect(harness.origins[2]).toBeUndefined();
    harness.pushEvent(resultEvent());
    await p3;
  });
});

describe("LiveSession: which request a result belongs to (2026-11-14 lost reply)", () => {
  // What the real CLI emits on resume for a background task the previous
  // process left running (reproduced against the CLI): a stopped
  // task_notification, then a result of its own that ran nothing.
  const staleNotification = { type: "system", subtype: "task_notification", task_id: "b1", status: "stopped", output_file: "/tmp/x", summary: "previous session ended" };
  const staleResult = { ...resultEvent(), num_turns: 0, result: "", usage: { input_tokens: 0, output_tokens: 0 }, origin: { kind: "task-notification" } };
  const answering = (...uuids: Array<string | undefined>) => ({ ...resultEvent(), user_message_uuids: uuids, user_message_uuid: uuids.at(-1) });

  it("stamps a client uuid on every message it sends", async () => {
    const { session, harness } = makeSession();
    void session.send("one").catch(() => {});
    await flushMicrotasks();
    void session.steer("two").catch(() => {});
    await flushMicrotasks();
    expect(harness.uuids).toHaveLength(2);
    expect(new Set(harness.uuids).size).toBe(2);
    for (const id of harness.uuids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the resume-time task-notification result does not end the web request; a nudge from another channel gets its own turn and none of the reply", async () => {
    const { session, harness } = makeSession();
    const web: string[] = [];
    const nudge: string[] = [];
    const p1 = session.send("Nice, it looks great now!", undefined, undefined, (b) => { web.push(b); });
    await flushMicrotasks();
    harness.pushEvent(staleNotification);
    harness.pushEvent(staleResult);
    await flushMicrotasks(20);
    expect(session.isBusy()).toBe(true);

    // The context nudge arrives now. Before the fix the session looked idle
    // here, the nudge took the turn, and the real reply resolved IT (output
    // suppressed) while the web got the fallback line.
    const p2 = session.send("<tomo-event type=\"context-nudge\">", undefined, undefined, (b) => { nudge.push(b); });
    await flushMicrotasks(20);
    expect(harness.inputs).toHaveLength(1);

    harness.pushEvent(assistantEvent("Glad it works 😁"));
    harness.pushEvent(answering(harness.uuids[0]));
    await expect(p1).resolves.toBe("Glad it works 😁");
    expect(web).toEqual(["Glad it works 😁"]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.objectContaining({ why: "task-notification turn" }), expect.any(String));

    await flushMicrotasks(20);
    expect(harness.inputs).toHaveLength(2);
    harness.pushEvent(assistantEvent("NO_REPLY"));
    harness.pushEvent(answering(harness.uuids[1]));
    await expect(p2).resolves.toBe("NO_REPLY");
    expect(nudge).not.toContain("Glad it works 😁");
  });

  it("backstop: an unstamped success that ran nothing and said nothing is nobody's answer", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello");
    await flushMicrotasks();
    harness.pushEvent({ ...resultEvent(), num_turns: 0, result: "" });
    await flushMicrotasks(20);
    expect(session.isBusy()).toBe(true);
    harness.pushEvent(assistantEvent("hi"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("hi");
  });

  it("a stamped result naming a different request is reported (error, both uuids) but still ends the current request", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello");
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("reply"));
    const other = "00000000-0000-4000-8000-000000000000";
    harness.pushEvent(answering(other));
    await expect(p1).resolves.toBe("reply");
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ current: harness.uuids[0], resultUuids: [other] }),
      expect.stringContaining("out of step"),
    );
  });

  it("a stamped result naming the current request raises no alarm", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello", undefined, undefined, () => {});
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("reply"));
    harness.pushEvent(answering(harness.uuids[0]));
    await expect(p1).resolves.toBe("reply");
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  it("a turn whose text came only in the result ships it as a block and resolves with it", async () => {
    const { session, harness } = makeSession();
    const shipped: string[] = [];
    const p1 = session.send("hello", undefined, undefined, (b) => { shipped.push(b); });
    await flushMicrotasks();
    harness.pushEvent(assistantToolEvent("Bash", "t1"));
    harness.pushEvent(toolResultEvent("t1"));
    harness.pushEvent({ ...answering(harness.uuids[0]), result: "done, all green" });
    await expect(p1).resolves.toBe("done, all green");
    expect(shipped).toEqual(["done, all green"]);
  });

  it("result-only text goes through the same render: a scaffold leak in it is filtered", async () => {
    const { session, harness } = makeSession();
    const shipped: string[] = [];
    const p1 = session.send("hello", undefined, undefined, (b) => { shipped.push(b); });
    await flushMicrotasks();
    harness.pushEvent(assistantToolEvent("Bash", "t1"));
    harness.pushEvent({ ...answering(harness.uuids[0]), result: "leaked\n_end_of_dialog_\nUser: hi" });
    await expect(p1).resolves.toBe("leaked");
    expect(shipped).toEqual(["leaked"]);
    expect(vi.mocked(log.warn).mock.calls.some(([, msg]) => msg === "model scaffold leak filtered")).toBe(true);
  });

  it("result text is not used when the turn's frames already carried text", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello", undefined, undefined, () => {});
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("the reply"));
    harness.pushEvent({ ...answering(harness.uuids[0]), result: "the reply" });
    await expect(p1).resolves.toBe("the reply");
  });

  it("a turn with no text anywhere resolves EMPTY_REPLY (silent, not a success) and warns", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello");
    await flushMicrotasks();
    harness.pushEvent(assistantToolEvent("Bash", "t1"));
    harness.pushEvent(toolResultEvent("t1"));
    harness.pushEvent(answering(harness.uuids[0]));
    await expect(p1).resolves.toBe(EMPTY_REPLY);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.anything(), "Turn ended with no reply text; resolving as an empty reply");
  });

  it("a literal NO_REPLY from the model is an ordinary silent reply, not an empty one", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("hello", undefined, undefined, () => {});
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("NO_REPLY"));
    harness.pushEvent(answering(harness.uuids[0]));
    await expect(p1).resolves.toBe("NO_REPLY");
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.anything(), "Turn ended with no reply text; resolving as an empty reply");
  });
});

describe("LiveSession.stop (owner Stop) and SDK signals", () => {
  const interrupted = (uuid: string | undefined) => ({ ...resultEvent(), subtype: "error_during_execution", is_error: true,
    user_message_uuids: [uuid], user_message_uuid: uuid });
  const signals = async () => {
    const { watchBus } = await import("../src/watch/bus.js");
    const seen: unknown[] = [];
    const off = watchBus.subscribe((event) => { if (event.type === "sdk") seen.push(event.signal); });
    return { seen, off };
  };

  it("asks the SDK to interrupt and settles the stopped turn with what it had said, not as a failure", async () => {
    const { session, harness } = makeSession();
    const { seen, off } = await signals();
    const turn = session.send("long job", undefined, undefined, () => {});
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("Starting on it."));
    await flushMicrotasks();
    await expect(session.stop()).resolves.toBe(true);
    expect(interruptState.calls).toBe(1);
    harness.pushEvent(interrupted(harness.uuids[0]));
    await expect(turn).resolves.toBe("Starting on it.");
    expect(seen).toContainEqual({ kind: "stopped" });
    expect(session.isAlive()).toBe(true);
    off();
  });

  it("a stopped turn that had said nothing is silent, and the next turn's failure is still a failure", async () => {
    const { session, harness } = makeSession();
    const first = session.send("one");
    await flushMicrotasks();
    await session.stop();
    harness.pushEvent(interrupted(harness.uuids[0]));
    await expect(first).resolves.toBe("NO_REPLY");
    const second = session.send("two");
    await flushMicrotasks();
    harness.pushEvent(interrupted(harness.uuids[1]));
    await expect(second).rejects.toBeInstanceOf(SdkResultError);
  });

  it("stops nothing when idle, and a failed interrupt leaves the turn's own outcome in place", async () => {
    const { session, harness } = makeSession();
    await expect(session.stop()).resolves.toBe(false);
    expect(interruptState.calls).toBe(0);
    const turn = session.send("one");
    await flushMicrotasks();
    interruptState.fail = true;
    await expect(session.stop()).resolves.toBe(false);
    harness.pushEvent(interrupted(harness.uuids[0]));
    await expect(turn).rejects.toBeInstanceOf(SdkResultError);
  });

  it("publishes retries, rate limits, tool progress and suggestions without touching the turn", async () => {
    const { session, harness } = makeSession();
    const { seen, off } = await signals();
    const turn = session.send("hello", undefined, undefined, () => {});
    await flushMicrotasks();
    harness.pushEvent({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" });
    harness.pushEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000, utilization: 0.9 } });
    harness.pushEvent({ type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 31 });
    harness.pushEvent({ type: "tool_progress", tool_use_id: "t2", tool_name: "Read", parent_tool_use_id: "agent-1", elapsed_time_seconds: 5 });
    harness.pushEvent(assistantEvent("Hi."));
    harness.pushEvent({ ...resultEvent(), user_message_uuids: [harness.uuids[0]], user_message_uuid: harness.uuids[0] });
    await expect(turn).resolves.toBe("Hi.");
    harness.pushEvent({ type: "prompt_suggestion", suggestion: "[web · Wed 09/02 20:50 PDT] and tomorrow?" });
    await flushMicrotasks();
    expect(seen).toEqual([
      { kind: "retry", attempt: 2, maxRetries: 10, delayMs: 4000, error: "overloaded", status: 529 },
      { kind: "rate_limit", status: "allowed_warning", limit: "five_hour", resetsAt: 1_800_000_000_000, utilization: 90, rawUtilization: 0.9 },
      { kind: "tool_progress", toolUseId: "t1", tool: "Bash", elapsedSeconds: 31 },
      { kind: "suggestion", text: "and tomorrow?" },
    ]);
    expect(session.isBusy()).toBe(false);
    off();
  });
});

describe("LiveSession: read receipts (user_message_uuids)", () => {
  type ReadEvent = { uuids: string[]; requestIds: string[] };
  const ctx = (requestId: string) => ({ turnId: requestId, channel: "web", requestId, interactive: true });
  const stamped = (text: string, ...uuids: Array<string | undefined>) => ({ ...assistantEvent(text), user_message_uuids: uuids, user_message_uuid: uuids.at(-1) });
  let reads: ReadEvent[] = [];
  let unsubscribe: () => void = () => {};
  beforeEach(async () => {
    const { watchBus } = await import("../src/watch/bus.js");
    reads = [];
    unsubscribe = watchBus.subscribe((e) => { if (e.type === "read" && e.sessionKey === "test:session") reads.push({ uuids: e.uuids, requestIds: e.requestIds }); });
  });
  afterEach(() => unsubscribe());

  it("marks a message read the first frame that names it, and only once", async () => {
    const { session, harness } = makeSession();
    const p = session.send("hi", undefined, undefined, undefined, undefined, undefined, false, ctx("req-1"));
    await flushMicrotasks();
    const uuid = harness.uuids[0]!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(reads).toEqual([]);
    harness.pushEvent(stamped("one", uuid));
    harness.pushEvent(stamped("two", uuid));
    harness.pushEvent({ ...resultEvent(), user_message_uuids: [uuid], user_message_uuid: uuid });
    await p;
    expect(reads).toEqual([{ uuids: [uuid], requestIds: ["req-1"] }]);
  });

  it("a message folded in mid-turn is marked read when the turn reports it, the first not again", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("first", undefined, undefined, undefined, undefined, undefined, false, ctx("req-1"));
    await flushMicrotasks();
    harness.pushEvent(stamped("working", harness.uuids[0]));
    await flushMicrotasks(10);
    const p2 = session.steer("second", undefined, undefined, undefined, undefined, undefined, undefined, { replyContext: ctx("req-2"), canJoin: () => true });
    await flushMicrotasks();
    expect(reads).toEqual([{ uuids: [harness.uuids[0]], requestIds: ["req-1"] }]);
    harness.pushEvent(userEcho("second"));
    harness.pushEvent(stamped("saw it", harness.uuids[0], harness.uuids[1]));
    harness.pushEvent(resultEvent());
    await p1; await p2;
    expect(reads).toEqual([{ uuids: [harness.uuids[0]], requestIds: ["req-1"] }, { uuids: [harness.uuids[1]], requestIds: ["req-2"] }]);
  });

  it("every member of a batch the CLI merged into the next turn is marked read, queued ones only when that turn reads them", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("first", undefined, undefined, undefined, undefined, undefined, false, ctx("req-1"));
    await flushMicrotasks();
    const p2 = session.steer("second", undefined, undefined, undefined, undefined, undefined, undefined, { replyContext: ctx("req-2"), canJoin: () => true });
    const p3 = session.steer("third", undefined, undefined, undefined, undefined, undefined, undefined, { replyContext: ctx("req-3"), canJoin: () => true });
    await flushMicrotasks();
    harness.pushEvent(stamped("one", harness.uuids[0]));
    harness.pushEvent(resultEvent());
    await p1;
    // Queued behind the turn: not read yet.
    expect(reads.flatMap((r) => r.requestIds)).toEqual(["req-1"]);
    harness.pushEvent(stamped("both", harness.uuids[1], harness.uuids[2]));
    harness.pushEvent(resultEvent());
    await flushMicrotasks(10);
    expect(reads.at(-1)).toEqual({ uuids: [harness.uuids[1], harness.uuids[2]], requestIds: ["req-2", "req-3"] });
    session.close();
    await Promise.allSettled([p2, p3]);
  });

  it("an older producer that stamps nothing: no receipt and no error; one that stamps only user_message_uuid still works", async () => {
    const { session, harness } = makeSession();
    const p1 = session.send("old", undefined, undefined, undefined, undefined, undefined, false, ctx("req-1"));
    await flushMicrotasks();
    harness.pushEvent(assistantEvent("reply"));
    harness.pushEvent(resultEvent());
    await expect(p1).resolves.toBe("reply");
    expect(reads).toEqual([]);
    const p2 = session.send("newer", undefined, undefined, undefined, undefined, undefined, false, ctx("req-2"));
    await flushMicrotasks();
    harness.pushEvent({ ...assistantEvent("ok"), user_message_uuid: harness.uuids[1] });
    harness.pushEvent(resultEvent());
    await p2;
    expect(reads).toEqual([{ uuids: [harness.uuids[1]], requestIds: ["req-2"] }]);
  });

  it("ignores uuids it did not send, and subagent frames", async () => {
    const { session, harness } = makeSession();
    const p = session.send("hi");
    await flushMicrotasks();
    harness.pushEvent({ ...stamped("sub", harness.uuids[0]), parent_tool_use_id: "tool-1" });
    harness.pushEvent(stamped("x", "00000000-0000-0000-0000-000000000000"));
    await flushMicrotasks(10);
    expect(reads).toEqual([]);
    harness.pushEvent(stamped("main", harness.uuids[0]));
    harness.pushEvent(resultEvent());
    await p;
    expect(reads).toEqual([{ uuids: [harness.uuids[0]], requestIds: [] }]);
  });
});

/** A recorder that lands every row at once, like a ledger whose writes all succeed. */
const into = (rows: UsageLedgerRow[]) => (build: () => UsageLedgerRow | undefined, onWritten: () => void) => {
  const row = build();
  if (row) { rows.push(row); onWritten(); }
};

describe("LiveSession usage ledger rows", () => {
  // Cumulative modelUsage after n turns: an opus main loop plus a haiku subagent.
  const sdkModels = (n: number, haiku = n) => ({
    "claude-opus": {
      inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 100 * n, cacheCreationInputTokens: 4 * n,
      cacheCreationEphemeral5mInputTokens: 3 * n, cacheCreationEphemeral1hInputTokens: n,
      thinkingTokens: 2 * n, webSearchRequests: n, costUSD: 0.5 * n, costBasis: "list",
    },
    "claude-haiku": {
      inputTokens: 1000 * haiku, outputTokens: 50 * haiku, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0.01 * haiku,
    },
  });
  const opusAt = (n: number) => ({
    input: 10 * n, output: 5 * n, cacheRead: 100 * n, cacheCreated: 4 * n,
    cacheCreated5m: 3 * n, cacheCreated1h: n, thinking: 2 * n, webSearch: n, costUsd: 0.5 * n,
  });
  const haikuAt = (n: number) => ({ input: 1000 * n, output: 50 * n, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.01 * n });
  const totalsAt = (n: number) => ({ input: 1010 * n, output: 55 * n, cacheRead: 100 * n, cacheCreated: 4 * n });
  // Field-by-field b - a, exactly as JS computes it: the ledger keeps the raw delta, float noise and all.
  const diff = <T extends Record<string, number>>(b: T, a: T): T =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k]])) as T;

  async function turn(
    session: InstanceType<typeof LiveSession>,
    harness: Harness,
    n: number,
    result: Record<string, unknown>,
    replyContext?: Record<string, unknown>,
  ) {
    const p = session.send(`turn ${n}`, undefined, undefined, undefined, undefined, undefined, undefined, replyContext as never);
    await waitFor(() => harness.inputs.length === n);
    harness.pushEvent({ ...resultEvent(), ...result });
    return p;
  }

  it("writes one versioned row per result with the turn's own cost, tokens, timings and attribution", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({ recordUsage: into(rows) });
    const owner = { turnId: "t1", channel: "web", requestId: "req-1", usage: { source: "owner", trigger: "what did I spend" } };

    await turn(session, harness, 1, { total_cost_usd: 0.51, modelUsage: sdkModels(1), duration_ms: 900, duration_api_ms: 700, num_turns: 3 }, owner);
    await turn(session, harness, 2, { total_cost_usd: 1.02, modelUsage: sdkModels(2), duration_ms: 400, duration_api_ms: 300, num_turns: 1 }, owner);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      v: 1,
      ts: expect.any(Number),
      sessionKey: "test:session",
      source: "owner",
      requestId: "req-1",
      trigger: "what did I spend",
      costUsd: 0.51,
      tokens: totalsAt(1),
      durationMs: 400,
      durationApiMs: 300,
      numTurns: 1,
      tools: 0,
      models: {
        "claude-opus": { ...opusAt(1), costBasis: "list" },
        "claude-haiku": haikuAt(1),
      },
      // The cumulative counters this turn ends on: the next resume's baseline.
      sdkSessionId: "sid-1",
      snapshot: {
        sdkSessionId: "sid-1", totalCostUsd: 1.02, tokens: totalsAt(2),
        models: { "claude-opus": opusAt(2), "claude-haiku": haikuAt(2) },
      },
    });
    expect(JSON.stringify(rows[1])).not.toContain("noBaseline");
  });

  it("counts the main loop's tool calls since the previous result, and starts again at zero", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({ recordUsage: into(rows) });
    const p = session.send("turn 1");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantToolEvent("Bash", "tu-1"));
    harness.pushEvent(toolResultEvent("tu-1"));
    harness.pushEvent({ type: "assistant", message: { content: [toolUseBlock("Read", "tu-2"), toolUseBlock("Grep", "tu-3")] } });
    harness.pushEvent(toolResultEvent("tu-2"));
    harness.pushEvent(toolResultEvent("tu-3"));
    // A subagent's own call is not the turn's.
    harness.pushEvent({ ...assistantToolEvent("Bash", "sub-1"), parent_tool_use_id: "tu-x" });
    harness.pushEvent({ ...resultEvent(), total_cost_usd: 0.1 });
    await p;
    await turn(session, harness, 2, { total_cost_usd: 0.2 });
    expect(rows.map((row) => row.tools)).toEqual([3, 0]);
  });

  it("leaves a model that did nothing this turn out, and the costs per model add up to the turn's", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({ recordUsage: into(rows) });
    await turn(session, harness, 1, { total_cost_usd: 0.51, modelUsage: sdkModels(1, 1) });
    // The haiku subagent did not run on turn 2.
    await turn(session, harness, 2, { total_cost_usd: 1.01, modelUsage: sdkModels(2, 1) });

    expect(Object.keys(rows[1].models!)).toEqual(["claude-opus"]);
    expect(rows[1].models!["claude-opus"]).toEqual({ ...opusAt(1), costBasis: "list" });
    const perModel = Object.values(rows[1].models!).reduce((sum, m) => sum + m.costUsd, 0);
    expect(perModel).toBeCloseTo(rows[1].costUsd, 6);
  });

  it("splits the first turn after a resume by model against the per-model baseline", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({
      recordUsage: into(rows),
      resumeFrom: {
        sdkSessionId: "sid-1",
        baseline: {
          sdkSessionId: "sid-1", totalCostUsd: 25.5, tokens: totalsAt(50),
          models: { "claude-opus": opusAt(50), "claude-haiku": haikuAt(50) },
        },
      },
    });
    await turn(session, harness, 1, { total_cost_usd: 26.01, modelUsage: sdkModels(51) });

    expect(rows[0]).toMatchObject({ costUsd: 26.01 - 25.5, tokens: totalsAt(1) });
    expect(rows[0].noBaseline).toBeUndefined();
    expect(rows[0].models).toEqual({
      "claude-opus": { ...diff(opusAt(51), opusAt(50)), costBasis: "list" },
      "claude-haiku": diff(haikuAt(51), haikuAt(50)),
    });
    // ... and the baseline it hands on carries the per-model counters too.
    expect(session.lastResult!.usageBaseline!.models).toEqual({ "claude-opus": opusAt(51), "claude-haiku": haikuAt(51) });
  });

  it("does not guess a per-model split when the resume baseline predates per-model counters", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({
      recordUsage: into(rows),
      resumeFrom: { sdkSessionId: "sid-1", baseline: { sdkSessionId: "sid-1", totalCostUsd: 25.5, tokens: totalsAt(50) } },
    });
    await turn(session, harness, 1, { total_cost_usd: 26.01, modelUsage: sdkModels(51) });
    await turn(session, harness, 2, { total_cost_usd: 26.52, modelUsage: sdkModels(52) });

    // Totals are still exact; only the split is unknown, for this one turn.
    expect(rows[0]).toMatchObject({ costUsd: 26.01 - 25.5, tokens: totalsAt(1) });
    expect(rows[0].models).toBeUndefined();
    expect(rows[1].models).toEqual({
      "claude-opus": { ...diff(opusAt(52), opusAt(51)), costBasis: "list" },
      "claude-haiku": diff(haikuAt(52), haikuAt(51)),
    });
  });

  it("flags the first turn after a resume with no baseline, with no per-model split", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({ recordUsage: into(rows), resumeFrom: { sdkSessionId: "sid-1" } });
    await turn(session, harness, 1, { total_cost_usd: 26.01, modelUsage: sdkModels(51), usage: { input_tokens: 7, output_tokens: 3 } });
    await turn(session, harness, 2, { total_cost_usd: 26.52, modelUsage: sdkModels(52) });

    expect(rows[0]).toMatchObject({ costUsd: 0, noBaseline: true, tokens: { input: 7, output: 3, cacheRead: 0, cacheCreated: 0 } });
    expect(rows[0].models).toBeUndefined();
    expect(rows[1].noBaseline).toBeUndefined();
    expect(rows[1].models!["claude-opus"]).toEqual({ ...opusAt(1), costBasis: "list" });
  });

  it("attributes cron turns to their job and SDK-initiated turns to background", async () => {
    const rows: UsageLedgerRow[] = [];
    const factory = vi.fn(() => ({ resolve: () => {}, reject: () => {}, onBlock: () => {} }));
    const session = new LiveSession({} as never, "dm:owner", undefined, factory, { recordUsage: into(rows) });
    const harness = harnessRef.current!;
    await turn(session, harness, 1, { total_cost_usd: 0.2 }, {
      turnId: "t", channel: "telegram",
      usage: { source: "cron", jobId: "job-7", jobName: "Morning digest", trigger: "Scheduled task \"Morning digest\" triggered." },
    });
    expect(rows[0]).toMatchObject({ source: "cron", jobId: "job-7", jobName: "Morning digest", sessionKey: "dm:owner", costUsd: 0.2 });

    // The CLI starts a turn on its own (a background task reported back).
    harness.pushEvent(assistantEvent("the review finished"));
    await waitFor(() => factory.mock.calls.length === 1);
    harness.pushEvent({ ...resultEvent(), total_cost_usd: 0.5, origin: { kind: "task-notification" }, num_turns: 1 });
    await waitFor(() => rows.length === 2);
    expect(rows[1]).toMatchObject({ source: "background", costUsd: 0.3 });
    expect(rows[1].jobId).toBeUndefined();
    session.close();
  });

  it("records costs exactly as differenced from the SDK's totals, never rounded", async () => {
    const rows: UsageLedgerRow[] = [];
    const { session, harness } = makeSession({ recordUsage: into(rows) });
    const models = (usd: number) => ({ "claude-opus": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd } });
    await turn(session, harness, 1, { total_cost_usd: 0.0000001234, modelUsage: models(0.0000001234) });
    await turn(session, harness, 2, { total_cost_usd: 0.1234567891, modelUsage: models(0.1234567891) });

    expect(rows[0].costUsd).toBe(0.0000001234);
    expect(rows[0].models!["claude-opus"].costUsd).toBe(0.0000001234);
    expect(rows[1].costUsd).toBe(0.1234567891 - 0.0000001234);
    expect(rows[1].models!["claude-opus"].costUsd).toBe(0.1234567891 - 0.0000001234);
  });

  it("a row that fails to land does not advance the ledger's counters: the next row carries both turns", async () => {
    const rows: UsageLedgerRow[] = [];
    let fail = true;
    const { session, harness } = makeSession({
      recordUsage: (build, onWritten) => {
        const row = build();
        if (!row) return;
        if (fail) { fail = false; return; } // the append failed: never on disk, onWritten not called
        rows.push(row);
        onWritten();
      },
    });
    await turn(session, harness, 1, { total_cost_usd: 0.51, modelUsage: sdkModels(1) });
    await turn(session, harness, 2, { total_cost_usd: 1.02, modelUsage: sdkModels(2) });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costUsd: 1.02, tokens: totalsAt(2), snapshot: { totalCostUsd: 1.02 } });
    expect(rows[0].models).toEqual({ "claude-opus": { ...opusAt(2), costBasis: "list" }, "claude-haiku": haikuAt(2) });
    // Session stats are a separate counter and still saw each turn once.
    expect(session.lastResult?.costUsd).toBeCloseTo(0.51);
  });

  it("a recorder that throws costs a warn, never the turn", async () => {
    const { session, harness } = makeSession({ recordUsage: () => { throw new Error("disk full"); } });
    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(assistantEvent("fine"));
    harness.pushEvent({ ...resultEvent(), total_cost_usd: 0.4 });
    await expect(p).resolves.toBe("fine");
    expect(session.lastResult?.costUsd).toBeCloseTo(0.4);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ session: "test:session" }), "Usage ledger row failed; turn unaffected");
  });
});

describe("LiveSession system/informational", () => {
  const informational = (over: Record<string, unknown>) => ({
    type: "system", subtype: "informational", uuid: "u-info", session_id: "s1", content: "hook X failed", level: "warning", ...over,
  });

  it("logs a warning line as warn with tag, text and session, and hands it to the callback", async () => {
    const seen: unknown[] = [];
    const { session, harness } = makeSession({ onInformational: (m) => seen.push(m) });
    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(informational({ tag: "hook_callback_failed" }));
    harness.pushEvent(assistantEvent("fine"));
    harness.pushEvent(resultEvent());
    await expect(p).resolves.toBe("fine");
    expect(log.warn).toHaveBeenCalledWith(
      { session: "test:session", tag: "hook_callback_failed", level: "warning", text: "hook X failed" },
      "SDK informational warning",
    );
    expect(seen).toEqual([expect.objectContaining({ tag: "hook_callback_failed" })]);
  });

  it("logs an unknown tag at its level and does not end the turn", async () => {
    const { session, harness } = makeSession();
    const p = session.send("hi");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(informational({ tag: "something_new", level: "notice", content: "fyi" }));
    harness.pushEvent(assistantEvent("fine"));
    harness.pushEvent(resultEvent());
    await expect(p).resolves.toBe("fine");
    expect(log.info).toHaveBeenCalledWith(
      { session: "test:session", tag: "something_new", level: "notice", text: "fyi" },
      "SDK informational",
    );
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), "SDK informational warning");
  });
});
