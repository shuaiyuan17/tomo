import { describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ===== DM message routing =====

describe("DM message routing", () => {
  it("falls back to the inbound chat as a unit when the fixed reply channel is not registered", async () => {
    // Identity pins replies to iMessage, but only Telegram is running (provider
    // disabled, say). The fallback must move channel AND chat id together —
    // the old code kept the iMessage handle and handed it to the Telegram bot.
    resetConfig({
      identities: [{
        name: "shuai",
        channels: { telegram: "12345", imessage: "+15551234567" },
        replyPolicy: "imessage",
      }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Hi there!";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].chatId).toBe("12345");
    expect(tg.delivered[0].text).toBe("Hi there!");

    await agent.stop();
  });

  it("refuses to answer a summoned group when the private reply channel is not registered", async () => {
    // The summon runs the group's messages on the owner's private dm: session
    // and promises its plain output stays private. With the private channel
    // (iMessage) down there is nowhere private to reply — the turn must not
    // run into the group. Before, it did.
    resetConfig({
      identities: [{ name: "shuai", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
    };
    internals.router.summonGroup("telegram", "-100270", "shuai");

    mockSdk.responseFn = () => "private side-note for the owner";

    await tg.simulateMessage(makeMsg({
      chatId: "-100270",
      text: "@tomo what did we say in private?",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([]);
    expect(mockSdk.promptsBySession).toEqual([]);

    await agent.stop();
  });

  it("routes DM and replies on the same channel", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Hi there!";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].chatId).toBe("12345");
    expect(tg.delivered[0].text).toBe("Hi there!");

    await agent.stop();
  });

  it("creates separate sessions for different chatIds", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let n = 0;
    mockSdk.responseFn = () => `reply-${++n}`;

    await tg.simulateMessage(makeMsg({ chatId: "111", text: "A" }));
    await drainQueue(agent);
    await tg.simulateMessage(makeMsg({ chatId: "222", text: "B" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(2);
    expect(tg.delivered[0].chatId).toBe("111");
    expect(tg.delivered[1].chatId).toBe("222");

    await agent.stop();
  });

  it("reacts to the latest inbound message in a DM session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ id: "41", chatId: "12345", text: "First" }));
    await drainQueue(agent);
    await tg.simulateMessage(makeMsg({ id: "42", chatId: "12345", text: "Second" }));
    await drainQueue(agent);

    const result = await agent.reactToMessage("telegram:12345", "like");

    expect(result.ok).toBe(true);
    expect(tg.reacted).toEqual([{ chatId: "12345", messageId: "42", reaction: "like", remove: false }]);

    await agent.stop();
  });

  it("reacts to the last active channel for an identity session", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ id: "11", chatId: "12345", text: "From Telegram" }));
    await drainQueue(agent);
    await im.simulateMessage(makeMsg({ id: "im-22", chatId: "+15551234567", text: "From iMessage" }));
    await drainQueue(agent);

    const result = await agent.reactToMessage("shuai", "love", true);

    expect(result.ok).toBe(true);
    expect(tg.reacted).toHaveLength(0);
    expect(im.reacted).toEqual([{ chatId: "+15551234567", messageId: "im-22", reaction: "love", remove: true }]);

    await agent.stop();
  });

  it("reports an error when there is no latest message to react to", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const result = await agent.reactToMessage("telegram:12345", "like");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown target|no latest inbound message/i);
    expect(tg.reacted).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Allowlist =====

describe("allowlist enforcement", () => {
  it("blocks messages from unknown senders", async () => {
    resetConfig({ channelAllowlists: { telegram: ["999"] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("allows whitelisted senders", async () => {
    resetConfig({ channelAllowlists: { telegram: ["12345"] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });
});

// ===== Group chat =====

describe("group chat handling", () => {
  it("ignores group messages when not mentioned", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "Hey everyone",
      isGroup: true,
      isMentioned: false,
    }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("responds to group messages when mentioned", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Group reply!";

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "@tomo what's up",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // Should have at least the user reply (may also have context injection response)
    const replies = tg.delivered.filter(m => m.chatId === "-100123");
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });

  it("uses channel:chatId session key for groups even with identity", async () => {
    resetConfig({
      identities: [{ name: "alice", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
      // No explicit allowlist — identity alone should NOT enable allowlist enforcement
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "reply";

    // DM → uses dm:alice session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "DM" }));
    await drainQueue(agent);

    const dmReplies = tg.delivered.filter(m => m.chatId === "12345");
    expect(dmReplies.length).toBeGreaterThanOrEqual(1);

    tg.clearDelivered();

    // Group → uses telegram:-100999 (separate session, NOT dm:alice)
    await tg.simulateMessage(makeMsg({
      chatId: "-100999",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // The group should get a reply (streamed or via error-retry direct send)
    const groupDelivered = tg.delivered.filter(m => m.chatId === "-100999");
    expect(groupDelivered.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });

  it("activates group via secret phrase", async () => {
    writeFileSync(join(agentEnv.tmpDir, "config.json"), JSON.stringify({
      channels: { telegram: { token: "test", allowlist: ["12345"] } },
    }));

    resetConfig({
      channelAllowlists: { telegram: ["12345"] },
      groupSecret: "tomo-secret-123",
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "tomo-secret-123",
      isGroup: true,
      isMentioned: false,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    const activation = tg.sent.find(m => m.text?.includes("activated"));
    expect(activation).toBeDefined();
    expect(activation!.chatId).toBe("-100group");

    await agent.stop();
  });

  it("does not create an allowlist when the secret arrives on an open channel", async () => {
    // The channel has no allowlist — everything (including this group) is
    // already allowed. Activation must not flip the channel to enforced,
    // which would lock out every other chat until restart.
    const configPath = join(agentEnv.tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      channels: { telegram: { token: "test" } },
    }));

    resetConfig({
      channelAllowlists: {},
      groupSecret: "tomo-secret-123",
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "tomo-secret-123",
      isGroup: true,
      isMentioned: false,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // Acknowledged, but the config gained no allowlist.
    expect(tg.sent.find(m => m.text?.includes("already active"))).toBeDefined();
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.channels.telegram.allowlist).toBeUndefined();

    // Other chats (e.g. the owner's DM) still get through.
    mockSdk.responseFn = () => "Hi there!";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);
    expect(tg.delivered.some(m => m.chatId === "12345")).toBe(true);

    await agent.stop();
  });

  it("renames a group chat and updates the session catalog title", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Group reply!";

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
      chatTitle: "Old Title",
    }));
    await drainQueue(agent);

    const result = await agent.renameGroupChat("telegram:-100123", "New Title");

    expect(result.ok).toBe(true);
    expect(tg.renamed).toEqual([{ chatId: "-100123", title: "New Title" }]);
    // Participants persist via the metadata stub even before an SDK session id
    // is captured for the group.
    expect(agent.listSessionCatalog().groups).toContainEqual({
      key: "telegram:-100123",
      title: "New Title",
      participants: ["Alice"],
    });

    await agent.stop();
  });

  it("rejects group rename for non-group targets", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    const result = await agent.renameGroupChat("telegram:12345", "Nope");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a group/i);
    expect(tg.renamed).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Identity multi-channel routing =====

describe("identity multi-channel routing", () => {
  it("unifies sessions under dm: key", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    let n = 0;
    mockSdk.responseFn = () => `reply-${++n}`;

    // Telegram message
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "From Telegram" }));
    await drainQueue(agent);

    // iMessage message — same identity, last-active should route here
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "From iMessage" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);
    expect(tg.delivered[0].chatId).toBe("12345");

    expect(im.delivered.length).toBeGreaterThanOrEqual(1);
    expect(im.delivered[0].chatId).toBe("+15551234567");

    await agent.stop();
  });

  it("routes reply to fixed channel when policy is set", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "telegram" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    mockSdk.responseFn = () => "Fixed channel reply";

    // Message arrives from iMessage, but policy routes reply to telegram
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);
    expect(tg.delivered[0].chatId).toBe("12345");
    expect(im.delivered).toHaveLength(0);

    await agent.stop();
  });
});
