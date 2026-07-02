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

describe("continuity delivery", () => {
  it("delivers to first DM session", async () => {
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

    await agent.handleContinuity("System: Free time.");

    // Continuity uses channel.send()
    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("splits newline-delimited continuity responses and preserves literal newline escapes", async () => {
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

    mockSdk.responseFn = () => "  first thought  \nsecond[[NL]]detail\n\n  third thought  ";

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent.map((msg) => msg.text)).toEqual([
      "first thought",
      "second\ndetail",
      "third thought",
    ]);

    await agent.stop();
  });

  it("keeps continuity MEDIA captions attached instead of newline-splitting them away from the photo", async () => {
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

    mockSdk.responseFn = () => `caption line 1\ncaption line 2 MEDIA:"${imagePath}"`;

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({
      chatId: "12345",
      text: "caption line 1\ncaption line 2",
      photo: imagePath,
    });

    await agent.stop();
  });

  it("falls back to channel: session when no identity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Continuity thought";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

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

  it("suppresses NO_REPLY in continuity", async () => {
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
