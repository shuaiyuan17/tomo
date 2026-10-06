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

  it("does not mention a stopped turn when nothing was running", async () => {
    const { agent, channel } = setup();
    try {
      await command(channel);
      expect(channel.sent.at(-1)?.text).toContain("Context rewound");
      expect(channel.sent.at(-1)?.text).not.toContain("stopped");
    } finally { await agent.stop(); }
  });
});
