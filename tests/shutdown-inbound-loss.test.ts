import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// Issue #294: an inbound message that lands in the shutdown settle window is
// acknowledged by the channel (imsg persists its cursor right after enqueue)
// but sits in the in-memory InboundBatcher, which nothing drains. The old stop
// order (manager first, channels last) leaves that window wide open, and
// `start.ts` calls process.exit() the moment stop() resolves — so the message
// is never processed, never recorded, and never replayed.
//
// The contract these tests pin: a message accepted by a channel is NEVER
// silently dropped. It is processed, or it is recorded in the transcript with
// the not-processed marker, or it is replayed after restart.
// ---------------------------------------------------------------------------

const NOT_PROCESSED = "[not processed — shutting down]";
const DELIVERY_FAILED = "[delivery failed]";

/**
 * The transcript file for ONE session, read from disk the way a post-restart
 * `recall_conversation` would.
 *
 * Keyed by session on purpose. Concatenating every JSONL under the sessions
 * dir made the assertion "the text is somewhere on disk", which passes just as
 * happily when a DM's message is recorded into a group's transcript — a
 * misroute that leaks one audience's words into another, and exactly the kind
 * of bug a shutdown path that re-derives routing could introduce. The session
 * key here is the one `IdentityRouter.resolve` produces with no identities
 * configured: `<channel>:<chatId>`, sanitised into a filename.
 */
function sessionTranscript(sessionKey: string): string {
  const file = join(mockConfig.sessionsDir, `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("shutdown does not silently drop inbound messages (#294)", () => {
  it("records a message that lands in the settle window as stop() begins", async () => {
    // Nonzero settle window on the channel that has one: the message parks in
    // the batcher instead of dispatching synchronously.
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    mockSdk.responseFn = async () => "ack";

    // Lands and parks in the batcher's settle window — accepted by the
    // channel (cursor-acknowledged in production), not yet dispatched.
    await channel.simulateMessage(makeMsg({ chatId: "555", text: "landed during shutdown" }));

    // Shutdown begins with the message still in `pendingBatches`.
    await agent.stop();

    // start.ts exits here. Whatever the transcript holds at this instant is
    // all that survives — so the message must already be in it, either
    // processed or explicitly marked as not processed.
    const text = sessionTranscript("imessage:555");
    expect(text).toContain("landed during shutdown");
    expect(text.includes(NOT_PROCESSED) || channel.delivered.length > 0).toBe(true);
  });

  it("refuses a message that arrives after the channels have stopped", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    await agent.stop();

    // `closeIngestion()` runs before anything else in stop(), so the inbound
    // door is shut by the time stop() resolves: this message never starts.
    const accepted = await channel.simulateMessage(makeMsg({ chatId: "556", text: "after the door closed" }));

    expect(accepted).toBe(false);
    expect(sessionTranscript("imessage:556")).not.toContain("after the door closed");
  });

  it("leaves an ordinary stop with an empty batcher unchanged", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    mockSdk.responseFn = async () => "ack";

    await channel.simulateMessage(makeMsg({ chatId: "557", text: "handled well before shutdown" }));
    // Let the settle window elapse and the turn complete: the batcher is empty
    // by the time we stop.
    await waitFor(() => expect(channel.delivered).toHaveLength(1), 2000);

    await agent.stop();

    const text = sessionTranscript("imessage:557");
    expect(text).toContain("handled well before shutdown");
    // Nothing was pending, so nothing gets the not-processed marker.
    expect(text).not.toContain(NOT_PROCESSED);
  });
});

// ---------------------------------------------------------------------------
// Round 6: the two halves of the shutdown order that #294 got wrong.
//
// `closeIngestion()` only refuses what has not STARTED. A message already
// inside a channel's parse path (imsg seconds into attachment loading, a
// Telegram photo mid-download) is past that guard and cannot be refused
// afterwards without losing it — imsg has advanced its cursor by then, and
// Telegram acknowledged the update before our middleware ever ran. So the
// agent waits for those parses to land in the batcher BEFORE draining it.
//
// And teardown moved to last. Killing the imsg child while the manager was
// still draining turns meant blocks produced in that window hit a dead channel
// and were recorded `[delivery failed]` — messages the owner would otherwise
// have received.
// ---------------------------------------------------------------------------

describe("shutdown waits for in-flight parses before draining (#294 round 6)", () => {
  it("records a message that was mid-parse when stop() began", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    mockSdk.responseFn = async () => "ack";

    // Past the entry guard, still inside the channel's own parsing. Refusing
    // this one later would be a silent drop, not a replay.
    const parked = channel.beginSlowMessage(makeMsg({ chatId: "558", text: "parsed through the shutdown" }));

    let stopped = false;
    const stopping = agent.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 30));

    // Shutdown is held open by quiesce, and the channel is NOT torn down yet.
    expect(stopped).toBe(false);
    expect(channel.tornDown).toBe(false);

    parked.release();
    await stopping;

    // The agent took custody, and the message is on disk in ITS session.
    expect(await parked.accepted).toBe(true);
    const text = sessionTranscript("imessage:558");
    expect(text).toContain("parsed through the shutdown");
    expect(text).toContain(NOT_PROCESSED);
    expect(channel.tornDown).toBe(true);
  });

  it("delivers a block produced during the drain instead of marking it failed", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    // A turn that is still running when SIGTERM lands.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let turnStarted = false;
    mockSdk.responseFn = async () => {
      turnStarted = true;
      await turnGate;
      return "produced during the drain";
    };

    await channel.simulateMessage(makeMsg({ chatId: "559", text: "start a slow turn" }));
    await waitFor(() => expect(turnStarted).toBe(true), 2000);

    // Holds shutdown inside its quiesce phase, which is where the manager's
    // drain overlaps with a channel that must still be able to send.
    const parked = channel.beginSlowMessage(makeMsg({ chatId: "560", text: "parked mid-parse" }));
    const stopping = agent.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(channel.tornDown).toBe(false);

    // The turn finishes mid-shutdown and its block goes out over a channel
    // that is still alive. Under the old order (#294) the channel was fully
    // torn down before the manager was even asked to drain, so this window
    // produced nothing the owner could receive: the send hit a dead channel
    // (`[delivery failed]`) or the session was closed before the block existed
    // and the turn was recorded as a bare `NO_REPLY`. Reverting the order here
    // yields the second: `expected '…' to contain 'produced during the drain'`
    // against a transcript holding only `NO_REPLY`.
    releaseTurn();
    await waitFor(
      () => expect(channel.delivered.map((d) => d.text)).toContain("produced during the drain"),
      2000,
    );

    parked.release();
    await stopping;

    const text = sessionTranscript("imessage:559");
    expect(text).toContain("produced during the drain");
    expect(text).not.toContain(DELIVERY_FAILED);
    // Teardown ran, but only after everything durable was written.
    expect(channel.tornDown).toBe(true);
  });

  it("still records the batcher even when a channel's quiesce fails", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    mockSdk.responseFn = async () => "ack";
    await channel.simulateMessage(makeMsg({ chatId: "561", text: "owed to the user" }));

    // A channel that cannot quiesce must not take the transcript down with it:
    // the recording and the manager stop sit in a `finally` relative to it.
    channel.quiesce = async () => { throw new Error("quiesce exploded"); };

    await agent.stop();

    expect(sessionTranscript("imessage:561")).toContain("owed to the user");
    expect(channel.tornDown).toBe(true);
  });

  it("records and stops the manager even when channel teardown throws", async () => {
    resetConfig({ imessageInboundSettleMs: 80 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();

    mockSdk.responseFn = async () => "ack";
    await channel.simulateMessage(makeMsg({ chatId: "562", text: "owed to the user too" }));

    // grammy's final `getUpdates` can reject (or hang on a 500s client
    // timeout). `start.ts` exits the moment stop() resolves, so a teardown
    // failure must not take the durable half of shutdown with it.
    channel.teardown = async () => { throw new Error("teardown exploded"); };

    await expect(agent.stop()).resolves.toBeUndefined();
    expect(sessionTranscript("imessage:562")).toContain("owed to the user too");
  });
});

// ---------------------------------------------------------------------------
// Issue #295: mention-required groups deliberately bypass coalescing, but the
// old direct SessionQueue path retained only a Promise — not the inbound item.
// If the session key was busy when shutdown landed, Agent.stop() drained the
// batcher, found nothing, and returned while this acknowledged Telegram update
// was still waiting in a queue the process was about to abandon.
// ---------------------------------------------------------------------------

describe("shutdown records non-coalescing group messages parked in sessionQueue (#295)", () => {
  it("records the accepted mention once and cancels its queued callback", async () => {
    resetConfig();
    const agent = new Agent();
    const channel = new MockChannel("telegram");
    agent.addChannel(channel);
    await agent.start();

    const sessionKey = "telegram:mention-group";
    const queue = (agent as unknown as {
      sessionQueue: {
        enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
        drain(): Promise<void>;
      };
    }).sessionQueue;

    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = queue.enqueue(sessionKey, () => blockerGate);

    const accepted = await channel.simulateMessage(makeMsg({
      chatId: "mention-group",
      text: "please do not lose this mention",
      senderName: "Alice",
      isGroup: true,
      isMentioned: true,
    }));
    expect(accepted).toBe(true);

    await agent.stop();

    const atExit = sessionTranscript(sessionKey);
    expect(atExit).toContain("please do not lose this mention");
    expect(atExit).toContain(NOT_PROCESSED);

    // The SessionQueue promise still exists, but shutdown claimed its inbound
    // record. When the blocker releases, the callback must no-op rather than
    // process or record the same user message a second time.
    releaseBlocker();
    await blocker;
    await queue.drain();

    const afterQueueSettles = sessionTranscript(sessionKey);
    expect(afterQueueSettles.match(/please do not lose this mention/g)).toHaveLength(1);
    expect(channel.delivered).toHaveLength(0);
  });
});
