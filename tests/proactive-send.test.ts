import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage, RecentChatMessage } from "../src/channels/types.js";
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
  edited: Array<{ chatId: string; messageId: string; text: string }> = [];
  unsent: Array<{ chatId: string; messageId: string }> = [];
  /** Newest-first recent-message window; set per test. Undefined = channel does not track. */
  recent: RecentChatMessage[] | undefined;
  constructor(name = "telegram") { this.name = name; }
  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  recentMessages? = (_chatId: string): RecentChatMessage[] => this.recent ?? [];
  async setChatTitle(chatId: string, title: string): Promise<void> {
    this.renamed.push({ chatId, title });
  }
  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean): Promise<void> {
    this.reacted.push({ chatId, messageId, reaction, remove });
  }
  editMessage? = async (chatId: string, messageId: string, text: string): Promise<void> => {
    this.edited.push({ chatId, messageId, text });
  };
  unsendMessage? = async (chatId: string, messageId: string): Promise<void> => {
    this.unsent.push({ chatId, messageId });
  };
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  closeIngestion(): void {}
  async quiesce(): Promise<void> {}
  async teardown(): Promise<void> {}
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
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].sessionKey).toBe("telegram:12345");
    expect(h.notes[0].note).toMatch(/^<tomo-event type="direct-send" ts="[^"]+">/);
    expect(h.notes[0].note).toContain(
      `Tomo from another session sent the following message to this conversation earlier: "${text}"`,
    );
  });

  it("rewrites the legacy [[NL]] marker to a newline instead of sending it verbatim", async () => {
    // 2026-08-30: a cron morning brief sent through send_message direct mode
    // reached iMessage with `AI[[NL]]· ...` in it — this was the one outlet
    // that skipped the rewrite every reply block gets.
    const h = makeHarness();

    const result = await h.service.sendToSession("telegram:12345", "☕ 早报\n\nAI [[NL]] · item", "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toEqual([{ chatId: "12345", text: "☕ 早报\n\nAI\n· item" }]);
    // The transcript and the pending note record what was actually sent.
    expect(h.transcript[0].content).toBe("[proactive] ☕ 早报\n\nAI\n· item");
    expect(h.notes[0].note).not.toContain("[[NL]]");
  });

  it("rewrites [[NL]] in the caption of an attachment send too", async () => {
    const dir = join(tmpdir(), `tomo-proactive-nl-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const photo = join(dir, "pic.png");
    writeFileSync(photo, "fake");
    try {
      const h = makeHarness();

      const result = await h.service.sendToSession("telegram:12345", `caption[[NL]]line two MEDIA:${photo}`);

      expect(result).toEqual({ ok: true });
      expect(h.channel.sent[0]).toEqual({ chatId: "12345", text: "caption\nline two" });
      expect(h.channel.sent[1]).toMatchObject({ chatId: "12345", photo });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("threads a direct send onto the matched recent message via replyTo", async () => {
    const h = makeHarness();
    h.channel.recent = [
      { id: "g-2", text: "how about Friday?", timestamp: 2, fromMe: false },
      { id: "g-1", text: "dinner plans?", timestamp: 1, fromMe: false },
    ];

    const result = await h.service.sendToSession("telegram:12345", "Friday works", undefined, { replyTo: "dinner" });

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toEqual([{ chatId: "12345", text: "Friday works", replyTo: "g-1" }]);
  });

  it("allows reply_to to thread onto Tomo's own earlier message", async () => {
    const h = makeHarness();
    h.channel.recent = [
      { id: "mine", text: "I'll check and get back to you", timestamp: 2, fromMe: true },
      { id: "theirs", text: "any update?", timestamp: 1, fromMe: false },
    ];

    const result = await h.service.sendToSession("telegram:12345", "Update: done", undefined, { replyTo: "get back to you" });

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toEqual([{ chatId: "12345", text: "Update: done", replyTo: "mine" }]);
  });

  it("does not send anything when the reply_to match fails", async () => {
    const h = makeHarness();
    h.channel.recent = [{ id: "g-1", text: "hello", timestamp: 1, fromMe: false }];

    const result = await h.service.sendToSession("telegram:12345", "hi", undefined, { replyTo: "nonexistent" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no recent message/i);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("still reports success when transcript persistence fails after delivery", async () => {
    const h = makeHarness({
      appendAssistantTranscript: () => { throw new Error("disk full"); },
    });

    const result = await h.service.sendToSession("telegram:12345", "delivered once");

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toHaveLength(1);
  });

  it("passes a normalized effect through to an iMessage send", async () => {
    const h = makeHarness({}, new FakeChannel("imessage"));

    const result = await h.service.sendToSession("imessage:+15551234567", "恭喜!!", undefined, { effect: " Confetti " });

    expect(result).toEqual({ ok: true });
    expect(h.channel.sent).toEqual([{ chatId: "+15551234567", text: "恭喜!!", effect: "confetti" }]);
  });

  it("still sends the text when the effect name is a typo, and teaches via the note", async () => {
    const h = makeHarness({}, new FakeChannel("imessage"));

    const result = await h.service.sendToSession("imessage:+15551234567", "pew pew", undefined, { effect: "laser" });

    // The failure model everywhere in this feature: the text always delivers,
    // the effect silently vanishes. A typo'd name must not swallow the send.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toMatch(/unknown effect "laser".*lasers/i);
    expect(h.channel.sent).toEqual([{ chatId: "+15551234567", text: "pew pew" }]);
    expect(JSON.stringify(h.channel.sent)).not.toContain("effect");
  });

  it("drops the effect with a note on channels that cannot render it", async () => {
    const h = makeHarness();

    const result = await h.service.sendToSession("telegram:12345", "big news", undefined, { effect: "confetti" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toMatch(/effect "confetti" was ignored/i);
    expect(h.channel.sent).toEqual([{ chatId: "12345", text: "big news" }]);
    expect(JSON.stringify(h.channel.sent)).not.toContain("confetti");
  });

  it("rides the effect on the text send, never on attachments", async () => {
    const h = makeHarness({}, new FakeChannel("imessage"));
    const dir = join(tmpdir(), `tomo-effect-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const photo = join(dir, "pic.png");
    writeFileSync(photo, "fake");
    try {
      const result = await h.service.sendToSession("imessage:+15551234567", `celebrate! MEDIA:${photo}`, undefined, { effect: "confetti" });

      expect(result).toEqual({ ok: true });
      expect(h.channel.sent).toEqual([
        { chatId: "+15551234567", text: "celebrate!", effect: "confetti" },
        { chatId: "+15551234567", photo, text: "" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("ProactiveSendService.reactToMessage", () => {
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

  function recent(id: string, text: string, timestamp = 1): RecentChatMessage {
    return { id, text, timestamp, fromMe: false };
  }

  it("reacts to the recorded latest inbound message when match is omitted", async () => {
    const h = makeHarness();
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "old" }));
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "latest" }));

    const result = await h.service.reactToMessage("telegram:12345", "like");

    expect(result).toEqual({ ok: true });
    expect(h.channel.reacted).toEqual([
      { chatId: "12345", messageId: "latest", reaction: "like", remove: false },
    ]);
  });

  it("ignores inbound messages without provider ids", async () => {
    const h = makeHarness();
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "" }));

    const result = await h.service.reactToMessage("telegram:12345", "like");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no latest inbound message/i);
  });

  it("reacts to the newest recent message matching the substring, case-insensitively", async () => {
    const h = makeHarness();
    h.channel.recent = [
      recent("newest", "unrelated"),
      recent("dinner-2", "Dinner Friday works!"),
      recent("dinner-1", "what about dinner sometime"),
    ];
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "newest" }));

    const result = await h.service.reactToMessage("telegram:12345", "love", false, "dinner friday");

    expect(result).toEqual({ ok: true });
    expect(h.channel.reacted).toEqual([
      { chatId: "12345", messageId: "dinner-2", reaction: "love", remove: false },
    ]);
  });

  it("errors without reacting when no recent message matches", async () => {
    const h = makeHarness();
    h.channel.recent = [recent("a", "hello there")];
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "a" }));

    const result = await h.service.reactToMessage("telegram:12345", "like", false, "nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no recent message/i);
    expect(h.channel.reacted).toHaveLength(0);
  });

  it("errors when the channel does not track recent messages", async () => {
    const h = makeHarness();
    h.channel.recentMessages = undefined;
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "a" }));

    const result = await h.service.reactToMessage("telegram:12345", "like", false, "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not track recent messages/i);
    expect(h.channel.reacted).toHaveLength(0);
  });

  it("never matches Tomo's own outbound messages", async () => {
    const h = makeHarness();
    h.channel.recent = [
      { id: "mine", text: "dinner friday works for me", timestamp: 2, fromMe: true },
      { id: "theirs", text: "dinner friday?", timestamp: 1, fromMe: false },
    ];
    h.service.recordLatestInboundMessage("telegram:12345", h.channel, inbound({ id: "theirs" }));

    const result = await h.service.reactToMessage("telegram:12345", "love", false, "dinner friday");

    expect(result).toEqual({ ok: true });
    expect(h.channel.reacted).toEqual([
      { chatId: "12345", messageId: "theirs", reaction: "love", remove: false },
    ]);

    const onlyMine = await h.service.reactToMessage("telegram:12345", "love", false, "works for me");
    expect(onlyMine.ok).toBe(false);
    if (!onlyMine.ok) expect(onlyMine.error).toMatch(/no recent message/i);
  });

  it("scopes match to the chat of an explicitly named raw target, not the latest-inbound chat", async () => {
    mockConfig.identities = [{ name: "Shuai", channels: { telegram: "12345", imessage: "+15551234567" } }];
    try {
      const tg = new FakeChannel("telegram");
      const im = new FakeChannel("imessage");
      im.recent = [{ id: "im-1", text: "check the imessage thread", timestamp: 1, fromMe: false }];
      const h = makeHarness({
        getChannel: (name) => (name === "telegram" ? tg : name === "imessage" ? im : undefined),
      }, tg);
      // Latest inbound for dm:shuai arrived on Telegram…
      h.service.recordLatestInboundMessage("dm:shuai", tg, inbound({ id: "tg-9", chatId: "12345" }));

      // …but the caller explicitly targeted the iMessage chat.
      const result = await h.service.reactToMessage("imessage:+15551234567", "like", false, "imessage thread");

      expect(result).toEqual({ ok: true });
      expect(tg.reacted).toHaveLength(0);
      expect(im.reacted).toEqual([
        { chatId: "+15551234567", messageId: "im-1", reaction: "like", remove: false },
      ]);
    } finally {
      mockConfig.identities = [];
    }
  });
});

describe("ProactiveSendService edit/unsend of own messages", () => {
  function own(id: string, text: string, timestamp = 1): RecentChatMessage {
    return { id, text, timestamp, fromMe: true };
  }
  function theirs(id: string, text: string, timestamp = 1): RecentChatMessage {
    return { id, text, timestamp, fromMe: false, senderName: "TestUser" };
  }

  it("edits the most recent own message when match is omitted", async () => {
    const h = makeHarness();
    h.channel.recent = [
      theirs("in-2", "what did you mean?"),
      own("mine-2", "dinner is at 7pm"),
      own("mine-1", "hello!"),
    ];

    const result = await h.service.editSentMessage("telegram:12345", "dinner is at 8pm");

    expect(result).toEqual({ ok: true });
    expect(h.channel.edited).toEqual([
      { chatId: "12345", messageId: "mine-2", text: "dinner is at 8pm" },
    ]);
  });

  it("rewrites the legacy [[NL]] marker in an edit", async () => {
    const h = makeHarness();
    h.channel.recent = [own("mine-1", "dinner at 7")];

    const result = await h.service.editSentMessage("telegram:12345", "dinner at 8 [[NL]] bring wine");

    expect(result).toEqual({ ok: true });
    expect(h.channel.edited).toEqual([
      { chatId: "12345", messageId: "mine-1", text: "dinner at 8\nbring wine" },
    ]);
  });

  it("unsends the most recent own message when match is omitted", async () => {
    const h = makeHarness();
    h.channel.recent = [
      theirs("in-2", "who is this for?"),
      own("mine-2", "wrong chat, sorry"),
    ];

    const result = await h.service.unsendMessage("telegram:12345");

    expect(result).toEqual({ ok: true });
    expect(h.channel.unsent).toEqual([{ chatId: "12345", messageId: "mine-2" }]);
  });

  it("matches only Tomo's own messages, never inbound ones", async () => {
    const h = makeHarness();
    h.channel.recent = [
      theirs("in-1", "there is a typo in that"),
      own("mine-1", "a message with a typo inside"),
    ];

    const result = await h.service.editSentMessage("telegram:12345", "fixed text", "typo");

    expect(result).toEqual({ ok: true });
    expect(h.channel.edited).toEqual([
      { chatId: "12345", messageId: "mine-1", text: "fixed text" },
    ]);

    const noOwnMatch = await h.service.unsendMessage("telegram:12345", "there is a typo");
    expect(noOwnMatch.ok).toBe(false);
    if (!noOwnMatch.ok) expect(noOwnMatch.error).toMatch(/no message sent by tomo/i);
    expect(h.channel.unsent).toHaveLength(0);
  });

  it("errors when no own message is known in the chat", async () => {
    const h = makeHarness();
    h.channel.recent = [theirs("in-1", "hello")];

    const result = await h.service.editSentMessage("telegram:12345", "new text");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no message sent by tomo/i);
    expect(h.channel.edited).toHaveLength(0);
  });

  it("errors when the channel does not support edit/unsend", async () => {
    const h = makeHarness();
    h.channel.recent = [own("mine-1", "hello")];
    h.channel.editMessage = undefined;
    h.channel.unsendMessage = undefined;

    const edit = await h.service.editSentMessage("telegram:12345", "new text");
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error).toMatch(/does not support editing/i);

    const unsend = await h.service.unsendMessage("telegram:12345");
    expect(unsend.ok).toBe(false);
    if (!unsend.ok) expect(unsend.error).toMatch(/does not support unsending/i);
  });

  it("rejects empty replacement text without touching the channel", async () => {
    const h = makeHarness();
    h.channel.recent = [own("mine-1", "hello")];

    const result = await h.service.editSentMessage("telegram:12345", "   ");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot be empty/i);
    expect(h.channel.edited).toHaveLength(0);
  });

  it("surfaces channel errors (provider time windows) as tool failures", async () => {
    const h = makeHarness();
    h.channel.recent = [own("mine-1", "hello")];
    h.channel.unsendMessage = async () => {
      throw new Error("Telegram refused the delete — bots can only delete messages within ~48 hours of sending");
    };

    const result = await h.service.unsendMessage("telegram:12345");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/48 hours/);
  });

  it("errors on unknown targets", async () => {
    const h = makeHarness();
    mockConfig.identities = [];

    const result = await h.service.unsendMessage("nobody");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown target/i);
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
