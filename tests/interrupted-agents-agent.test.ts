import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { watchBus } from "../src/watch/bus.js";
import type { WatchTask } from "../src/watch/protocol.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// Subagents running when the daemon went away: on the next start, the session
// that owned them is told (once), with their ids, and nothing is resumed.
// ---------------------------------------------------------------------------

const ledgerPath = () => join(mockConfig.tomoHome, "data", "running-agents.json");

async function boot(): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({ interruptedAgents: true, tomoHome: mockConfig.tomoHome });
  const agent = new Agent();
  const channel = new MockChannel("imessage");
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

/** SIGKILL: no shutdown code runs; the in-process subscriber goes with the process. */
function crash(agent: Agent): void {
  (agent as unknown as { detachRunningAgents?: () => void }).detachRunningAgents?.();
}

const task = (id: string, extra: Partial<WatchTask> = {}): WatchTask => ({
  taskId: id, taskType: "local_agent", subagentType: "general-purpose", description: `job ${id}`,
  ambient: false, background: true, startedAt: Date.now(), ...extra,
});

async function haveSession(channel: MockChannel, chatId: string): Promise<void> {
  mockSdk.responseFn = async () => "hi";
  const before = channel.delivered.length;
  await channel.simulateMessage(makeMsg({ chatId, text: "start something" }));
  await waitFor(() => expect(channel.delivered.length).toBeGreaterThan(before));
}

const notices = (key?: string) => mockSdk.promptsBySession
  .filter((p) => p.text.includes('<tomo-event type="interrupted-agents"') && (!key || p.sessionKey === key));

describe("interrupted subagents across a restart", () => {
  it("tells the owning session, with the ids, after a graceful restart; finished ones are left out", async () => {
    const first = await boot();
    await haveSession(first.channel, "700");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:700", tasks: [task("agentlive1"), task("agentdone1")] });
    watchBus.publish({ type: "tasks", sessionKey: "imessage:700", tasks: [task("agentlive1")], ended: [{ taskId: "agentdone1", status: "completed" }] });
    // Shutdown closes the live sessions, and closing empties their task set
    // (LiveSession.close -> TaskTracker.reset): that must not read as finished.
    const stopping = first.agent.stop();
    watchBus.publish({ type: "tasks", sessionKey: "imessage:700", tasks: [] });
    await stopping;

    mockSdk.promptsBySession = [];
    const second = await boot();
    await waitFor(() => expect(notices("imessage:700")).toHaveLength(1));
    const text = notices()[0].text;
    expect(text).toContain("agentlive1");
    expect(text).toContain("general-purpose");
    expect(text).not.toContain("agentdone1");
    await second.agent.stop();
  });

  it("covers a crash (no shutdown path), and reminds only once", async () => {
    const first = await boot();
    await haveSession(first.channel, "701");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:701", tasks: [task("crashed1"), task("bash1", { taskType: "local_bash", subagentType: undefined, description: "npm test" })] });
    crash(first.agent);

    mockSdk.promptsBySession = [];
    const second = await boot();
    await waitFor(() => expect(notices("imessage:701")).toHaveLength(1));
    expect(notices()[0].text).toContain("crashed1");
    expect(notices()[0].text).toMatch(/bash1 "npm test" \(background command/);
    await waitFor(() => expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).interrupted).toEqual([]));
    await second.agent.stop();

    mockSdk.promptsBySession = [];
    const third = await boot();
    await new Promise((r) => setTimeout(r, 50));
    expect(notices()).toEqual([]);
    await third.agent.stop();
  });

  it("a notice turn that fails keeps the list, and the next start tells the session again", async () => {
    const first = await boot();
    await haveSession(first.channel, "705");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:705", tasks: [task("retry705")] });
    crash(first.agent);

    // Second run: the SDK takes the notice turn and never finishes it; the
    // daemon dies again mid-turn.
    mockSdk.promptsBySession = [];
    mockSdk.responseFn = () => new Promise(() => {});
    const second = await boot();
    await waitFor(() => expect(notices("imessage:705").length).toBeGreaterThan(0));
    // The ledger has handed off, but the durable note is still owed.
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).interrupted).toEqual([]);
    const store = (second.agent as unknown as { sessions: { getPendingNotes(k: string): string[] } }).sessions;
    expect(store.getPendingNotes("imessage:705").join("\n")).toContain("retry705");
    crash(second.agent);

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "ok";
    const third = await boot();
    await waitFor(() => expect(notices("imessage:705").some((p) => p.text.includes("retry705"))).toBe(true));
    const thirdStore = (third.agent as unknown as { sessions: { getPendingNotes(k: string): string[] } }).sessions;
    await waitFor(() => expect(thirdStore.getPendingNotes("imessage:705").join("\n")).not.toContain("retry705"));
    await third.agent.stop();
  });

  it("only the session that owned the agent is told", async () => {
    const first = await boot();
    await haveSession(first.channel, "702");
    await haveSession(first.channel, "703");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:703", tasks: [task("only703")] });
    crash(first.agent);

    mockSdk.promptsBySession = [];
    const second = await boot();
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0].sessionKey).toBe("imessage:703");
    expect(mockSdk.promptsBySession.filter((p) => p.sessionKey === "imessage:702")).toEqual([]);
    await second.agent.stop();
  });

  it("a corrupt ledger does not stop the daemon from starting", async () => {
    const first = await boot();
    await first.agent.stop();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(mockConfig.tomoHome, "data"), { recursive: true });
    writeFileSync(ledgerPath(), "\u0000garbage");
    const second = await boot();
    await haveSession(second.channel, "704");
    expect(notices()).toEqual([]);
    expect(existsSync(ledgerPath())).toBe(true);
    await second.agent.stop();
  });
});
