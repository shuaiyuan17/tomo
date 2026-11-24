import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { join } from "node:path";
import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { formatTomoEvent } from "../src/tomo-event.js";

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

  it("gives a task session no external MCP server and no claude.ai connector", async () => {
    resetConfig({
      identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
      subsessions: { ...mockConfig.subsessions, enabled: true },
      tomoHome: mockConfig.tomoHome,
      mcpServers: { linear: { server: { type: "http", url: "https://example.invalid/mcp" } } },
    } as never);
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    await agent.start();
    mockSdk.responseFn = () => new Promise(() => {});
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    await waitFor(() => expect(mockSdk.optionsBySession.some((o) => o.sessionKey === "task:s1")).toBe(true));
    const options = mockSdk.optionsBySession.find((o) => o.sessionKey === "task:s1")!.options as {
      mcpServers: Record<string, unknown>; settings: { disableClaudeAiConnectors?: boolean };
    };
    expect(Object.keys(options.mcpServers)).toEqual(["tomo-internal"]);
    expect(options.settings.disableClaudeAiConnectors).toBe(true);
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
    expect(agent.subsessions!.get("s1")?.pendingInput.some((p) => p.text.includes("check CI"))).toBe(true);
    expect(channel.delivered).toHaveLength(0);
    expect(await agent.handleCronMessage("check CI", "task:s42")).toBe(false);
    await agent.stop();
  });

  it("recovers sub-sessions before any channel ingests, and runs no task turn until start() opens dispatch", async () => {
    resetConfig({
      identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
      subsessions: { ...mockConfig.subsessions, enabled: true },
      tomoHome: mockConfig.tomoHome,
    });
    // The last run left a task in the middle of a turn.
    const store = new SubsessionStore(join(mockConfig.tomoHome, "data", "subsessions.json"));
    const t = store.create({ parentKey: "dm:alex", title: "t", brief: "b" });
    store.transition(t.id, "start");
    mockSdk.responseFn = () => new Promise(() => {});
    const agent = new Agent();
    const channel = new MockChannel("telegram");
    const during: { available?: boolean; status?: string; relayed?: boolean; turns?: number } = {};
    // A channel that delivers input while it is still starting.
    channel.start = async () => {
      during.available = agent.subsessions!.available();
      during.status = agent.subsessions!.get("s1")?.status;
      during.relayed = agent.subsessions!.relay("s1", "early word").ok;
      await new Promise((r) => setImmediate(r));
      during.turns = taskPrompts("task:s1").length;
    };
    agent.addChannel(channel);
    await agent.start();
    expect(during).toEqual({ available: true, status: "queued", relayed: true, turns: 0 });
    await waitFor(() => expect(taskPrompts("task:s1")).toHaveLength(1));
    expect(taskPrompts("task:s1")[0].text).toContain("early word");
    expect(taskPrompts("task:s1")[0].text).toContain('type="subsession-resume"');
    await agent.stop();
  });

  it("keeps a task's report out of a summoned group's turn on the owner's session, for the owner's next turn", async () => {
    const { agent, channel } = await boot();
    const internals = agent as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
      subsessions: { deps: { queuePendingNote(key: string, note: string): boolean } };
    };
    internals.router.summonGroup("telegram", "-100271", "alex");
    mockSdk.responseFn = () => "NO_REPLY";
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);
    mockSdk.promptsBySession = [];
    // A task finished: its report note waits on the owner's session (the
    // service's own dep, so the agent's wiring marks it).
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-report", "Sub-session s1 finished. Its report:\nSECRET-REPORT", { name: "s1" }));
    // The summoned group's turn runs first, on dm:alex, with the group's audience.
    expect(await agent.handleCronMessage("Scheduled group task", "telegram:-100271", { waitForHandoff: true })).toBe(true);
    const groupTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex").map((p) => p.text).join("\n");
    expect(groupTurn).toContain("Scheduled group task");
    expect(groupTurn).not.toContain("SECRET-REPORT");
    // The owner's own next turn gets it.
    mockSdk.promptsBySession = [];
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "anything new?" }));
    await drainQueue(agent);
    const ownerTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex").map((p) => p.text).join("\n");
    expect(ownerTurn).toContain("SECRET-REPORT");
    await agent.stop();
  });

  it("keeps a task's own words, sent to the owner, out of a summoned group's turn", async () => {
    const { agent, channel } = await boot();
    const internals = agent as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
      subsessions: { deps: { sendToScope(parentKey: string, text: string, taskKey: string, noteFrom: string): Promise<{ ok: boolean }> } };
    };
    internals.router.summonGroup("telegram", "-100271", "alex");
    mockSdk.responseFn = () => "NO_REPLY";
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);
    mockSdk.promptsBySession = [];
    // The task tells the owner something private (task_notify's path).
    expect((await internals.subsessions.deps.sendToScope("dm:alex", "[s1 · t] SECRET-WORDS", "task:s1", "Your sub-session s1")).ok).toBe(true);
    expect(await agent.handleCronMessage("Scheduled group task", "telegram:-100271", { waitForHandoff: true })).toBe(true);
    const groupTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex").map((p) => p.text).join("\n");
    expect(groupTurn).toContain("Scheduled group task");
    expect(groupTurn).not.toContain("SECRET-WORDS");
    mockSdk.promptsBySession = [];
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "anything new?" }));
    await drainQueue(agent);
    const ownerTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex").map((p) => p.text).join("\n");
    expect(ownerTurn).toContain("SECRET-WORDS");
    await agent.stop();
  });
});
