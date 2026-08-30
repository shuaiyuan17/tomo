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

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> }; priority?: string; origin?: unknown }> }) => {
    const inputs: string[] = [];
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
        priorities.push(msg.priority);
        origins.push(msg.origin);
      }
    })().catch(() => {});

    harnessRef.current = {
      inputs,
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
      getContextUsage: async () => ({ totalTokens: 100, maxTokens: 1000, percentage: 10, categories: [] }),
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
  STEER_MERGED,
  SdkResultError,
} = await import("../src/agent/live-session.js");
const { log } = await import("../src/logger.js");
const TIMEOUT_MS = 10 * 60 * 1000;

function makeSession(settings?: {
  timeoutMs?: number;
  showThinking?: boolean;
  onMcpAuthError?: (serverName: string) => Promise<string> | string;
  now?: () => number;
  onToolResult?: (toolName: string, content: unknown, isError: boolean) => void;
}) {
  const session = new LiveSession({} as never, "test:session", undefined, undefined, settings);
  const harness = harnessRef.current!;
  return { session, harness };
}

describe("LiveSession tool-result observation", () => {
  it("notifies after the SDK emits a named tool result", async () => {
    const onToolResult = vi.fn();
    const { session, harness } = makeSession({ onToolResult });

    harness.pushEvent(assistantToolEvent("Bash", "tool-1"));
    harness.pushEvent(toolResultEvent("tool-1", "scheduled"));

    await waitFor(() => onToolResult.mock.calls.length === 1);
    expect(onToolResult).toHaveBeenCalledWith("Bash", "scheduled", false);
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
// thinking (`思考:`) or like tool debris (`count`). A `thinking` block with the
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

  it("keeps a non-empty thinking block in the response, unmarked, when showThinking is off", async () => {
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
    await expect(p).resolves.toBe("the user probably wants X\nSure — here's X.");
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

    const p = session.send("translate 计数 to English, one word");
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

  it("drops a mid-turn block whose trailing line is NO_REPLY, keeping the rest", async () => {
    await expect(multiBlockTurn(["A", "housekeeping\nNO_REPLY", "B"])).resolves.toBe("A\nB");
  });

  it("drops a mid-turn NO_REPLY block that also carried an attachment tag", async () => {
    await expect(multiBlockTurn(["A", "MEDIA:/tmp/x.png\nNO_REPLY", "B"])).resolves.toBe("A\nB");
  });

  it("keeps a trailing NO_REPLY so the delivery layer suppresses the turn", async () => {
    // The token stays on the END of the response; stripTrailingNoReply then
    // silences the whole turn, narration included (owner decision 2026-07-08).
    await expect(multiBlockTurn(["did the housekeeping", "NO_REPLY"]))
      .resolves.toBe("did the housekeeping\nNO_REPLY");
  });

  it("cuts only the block that leaked scaffold", async () => {
    await expect(
      multiBlockTurn(["A", "leaked\n_end_of_dialog_\nUser: hi", "B"]),
    ).resolves.toBe("A\nleaked\nB");
  });

  it("warns once when any block leaked scaffold", async () => {
    vi.mocked(log.warn).mockClear();
    await multiBlockTurn(["A", "<system-reminder>note</system-reminder>", "B"]);
    expect(vi.mocked(log.warn).mock.calls.some(([, msg]) => msg === "model scaffold leak filtered")).toBe(true);
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

  it("names the budget limit for error_max_budget_usd", async () => {
    const { session, harness } = makeSession();
    const p = session.send("expensive");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(errorResult("error_max_budget_usd"));
    await expect(p).rejects.toThrow("I hit the spending limit for this turn before finishing.");
  });

  it("treats error_during_execution (and any other error_* subtype) as a failed turn", async () => {
    const { session, harness } = makeSession();
    const p = session.send("crash");
    await waitFor(() => harness.inputs.length === 1);
    harness.pushEvent(errorResult("error_during_execution"));
    await expect(p).rejects.toThrow(/stopped early/);

    const p2 = session.send("again");
    await waitFor(() => harness.inputs.length === 2);
    harness.pushEvent(errorResult("error_max_structured_output_retries"));
    await expect(p2).rejects.toThrow(/stopped early/);
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
