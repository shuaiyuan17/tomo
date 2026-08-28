/**
 * Mid-turn outbound delivery: one completed content block, one delivery.
 *
 * #292 removed streaming and moved delivery to the END of the turn. That fixed
 * the "几十条消息" newline-splitting of the streaming era but cost the owner the
 * ability to be answered mid-turn: while the agent waits 20 minutes on a
 * subagent, text it already produced sits in a buffer.
 *
 * The contract pinned here is the third option: no streaming, but each `text`
 * content block ships as soon as the SDK closes it — i.e. before the tool call
 * that follows it runs. Newlines inside a block stay inside one message.
 * Nothing inspects the model's words to decide what ships; block TYPE decides.
 *
 * These tests drive the REAL stack — LiveSession over a scripted mock SDK,
 * through TurnRunner, through DeliveryPipeline, into a fake channel — because
 * the regression is an ORDERING property that no single unit can express.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage, StopTyping } from "../src/channels/types.js";
import type { TurnRunnerDeps, TurnSpec } from "../src/agent/turn-runner.js";

type AnyEvent = Record<string, unknown>;

interface Harness {
  inputs: string[];
  /** Queue events for the SDK stream. Pulled one at a time, as the consumer asks. */
  enqueue: (events: AnyEvent[]) => void;
}

const harnessRef = vi.hoisted(() => ({ current: null as Harness | null }));

/**
 * Scripted mock SDK.
 *
 * The queue is pulled ONE EVENT AT A TIME, only when LiveSession asks for the
 * next one — exactly like the real stream. That is what makes the ordering
 * assertions meaningful: a `__effect` step (standing in for the CLI actually
 * running a tool) cannot run until the consumer has finished handling every
 * event queued before it, delivery included.
 */
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: Array<{ type: string; text?: string }> } }> }) => {
    const inputs: string[] = [];
    const eventQueue: AnyEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;

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
      enqueue: (events) => { eventQueue.push(...events); wake?.(); },
    };

    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (eventQueue.length === 0 && !done) {
            await new Promise<void>((r) => { wake = r; });
            wake = null;
          }
          if (eventQueue.length === 0) return;
          const event = eventQueue.shift()!;
          if (event.type === "__effect") {
            // Work the CLI does BETWEEN stream events (running the tool it
            // just announced). Never yielded — only its position matters.
            (event.run as () => void)();
            continue;
          }
          yield event;
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

const { LiveSession } = await import("../src/agent/live-session.js");
const { TurnRunner } = await import("../src/agent/turn-runner.js");
const { DeliveryPipeline } = await import("../src/agent/delivery-pipeline.js");
const { isSilentReply } = await import("../src/agent/text-utils.js");

// --- event builders -------------------------------------------------------

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking, signature: "sig" });
const toolUseBlock = (name: string, id: string) => ({ type: "tool_use", id, name, input: {} });
const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });
const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const effect = (run: () => void) => ({ type: "__effect", run });
const result = () => ({
  type: "result",
  subtype: "success",
  session_id: "sid-1",
  total_cost_usd: 0,
  num_turns: 1,
  duration_ms: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
});

// --- harness --------------------------------------------------------------

/** Records every send in the ONE ordered log the ordering tests assert on. */
class OrderedChannel implements Channel {
  readonly name = "imessage";
  sent: OutgoingMessage[] = [];

  constructor(private readonly order: string[]) {}

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
    this.order.push(message.photo ? `photo:${message.photo}` : `send:${message.text}`);
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface Rig {
  order: string[];
  channel: OrderedChannel;
  transcript: string[];
  run: (events: AnyEvent[], overrides?: Partial<TurnSpec>) => Promise<boolean>;
  close: () => void;
}

function makeRig(settings: { showThinking?: boolean } = {}): Rig {
  const order: string[] = [];
  const channel = new OrderedChannel(order);
  const transcript: string[] = [];
  const session = new LiveSession({} as never, "test:session", undefined, undefined, settings);
  const harness = harnessRef.current!;

  const deps: TurnRunnerDeps = {
    drainPendingNotes: () => "",
    runWithRetry: (req) => session.send(req.prompt, undefined, undefined, req.onBlock),
    appendAssistantTranscript: (_key, content) => { transcript.push(content); },
    queuePendingErrorNote: () => {},
    startTurnTyping: (): StopTyping => async () => {},
    delivery: new DeliveryPipeline({ queuePendingErrorNote: () => {} }),
  };
  const runner = new TurnRunner(deps);

  const run = async (events: AnyEvent[], overrides: Partial<TurnSpec> = {}) => {
    const spec: TurnSpec = {
      key: "dm:owner",
      source: "user",
      prompt: "hello",
      stampChannelName: "imessage",
      delivery: { kind: "reply", channel, chatId: "chat1" },
      silentMatcher: isSilentReply,
      transcript: "always",
      errors: {
        visiblePrefix: "[error] ",
        response: "deliver",
        thrown: "deliver",
        thrownLogMessage: "Error handling message",
      },
      ...overrides,
    };
    const turn = runner.runTurn(spec);
    // Queue the whole script only once the turn is genuinely in flight; from
    // there the stream advances solely at the consumer's pace.
    while (harness.inputs.length === 0) await new Promise((r) => setTimeout(r, 1));
    harness.enqueue(events);
    return await turn;
  };

  return { order, channel, transcript, run, close: () => session.close() };
}

let rigs: Rig[] = [];
function rig(settings?: { showThinking?: boolean }): Rig {
  const r = makeRig(settings);
  rigs.push(r);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  harnessRef.current = null;
  rigs = [];
});

afterEach(() => {
  for (const r of rigs) r.close();
});

// ---------------------------------------------------------------------------

describe("a completed text block ships before the tool call that follows it", () => {
  /**
   * THE regression test for #292. The owner's complaint in one assertion: a
   * reply produced before a 20-minute tool call must reach him before that
   * tool call runs, not after the turn ends.
   */
  it("delivers block A before the tool runs, then B after it", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([toolUseBlock("Bash", "t1")]),
      effect(() => r.order.push("tool:Bash")),
      toolResult("t1"),
      assistant([textBlock("B")]),
      result(),
    ]);

    expect(r.order).toEqual(["send:A", "tool:Bash", "send:B"]);
  });

  it("delivers a block that arrives in the same event as the tool_use it precedes", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A"), toolUseBlock("Bash", "t1")]),
      effect(() => r.order.push("tool:Bash")),
      toolResult("t1"),
      assistant([textBlock("B")]),
      result(),
    ]);

    expect(r.order).toEqual(["send:A", "tool:Bash", "send:B"]);
  });
});

describe("one block, one message", () => {
  it("ships a three-line block as one send with two embedded newlines", async () => {
    const r = rig();

    await r.run([assistant([textBlock("line one\nline two\nline three")]), result()]);

    expect(r.channel.sent).toHaveLength(1);
    expect(r.channel.sent[0].text).toBe("line one\nline two\nline three");
  });

  it("never merges two completed blocks into one send", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([textBlock("B")]),
      result(),
    ]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["A", "B"]);
  });

  it("rewrites [[NL]] and never ships the literal token", async () => {
    const r = rig();

    await r.run([assistant([textBlock("intro[[NL]]detail")]), result()]);

    expect(r.channel.sent).toHaveLength(1);
    expect(r.channel.sent[0].text).toBe("intro\ndetail");
  });
});

describe("NO_REPLY is enforced per block", () => {
  let dir: string;
  let photoPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-per-block-"));
    photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships A and nothing at all from a following housekeeping NO_REPLY block", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([textBlock(`housekeeping MEDIA:${photoPath}\nNO_REPLY`)]),
      result(),
    ]);

    // The 2026-07-08 invariant, per block: text AND media suppressed together.
    expect(r.channel.sent).toEqual([{ chatId: "chat1", text: "A" }]);
  });

  /**
   * The semantics chosen for mid-turn delivery (see delivery-pipeline.ts):
   * a trailing bare NO_REPLY block suppresses ONLY ITSELF. A block that has
   * already shipped cannot be recalled, and holding the last block back until
   * the turn ends would reintroduce exactly the end-of-turn latency this whole
   * change exists to remove — on the block the owner is usually waiting for.
   */
  it("suppresses only itself when a bare NO_REPLY block trails a shipped block", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([textBlock("NO_REPLY")]),
      result(),
    ]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["A"]);
  });

  it("sends nothing for a turn that is only NO_REPLY", async () => {
    const r = rig();

    await r.run([assistant([textBlock("NO_REPLY")]), result()]);

    expect(r.channel.sent).toEqual([]);
  });

  it("sends nothing for a cron turn whose narration ends in NO_REPLY", async () => {
    const r = rig();

    await r.run(
      [assistant([textBlock("ran the backup, 3 files\nNO_REPLY")]), result()],
      { delivery: { kind: "send", channel: r.channel, chatId: "chat1" }, transcript: "on-delivery" },
    );

    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual([]);
  });

  it("still ships a block that merely mentions NO_REPLY mid-line (#222)", async () => {
    const r = rig();

    await r.run([assistant([textBlock("I answer with NO_REPLY when I have nothing to add.")]), result()]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["I answer with NO_REPLY when I have nothing to add."]);
  });
});

describe("thinking blocks", () => {
  it("never ships a thinking block when showThinking is off", async () => {
    const r = rig({ showThinking: false });

    await r.run([
      assistant([thinkingBlock("weighing the options")]),
      assistant([textBlock("A")]),
      result(),
    ]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["A"]);
  });

  it("ships a thinking block as its own marked message before the text that follows", async () => {
    const r = rig({ showThinking: true });

    await r.run([
      assistant([thinkingBlock("weighing the options")]),
      assistant([toolUseBlock("Bash", "t1")]),
      effect(() => r.order.push("tool:Bash")),
      toolResult("t1"),
      assistant([textBlock("A")]),
      result(),
    ]);

    expect(r.order).toEqual(["send:💭 weighing the options", "tool:Bash", "send:A"]);
  });
});

describe("attachment placement across blocks", () => {
  let dir: string;
  let photoPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-per-block-media-"));
    photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships A, then the photo, then B, each as its own block completes", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([textBlock(`MEDIA:${photoPath}`)]),
      assistant([textBlock("B")]),
      result(),
    ]);

    expect(r.order).toEqual(["send:A", `photo:${photoPath}`, "send:B"]);
    expect(r.channel.sent).toEqual([
      { chatId: "chat1", text: "A" },
      { chatId: "chat1", photo: photoPath, text: "" },
      { chatId: "chat1", text: "B" },
    ]);
  });
});

describe("the reply target is spent by the first block that ships", () => {
  it("threads A and leaves B unthreaded", async () => {
    const r = rig();

    await r.run(
      [assistant([textBlock("A")]), assistant([textBlock("B")]), result()],
      { delivery: { kind: "reply", channel: r.channel, chatId: "chat1", replyToMessageId: "msg-42" } },
    );

    expect(r.channel.sent).toEqual([
      { chatId: "chat1", text: "A", replyTo: "msg-42" },
      { chatId: "chat1", text: "B" },
    ]);
  });

  it("does not spend the target on a dropped leading NO_REPLY block", async () => {
    const r = rig();

    await r.run(
      [
        assistant([textBlock("housekeeping\nNO_REPLY")]),
        assistant([textBlock("B")]),
        result(),
      ],
      { delivery: { kind: "reply", channel: r.channel, chatId: "chat1", replyToMessageId: "msg-42" } },
    );

    expect(r.channel.sent).toEqual([{ chatId: "chat1", text: "B", replyTo: "msg-42" }]);
  });
});
