import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, expectNoChangeFor, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { watchBus } from "../src/watch/bus.js";
import { MAX_AUTO_RESUMES, type RunningAgentsLedger } from "../src/agent/running-agents-ledger.js";
import type { WatchTask } from "../src/watch/protocol.js";

installAgentTestHooks();

/** The session store's durable pending notes for `key` (what survives a crash). */
function durableNotes(agent: InstanceType<typeof Agent>, key: string): string {
  return (agent as unknown as { sessions: { getPendingNotes(k: string): string[] } }).sessions.getPendingNotes(key).join("\n");
}

// ---------------------------------------------------------------------------
// Subagents running when the daemon went away: on the next start, the session
// that owned them is told (once), with their ids, and nothing is resumed.
// ---------------------------------------------------------------------------

const ledgerPath = () => join(mockConfig.tomoHome, "data", "running-agents.json");

async function boot(overrides: Record<string, unknown> = {}): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({ interruptedAgents: true, tomoHome: mockConfig.tomoHome, ...overrides });
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
    await expectNoChangeFor(() => expect(notices()).toEqual([]), 50);
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
    expect(durableNotes(second.agent, "imessage:705")).toContain("retry705");
    crash(second.agent);

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "ok";
    const third = await boot();
    await waitFor(() => expect(notices("imessage:705").some((p) => p.text.includes("retry705"))).toBe(true));
    await waitFor(() => expect(durableNotes(third.agent, "imessage:705")).not.toContain("retry705"));
    await third.agent.stop();
  });

  it("a notice turn that ends on an API error (429) keeps the list for the next start", async () => {
    const first = await boot();
    await haveSession(first.channel, "706");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:706", tasks: [task("ratelimited706")] });
    crash(first.agent);

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "API Error: 429 rate limited";
    const second = await boot();
    await waitFor(() => expect(notices("imessage:706").length).toBeGreaterThan(0));
    // The failed turn puts the note back; poll for it rather than sleep.
    await waitFor(() => expect(durableNotes(second.agent, "imessage:706")).toContain("ratelimited706"));
    await second.agent.stop();

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "ok";
    const third = await boot();
    await waitFor(() => expect(notices("imessage:706").some((p) => p.text.includes("ratelimited706"))).toBe(true));
    await third.agent.stop();
  });

  it("with the pending notes unreadable at start, the check waits, then tells the session once they read", async () => {
    const first = await boot();
    await haveSession(first.channel, "707");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:707", tasks: [task("unreadable707")] });
    crash(first.agent);

    const notesFile = join(mockConfig.sessionsDir, "_pending_notes.json");
    mkdirSync(notesFile); // reads fail with EISDIR
    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "ok";
    const second = await boot();
    await expectNoChangeFor(() => expect(notices("imessage:707")).toEqual([]), 50);
    // Not acknowledged: nothing could be written for it.
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).interrupted.map((r: { taskId: string }) => r.taskId)).toEqual(["unreadable707"]);

    rmSync(notesFile, { recursive: true });
    (second.agent as unknown as { retryInterruptedAgentsNotes(keys: Set<string>): void })
      .retryInterruptedAgentsNotes(new Set(["imessage:707"]));
    await waitFor(() => expect(notices("imessage:707").some((p) => p.text.includes("unreadable707"))).toBe(true));
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).interrupted).toEqual([]);
    await second.agent.stop();
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

describe("auto-resume of interrupted subagents", () => {
  afterEach(() => vi.restoreAllMocks());
  const checkTurn = (key: string) => notices(key).find((p) => p.text.includes('name="check"'));
  const ledgerOf = (agent: Agent) => (agent as unknown as { runningAgents: RunningAgentsLedger }).runningAgents;
  const gateOf = (agent: Agent) => (agent as unknown as { liveSessionManager: { deps: { resumeGate?: (k: string, id: string) => string | null } } })
    .liveSessionManager.deps.resumeGate;

  it("on (default): the note and the check turn ask for each resumable subagent to be resumed now", async () => {
    const first = await boot();
    await haveSession(first.channel, "710");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:710", tasks: [task("resume710"), task("explore710", { subagentType: "Explore" })] });
    crash(first.agent);

    mockSdk.promptsBySession = [];
    const second = await boot();
    await waitFor(() => expect(checkTurn("imessage:710")).toBeDefined());
    const text = checkTurn("imessage:710")!.text;
    expect(text).toContain("for each resumable one use SendMessage to resume it right away, unless the owner has explicitly said not to, or it has already been resumed or has finished since");
    expect(text).toContain("tell it it was interrupted by a restart, have it first check how far it got and which side effects");
    expect(text).toMatch(/resume710 "job resume710" \(general-purpose[^\n]*\)\n/);
    expect(text).toMatch(/explore710 "job explore710" \(Explore[^\n]* — cannot be resumed/);
    expect(text).not.toContain("Nothing has been resumed");
    // The gate is wired into the session options.
    expect(gateOf(second.agent)?.("imessage:710", "resume710")).toBeNull();
    expect(ledgerOf(second.agent).resumeCount("imessage:710", "resume710")).toBe(1);
    await second.agent.stop();
  });

  it("off: wording, ledger and options are as on main", async () => {
    const first = await boot({ interruptedAgentsAutoResume: false });
    await haveSession(first.channel, "711");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:711", tasks: [task("keep711")] });
    crash(first.agent);

    mockSdk.promptsBySession = [];
    const second = await boot({ interruptedAgentsAutoResume: false });
    await waitFor(() => expect(checkTurn("imessage:711")).toBeDefined());
    const text = checkTurn("imessage:711")!.text;
    expect(text).toContain("Startup check after a restart: if a note above lists interrupted subagents or commands, decide whether each is still worth continuing; otherwise there is nothing to do.");
    expect(text).toContain("Nothing has been resumed. To continue a resumable subagent, SendMessage to its id");
    expect(text).not.toMatch(/right away|FAILED|type unknown/);
    expect(gateOf(second.agent)).toBeUndefined();
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8"))).not.toHaveProperty("resumes");
    await second.agent.stop();
  });

  it(`a subagent cut off again after ${MAX_AUTO_RESUMES} resumes is refused by the gate and reported to the owner`, async () => {
    const owner = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(true);
    let run = await boot();
    await haveSession(run.channel, "712");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:712", tasks: [task("loop712")] });
    crash(run.agent);

    // Each start: the model resumes it through SendMessage (the gate allows it),
    // it runs again under the same id, and the daemon dies again.
    for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
      mockSdk.promptsBySession = [];
      run = await boot();
      await waitFor(() => expect(checkTurn("imessage:712")).toBeDefined());
      expect(checkTurn("imessage:712")!.text).not.toContain("FAILED");
      expect(gateOf(run.agent)!("imessage:712", "loop712")).toBeNull();
      watchBus.publish({ type: "tasks", sessionKey: "imessage:712", tasks: [task("loop712")] });
      crash(run.agent);
    }
    expect(owner).not.toHaveBeenCalled();

    mockSdk.promptsBySession = [];
    run = await boot();
    await waitFor(() => expect(checkTurn("imessage:712")).toBeDefined());
    expect(checkTurn("imessage:712")!.text).toMatch(/loop712 [^\n]* — FAILED: cut off again after 3 resumes; do not resume it/);
    expect(gateOf(run.agent)!("imessage:712", "loop712")).toMatch(/already been resumed 3 times/);
    await waitFor(() => expect(owner).toHaveBeenCalledOnce());
    expect(String(owner.mock.calls[0][0])).toContain("loop712");
    expect(String(owner.mock.calls[0][0])).toContain("imessage:712");
    await run.agent.stop();

    // Told once: the next start does not tell the owner again.
    const again = await boot();
    await expectNoChangeFor(() => expect(owner).toHaveBeenCalledOnce(), 50);
    await again.agent.stop();
  });

  it("a failure notice that could not be sent is sent on the next start", async () => {
    const owner = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(false);
    let run = await boot();
    await haveSession(run.channel, "719");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:719", tasks: [task("lost719")] });
    crash(run.agent);
    for (let i = 0; i <= MAX_AUTO_RESUMES; i++) {
      run = await boot();
      gateOf(run.agent)!("imessage:719", "lost719");
      watchBus.publish({ type: "tasks", sessionKey: "imessage:719", tasks: [task("lost719")] });
      crash(run.agent);
    }
    await waitFor(() => expect(owner).toHaveBeenCalledOnce());
    owner.mockResolvedValue(true);
    run = await boot();
    await waitFor(() => expect(owner).toHaveBeenCalledTimes(2));
    await run.agent.stop();
    const last = await boot();
    await expectNoChangeFor(() => expect(owner).toHaveBeenCalledTimes(2), 50);
    await last.agent.stop();
  });

  it("a note still owed when auto-resume is turned off instructs nothing", async () => {
    const first = await boot();
    await haveSession(first.channel, "720");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:720", tasks: [task("owed720")] });
    crash(first.agent);
    // The check turn never finishes; the daemon dies again.
    mockSdk.promptsBySession = [];
    mockSdk.responseFn = () => new Promise(() => {});
    const second = await boot();
    await waitFor(() => expect(checkTurn("imessage:720")).toBeDefined());
    crash(second.agent);

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "ok";
    const off = await boot({ interruptedAgentsAutoResume: false });
    await waitFor(() => expect(checkTurn("imessage:720")).toBeDefined());
    const text = checkTurn("imessage:720")!.text;
    expect(text).toContain("owed720");
    expect(text).toContain("decide whether each is still worth continuing");
    expect(text).not.toContain("right away");
    await off.agent.stop();
  });

  it("turning tracking off removes the old records, so turning it back on revives nothing", async () => {
    const first = await boot();
    await haveSession(first.channel, "718");
    watchBus.publish({ type: "tasks", sessionKey: "imessage:718", tasks: [task("old718")] });
    crash(first.agent);
    expect(existsSync(ledgerPath())).toBe(true);

    const off = await boot({ interruptedAgents: false });
    expect(existsSync(ledgerPath())).toBe(false);
    await off.agent.stop();

    mockSdk.promptsBySession = [];
    const on = await boot();
    await expectNoChangeFor(() => expect(notices("imessage:718")).toEqual([]), 50);
    expect(gateOf(on.agent)!("imessage:718", "old718")).toBeNull();
    expect(ledgerOf(on.agent).resumeCount("imessage:718", "old718")).toBe(0);
    await on.agent.stop();
  });
});

