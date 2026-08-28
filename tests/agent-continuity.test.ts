import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ===== Continuity delivery =====

/**
 * CONTINUITY TURNS ARE SILENT (owner decision 2026-08-28, option A).
 *
 * A heartbeat is unstructured free time the harness hands the agent; nobody
 * asked it a question, so nothing it writes as the turn's own output reaches a
 * chat. To message the user from a heartbeat it calls `send_message`, which is
 * an explicit, deliberate act rather than a side effect of thinking out loud.
 *
 * WHY THIS IS NOW ENFORCED IN CODE. The old contract was a prompt instruction:
 * CONTINUITY.md asked for a closing `NO_REPLY`, and under end-of-turn delivery
 * that trailing token retroactively suppressed the whole turn, narration
 * included. Per-block delivery ships each block the moment it completes, so a
 * heartbeat that narrates, calls a tool, and only then answers `NO_REPLY` has
 * already put the narration on the owner's phone — and a sent message cannot be
 * recalled. Silence for a turn nobody asked for must not depend on the model's
 * cooperation, so `processContinuity` sets `suppressDelivery`.
 *
 * These tests therefore assert WHICH SESSION the heartbeat ran on (the property
 * the routing rules are actually about) plus silence, rather than reading
 * routing off a delivered message.
 */
describe("continuity delivery", () => {
  /** Session keys the mock SDK saw the continuity prompt on. */
  const continuitySessions = () => mockSdk.promptsBySession
    .filter((p) => p.text.includes("Free time."))
    .map((p) => p.sessionKey);

  it("runs on the first DM session and delivers none of the turn's own text", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Good morning!";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();
    mockSdk.promptsBySession = [];

    await agent.handleContinuity("System: Free time.");

    // Routed to the owner's DM session...
    expect(continuitySessions()).toEqual(["dm:shuai"]);
    // ...and "Good morning!" — an unbidden greeting, the exact shape option A
    // exists to stop — never left the machine.
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("suppresses rich output too — multi-line text and MEDIA attachments alike", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "continuity-captioned-photo.png");
    writeFileSync(imagePath, "fake image");

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    // Formatting and attachments are not a loophole: suppression is decided by
    // the turn's delivery policy, before anything inspects the content.
    mockSdk.responseFn = () => `first thought\nsecond[[NL]]detail MEDIA:"${imagePath}"`;

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("falls back to the channel: session when no identity is configured", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Continuity thought";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();
    mockSdk.promptsBySession = [];

    await agent.handleContinuity("System: Free time.");

    expect(continuitySessions()).toEqual(["telegram:12345"]);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("skips group-only sessions", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Should not arrive";

    // Only a group session exists (negative chatId)
    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);
    tg.clearDelivered();

    // No private session exists — the heartbeat must skip entirely, not run
    // the turn on the group session (that would leak the continuity prompt
    // into the group's context).
    const continuityTurn = vi.fn(() => "Should not arrive");
    mockSdk.responseFn = continuityTurn;

    await agent.handleContinuity("System: Free time.");

    expect(continuityTurn).not.toHaveBeenCalled();
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  /**
   * #203 — every delivered message must reach the transcript, or it is
   * invisible to recall_conversation. Under option A a heartbeat's own text is
   * never delivered, so the guarantee moves with the delivery path: what a
   * heartbeat sends through `send_message` is what must be recorded.
   */
  it("records what a heartbeat sends via send_message, and nothing it merely wrote (#203)", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    // The turn writes this as its own output. It goes nowhere.
    mockSdk.responseFn = () => "Heads up: your flight check-in opens in an hour.";
    await agent.handleContinuity("System: Free time.");

    expect(tg.sent).toHaveLength(0);
    expect(agent.searchSessionTranscript("dm:shuai", { query: "flight check-in" })).toHaveLength(0);

    // The same thought, sent the way a heartbeat is supposed to send it.
    const result = await agent.sendToSession("shuai", "Your flight check-in opens in an hour.");
    expect(result.ok).toBe(true);
    expect(tg.sent.map((m) => m.text)).toEqual(["Your flight check-in opens in an hour."]);

    const recorded = agent.searchSessionTranscript("dm:shuai", { query: "flight check-in" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].role).toBe("assistant");
    expect(recorded[0].channel).toBe("telegram");

    await agent.stop();
  });

  it("stays silent on a NO_REPLY heartbeat, as it always has", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});
