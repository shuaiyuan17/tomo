/**
 * Stopping one task and moving a foreground task to the background, from the
 * web task view down to the SDK: Agent → LiveSessionManager → LiveSession →
 * Query.stopTask / Query.backgroundTasks. Neither creates a session, ends the
 * turn or throws to the caller.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk } from "./helpers/agent-harness.js";

installAgentTestHooks();

async function live(chatId = "12345") {
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  mockSdk.responseFn = () => "seeded";
  await tg.simulateMessage(makeMsg({ chatId, text: "Hi" }));
  await drainQueue(agent);
  const key = mockSdk.promptsBySession.at(-1)!.sessionKey;
  return { agent, key };
}

describe("task control", () => {
  it("stops one task and moves one to the background on the session's own query", async () => {
    const { agent, key } = await live();
    await expect(agent.stopTask(key, "task-1")).resolves.toBe(true);
    await expect(agent.backgroundTask(key, "toolu_1")).resolves.toBe(true);
    expect(mockSdk.stoppedTasks).toEqual(["task-1"]);
    expect(mockSdk.backgroundedToolUses).toEqual(["toolu_1"]);
    expect(mockSdk.interrupts).toBe(0);
    await agent.stop();
  });

  it("reports what the SDK answered: no matching foreground task, or a refusal, is false and never a throw", async () => {
    const { agent, key } = await live();
    mockSdk.taskControlResult = false;
    await expect(agent.backgroundTask(key, "toolu_gone")).resolves.toBe(false);
    mockSdk.taskControlResult = "throw";
    await expect(agent.backgroundTask(key, "toolu_1")).resolves.toBe(false);
    await expect(agent.stopTask(key, "task-1")).resolves.toBe(false);
    await agent.stop();
  });

  it("a session that is not live is not created for it", async () => {
    const agent = new Agent();
    await expect(agent.stopTask("dm:nobody", "task-1")).resolves.toBe(false);
    await expect(agent.backgroundTask("dm:nobody", "toolu_1")).resolves.toBe(false);
    expect(mockSdk.optionsBySession).toEqual([]);
    await agent.stop();
  });

  it("declares the per-task stop control only where it exists: the owner conversation with the web UI on", async () => {
    const off = await live();
    expect(mockSdk.optionsBySession.at(-1)!.options.perTaskStopAffordance).toBeUndefined();
    await off.agent.stop();
    const config = mockConfig as unknown as { web: unknown };
    const before = config.web;
    const identities = mockConfig.identities;
    config.web = { enabled: true };
    mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
    try {
      const { agent, key } = await live("test-owner");
      expect(key.startsWith("dm:")).toBe(true);
      expect(mockSdk.optionsBySession.at(-1)!.options.perTaskStopAffordance).toBe(true);
      await agent.stop();
    } finally { config.web = before; mockConfig.identities = identities; }
  });
});
