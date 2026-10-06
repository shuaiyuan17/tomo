import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
const prepare = vi.hoisted(() => vi.fn());
const discard = vi.hoisted(() => vi.fn());
vi.mock("../src/agent/session-rewind.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/agent/session-rewind.js")>(), prepareSessionRewind: prepare }));
import { Agent, MockChannel, SessionStore, installAgentTestHooks, resetConfig, mockSdk, drainQueue, makeMsg } from "./helpers/agent-harness.js";

installAgentTestHooks();
beforeEach(() => {
  discard.mockReset().mockResolvedValue(undefined);
  prepare.mockReset().mockImplementation(async (_sid: string, count: number) =>
    ({ sessionId: "fork-example", count, preview: "Request to edit", assertUnchanged: () => {}, discard }));
  resetConfig({ identities: [{ name: "example", channels: { telegram: "owner-example" }, replyPolicy: "last-active" }] });
});
function setup() {
  const agent = new Agent();
  const channel = new MockChannel("telegram");
  agent.addChannel(channel);
  const store = (agent as unknown as { sessions: InstanceType<typeof SessionStore> }).sessions;
  store.setSdkSessionId("dm:example", "source-example");
  return { agent, channel, store };
}
const command = (channel: MockChannel, args?: string, chat = "owner-example", sender = "owner-example") =>
  channel.simulateCommand("rewind", chat, "Example", args, sender);

describe("/rewind", () => {
  it("runs without a model request and the next user turn resumes the fork", async () => {
    const { agent, channel, store } = setup();
    try {
      await command(channel, "2");
      expect(prepare.mock.calls[0].slice(0, 2)).toEqual(["source-example", 2]);
      expect(mockSdk.promptsBySession).toHaveLength(0);
      expect(store.getSdkSessionId("dm:example")).toBe("fork-example");
      expect(discard).not.toHaveBeenCalled();
      expect(channel.sent[0].text).toContain("completed actions and file changes are not undone");
      expect(channel.sent[0].text).toContain('before the last 2 user message(s) ("Request to edit").');
      expect(channel.sent[0].text).not.toContain("further back");
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Edited request" }));
      await drainQueue(agent);
      expect(mockSdk.optionsBySession.at(-1)?.options.resume).toBe("fork-example");
    } finally { await agent.stop(); }
  });

  it("says so when the rewind went further back than asked", async () => {
    const { agent, channel, store } = setup();
    try {
      prepare.mockResolvedValueOnce({ sessionId: "fork-example", count: 3, preview: "Start work", assertUnchanged: () => {}, discard });
      await command(channel);
      expect(store.getSdkSessionId("dm:example")).toBe("fork-example");
      expect(channel.sent.at(-1)?.text).toContain('before the last 3 user message(s) ("Start work"). That is further back than the 1 you asked for');
    } finally { await agent.stop(); }
  });

  it("defaults to one message and refuses invalid arguments without touching history", async () => {
    const { agent, channel } = setup();
    try {
      for (const arg of ["0", "-1", "1.5", "2 extra", "9007199254740992"]) await command(channel, arg);
      expect(prepare).not.toHaveBeenCalled();
      await command(channel);
      expect(prepare.mock.calls[0][1]).toBe(1);
    } finally { await agent.stop(); }
  });

  it("refuses groups, non-owners, and unconfigured installations", async () => {
    const { agent, channel, store } = setup();
    try {
      await command(channel, undefined, "-100000", "owner-example");
      await command(channel, undefined, "guest-example", "guest-example");
      expect(prepare).not.toHaveBeenCalled();
      expect(store.listActiveEntries()).toHaveLength(1);
      resetConfig({ identities: [] });
      const unconfigured = new Agent();
      const other = new MockChannel("telegram");
      unconfigured.addChannel(other);
      try { await command(other); expect(prepare).not.toHaveBeenCalled(); }
      finally { await unconfigured.stop(); }
    } finally { await agent.stop(); }
  });

  it("keeps the old link on preparation failure or a concurrent link change", async () => {
    const { agent, channel, store } = setup();
    try {
      prepare.mockRejectedValueOnce(new Error("History unavailable"));
      await command(channel);
      expect(store.getSdkSessionId("dm:example")).toBe("source-example");
      expect(channel.sent.at(-1)?.text).toContain("Could not rewind");
      prepare.mockImplementationOnce(async () => {
        store.setSdkSessionId("dm:example", "concurrent-example");
        return { sessionId: "fork-example", assertUnchanged: () => {}, discard };
      });
      await command(channel);
      expect(store.getSdkSessionId("dm:example")).toBe("concurrent-example");
      expect(channel.sent.at(-1)?.text).toContain("Session changed");
      expect(discard).toHaveBeenCalledOnce();
    } finally { await agent.stop(); }
  });

  it.each(["snapshot", "registry", "shutdown"])("discards the unpublished fork after a %s failure", async (failure) => {
    const { agent, channel, store } = setup();
    try {
      prepare.mockImplementationOnce(async () => {
        if (failure === "shutdown") (agent as unknown as { stopping: boolean }).stopping = true;
        return {
          sessionId: "fork-example", discard,
          assertUnchanged: () => { if (failure === "snapshot") throw new Error("History changed"); },
        };
      });
      const publish = vi.spyOn(store, "replaceSdkSessionId");
      if (failure === "registry") publish.mockImplementationOnce(() => { throw new Error("Registry unavailable"); });
      await command(channel);
      expect(discard).toHaveBeenCalledOnce();
      expect(store.getSdkSessionId("dm:example")).toBe("source-example");
      expect(channel.sent.at(-1)?.text).toContain("Could not rewind");
      if (failure !== "registry") expect(publish).not.toHaveBeenCalled();
    } finally {
      (agent as unknown as { stopping: boolean }).stopping = false;
      await agent.stop();
    }
  });

  it("stops a stuck turn instead of waiting behind it; the turn is not retried and sends nothing more", async () => {
    const { agent, channel, store } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("Work")) { await gate; return "Late reply from the stopped turn"; }
      return "Fresh answer";
    };
    try {
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Work" }));
      await vi.waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
      // Sent while the turn is stuck: steered into it, so it goes with it.
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Still there?" }));
      const live = () => (agent as unknown as { liveSessionManager: { liveSessions: Map<string, { steeredRequestCount(): number }> } })
        .liveSessionManager.liveSessions.get("dm:example");
      await vi.waitFor(() => expect(live()?.steeredRequestCount()).toBe(1));
      // A cron queued behind the stuck turn: runs after the rewind, on the fork.
      const cron = agent.handleCronMessage("Scheduled check", "dm:example");

      await command(channel);
      expect(prepare).toHaveBeenCalledOnce();
      expect(store.getSdkSessionId("dm:example")).toBe("fork-example");
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0].text).toContain("Context rewound");
      expect(channel.sent[0].text).toContain("The turn that was still running was stopped first and will send nothing more. 1 message(s) you sent while it ran went with it");

      release();
      await cron;
      await drainQueue(agent);
      // Neither the stopped turn nor the steered message was re-run.
      expect(mockSdk.promptsBySession.filter((p) => p.text.includes("Work") || p.text.includes("Still there?"))).toHaveLength(1);
      expect(mockSdk.promptsBySession.at(-1)?.text).toContain("Scheduled check");
      expect(mockSdk.optionsBySession.at(-1)?.options.resume).toBe("fork-example");
      // Nothing from the stopped turn (no late block, no error) after the rewind reply.
      expect(channel.sent.map((m) => m.text).join("\n")).not.toMatch(/Late reply|\[error\]/);
    } finally { release(); await agent.stop(); }
  });

  it("stops a stuck FIRST turn even though no session id is stored yet, and forks nothing", async () => {
    const { agent, channel, store } = setup();
    store.clearSdkSessionId("dm:example");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("Work")) { await gate; return "Late reply from the stopped turn"; }
      return "Fresh answer";
    };
    try {
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Work" }));
      await vi.waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
      expect(store.getSdkSessionId("dm:example")).toBeFalsy();
      await command(channel);
      expect(prepare).not.toHaveBeenCalled();
      expect(store.getSdkSessionId("dm:example")).toBeFalsy();
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0].text).toContain("Stopped the turn that was still running");
      expect(channel.sent[0].text).toContain("no earlier history to rewind to");
      release();
      await drainQueue(agent);
      expect(mockSdk.promptsBySession).toHaveLength(1);
      expect(channel.sent).toHaveLength(1);
      // Still refuses when nothing is running and nothing is stored.
      await command(channel);
      expect(channel.sent.at(-1)?.text).toContain("No active conversation to rewind.");
    } finally { release(); await agent.stop(); }
  });

  it("stops a first turn that is still building its session (not yet busy), so it never runs", async () => {
    const { agent, channel, store } = setup();
    store.clearSdkSessionId("dm:example");
    const manager = (agent as unknown as { liveSessionManager: {
      deps: { buildExternalMcpServers: (key: string) => Promise<Record<string, unknown>> };
      liveSessionCreates: Map<string, unknown>;
      isBusy(key: string): boolean;
    } }).liveSessionManager;
    let finishBuild!: () => void;
    const slowSetup = new Promise<void>((resolve) => { finishBuild = resolve; });
    const build = manager.deps.buildExternalMcpServers;
    manager.deps.buildExternalMcpServers = async (key) => { await slowSetup; return build(key); };
    try {
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Work" }));
      await vi.waitFor(() => expect(manager.liveSessionCreates.size).toBe(1));
      expect(manager.isBusy("dm:example")).toBe(false);
      const pending = command(channel);
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishBuild();
      await pending;
      expect(prepare).not.toHaveBeenCalled();
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0].text).toContain("Stopped the turn that was still running");
      await drainQueue(agent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The first turn never reached the model, and nothing else was sent.
      expect(mockSdk.promptsBySession).toHaveLength(0);
      expect(channel.sent).toHaveLength(1);
    } finally { finishBuild(); manager.deps.buildExternalMcpServers = build; await agent.stop(); }
  });

  it("a session build that outlives the rewind's wait budget is discarded; the next request resumes the fork", async () => {
    const { agent, channel, store } = setup();
    const manager = (agent as unknown as { liveSessionManager: {
      deps: { buildExternalMcpServers: (key: string) => Promise<Record<string, unknown>> };
      liveSessionCreates: Map<string, unknown>;
      liveSessions: Map<string, { isAlive(): boolean }>;
      suspendForRewind(key: string, timeoutMs?: number): Promise<unknown>;
    } }).liveSessionManager;
    const suspend = manager.suspendForRewind.bind(manager);
    manager.suspendForRewind = (key) => suspend(key, 30); // a budget the build outlives
    let finishBuild!: () => void;
    const slowSetup = new Promise<void>((resolve) => { finishBuild = resolve; });
    const build = manager.deps.buildExternalMcpServers;
    let stalled = true;
    manager.deps.buildExternalMcpServers = async (key) => { if (stalled) { stalled = false; await slowSetup; } return build(key); };
    try {
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Work" }));
      await vi.waitFor(() => expect(manager.liveSessionCreates.size).toBe(1));
      await command(channel);
      expect(store.getSdkSessionId("dm:example")).toBe("fork-example");
      expect(channel.sent.at(-1)?.text).toContain("Context rewound");

      finishBuild();
      await drainQueue(agent);
      await vi.waitFor(() => expect(manager.liveSessionCreates.size).toBe(0));
      // The late build (resuming the pre-rewind id) was not published.
      expect(manager.liveSessions.get("dm:example")?.isAlive() ?? false).toBe(false);
      expect(mockSdk.promptsBySession).toHaveLength(0);

      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Next" }));
      await drainQueue(agent);
      expect(mockSdk.promptsBySession.map((p) => p.text).join(" ")).toContain("Next");
      expect(mockSdk.promptsBySession.some((p) => p.text.includes("Work"))).toBe(false);
      expect(mockSdk.optionsBySession.at(-1)?.options.resume).toBe("fork-example");
    } finally { finishBuild(); manager.deps.buildExternalMcpServers = build; await agent.stop(); }
  });

  it("shutdown during a stalled prepare waits for it, discards the fork, publishes nothing, and releases the hold", async () => {
    const { agent, channel, store } = setup();
    let unstall!: () => void;
    const stalled = new Promise<void>((resolve) => { unstall = resolve; });
    prepare.mockImplementationOnce(async (_sid: string, count: number) => {
      await stalled;
      return { sessionId: "fork-example", count, preview: "Request to edit", assertUnchanged: () => {}, discard };
    });
    const publish = vi.spyOn(store, "replaceSdkSessionId");
    const holds = () => (agent as unknown as { liveSessionManager: { sessionHolds: Map<string, unknown> } }).liveSessionManager.sessionHolds;
    const pending = command(channel);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(holds().size).toBe(1);
    let stopped = false;
    const stopping = agent.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    unstall();
    await stopping;
    await pending;
    expect(discard).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(store.getSdkSessionId("dm:example")).toBe("source-example");
    expect(holds().size).toBe(0);
    expect(channel.sent.at(-1)?.text).toContain("Could not rewind: Tomo is stopping");
  });

  it("shutdown does not hang on a prepare that never returns, and still releases the hold", async () => {
    const { agent, channel, store } = setup();
    prepare.mockImplementationOnce(() => new Promise(() => {}));
    const holds = () => (agent as unknown as { liveSessionManager: { sessionHolds: Map<string, unknown> } }).liveSessionManager.sessionHolds;
    void command(channel);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(holds().size).toBe(1);
    await agent.stop();
    expect(holds().size).toBe(0);
    expect(store.getSdkSessionId("dm:example")).toBe("source-example");
  }, 10_000);

  it("does not mention a stopped turn when nothing was running", async () => {
    const { agent, channel } = setup();
    try {
      await command(channel);
      expect(channel.sent.at(-1)?.text).toContain("Context rewound");
      expect(channel.sent.at(-1)?.text).not.toContain("stopped");
    } finally { await agent.stop(); }
  });
});
