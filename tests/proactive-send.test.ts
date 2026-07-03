import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage } from "../src/channels/types.js";
import type { SessionEntry } from "../src/sessions/types.js";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    identities: [] as Array<{ name: string; channels?: Record<string, string> }>,
  },
}));

vi.mock("../src/config.js", () => ({ config: mockConfig }));

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ProactiveSendService } = await import("../src/agent/proactive-send.js");
type Deps = ConstructorParameters<typeof ProactiveSendService>[0];

class FakeChannel implements Channel {
  readonly name: string;
  sent: OutgoingMessage[] = [];
  renamed: Array<{ chatId: string; title: string }> = [];
  reacted: Array<{ chatId: string; messageId: string; reaction: MessageReaction; remove?: boolean }> = [];
  constructor(name = "telegram") { this.name = name; }
  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  async setChatTitle(chatId: string, title: string): Promise<void> {
    this.renamed.push({ chatId, title });
  }
  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean): Promise<void> {
    this.reacted.push({ chatId, messageId, reaction, remove });
  }
  createStreamingMessage(): never { throw new Error("not used"); }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface Harness {
  service: InstanceType<typeof ProactiveSendService>;
  channel: FakeChannel;
  transcript: Array<{ sessionKey: string; content: string; channelName: string }>;
  notes: Array<{ sessionKey: string; note: string }>;
  titles: Array<{ sessionKey: string; title: string }>;
  delegated: Array<{ systemMsg: string; sessionKey: string; deliveryTarget?: { channelName: string; chatId: string } }>;
}

function makeHarness(overrides: Partial<Deps> = {}, channel = new FakeChannel()): Harness {
  const transcript: Harness["transcript"] = [];
  const notes: Harness["notes"] = [];
  const titles: Harness["titles"] = [];
  const delegated: Harness["delegated"] = [];

  const service = new ProactiveSendService({
    getChannel: (name) => (name === channel.name ? channel : undefined),
    getSummonedIdentity: () => undefined,
    getReplyTarget: () => undefined,
    deriveReplyTargetFromConfig: () => undefined,
    appendAssistantTranscript: (sessionKey, content, channelName) => {
      transcript.push({ sessionKey, content, channelName });
    },
    setChatTitle: (sessionKey, title) => { titles.push({ sessionKey, title }); },
    listActiveEntries: () => [],
    queuePendingNote: (sessionKey, note) => { notes.push({ sessionKey, note }); },
    runDelegateTurn: async (systemMsg, sessionKey, deliveryTarget) => {
      delegated.push({ systemMsg, sessionKey, deliveryTarget });
      return true;
    },
    ...overrides,
  });

  return { service, channel, transcript, notes, titles, delegated };
}

describe("ProactiveSendService.sendToSession", () => {
  it("rejects unknown targets and disconnected channels", async () => {
    const h = makeHarness();
    mockConfig.identities = [];

    const unknown = await h.service.sendToSession("nobody", "hi");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/unknown target/i);

    const offline = await h.service.sendToSession("imessage:+15551234567", "hi");
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.error).toMatch(/not connected/i);
    expect(h.channel.sent).toHaveLength(0);
  });

  it("sends verbatim text, appends a proactive transcript entry, and queues a pending note", async () => {
    const h = makeHarness();
    const text = "  keep whitespace\n";

    const result = await h.service.sendToSession("telegram:12345", text, "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toEqual([{ chatId: "12345", text }]);
    expect(h.transcript).toEqual([
      { sessionKey: "telegram:12345", content: `[proactive] ${text}`, channelName: "telegram" },
    ]);
    expect(h.notes).toEqual([{
      sessionKey: "telegram:12345",
      note: `[System: Tomo from another session sent the following message to this conversation earlier: "${text}"]`,
    }]);
  });

  it("attributes summoned-group sends to the summoning dm session only", async () => {
    const summonDeps = { getSummonedIdentity: () => "alice" };

    const fromSummoner = makeHarness(summonDeps);
    await fromSummoner.service.sendToSession("telegram:-987", "hello group", "dm:alice");
    expect(fromSummoner.transcript[0].content).toBe("[via dm:alice (summoned)] hello group");
    expect(fromSummoner.notes[0].note).toContain("alice's main session (dm:alice)");

    const otherCaller = makeHarness(summonDeps);
    await otherCaller.service.sendToSession("telegram:-987", "hi from bob", "telegram:222");
    expect(otherCaller.transcript[0].content).toBe("[proactive] hi from bob");
    expect(otherCaller.notes[0].note).toContain("Tomo from another session");
  });

  it("notes a self-targeted direct send as the session's own message", async () => {
    const h = makeHarness();
    await h.service.sendToSession("telegram:12345", "progress update", "telegram:12345");

    expect(h.notes[0].note).toContain("You sent the following message to this conversation earlier");
  });

  it("records a raw target bound to an identity DM under the dm session key (#203)", async () => {
    mockConfig.identities = [{ name: "Shuai", channels: { telegram: "12345" } }];
    try {
      const h = makeHarness();
      const result = await h.service.sendToSession("telegram:12345", "marker text", "dm:shuai");

      expect(result).toEqual({ ok: true });
      // Delivery stays pinned to the channel the caller named…
      expect(h.channel.sent).toEqual([{ chatId: "12345", text: "marker text" }]);
      // …but the record and note land on the dm session, where the chat's
      // inbound history (and recall_conversation) live.
      expect(h.transcript).toEqual([
        { sessionKey: "dm:shuai", content: "[proactive] marker text", channelName: "telegram" },
      ]);
      expect(h.notes[0].sessionKey).toBe("dm:shuai");
      expect(h.notes[0].note).toContain("You sent the following message to this conversation earlier");
    } finally {
      mockConfig.identities = [];
    }
  });

  it("splits attachments into ordered text/photo/sticker sends", async () => {
    const dir = join(tmpdir(), `tomo-proactive-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const imagePath = join(dir, "photo.jpg");
    writeFileSync(imagePath, "fake");
    try {
      const h = makeHarness();
      const result = await h.service.sendToSession(
        "telegram:12345",
        `here MEDIA:"${imagePath}" STICKER:CAAC123`,
      );

      expect(result).toEqual({ ok: true });
      expect(h.channel.sent).toEqual([
        { chatId: "12345", text: "here" },
        { chatId: "12345", photo: imagePath, text: "" },
        { chatId: "12345", sticker: "CAAC123", text: "" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports success when transcript persistence fails after delivery", async () => {
    const h = makeHarness({
      appendAssistantTranscript: () => { throw new Error("disk full"); },
    });

    const result = await h.service.sendToSession("telegram:12345", "delivered once");

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toHaveLength(1);
  });
});

describe("ProactiveSendService.delegateToSession", () => {
  it("dispatches a system turn to the target session and returns immediately", async () => {
    const h = makeHarness();

    const result = await h.service.delegateToSession("telegram:12345", "follow up with Alice");

    expect(result).toEqual({ ok: true });
    expect(h.delegated).toHaveLength(1);
    expect(h.delegated[0].sessionKey).toBe("telegram:12345");
    expect(h.delegated[0].systemMsg).toContain("follow up with Alice");
    expect(h.delegated[0].systemMsg).toContain("Reply NO_REPLY");
  });

  it("rejects delegation to a disconnected channel without dispatching", async () => {
    const h = makeHarness();

    const result = await h.service.delegateToSession("imessage:+15551234567", "say hi");

    expect(result.ok).toBe(false);
    expect(h.delegated).toHaveLength(0);
  });

  it("delegates a raw target bound to an identity DM on the unified dm session (#203)", async () => {
    mockConfig.identities = [{ name: "Shuai", channels: { telegram: "12345" } }];
    try {
      const h = makeHarness();
      const result = await h.service.delegateToSession("telegram:12345", "send the brief");

      expect(result).toEqual({ ok: true });
      // Running under the raw key would spawn a shadow session parallel to
      // dm:shuai for the same chat.
      expect(h.delegated[0].sessionKey).toBe("dm:shuai");
      // Delivery stays pinned to the channel/chat the caller named — the dm
      // session's replyPolicy must not redirect it to another channel.
      expect(h.delegated[0].deliveryTarget).toEqual({ channelName: "telegram", chatId: "12345" });
    } finally {
      mockConfig.identities = [];
    }
  });

  it("does not pin delivery for identity or dm targets (reply policy decides)", async () => {
    mockConfig.identities = [{ name: "Shuai", channels: { telegram: "12345" } }];
    try {
      const h = makeHarness({ deriveReplyTargetFromConfig: () => ({ channelName: "telegram", chatId: "12345" }) });
      await h.service.delegateToSession("Shuai", "send the brief");

      expect(h.delegated[0].sessionKey).toBe("dm:shuai");
      expect(h.delegated[0].deliveryTarget).toBeUndefined();
    } finally {
      mockConfig.identities = [];
    }
  });
});

describe("ProactiveSendService.renameGroupChat", () => {
  it("renames a group and persists the title locally", async () => {
    const h = makeHarness();

    const result = await h.service.renameGroupChat("telegram:-100123", "  New Title  ");

    expect(result).toEqual({ ok: true });
    expect(h.channel.renamed).toEqual([{ chatId: "-100123", title: "New Title" }]);
    expect(h.titles).toEqual([{ sessionKey: "telegram:-100123", title: "New Title" }]);
  });

  it("rejects empty titles and non-group targets", async () => {
    const h = makeHarness();

    const empty = await h.service.renameGroupChat("telegram:-100123", "   ");
    expect(empty.ok).toBe(false);

    const dm = await h.service.renameGroupChat("telegram:12345", "Nope");
    expect(dm.ok).toBe(false);
    if (!dm.ok) expect(dm.error).toMatch(/not a group/i);
    expect(h.channel.renamed).toHaveLength(0);
    expect(h.titles).toHaveLength(0);
  });

  it("surfaces channel rename failures without persisting the title", async () => {
    const channel = new FakeChannel();
    channel.setChatTitle = async () => { throw new Error("bot is not an admin"); };
    const h = makeHarness({}, channel);

    const result = await h.service.renameGroupChat("telegram:-100123", "New Title");

    expect(result).toEqual({ ok: false, error: "bot is not an admin" });
    expect(h.titles).toHaveLength(0);
  });
});

describe("ProactiveSendService.reactToLatestMessage", () => {
  function inbound(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      id: "msg-1",
      chatId: "12345",
      senderName: "TestUser",
      text: "hello",
      timestamp: 1,
      ...overrides,
    };
  }

  it("reacts to the recorded latest inbound message", async () => {
    const h = makeHarness();
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "old" }));
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "latest" }));

    const result = await h.service.reactToLatestMessage("telegram:12345", "like");

    expect(result).toEqual({ ok: true });
    expect(h.channel.reacted).toEqual([
      { chatId: "12345", messageId: "latest", reaction: "like", remove: false },
    ]);
  });

  it("ignores inbound messages without provider ids", async () => {
    const h = makeHarness();
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "" }));

    const result = await h.service.reactToLatestMessage("telegram:12345", "like");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no latest inbound message/i);
  });
});

describe("ProactiveSendService.listSessionCatalog", () => {
  it("lists identities and group entries with metadata", () => {
    mockConfig.identities = [{ name: "Alice" }];
    const entries = [
      { channelKey: "telegram:-100123", chatTitle: "Team", participants: ["Bob"] },
      { channelKey: "telegram:12345" }, // DM — excluded
      { channelKey: "telegram:-100999" }, // group without metadata
    ] as SessionEntry[];
    const h = makeHarness({ listActiveEntries: () => entries });

    const catalog = h.service.listSessionCatalog();

    expect(catalog.identities).toEqual([{ name: "Alice" }]);
    expect(catalog.groups).toEqual([
      { key: "telegram:-100123", title: "Team", participants: ["Bob"] },
      { key: "telegram:-100999" },
    ]);
    mockConfig.identities = [];
  });
});
