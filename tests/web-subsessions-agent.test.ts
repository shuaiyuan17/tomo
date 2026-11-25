import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { randomUUID } from "node:crypto";
import { Agent, MockChannel, installAgentTestHooks, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";

installAgentTestHooks();

/**
 * Agent.webSubsessions: what the web UI may see of the owner's sub-sessions
 * and how it writes to one. The owner's own scope only; a write is exactly
 * the `/s <id> <text>` path (SubsessionService.ownerMessage).
 */
async function boot(): Promise<Agent> {
  resetConfig({
    identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    subsessions: { ...mockConfig.subsessions, enabled: true },
    tomoHome: mockConfig.tomoHome,
  });
  const agent = new Agent();
  agent.addChannel(new MockChannel("telegram"));
  await agent.start();
  // Turns hang, so a task stays active (and working) while the test looks at it.
  mockSdk.responseFn = () => new Promise(() => {});
  return agent;
}

describe("the web's access to sub-sessions", () => {
  it("lists, opens and writes the owner's tasks only", async () => {
    const agent = await boot();
    const changed = vi.fn();
    agent.onSubsessionsChanged(changed);
    const mine = agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "Do mine." });
    const theirs = agent.subsessions!.spawn("telegram:-100", { title: "A group's", brief: "Do theirs." });
    expect(mine.ok && theirs.ok).toBe(true);
    expect(changed).toHaveBeenCalled();
    const web = agent.webSubsessions()!;
    await waitFor(() => expect(web.list().tasks.find((t) => t.id === "s1")?.working).toBe(true));
    expect(web.list()).toMatchObject({ available: true, tasks: [{ id: "s1", title: "Mine", status: "active" }] });
    expect(web.get("s2")).toBeUndefined();
    expect(web.get("s1")).toMatchObject({ id: "s1", brief: "Do mine.", conversation: [] });

    const requestId = randomUUID();
    expect(web.message("s1", "use plan B", requestId)).toMatchObject({ ok: true, duplicate: false, task: { id: "s1", revision: 1 } });
    expect(agent.subsessions!.get("s1")).toMatchObject({ ownerMessageIds: [`web:${requestId}`], conversation: [{ from: "owner", kind: "message", text: "use plan B" }] });
    expect(agent.subsessions!.get("s1")!.pendingInput.at(-1)).toMatchObject({ from: "owner", words: "use plan B" });
    // A retry of the same request is recognised, not delivered twice.
    expect(web.message("s1", "use plan B", requestId)).toMatchObject({ ok: true, duplicate: true });
    expect(agent.subsessions!.get("s1")!.conversation).toHaveLength(1);
    // Another scope's task cannot be written from the web.
    expect(web.message("s2", "hijack", randomUUID())).toEqual({ ok: false, reason: "unknown" });
    expect(agent.subsessions!.get("s2")!.conversation).toHaveLength(0);
    await agent.stop();
  });

  it("marks a task waiting on something external as working in the background while its session's background work runs", async () => {
    const agent = await boot();
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    await waitFor(() => expect(agent.subsessions!.get("s1")?.status).toBe("active"));
    // As a turn that ended with a check-back scheduled leaves it.
    const moved = (agent.subsessions as unknown as { transition: (id: string, e: string, o: object) => { ok: boolean } })
      .transition("s1", "wait_external", { reason: "waiting for its scheduled check-back", expectFrom: ["active"] });
    expect(moved.ok).toBe(true);
    const background = vi.spyOn(agent, "hasBackgroundWork").mockImplementation((key) => key === "task:s1");
    const web = agent.webSubsessions()!;
    expect(web.list().tasks[0]).toMatchObject({ id: "s1", status: "waiting", waitingOn: "external", background: true });
    expect(web.get("s1")).toMatchObject({ background: true });
    expect(agent.subsessions!.backgroundRunning(agent.subsessions!.get("s1")!)).toBe(true);
    background.mockReturnValue(false);
    expect(web.list().tasks[0]).not.toHaveProperty("background");
    await agent.stop();
  });

  it("refuses a task that has ended", async () => {
    const agent = await boot();
    // Turns end at once here, so the cancel does not wait for one to stop.
    mockSdk.responseFn = () => "ok";
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    await agent.subsessions!.cancel("s1", "test");
    expect(agent.webSubsessions()!.message("s1", "hello?", randomUUID())).toEqual({ ok: false, reason: "ended" });
    expect(agent.webSubsessions()!.get("s1")).toMatchObject({ status: "cancelled", writable: false });
    await agent.stop();
  });
});
