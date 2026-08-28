import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Everything recall could ever see: every transcript JSONL under the sessions
 * dir. Deliberately not keyed by session — "the message is somewhere in the
 * transcript" is the property under test, and reading the files (rather than
 * the in-memory store) is what a post-restart recall would actually do.
 */
function transcriptText(): string {
  const dir = mockConfig.sessionsDir;
  let out = "";
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out += readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
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
    const text = transcriptText();
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

    // Channels stop FIRST now, so ingestion is closed by the time stop()
    // resolves: this message is never accepted at all.
    const accepted = await channel.simulateMessage(makeMsg({ chatId: "556", text: "after the door closed" }));

    expect(accepted).toBe(false);
    expect(transcriptText()).not.toContain("after the door closed");
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

    const text = transcriptText();
    expect(text).toContain("handled well before shutdown");
    // Nothing was pending, so nothing gets the not-processed marker.
    expect(text).not.toContain(NOT_PROCESSED);
  });
});
