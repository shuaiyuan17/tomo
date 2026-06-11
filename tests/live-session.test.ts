import { describe, it, expect, beforeEach, vi } from "vitest";

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
  pushEvent: (e: AnyEvent) => void;
  fail: (err: Error) => void;
}

const harnessRef = vi.hoisted(() => ({ current: null as Harness | null }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> } }> }) => {
    const inputs: string[] = [];
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
      }
    })().catch(() => {});

    harnessRef.current = {
      inputs,
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

const textBlock = (text: string) => ({ type: "text", text });
const assistantEvent = (text: string) => ({ type: "assistant", message: { content: [textBlock(text)] } });
const userEcho = (text: string) => ({ type: "user", message: { content: [textBlock(text)] } });
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
