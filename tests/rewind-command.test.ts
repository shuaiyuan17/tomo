import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
const prepare = vi.hoisted(() => vi.fn());
vi.mock("../src/agent/session-rewind.js", () => ({ prepareSessionRewind: prepare }));
import { Agent, MockChannel, SessionStore, installAgentTestHooks, resetConfig, mockSdk, drainQueue, makeMsg } from "./helpers/agent-harness.js";

installAgentTestHooks();
beforeEach(() => {
  prepare.mockReset().mockResolvedValue({ sessionId: "fork-example", assertUnchanged: () => {} });
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
      expect(channel.sent[0].text).toContain("completed actions and file changes are not undone");
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Edited request" }));
      await drainQueue(agent);
      expect(mockSdk.optionsBySession.at(-1)?.options.resume).toBe("fork-example");
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
        return { sessionId: "fork-example", assertUnchanged: () => {} };
      });
      await command(channel);
      expect(store.getSdkSessionId("dm:example")).toBe("concurrent-example");
      expect(channel.sent.at(-1)?.text).toContain("Session changed");
    } finally { await agent.stop(); }
  });

  it("waits behind an active turn before closing and forking the session", async () => {
    const { agent, channel } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async () => { await gate; return "Finished"; };
    try {
      await channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "Work" }));
      await vi.waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
      const pending = command(channel);
      await Promise.resolve();
      expect(prepare).not.toHaveBeenCalled();
      release();
      await pending;
      expect(prepare).toHaveBeenCalledOnce();
      expect(channel.sent[0].text).toBe("Finished");
      expect(channel.sent.at(-1)?.text).toContain("Context rewound");
    } finally { release(); await agent.stop(); }
  });
});
