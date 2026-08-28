/**
 * SHUTDOWN MUST NOT SWALLOW WHAT THE OWNER ALREADY RECEIVED.
 *
 * `LiveSessionManager.runWithRetry` deliberately converts an in-flight
 * "Session is closed" into a SUCCESSFUL `NO_REPLY` while stopping, so a
 * restart does not unlink the SDK session. That conversion used to lie about
 * the transcript twice over:
 *
 *   1. Resolving instead of rejecting skips `TurnRunner`'s rejection flush, so
 *      the per-block transcript slots a user turn has been holding (user turns
 *      DEFER them — they normally record the joined response once, after the
 *      turn succeeds) were never appended at all.
 *   2. The success path then recorded the fabricated response — a bare
 *      `NO_REPLY` — as the turn's outcome. A block that had genuinely reached
 *      the owner's phone was replaced in the transcript by an assertion that
 *      the turn said nothing, and `recall_conversation` would later read the
 *      shutdown back as silence.
 *
 * And a slot whose send was still OPEN when shutdown began was worse still:
 * nothing abandoned it synchronously, so the turn sat on the 60s delivery
 * budget while the daemon tried to exit.
 *
 * These tests drive the REAL stack — a scripted mock SDK, through the real
 * LiveSession, the real LiveSessionManager (its shutdown branch is the
 * subject), the real TurnRunner and DeliveryPipeline, into a fake channel —
 * because the property is an interaction between all four.
 */
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

/** Scripted mock SDK — one event handed over at a time, only when asked. */
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
          yield eventQueue.shift()!;
        }
      },
      close: () => { done = true; wake?.(); },
      getContextUsage: async () => ({ totalTokens: 100, maxTokens: 1000, percentage: 10, categories: [] }),
    };
  }),
}));

vi.mock("../src/agent/sdk-options.js", () => ({
  resetTurnBudget: vi.fn(),
  makeTurnBudget: () => ({}),
  sdkOptions: () => ({ model: "test-model" }),
}));

vi.mock("../src/config.js", () => ({
  config: { sdkSessionsDir: "/tmp/sdk-sessions", liveSessionTimeoutMs: 600_000, showThinking: false },
}));

vi.mock("../src/sessions/repair.js", () => ({
  repairSdkSessionForResume: vi.fn(() => ({})),
}));

vi.mock("../src/lcm/index.js", () => ({
  checkAndClearCompactTrigger: vi.fn(() => false),
}));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LiveSessionManager, SHUTDOWN_NOT_PROCESSED } = await import("../src/agent/live-session-manager.js");
const { TurnRunner } = await import("../src/agent/turn-runner.js");
const { DeliveryPipeline } = await import("../src/agent/delivery-pipeline.js");
const { isSilentReply } = await import("../src/agent/text-utils.js");
const { DELIVERY_FAILED_MARKER } = await import("../src/agent/block-transcript.js");

type Deps = ConstructorParameters<typeof LiveSessionManager>[0];

function makeManagerDeps(buildExternalMcpServers?: Deps["buildExternalMcpServers"]): Deps {
  return {
    buildExternalMcpServers: buildExternalMcpServers ?? (async () => ({})),
    buildSystemPrompt: () => "prompt-v1",
    getSdkSessionId: () => undefined,
    setSdkSessionId: vi.fn(),
    clearSdkSessionId: vi.fn(),
    retireSdkSessionId: vi.fn(),
    updateStats: vi.fn(),
    getSessionMessages: () => [],
    getModelOverride: () => undefined,
    createInternalMcpServer: () => ({} as ReturnType<Deps["createInternalMcpServer"]>),
    buildGroupContext: () => undefined,
    handleMcpElicitation: async () => ({ action: "decline" as const }),
    createUnownedTurnRequest: () => undefined,
    maybeNudgeCompact: vi.fn(),
  };
}

// --- event builders -------------------------------------------------------

const textBlock = (text: string) => ({ type: "text", text });
const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });

// --- fake channel ---------------------------------------------------------

class TestChannel implements Channel {
  readonly name = "imessage";
  sent: OutgoingMessage[] = [];
  /** Texts whose send PARKS until `releaseHangs()` — a wedged channel. */
  private hangs = new Set<string>();
  private gates: Array<() => void> = [];

  constructor(private readonly order: string[]) {}

  hang(text: string): void { this.hangs.add(text); }

  releaseHangs(): void {
    const gates = this.gates;
    this.gates = [];
    for (const open of gates) open();
  }

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> {
    if (message.text !== undefined && this.hangs.has(message.text)) {
      this.hangs.delete(message.text);
      this.order.push(`send-parked:${message.text}`);
      await new Promise<void>((resolve) => { this.gates.push(resolve); });
    }
    this.sent.push(message);
    this.order.push(`send:${message.text}`);
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  closeIngestion(): void {}
  async quiesce(): Promise<void> {}
  async teardown(): Promise<void> {}
  async stop(): Promise<void> {}
}

// --- rig ------------------------------------------------------------------

interface Rig {
  order: string[];
  channel: TestChannel;
  transcript: string[];
  manager: InstanceType<typeof LiveSessionManager>;
  /** Start a user turn and return its (never-rejecting) promise. */
  start: () => Promise<boolean>;
}

let rigs: Rig[] = [];

function rig(buildExternalMcpServers?: Deps["buildExternalMcpServers"]): Rig {
  const order: string[] = [];
  const channel = new TestChannel(order);
  const transcript: string[] = [];
  const manager = new LiveSessionManager(makeManagerDeps(buildExternalMcpServers));

  const deps: TurnRunnerDeps = {
    drainPendingNotes: () => "",
    runWithRetry: (req) => manager.runWithRetry(req),
    appendAssistantTranscript: (_key, content) => { transcript.push(content); },
    queuePendingErrorNote: () => {},
    startTurnTyping: (): StopTyping => async () => {},
    delivery: new DeliveryPipeline({ queuePendingErrorNote: () => {} }),
  };
  const runner = new TurnRunner(deps);

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
  };

  const r: Rig = { order, channel, transcript, manager, start: () => runner.runTurn(spec) };
  rigs.push(r);
  return r;
}

async function waitFor(label: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Resolves once the turn has actually reached the SDK child. */
const turnInFlight = () => waitFor("the turn to reach the session", () => (harnessRef.current?.inputs.length ?? 0) > 0);

beforeEach(() => {
  vi.clearAllMocks();
  harnessRef.current = null;
  rigs = [];
});

afterEach(async () => {
  for (const r of rigs) await r.manager.stop();
});

// ---------------------------------------------------------------------------

describe("shutdown flushes the block transcript before converting a turn to NO_REPLY", () => {
  it("keeps a block that was DELIVERED, and records no bare NO_REPLY as the outcome", async () => {
    const r = rig();
    const turn = r.start();
    await turnInFlight();

    harnessRef.current!.enqueue([assistant([textBlock("A")])]);
    await waitFor("A to reach the channel", () => r.channel.sent.length === 1);

    // SIGTERM lands mid-turn: the session dies under the turn, and the manager
    // converts the rejection into NO_REPLY to keep the SDK session link.
    await r.manager.stop();
    await turn;

    expect(r.channel.sent.map((m) => m.text)).toEqual(["A"]);
    // A is on the owner's phone, so A is what the transcript must say — not a
    // bare NO_REPLY claiming the turn was silent.
    expect(r.transcript).toEqual(["A"]);
    expect(r.transcript).not.toContain("NO_REPLY");
  });

  it("closes a slot whose send is still OPEN with the failure marker, in slot order, without hanging", async () => {
    const r = rig();
    r.channel.hang("A");
    const turn = r.start();
    await turnInFlight();

    harnessRef.current!.enqueue([assistant([textBlock("A")])]);
    await waitFor("A's send to park", () => r.order.includes("send-parked:A"));

    // Must not wait out the 60s per-block delivery budget: the slot is
    // abandoned synchronously and the turn's promise settles at once.
    await r.manager.stop();
    await turn;

    expect(r.transcript).toEqual([`${DELIVERY_FAILED_MARKER}A`]);

    // The parked send has no cancellation to be handed; it completes late.
    // Its slot is already closed, so it cannot rewrite history.
    r.channel.releaseHangs();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.transcript).toEqual([`${DELIVERY_FAILED_MARKER}A`]);
  });

  it("is unchanged when no block was ever in flight: NO_REPLY, recorded once, quickly", async () => {
    const r = rig();
    const turn = r.start();
    await turnInFlight();

    await r.manager.stop();
    await turn;

    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual(["NO_REPLY"]);
  });
});

describe("shutdown refuses work it can no longer process", () => {
  it("refuses a turn that arrives after stop(), and says so in the transcript", async () => {
    // Channel ingestion closes first, but the manager is not fed by channels
    // alone (cron, continuity, proactive sends, and the batcher's own drain all
    // land here), so a turn really can arrive mid-shutdown. Before, it built a
    // fresh session and ran it past the daemon's exit; now it is refused. The
    // refusal must not read back as silence either — the owner's message was
    // never processed, and "NO_REPLY" would claim Tomo chose not to answer.
    const r = rig();
    await r.manager.stop();

    const ok = await r.start();

    expect(ok).toBe(false);
    expect(r.channel.sent).toEqual([]);
    expect(r.transcript).toEqual([SHUTDOWN_NOT_PROCESSED]);
    expect(r.transcript).not.toContain("NO_REPLY");
    // Refused at the door: no SDK child was ever started for it.
    expect(harnessRef.current).toBeNull();
  });

  it("closes a session built after stop() instead of publishing it into the cleared map", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let building = false;
    const r = rig(async () => { building = true; await gate; return {}; });

    const turn = r.start();
    await waitFor("session construction to be entered", () => building);

    const stopping = r.manager.stop();
    release();
    await stopping;
    const ok = await turn;

    expect(ok).toBe(false);
    expect(r.channel.sent).toEqual([]);
    // The late-built session is closed, never published — the map stop()
    // cleared must stay cleared.
    expect(r.manager.isAlive("dm:owner")).toBe(false);
    // The turn never reached the model, so it is "not processed", not silent.
    expect(r.transcript).toEqual([SHUTDOWN_NOT_PROCESSED]);
    expect(r.transcript).not.toContain("NO_REPLY");
  });
});
