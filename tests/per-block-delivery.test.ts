/**
 * Mid-turn outbound delivery: one completed content block, one delivery.
 *
 * #292 removed streaming and moved delivery to the END of the turn. That fixed
 * the "几十条消息" newline-splitting of the streaming era but cost the owner the
 * ability to be answered mid-turn: while the agent waits 20 minutes on a
 * subagent, text it already produced sits in a buffer.
 *
 * The contract pinned here is the third option: no streaming, but each `text`
 * content block ships as soon as the SDK closes it — WHILE THE TURN IS STILL
 * RUNNING, rather than after it ends. Newlines inside a block stay inside one
 * message. Nothing inspects the model's words to decide what ships; block TYPE
 * decides.
 *
 * SCOPE OF THE ORDERING CLAIM. These tests assert that a block reaches the
 * channel before the turn ends, and that blocks reach it in model order. They
 * deliberately do NOT assert that a block lands before the CLI runs the tool
 * the model announced alongside it — that is not true and this layer cannot
 * make it true. The SDK's `Query.readMessages()` (0.3.246) drains the
 * transport into its own internal queue on its own schedule, so the CLI starts
 * and finishes the announced tool regardless of how fast Tomo consumes events
 * or how slow a channel send is. Awaiting delivery orders OUR sends; it does
 * not throttle the CLI. The owner's requirement was "my text reaches him while
 * the turn is still running", which is what is pinned here.
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
 * next one. A `__effect` step therefore runs at a known point in OUR
 * consumption: after everything queued before it has been fully handled,
 * delivery included.
 *
 * That is a statement about the consumer, not about the real CLI — the real
 * `Query` pre-drains the transport (see the file header). So `__effect` is used
 * here only to mark points in Tomo's own progress through a turn, such as "the
 * turn is about to end". It is NOT used to stand in for the CLI executing a
 * tool; a mock that only runs the tool when Tomo asks for the next event would
 * prove ordering against the mock rather than against the SDK.
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
const { log } = await import("../src/logger.js");
const { DELIVERY_FAILED_MARKER } = await import("../src/agent/block-transcript.js");

// --- event builders -------------------------------------------------------

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking, signature: "sig" });
const toolUseBlock = (name: string, id: string) => ({ type: "tool_use", id, name, input: {} });
const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });
const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const effect = (run: () => void) => ({ type: "__effect", run });
/**
 * Marks the last instant at which the turn is still running: placed
 * immediately before `result()`, it runs once every earlier event has been
 * fully handled and before the turn's result is consumed. Anything logged
 * after this marker did NOT reach the channel mid-turn.
 */
const turnEnding = (order: string[]) => effect(() => order.push("TURN-ENDING"));
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
  /** Texts whose send must throw, for the partial-delivery tests. */
  failTexts = new Set<string>();
  /**
   * Texts whose send PARKS until the test releases it — a wedged channel, the
   * shape the delivery budget exists for. The send is not cancelled when the
   * budget expires (no channel offers cancellation), so on release it completes
   * normally and late, which is exactly the ordering hazard under test.
   */
  hangs = new Map<string, () => void>();
  private gates: Array<() => void> = [];

  constructor(private readonly order: string[]) {}

  /** Park this text's send until `releaseHangs()`. */
  hang(text: string): void {
    this.hangs.set(text, () => {});
  }

  /** Let every parked send complete. */
  releaseHangs(): void {
    const gates = this.gates;
    this.gates = [];
    for (const open of gates) open();
  }

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> {
    if (message.text !== undefined && this.failTexts.has(message.text)) {
      this.order.push(`send-failed:${message.text}`);
      throw new Error(`channel refused ${message.text}`);
    }
    if (message.text !== undefined && this.hangs.has(message.text)) {
      this.hangs.delete(message.text);
      this.order.push(`send-parked:${message.text}`);
      await new Promise<void>((resolve) => { this.gates.push(resolve); });
    }
    this.sent.push(message);
    this.order.push(message.photo ? `photo:${message.photo}` : `send:${message.text}`);
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  closeIngestion(): void {}
  async quiesce(): Promise<void> {}
  async teardown(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface Rig {
  order: string[];
  channel: OrderedChannel;
  transcript: string[];
  run: (events: AnyEvent[], overrides?: Partial<TurnSpec>) => Promise<boolean>;
  close: () => void;
}

function makeRig(settings: {
  showThinking?: boolean;
  /** Stand in for the host's runWithRetry — for responses that never had
   *  content blocks (LiveSessionManager's fabricated fallbacks). */
  runWithRetry?: TurnRunnerDeps["runWithRetry"];
} = {}): Rig {
  const order: string[] = [];
  const channel = new OrderedChannel(order);
  const transcript: string[] = [];
  const session = new LiveSession({} as never, "test:session", undefined, undefined, settings);
  const harness = harnessRef.current!;

  const deps: TurnRunnerDeps = {
    drainPendingNotes: () => "",
    runWithRetry: settings.runWithRetry
      ?? ((req) => session.send(req.prompt, undefined, undefined, req.onBlock, req.onBlockAbandoned)),
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
    // there the stream advances solely at the consumer's pace. An empty script
    // means the turn never reaches the session at all (a stubbed runWithRetry),
    // so there is nothing to wait for.
    if (events.length > 0) {
      while (harness.inputs.length === 0) await new Promise((r) => setTimeout(r, 1));
      harness.enqueue(events);
    }
    const done = await turn;
    // The other end of the mid-turn claim: everything logged before this point
    // reached the channel while TurnRunner had not yet returned.
    order.push("TURN-RETURNED");
    return done;
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

describe("a completed text block reaches the channel while the turn is still running", () => {
  /**
   * THE regression test for #292. The owner's complaint, stated as something
   * that is actually true: a reply written before a 20-minute tool call must
   * reach him DURING the turn — not held in a buffer until the turn ends.
   *
   * Under #292 both sends landed after `result` was consumed, so both would
   * fall on the far side of TURN-ENDING. That is exactly what this catches.
   *
   * NOT asserted, and not true: that A lands before the CLI executes `Bash`.
   * By the time A is on the phone the CLI has very likely already started, and
   * may already have finished, that tool — the SDK pre-drains the transport
   * and nothing in Tomo throttles it. The tool_use/tool_result pair is in the
   * script for realistic shape only; no assertion rests on where the CLI ran.
   */
  it("delivers block A mid-turn, before the turn ends, and B after it in model order", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([toolUseBlock("Bash", "t1")]),
      toolResult("t1"),
      assistant([textBlock("B")]),
      turnEnding(r.order),
      result(),
    ]);

    expect(r.order).toEqual(["send:A", "send:B", "TURN-ENDING", "TURN-RETURNED"]);
  });

  /**
   * The block the owner is actually waiting on is the one written BEFORE the
   * long tool. Pinned separately: A must be on the channel before the turn
   * consumes that tool's result, so a tool that takes twenty minutes to come
   * back cannot be what delays A.
   */
  it("delivers block A before the turn consumes the result of the tool that follows it", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A")]),
      assistant([toolUseBlock("Bash", "t1")]),
      effect(() => r.order.push("TOOL-RESULT-CONSUMED")),
      toolResult("t1"),
      assistant([textBlock("B")]),
      turnEnding(r.order),
      result(),
    ]);

    expect(r.order).toEqual([
      "send:A",
      "TOOL-RESULT-CONSUMED",
      "send:B",
      "TURN-ENDING",
      "TURN-RETURNED",
    ]);
  });

  it("delivers a block that arrives in the same event as the tool_use it precedes", async () => {
    const r = rig();

    await r.run([
      assistant([textBlock("A"), toolUseBlock("Bash", "t1")]),
      toolResult("t1"),
      assistant([textBlock("B")]),
      turnEnding(r.order),
      result(),
    ]);

    expect(r.order).toEqual(["send:A", "send:B", "TURN-ENDING", "TURN-RETURNED"]);
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

  it("absorbs the spaces around a legacy [[NL]] so the block ships as one clean multi-line message", async () => {
    const r = rig();

    await r.run([assistant([textBlock("☕ 早报\n\nAI [[NL]] · item one [[NL]] · item two")]), result()]);

    expect(r.channel.sent).toHaveLength(1);
    expect(r.channel.sent[0].text).toBe("☕ 早报\n\nAI\n· item one\n· item two");
    expect(r.channel.sent[0].text).not.toContain("[[NL]]");
    // `always` policy: the joined response is recorded after the turn — in
    // the form that was delivered, not the form the model composed.
    expect(r.transcript).toEqual(["☕ 早报\n\nAI\n· item one\n· item two"]);
  });

  it("records the rewritten text in the on-delivery transcript, not the [[NL]] form", async () => {
    // recall_conversation reads the transcript back as "things I told him".
    // Before this the slot settled with the pre-rewrite block, so recall held
    // `AI [[NL]] · item` while the phone showed `AI\n· item`.
    const r = rig();

    await r.run(
      [assistant([textBlock("AI [[NL]] · item one")]), assistant([textBlock("plain\nlines")]), result()],
      { delivery: { kind: "send", channel: r.channel, chatId: "chat1" }, transcript: "on-delivery" },
    );

    expect(r.channel.sent.map((m) => m.text)).toEqual(["AI\n· item one", "plain\nlines"]);
    expect(r.transcript).toEqual(["AI\n· item one", "plain\nlines"]);
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

/**
 * A `thinking` block that HAS TEXT IN IT, with showThinking off, is a
 * misplaced message — and is delivered as one.
 *
 * WHY, EMPIRICALLY. showThinking off starts the SDK with thinking
 * `display: "omitted"`, which strips the reasoning and leaves a
 * signature-only block whose `thinking` string is EMPTY. One session's
 * transcript for 2026-08-28 (since the 01:13 restart, flag off) held 173 such
 * blocks — all empty, which is what real reasoning looks like under
 * `omitted` — and 21 `thinking` blocks with non-empty text. Every one of the
 * 21 was prose the model addressed to the owner: a reply written after a tool
 * result, a progress line after a steered message. Six were answers he was
 * waiting for and never received. None was reasoning that leaked past
 * `omitted`.
 *
 * The rule that follows is still TYPE + LENGTH ONLY, never content. Nothing
 * below reads the prose to judge whether it is "really" a reply — that is the
 * inspection #292 exists to prevent. Empty (or whitespace-only) thinking is
 * dropped exactly as before; non-empty thinking with the flag off renders
 * exactly like a `text` block, with NO 💭 marker, because it is not being
 * shown as reasoning: it IS the message.
 */
describe("thinking blocks", () => {
  it("delivers a non-empty thinking block as text, in order, unmarked, when showThinking is off", async () => {
    const r = rig({ showThinking: false });

    await r.run([
      assistant([thinkingBlock("hello there")]),
      assistant([toolUseBlock("Bash", "t1")]),
      toolResult("t1"),
      assistant([textBlock("B")]),
      turnEnding(r.order),
      result(),
    ]);

    // Its own message, before the tool call, and with no 💭 — the marker says
    // "this is reasoning", which is the one thing this block is not.
    expect(r.order).toEqual([
      "send:hello there",
      "send:B",
      "TURN-ENDING",
      "TURN-RETURNED",
    ]);
  });

  it("warns, with the delivered length, only for the block it actually delivered", async () => {
    const r = rig({ showThinking: false });

    await r.run([
      assistant([thinkingBlock("hello there")]),
      assistant([thinkingBlock("   ")]),
      result(),
    ]);

    const thinkingWarns = vi.mocked(log.warn).mock.calls.filter(
      ([, msg]) => typeof msg === "string" && msg.includes("thinking block routed as text"),
    );
    expect(thinkingWarns).toHaveLength(1);
    expect(thinkingWarns[0]![0]).toMatchObject({ session: "test:session", chars: 11 });
  });

  it.each([
    { label: "empty", thinking: "" },
    { label: "whitespace-only", thinking: "   " },
  ])("drops a $label thinking block silently — that is what `omitted` produces", async ({ thinking }) => {
    const r = rig({ showThinking: false });

    await r.run([
      assistant([thinkingBlock(thinking)]),
      assistant([textBlock("A")]),
      result(),
    ]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["A"]);
    // Silent: 173 of these in one day would drown the log, and none of them
    // means anything is wrong.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("drops a non-empty thinking block whose trailing line is bare NO_REPLY", async () => {
    const r = rig({ showThinking: false });

    // The per-block rules apply to it exactly as they apply to a text block —
    // rendering it as text means ALL of the text path, not just the send.
    await r.run([
      assistant([thinkingBlock("housekeeping done\nNO_REPLY")]),
      assistant([textBlock("B")]),
      result(),
    ]);

    expect(r.channel.sent.map((m) => m.text)).toEqual(["B"]);
  });

  it("ships nothing from a non-empty thinking block on a suppressed turn", async () => {
    const r = rig({ showThinking: false });

    // suppressDelivery is a policy about the TURN; rendering a thinking block
    // as text changes what a block would say, not whether this turn may speak.
    await r.run(
      [assistant([thinkingBlock("checking the morning routine…")]), result()],
      {
        delivery: {
          kind: "deferred-send",
          suppressDelivery: true,
          resolveTarget: () => ({ channel: r.channel, chatId: "chat1" }),
        },
        transcript: "on-delivery",
      },
    );

    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual([]);
  });

  it("ships a thinking block as its own marked message before the text that follows", async () => {
    const r = rig({ showThinking: true });

    await r.run([
      assistant([thinkingBlock("weighing the options")]),
      assistant([toolUseBlock("Bash", "t1")]),
      toolResult("t1"),
      assistant([textBlock("A")]),
      turnEnding(r.order),
      result(),
    ]);

    expect(r.order).toEqual([
      "send:💭 weighing the options",
      "send:A",
      "TURN-ENDING",
      "TURN-RETURNED",
    ]);
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

    expect(r.order).toEqual(["send:A", `photo:${photoPath}`, "send:B", "TURN-RETURNED"]);
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

/**
 * The 2026-08-28 lost reply: what actually happened.
 *
 * THE REPORT. A DM turn produced a ~700-char block at 08:33:33 and then sat in
 * an MCP tool until 08:40:42. The owner received exactly one 31-char message
 * and never the long one.
 *
 * THE CAUSE, ESTABLISHED FROM THE LOG. `tomo.log` at 08:33:33 reads
 * `Routing unowned SDK turn to default delivery target
 * {"session":"dm:shuai","reason":"assistant_thinking"}`. The block the owner
 * never saw was emitted by the model as a `thinking` block, not a `text` one,
 * and with `showThinking` off `ef69851` dropped it BY DESIGN — renderBlock
 * decides what ships from the block TYPE and nothing else. There was no
 * interleaving between turns, and nothing was dropped on the unowned path.
 * The delivery layer behaved exactly as specified; the model simply put its
 * reply somewhere replies are not read from.
 *
 * WHAT CHANGED AS A RESULT, IN TWO STEPS. First, VISIBILITY: an unowned turn
 * opening with a hidden thinking block logs at warn with the block's length
 * (LiveSession.claimFirstUnownedEvent), so the shape is legible in the log
 * instead of taking a forensics pass. Then, once a day of transcript showed
 * that a NON-EMPTY thinking block under `display: "omitted"` is always a
 * misplaced message and never leaked reasoning (173 empty vs 21 non-empty, all
 * 21 messages), DELIVERY: such a block is now rendered exactly like a `text`
 * block. See the "thinking blocks" describe above. The rule is still decided
 * from the block's type and length alone — its prose is never inspected.
 *
 * THE TESTS BELOW ARE A GUARD, NOT AN EXPLANATION. They pin that a turn's
 * blocks belong to that turn alone — cross-turn contamination was the leading
 * hypothesis before the log settled it, and per-block delivery is what makes it
 * structurally impossible (a block goes out through its OWN turn's sink the
 * instant it completes, so no shared buffer survives for a later turn to
 * consume). Keeping them costs little and forecloses a real failure mode; they
 * are simply not the account of what went wrong that day.
 */
describe("a turn's blocks belong to that turn alone", () => {
  it("a NO_REPLY turn queued mid-flight cannot capture or suppress the earlier turn's blocks", async () => {
    const session = new LiveSession({} as never, "dm:owner", undefined, undefined, {});
    const harness = harnessRef.current!;
    const toA: string[] = [];
    const toB: string[] = [];

    try {
      // Turn A starts and produces its first block, then stalls in a tool.
      const turnA = session.send("A?", undefined, undefined, async (b) => { toA.push(b); });
      while (harness.inputs.length === 0) await new Promise((r) => setTimeout(r, 1));
      harness.enqueue([assistant([textBlock("A1")]), assistant([toolUseBlock("codex", "t1")])]);
      await new Promise((r) => setTimeout(r, 5));

      // A1 is already on the owner's phone — DURING the turn, with the tool
      // still outstanding. #292 would still have it buffered here.
      expect(toA).toEqual(["A1"]);

      // The heartbeat turn is dispatched now, while A is still in flight. It
      // must not be able to touch A: send() waits for genuine idleness, so B
      // does not become the session's current request until A has resolved.
      const turnB = session.send("heartbeat", undefined, undefined, async (b) => { toB.push(b); });
      await new Promise((r) => setTimeout(r, 5));
      expect(harness.inputs).toHaveLength(1); // B has NOT been dispatched

      // The tool returns, A finishes.
      harness.enqueue([toolResult("t1"), assistant([textBlock("A2")]), result()]);
      expect(await turnA).toBe("A1\nA2");

      // Only now does B run, and it says nothing.
      while (harness.inputs.length < 2) await new Promise((r) => setTimeout(r, 1));
      harness.enqueue([assistant([textBlock("NO_REPLY")]), result()]);
      expect(await turnB).toBe("NO_REPLY");

      // The whole point: A got both of its blocks, B got none of them, and
      // B's NO_REPLY suppressed only B.
      expect(toA).toEqual(["A1", "A2"]);
      expect(toB).toEqual([]);
    } finally {
      session.close();
    }
  });

  it("an unowned turn that opens with a tool call still owns the session from its first event", async () => {
    const unowned: string[] = [];
    const session = new LiveSession(
      {} as never,
      "dm:owner",
      undefined,
      () => ({ resolve: () => {}, reject: () => {}, onBlock: (b) => { unowned.push(b); } }),
      {},
    );
    const harness = harnessRef.current!;
    const toB: string[] = [];

    try {
      // An autonomous / task-notification turn whose FIRST event carries no
      // text at all — just a root tool_use. This is the common shape: the model
      // reads a file or calls an MCP tool before it says anything.
      harness.enqueue([assistant([toolUseBlock("Bash", "t1")])]);
      await new Promise((r) => setTimeout(r, 5));

      // The turn is in flight, and the session says so. Claiming only on
      // text/thinking left isBusy() false right here, which is the whole bug.
      expect(session.isBusy()).toBe(true);

      // A heartbeat/cron/user send arrives mid-tool. It must QUEUE, not claim:
      // claiming would take currentRequest and clear `parts` out from under the
      // unowned turn, and the unowned turn's later text would then ship through
      // B's sink — to B's target, in B's turn.
      const turnB = session.send("heartbeat", undefined, undefined, async (b) => { toB.push(b); });
      await new Promise((r) => setTimeout(r, 5));
      expect(harness.inputs).toHaveLength(0); // B has NOT been dispatched

      // The tool returns and the unowned turn finally speaks.
      harness.enqueue([toolResult("t1"), assistant([textBlock("autonomous answer")]), result()]);
      await new Promise((r) => setTimeout(r, 5));

      // Delivered to the session's DEFAULT target, through the unowned turn's
      // own sink — not into B's.
      expect(unowned).toEqual(["autonomous answer"]);
      expect(toB).toEqual([]);

      // Only now does B run, and it gets its own reply and nothing else.
      while (harness.inputs.length < 1) await new Promise((r) => setTimeout(r, 1));
      harness.enqueue([assistant([textBlock("B reply")]), result()]);
      expect(await turnB).toBe("B reply");
      expect(toB).toEqual(["B reply"]);
      expect(unowned).toEqual(["autonomous answer"]);
    } finally {
      session.close();
    }
  });

  it("lets only one of two simultaneous sends claim the idle session", async () => {
    const session = new LiveSession({} as never, "dm:owner", undefined, undefined, {});
    const harness = harnessRef.current!;

    try {
      // Both callers find the session idle in the same tick. "await
      // waitForIdle(); this.currentRequest = req;" let both through — the
      // second silently replacing the first's request and clearing its parts.
      const first = session.send("first");
      const second = session.send("second");
      await new Promise((r) => setTimeout(r, 5));

      expect(harness.inputs).toEqual(["first"]);

      harness.enqueue([assistant([textBlock("one")]), result()]);
      expect(await first).toBe("one");

      while (harness.inputs.length < 2) await new Promise((r) => setTimeout(r, 1));
      harness.enqueue([assistant([textBlock("two")]), result()]);
      expect(await second).toBe("two");
    } finally {
      session.close();
    }
  });

  it("delivers, and warns about, an unowned turn that opens with a non-empty thinking block", async () => {
    const unowned: string[] = [];
    const session = new LiveSession(
      {} as never,
      "dm:owner",
      undefined,
      () => ({ resolve: () => {}, reject: () => {}, onBlock: (b) => { unowned.push(b); } }),
      { showThinking: false },
    );
    const harness = harnessRef.current!;

    try {
      // THE EXACT 2026-08-28 08:33 SHAPE: a ~700-char reply written inside a
      // thinking block, on an unowned turn, with showThinking off, followed by
      // a seven-minute tool call. It used to be dropped by design and the owner
      // simply never got his answer. It now goes to the session's default
      // target, unmarked, as the message it is.
      harness.enqueue([assistant([thinkingBlock("x".repeat(700))]), assistant([toolUseBlock("Bash", "t1")])]);
      await new Promise((r) => setTimeout(r, 5));

      expect(unowned).toEqual(["x".repeat(700)]);
      // The claim-time warn from #293 stays: this shape is worth seeing in the
      // log whatever we now do with it.
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ session: "dm:owner", chars: 700 }),
        expect.stringContaining("thinking block"),
      );
    } finally {
      session.close();
    }
  });

  it("delivers a block that arrives with no owning request to the session's default target", async () => {
    const unowned: string[] = [];
    const session = new LiveSession(
      {} as never,
      "dm:owner",
      undefined,
      // The default-target sink LiveSessionManager installs
      // (Agent.createUnownedTurnRequest in production).
      () => ({ resolve: () => {}, reject: () => {}, onBlock: (b) => { unowned.push(b); } }),
      {},
    );
    const harness = harnessRef.current!;

    try {
      // No send() in flight: this turn was initiated by the SDK itself.
      harness.enqueue([assistant([textBlock("orphan narration")]), result()]);
      await new Promise((r) => setTimeout(r, 10));

      // Delivered, not dropped. Losing it silently is the failure mode the
      // 2026-08-28 repro is suspected of.
      expect(unowned).toEqual(["orphan narration"]);
    } finally {
      session.close();
    }
  });

  it("logs at ERROR when an unowned block has no default target and must be dropped", async () => {
    const session = new LiveSession({} as never, "dm:owner", undefined, () => undefined, {});
    const harness = harnessRef.current!;

    try {
      harness.enqueue([assistant([textBlock("orphan narration")]), result()]);
      await new Promise((r) => setTimeout(r, 10));

      // A block the model wrote reached nobody. That is never an info-level
      // event, however routine the cause.
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ session: "dm:owner" }),
        expect.stringContaining("DROPPING the content block"),
      );
    } finally {
      session.close();
    }
  });
});

describe("the transcript records what was DELIVERED, not what was composed", () => {
  /**
   * The transcript is what `recall_conversation` reads back as "things I told
   * him". Writing an entry before the send meant a turn whose second block
   * failed still recorded both, so the agent would later act on a message the
   * owner never received. Entries are therefore written after the send
   * resolves, and a failed send is recorded with a marker instead.
   */
  it("marks a block whose send threw, and records the one that succeeded clean", async () => {
    const r = rig();
    r.channel.failTexts.add("B");

    await r.run(
      [
        assistant([textBlock("A")]),
        assistant([textBlock("B")]),
        assistant([textBlock("C")]),
        result(),
      ],
      { transcript: "on-delivery" },
    );

    // A and C reached the owner; B did not, and says so.
    expect(r.transcript).toEqual(["A", "[delivery failed] B", "C"]);
    expect(r.channel.sent.map((m) => m.text)).toEqual(["A", "C"]);
    // A failed send never aborts the turn — C still ships after B.
    expect(r.order).toEqual([
      "send:A",
      "send-failed:B",
      "send:C",
      "TURN-RETURNED",
    ]);
  });
});

/**
 * THE TRANSCRIPT IS ORDERED BY DISPATCH, NOT BY SETTLEMENT.
 *
 * A block's transcript entry can only be written once its send has settled —
 * writing on intent claims deliveries that never happened. But settle order is
 * not model order: a block that blows the 60s delivery budget is abandoned and
 * the turn moves on, while its promise keeps running. Appending at settle time
 * therefore produced `B, A`, or `B, [delivery failed] A`, or — when the wedged
 * send never settled at all — no entry for A whatsoever, all while the PR
 * claimed an ordered `[delivery failed] A, B`.
 *
 * The fix is slot reservation: a block takes its place in the transcript when
 * its send is ATTEMPTED (which LiveSession serializes, so it is model order)
 * and fills that slot when the send settles or is given up on. A slot is filled
 * exactly once, so a late-settling send changes nothing.
 */
describe("a wedged block keeps its place in the transcript", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("records the abandoned block IN ORDER, and ignores its late completion", async () => {
    const r = rig();
    r.channel.hang("A");

    const turn = r.run(
      [assistant([textBlock("A")]), assistant([textBlock("B")]), result()],
      { transcript: "on-delivery" },
    );

    // A is dispatched and parks in the channel. Nothing is recorded yet: the
    // slot is reserved but open, and an open slot holds back everything behind
    // it rather than letting it overtake.
    await vi.advanceTimersByTimeAsync(20);
    expect(r.transcript).toEqual([]);

    // Past the 60s delivery budget: A is given up on and closed out in its own
    // place, before B is ever handed over — so A's entry is FIRST even though
    // B's send is the one that settled first.
    await vi.advanceTimersByTimeAsync(60_100);
    expect(r.transcript[0]).toBe("[delivery failed] A");

    await turn;
    expect(r.transcript).toEqual(["[delivery failed] A", "B"]);
    // B is on the owner's phone; A is not known to be.
    expect(r.channel.sent.map((m) => m.text)).toEqual(["B"]);

    // A's send finally completes, long after the turn gave up on it. It may
    // well have reached the owner — that is unavoidable and is exactly what the
    // marker's ambiguity means — but it must not rewrite history.
    r.channel.releaseHangs();
    await vi.advanceTimersByTimeAsync(20);
    expect(r.transcript).toEqual(["[delivery failed] A", "B"]);
  });
});

/**
 * A turn that dies after shipping must still say what it shipped.
 *
 * Ordinary user turns record `transcript: "always"` — the turn's joined
 * response, once, AFTER runWithRetry succeeds. The no-retry-after-ship guard
 * makes "it never succeeds" routine: a turn that has already put a block on the
 * owner's phone is refused a retry (a retry would re-send it) and throws
 * instead. So the owner held text the transcript had never heard of, and recall
 * would later contradict what he was actually told.
 */
describe("blocks that shipped before the turn died reach the transcript", () => {
  it("records the shipped block, then the error, in that order", async () => {
    const r = rig();

    // A ships; then the session dies mid-turn, exactly as a killed SDK child
    // does. `transcript: "always"` is the ordinary user-turn policy.
    const ok = await r.run(
      [assistant([textBlock("A")]), effect(() => { r.close(); })],
      { transcript: "always" },
    );

    expect(ok).toBe(false);
    expect(r.channel.sent.map((m) => m.text)).toEqual(["A", "[error] Session is closed"]);
    expect(r.transcript).toEqual(["A", "[error] Session is closed"]);
  });
});

/**
 * The fabricated fallback follows the same rule as every other send.
 *
 * LiveSessionManager's max-turn and shutdown responses ("I ran out of steps
 * trying to complete that.") never produced content blocks, so they never
 * reached the per-block sink and are delivered once, after the turn. That path
 * used to append its transcript entry and THEN send, so a channel throw left a
 * clean entry for a message that never arrived.
 */
describe("the fabricated-response fallback transcribes after it sends", () => {
  const FABRICATED = "I ran out of steps trying to complete that. Can you try a simpler request?";

  it("records it clean when the send succeeds", async () => {
    const r = rig({ runWithRetry: async () => FABRICATED });

    const ok = await r.run([], { transcript: "on-delivery" });

    expect(ok).toBe(true);
    expect(r.channel.sent.map((m) => m.text)).toEqual([FABRICATED]);
    expect(r.transcript).toEqual([FABRICATED]);
  });

  it("marks it when the send throws, instead of claiming a delivery that never happened", async () => {
    const r = rig({ runWithRetry: async () => FABRICATED });
    r.channel.failTexts.add(FABRICATED);

    const ok = await r.run([], { transcript: "on-delivery" });

    expect(ok).toBe(false);
    // Never delivered...
    expect(r.channel.sent.map((m) => m.text)).toEqual([`[error] channel refused ${FABRICATED}`]);
    // ...and the transcript says so, rather than reading back as told.
    expect(r.transcript).toEqual([
      `${DELIVERY_FAILED_MARKER}${FABRICATED}`,
      `[error] channel refused ${FABRICATED}`,
    ]);
  });
});

/**
 * DECIDED (owner, 2026-08-28): OPTION A.
 *
 * Continuity turns (heartbeat, post-restart notice) are unbidden — nobody asked
 * a question — so their own text blocks are never delivered. To speak from one,
 * the model calls `send_message`. Turns the user DID ask for, and delegated
 * proactive turns (whose whole purpose is to produce a message), are unaffected.
 *
 * The alternative was to keep relying on the prompt's closing `NO_REPLY`, which
 * per-block delivery can no longer honour: a turn that narrates, calls a tool
 * and only then answers NO_REPLY has already shipped the narration, and a sent
 * message cannot be recalled. Silence for a turn nobody asked for must not
 * depend on the model's cooperation, so it is enforced by the delivery policy.
 */
describe("continuity-shaped turns ship nothing of their own (option A)", () => {
  /** The continuity turn's real shape, as processContinuity builds it. */
  const continuityDelivery = (r: Rig): Partial<TurnSpec> => ({
    delivery: {
      kind: "deferred-send",
      suppressDelivery: true,
      resolveTarget: () => ({ channel: r.channel, chatId: "chat1" }),
    },
    transcript: "on-delivery",
  });

  it("drops the narration block of a text -> tool -> NO_REPLY heartbeat", async () => {
    const r = rig();

    await r.run(
      [
        assistant([textBlock("Checking in on the morning routine…")]),
        assistant([toolUseBlock("Bash", "t1")]),
        toolResult("t1"),
        assistant([textBlock("NO_REPLY")]),
        result(),
      ],
      continuityDelivery(r),
    );

    // Under the old contract the narration was already gone by the time the
    // NO_REPLY that was meant to silence it was written. Now it never ships.
    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual([]);
  });

  it("drops even a heartbeat that says something genuinely useful", async () => {
    const r = rig();

    // Suppression is not a judgement about the content — it is a property of
    // the turn. A heartbeat with real news must route it through send_message.
    await r.run(
      [assistant([textBlock("Your flight check-in opens in an hour.")]), result()],
      continuityDelivery(r),
    );

    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual([]);
  });

  it("still delivers a turn that was actually asked for", async () => {
    const r = rig();

    // The delegated-proactive / cron shape: a turn whose output IS the message.
    // Option A must not touch it.
    await r.run(
      [assistant([textBlock("the brief")]), result()],
      {
        delivery: { kind: "send", channel: r.channel, chatId: "chat1" },
        transcript: "on-delivery",
      },
    );

    expect(r.channel.sent.map((m) => m.text)).toEqual(["the brief"]);
    expect(r.transcript).toEqual(["the brief"]);
  });
});

/**
 * A slow channel must not look like a dead model.
 *
 * LiveSession kills a turn that goes quiet for `timeoutMs` — that timer exists
 * to notice a MODEL that stopped producing. Before this fix it was refreshed
 * on the event carrying a block and then never again for the whole duration of
 * `await onBlock`, because refreshes only happen while we are consuming SDK
 * events and during a send we are not. Real events piled up in the SDK's own
 * queue where the timer could not see them. A wedged iMessage send therefore
 * ran the clock down on a healthy turn and closed the session: the owner got
 * his late message AND a spurious "Query timed out" error.
 */
describe("inactivity accounting is suspended while a block is being delivered", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("completes a turn whose send outlasts the whole inactivity window", async () => {
    // Deliberately tiny: the send below takes five times this long.
    const session = new LiveSession({} as never, "dm:owner", undefined, undefined, { timeoutMs: 1_000 });
    const harness = harnessRef.current!;

    let release!: () => void;
    const wedged = new Promise<void>((r) => { release = r; });
    const delivered: string[] = [];

    try {
      const turn = session.send("hi", undefined, undefined, async (b) => {
        delivered.push(b);
        await wedged;
      });
      await vi.advanceTimersByTimeAsync(5);

      harness.enqueue([assistant([textBlock("A")])]);
      await vi.advanceTimersByTimeAsync(5);
      expect(delivered).toEqual(["A"]); // now parked inside `await onBlock`

      // Five inactivity windows pass with the send still outstanding. Under
      // the old code the timer fired here and closed the session.
      await vi.advanceTimersByTimeAsync(5_000);

      release();
      await vi.advanceTimersByTimeAsync(5);
      harness.enqueue([assistant([textBlock("B")]), result()]);
      await vi.advanceTimersByTimeAsync(5);

      // The turn finished normally: no timeout error, both blocks intact.
      await expect(turn).resolves.toBe("A\nB");
    } finally {
      release();
      session.close();
    }
  });

  it("abandons a block whose send never returns, without killing the turn", async () => {
    // Inactivity window comfortably longer than the 60s delivery budget, as in
    // production (10 minutes vs 60 seconds) — the delivery timeout must be the
    // one that fires.
    const session = new LiveSession({} as never, "dm:owner", undefined, undefined, { timeoutMs: 5 * 60_000 });
    const harness = harnessRef.current!;
    const delivered: string[] = [];

    try {
      // The send of block A never settles at all. B's send is normal, so the
      // turn can still finish once A has been given up on.
      const turn = session.send("hi", undefined, undefined, async (b) => {
        delivered.push(b);
        if (b === "A") await new Promise<void>(() => {});
      });
      await vi.advanceTimersByTimeAsync(5);

      harness.enqueue([assistant([textBlock("A")])]);
      await vi.advanceTimersByTimeAsync(5);
      expect(delivered).toEqual(["A"]);

      // Past the 60s delivery budget: the block is given up on...
      await vi.advanceTimersByTimeAsync(60_100);

      // ...and the turn carries on and completes. The session is NOT closed,
      // and B still ships.
      harness.enqueue([assistant([textBlock("B")]), result()]);
      await vi.advanceTimersByTimeAsync(5);
      await expect(turn).resolves.toBe("A\nB");
      expect(delivered).toEqual(["A", "B"]);
    } finally {
      session.close();
    }
  });
});
