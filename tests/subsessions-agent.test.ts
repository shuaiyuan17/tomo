import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// Sub-sessions wired through the real Agent: a task's turns run on its own
// task: key, silently; its scope (parentKey) decides its privacy.
// ---------------------------------------------------------------------------

async function boot(enabled = true): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({
    identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    subsessions: { ...mockConfig.subsessions, enabled },
    tomoHome: mockConfig.tomoHome,
  });
  const agent = new Agent();
  const channel = new MockChannel("telegram");
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

const taskPrompts = (key: string) => mockSdk.promptsBySession.filter((p) => p.sessionKey === key);

describe("sub-sessions through the Agent", () => {
  it("is absent when disabled", async () => {
    const { agent } = await boot(false);
    expect(agent.subsessions).toBeUndefined();
    await agent.stop();
  });

  it("runs a task's turns on its own key, and nothing it writes reaches the chat", async () => {
    const { agent, channel } = await boot();
    mockSdk.responseFn = () => "Working on it, here is a long plain-text update nobody should see.";
    const spawned = agent.subsessions!.spawn("dm:alex", { title: "Fix it", brief: "Fix the flaky test." });
    expect(spawned.ok).toBe(true);
    await waitFor(() => expect(taskPrompts("task:s1").length).toBeGreaterThanOrEqual(3));
    expect(taskPrompts("task:s1")[0].text).toContain('<tomo-event type="subsession-start" name="s1"');
    // Three turns with no progress pause it; only the harness notice reaches the owner.
    await waitFor(() => expect(agent.subsessions!.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner" }));
    expect(channel.delivered.some((d) => d.text.includes("nobody should see"))).toBe(false);
    await agent.stop();
  });

  it("follows the owning scope for privacy, failing closed for an unknown task", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    expect(agent.isPrivateMemoryBarred("task:s1")).toBe(false);
    expect(agent.isPrivateMemoryBarred("task:s99")).toBe(true);
    await agent.stop();
  });

  it("routes a cron fire on a task key to the task, not to a chat", async () => {
    const { agent, channel } = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    const spawned = agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    if (!spawned.ok) throw new Error(spawned.error);
    // Not waiting on anything external: the fire is taken while it runs.
    expect(await agent.handleCronMessage("check CI", "task:s1")).toBe(true);
    expect(agent.subsessions!.get("s1")?.pendingInput.some((p) => p.includes("check CI"))).toBe(true);
    expect(channel.delivered).toHaveLength(0);
    expect(await agent.handleCronMessage("check CI", "task:s42")).toBe(false);
    await agent.stop();
  });
});
