import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { join } from "node:path";
import type { OutgoingMessage, SendResult } from "../src/channels/types.js";
import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { DurableInbox, INBOX_STALE_NOT_PROCESSED } from "../src/agent/durable-inbox.js";
import { existsSync, readFileSync } from "node:fs";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// Sub-sessions wired through the real Agent: a task's turns run on its own
// task: key, silently; its scope (parentKey) decides its privacy.
// ---------------------------------------------------------------------------

/** A channel that answers each send with provider ids, as Telegram and iMessage do. */
class IdChannel extends MockChannel {
  private next = 500;
  override async send(msg: OutgoingMessage): Promise<SendResult> {
    await super.send(msg);
    return { messageIds: [String(this.next++)] };
  }
}

async function boot(enabled = true, channel: MockChannel = new MockChannel("telegram")): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({
    identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    subsessions: { ...mockConfig.subsessions, enabled },
    tomoHome: mockConfig.tomoHome,
  });
  const agent = new Agent();
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

  it("keeps the text a task sent to the owner out of a summoned group's turn on the owner's session", async () => {
    const channel = new IdChannel("telegram");
    const { agent } = await boot(true, channel);
    (agent as unknown as { router: { summonGroup(ch: string, chatId: string, identity: string): void } })
      .router.summonGroup("telegram", "-100271", "alex");
    let release!: () => void;
    const gate = new Promise<string>((r) => { release = () => r("NO_REPLY"); });
    mockSdk.responseFn = () => gate;
    const spawned = agent.subsessions!.spawn("dm:alex", { title: "Deploy", brief: "b" });
    if (!spawned.ok) throw new Error(spawned.error);
    await waitFor(() => expect(taskPrompts("task:s1")).toHaveLength(1));
    // The real task-send path: the channel send, then the direct-send note on dm:alex.
    expect(await agent.subsessions!.notify("task:s1", "the private deploy plan")).toMatchObject({ ok: true });
    expect(channel.delivered.some((d) => d.text.includes("the private deploy plan"))).toBe(true);

    mockSdk.responseFn = () => "NO_REPLY";
    release();
    await expect(agent.handleCronMessage("Scheduled group task", "telegram:-100271", { waitForHandoff: true })).resolves.toBe(true);
    const groupTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex");
    expect(groupTurn).toHaveLength(1);
    expect(groupTurn[0].text).toContain("Scheduled group task");
    expect(groupTurn[0].text).not.toContain("the private deploy plan");

    // The owner's own next turn gets it.
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "how is it going?" }));
    await drainQueue(agent);
    const ownerTurn = mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex").at(-1);
    expect(ownerTurn?.text).toContain("how is it going?");
    expect(ownerTurn?.text).toContain("the private deploy plan");
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

  describe("the owner addressing a task (/s, reply threads)", () => {
    const owner = (text: string, extra: Record<string, unknown> = {}) => makeMsg({ chatId: "12345", senderId: "12345", text, rawText: text, ...extra });
    const ownerPrompts = () => mockSdk.promptsBySession.filter((p) => p.sessionKey === "dm:alex");

    it("answers /s itself: no turn on the owner's session", async () => {
      const { agent, channel } = await boot();
      await channel.simulateMessage(owner("/s"));
      expect(channel.delivered.at(-1)?.text).toBe("No sub-sessions.");
      await channel.simulateMessage(owner("/s s1 stop"));
      expect(channel.delivered.at(-1)?.text).toBe("There's no sub-session s1.");
      await drainQueue(agent);
      expect(ownerPrompts()).toHaveLength(0);
      await agent.stop();
    });

    it("hands /s <id> <words> to the task, without the prefix and without an owner turn", async () => {
      const { agent, channel } = await boot();
      mockSdk.responseFn = (text) => (text.includes("subsession-") ? new Promise(() => {}) : "owner reply");
      agent.subsessions!.spawn("dm:alex", { title: "Fix it", brief: "b" });
      await channel.simulateMessage(owner("/s s1 stop the deploy and roll back"));
      await waitFor(() => expect(agent.subsessions!.get("s1")!.pendingInput.length).toBeGreaterThan(0));
      expect(agent.subsessions!.get("s1")?.status).toBe("active");
      const input = agent.subsessions!.get("s1")!.pendingInput.map((i) => i.text).join("\n");
      expect(input).toContain('type="subsession-owner-message"');
      expect(input).toContain("stop the deploy and roll back");
      expect(input).not.toContain("/s s1");
      expect(ownerPrompts()).toHaveLength(0);
      await agent.stop();
    });

    it("a message for a task that is gone reaches the owner's session, saying so", async () => {
      const { agent, channel } = await boot();
      mockSdk.responseFn = () => "ok";
      await channel.simulateMessage(owner("/s s4 are you done?"));
      await waitFor(() => expect(ownerPrompts().length).toBeGreaterThan(0));
      expect(ownerPrompts()[0].text).toContain("sent this to sub-session s4, which does not exist");
      expect(ownerPrompts()[0].text).toContain("are you done?");
      await agent.stop();
    });

    it("routes a reply to one of the task's messages back to the task", async () => {
      const { agent, channel } = await boot(true, new IdChannel("telegram"));
      mockSdk.responseFn = (text) => (text.includes("subsession-") ? new Promise(() => {}) : "owner reply");
      // A message from the owner first, so the owner's reply target is known.
      await channel.simulateMessage(owner("hi"));
      await drainQueue(agent);
      const before = ownerPrompts().length;
      agent.subsessions!.spawn("dm:alex", { title: "Fix it", brief: "b" });
      expect((await agent.subsessions!.notify("task:s1", "Which branch?")).ok).toBe(true);
      const asked = channel.sent.find((m) => m.text.startsWith("[s1 · Fix it] Which branch?"));
      expect(asked).toBeDefined();
      const id = agent.subsessions!.get("s1")!.replyMap.at(-1)!.messageId;
      await channel.simulateMessage(owner("main", { replyToId: id }));
      await waitFor(() => expect(agent.subsessions!.get("s1")!.pendingInput.map((i) => i.text).join("\n")).toContain("main"));
      expect(ownerPrompts()).toHaveLength(before);
      await agent.stop();
    });

    it("matches a reply sent while the task's message is still sending, once the inbox has it", async () => {
      resetConfig({
        identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
        subsessions: { ...mockConfig.subsessions, enabled: true },
        inbox: true,
        tomoHome: mockConfig.tomoHome,
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      class GateChannel extends IdChannel {
        override async send(msg: OutgoingMessage): Promise<SendResult> {
          const result = await super.send(msg);
          // The provider already shows the task's message; its ids come back late.
          if (msg.text.startsWith("[s1 ")) await gate;
          return result;
        }
      }
      const channel = new GateChannel("telegram");
      const agent = new Agent();
      agent.addChannel(channel);
      await agent.start();
      mockSdk.responseFn = (text) => (text.includes("subsession-") ? new Promise(() => {}) : "owner reply");
      await channel.simulateMessage(owner("hi"));
      await drainQueue(agent);
      const before = ownerPrompts().length;
      agent.subsessions!.spawn("dm:alex", { title: "Fix it", brief: "b" });
      const notifying = agent.subsessions!.notify("task:s1", "Which branch?");
      await waitFor(() => expect(channel.sent.some((m) => m.text.startsWith("[s1 · Fix it] Which branch?"))).toBe(true));
      const inbox = (agent as unknown as { inbox: { pending(): Array<{ message: { id: string } }> } }).inbox;
      // The id the provider will report for that message (IdChannel counts up).
      const id = String(500 + channel.sent.findIndex((m) => m.text.startsWith("[s1 · Fix it] Which branch?")));
      const replying = channel.simulateMessage(owner("main", { id: "r1", replyToId: id }));
      // Custody first: the reply is in the inbox while it waits for the send.
      await waitFor(() => expect(inbox.pending().some((r) => r.message.id === "r1")).toBe(true));
      release();
      expect((await notifying).ok).toBe(true);
      expect(await replying).toBe(true);
      await waitFor(() => expect(agent.subsessions!.get("s1")!.pendingInput.map((i) => i.text).join("\n")).toContain("main"));
      expect(ownerPrompts()).toHaveLength(before);
      await agent.stop();
    });

    it("tells the owner's session when a reply sent during a task's send still matches nothing once the send settles", async () => {
      resetConfig({
        identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
        subsessions: { ...mockConfig.subsessions, enabled: true },
        inbox: true,
        tomoHome: mockConfig.tomoHome,
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // The task's send settles with no provider id: nothing to match a reply on.
      class NoIdGateChannel extends MockChannel {
        override async send(msg: OutgoingMessage): Promise<SendResult> {
          const result = await super.send(msg);
          if (msg.text.startsWith("[s1 ")) await gate;
          return result;
        }
      }
      const channel = new NoIdGateChannel("telegram");
      const agent = new Agent();
      agent.addChannel(channel);
      await agent.start();
      const ownerTexts: string[] = [];
      mockSdk.responseFn = (text) => {
        if (text.includes("subsession-start")) return new Promise(() => {});
        ownerTexts.push(text);
        return "owner reply";
      };
      agent.subsessions!.spawn("dm:alex", { title: "Fix it", brief: "b" });
      const notifying = agent.subsessions!.notify("task:s1", "Which branch?");
      await waitFor(() => expect(channel.sent.some((m) => m.text.startsWith("[s1 · Fix it] Which branch?"))).toBe(true));
      const replying = channel.simulateMessage(owner("main", { id: "r2", replyToId: "provider-7" }));
      await new Promise((r) => setTimeout(r, 20));
      release();
      await notifying;
      expect(await replying).toBe(true);
      await waitFor(() => expect(ownerTexts.some((t) => t.includes("main"))).toBe(true));
      const turn = ownerTexts.find((t) => t.includes("main"))!;
      expect(turn).toContain("may be answering it");
      expect(turn).toContain("/s s1 <message>");
      await agent.stop();
    });

    it("still warns after a restart that came before a reply sent during a task's send was matched", async () => {
      resetConfig({
        identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
        subsessions: { ...mockConfig.subsessions, enabled: true },
        inbox: true,
        tomoHome: mockConfig.tomoHome,
      });
      const store = new SubsessionStore(join(mockConfig.tomoHome, "data", "subsessions.json"));
      const t = store.create({ parentKey: "dm:alex", title: "Fix it", brief: "b" });
      store.transition(t.id, "start");
      store.transition(t.id, "ask", { reason: "asked" });
      // In the inbox when the last run died: an owner reply, unmatched, sent while s1 was sending.
      const inbox = new DurableInbox({ path: join(mockConfig.tomoHome, "data", "inbox.jsonl") });
      inbox.accept("telegram", { ...owner("main", { id: "r3", replyToId: "provider-8" }), taskSendsInFlight: [t.id] },
        { sessionKey: "dm:alex", replyTarget: { channelName: "telegram", chatId: "12345" }, identityName: "alex" });
      inbox.close();
      const ownerTexts: string[] = [];
      mockSdk.responseFn = (text) => {
        if (text.includes("subsession-start") || text.includes("subsession-resume")) return new Promise(() => {});
        ownerTexts.push(text);
        return "ok";
      };
      const agent = new Agent();
      agent.addChannel(new MockChannel("telegram"));
      await agent.start();
      await waitFor(() => expect(ownerTexts.some((x) => x.includes("main"))).toBe(true));
      expect(ownerTexts.find((x) => x.includes("main"))).toContain("may be answering it");
      await agent.stop();
    });

    it("leaves /s alone when sub-sessions are off", async () => {
      const { agent, channel } = await boot(false);
      mockSdk.responseFn = () => "ok";
      await channel.simulateMessage(owner("/s s1 hi"));
      await waitFor(() => expect(ownerPrompts().length).toBeGreaterThan(0));
      expect(ownerPrompts()[0].text).toContain("/s s1 hi");
      await agent.stop();
    });
  });

  it("records a /s message too old to replay in the owner's own conversation, not the task's", async () => {
    // The last run took the owner's message to s1 into the inbox and died
    // before handing it over; it is past the replay window now.
    const inbox = new DurableInbox({ path: join(mockConfig.tomoHome, "data", "inbox.jsonl") });
    inbox.accept("telegram", makeMsg({ id: "late", chatId: "12345", senderId: "12345", text: "use plan B" }),
      { sessionKey: "task:s1", replyTarget: { channelName: "telegram", chatId: "12345" } });
    inbox.close();
    resetConfig({
      identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
      subsessions: { ...mockConfig.subsessions, enabled: true },
      inbox: true,
      inboxReplayMaxAgeMinutes: 0,
      tomoHome: mockConfig.tomoHome,
    });
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    await agent.start();
    const transcript = (key: string) => {
      const file = join(mockConfig.sessionsDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    };
    const mine = transcript("dm:alex");
    expect(mine).toContain("use plan B");
    expect(mine).toContain("sub-session s1");
    expect(mine).toContain(INBOX_STALE_NOT_PROCESSED);
    expect(transcript("task:s1")).not.toContain("use plan B");
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
