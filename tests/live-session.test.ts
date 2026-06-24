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
  pushEvent: (e: AnyEvent) => void;
  fail: (err: Error) => void;
}

const harnessRef = vi.hoisted(() => ({ current: null as Harness | null }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> }; priority?: string }> }) => {
    const inputs: string[] = [];
    const priorities: Array<string | undefined> = [];
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
      }
    })().catch(() => {});

    harnessRef.current = {
      inputs,
      priorities,
      pushEvent: (e) => { eventQueue.push(e); wake?.(); },
      fail: (err) => { error = err; wake?.(); },
    };

    return {
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
  }),
}));

vi.mock("../src/agent/sdk-options.js", () => ({
  resetTurnBudget: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LiveSession, STEER_MERGED } = await import("../src/agent/live-session.js");
const TIMEOUT_MS = 10 * 60 * 1000;

function makeSession() {
  const session = new LiveSession({} as never, "test:session");
  const harness = harnessRef.current!;
  return { session, harness };
}

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
const assistantEvent = (text: string) => ({ type: "assistant", message: { content: [textBlock(text)] } });
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
  harnessRef.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveSession timeouts", () => {
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

  it("closes the live session when a promoted steered turn times out", async () => {
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
    const steeredBlocks: string[] = [];

    const p1 = session.send("first");
    await waitFor(() => harness.inputs.length === 1);

    const p2 = session.steer("second", undefined, undefined, (t) => { steeredBlocks.push(t); });
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
    expect(steeredBlocks).toEqual(["reply two"]);
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
  it("keeps subagent narration out of callbacks and the response", async () => {
    const { session, harness } = makeSession();
    const texts: string[] = [];
    const blocks: string[] = [];

    const p = session.send("first", (t) => { texts.push(t); }, undefined, (b) => { blocks.push(b); });
    await waitFor(() => harness.inputs.length === 1);

    harness.pushEvent(subagentAssistantEvent("inner monologue"));
    // Subagent stream deltas must not pollute the top-level streaming text.
    harness.pushEvent({
      type: "stream_event",
      parent_tool_use_id: "toolu_parent",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    });
    harness.pushEvent({
      type: "stream_event",
      parent_tool_use_id: "toolu_parent",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "leaky delta" } },
    });
    harness.pushEvent(assistantEvent("real reply"));
    harness.pushEvent(resultEvent());

    await expect(p).resolves.toBe("real reply");
    expect(blocks).toEqual(["real reply"]);
    for (const t of texts) {
      expect(t).not.toContain("inner monologue");
      expect(t).not.toContain("leaky delta");
    }
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
