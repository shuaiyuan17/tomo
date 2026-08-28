import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  queryState,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ===== Outbound delivery, end to end (iMessage + Telegram) =====
//
// Delivery is non-streaming but not end-of-turn: each content block ships as
// ONE channel message the moment the SDK closes it, newlines and all. Nothing
// pattern-matches the model's words — block TYPE decides what ships.

describe("outbound delivery", () => {
  it("iMessage ships a single-block response as one message", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "single block reply";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "hi" }));
    await drainQueue(agent);

    // One block → one delivery, no merging or duplication
    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("single block reply");

    await agent.stop();
  });

  it("ships each block of a multi-block turn as its own iMessage", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Three text blocks in a single turn (text → tool → text → tool → text).
    // Each ships as its own message as it completes, so the owner is answered
    // during the turn instead of after it.
    mockSdk.responseFn = () => ["first block", "second block", "third block"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["first block", "second block", "third block"]);

    await agent.stop();
  });

  it("ships each block of a multi-block turn as its own Telegram message", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => ["alpha", "beta", "gamma"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered.map((d) => d.text)).toEqual(["alpha", "beta", "gamma"]);

    await agent.stop();
  });

  it("keeps a three-line reply in one iMessage with its newlines", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "line A\nline B\nline C";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("line A\nline B\nline C");

    await agent.stop();
  });

  it("delivers interior blank lines verbatim instead of splitting on them", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "  first burst\n\nsecond burst  ";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("first burst\n\nsecond burst");

    await agent.stop();
  });

  it("rewrites [[NL]] to a real newline and never ships the token literally", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "intro[[NL]]detail\nnext";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("intro\ndetail\nnext");
    expect(im.delivered[0].text).not.toContain("[[NL]]");

    await agent.stop();
  });

  it("delivers a one-word `count` reply verbatim (#291 P1)", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "count";

    await im.simulateMessage(makeMsg({
      chatId: "iMessage;-;+15551112222",
      text: "translate 计数 to English, one word",
    }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("count");

    await agent.stop();
  });

  it("delivers a text block that opens with 思考: verbatim (#291 P1)", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const reply = "思考: 我建议分两步。 第一步先备份。 第二步再迁移。";
    mockSdk.responseFn = () => reply;

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "怎么做" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe(reply);

    await agent.stop();
  });

  it("keeps [[NL]] line-formatted lists together in iMessage groups", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => [
      "清单 🦀[[NL]]",
      "· Lululemon ×3[[NL]]",
      "· Canada Goose ×1[[NL]]",
      "[[NL]]",
      "取货：国庆自取。",
    ].join("\n");

    await im.simulateMessage(makeMsg({
      chatId: "iMessage;+;group123",
      text: "go",
      isGroup: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual([
      "清单 🦀\n· Lululemon ×3\n· Canada Goose ×1\n\n取货：国庆自取。",
    ]);

    await agent.stop();
  });

  it("keeps MEDIA captions attached instead of newline-splitting them away from the photo", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "captioned-photo.png");
    writeFileSync(imagePath, "fake image");

    mockSdk.responseFn = () => `caption line 1\ncaption line 2 MEDIA:"${imagePath}"`;

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "send photo" }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "caption line 1\ncaption line 2", photo: imagePath, sticker: undefined },
    ]);
    expect(tg.delivered.map((d) => d.text).join("\n")).not.toContain("MEDIA:");

    await agent.stop();
  });

  // The whole mechanism is the block-TYPE gate in renderBlock: the same turn,
  // the same two blocks, only the flag differs. Delete the gate and the
  // showThinking:false row ships the reasoning and fails; delete the marker
  // and the showThinking:true row fails. Each block is its own message, so
  // the reasoning arrives BEFORE the answer rather than glued to it.
  it.each([
    { showThinking: false, expected: ["public answer"] },
    { showThinking: true, expected: ["💭 the user probably wants X", "public answer"] },
  ])("renders a thinking + text turn by block type (showThinking=$showThinking)", async ({ showThinking, expected }) => {
    resetConfig({ showThinking });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => [
      { type: "thinking", thinking: "the user probably wants X" },
      "public answer",
    ];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered.map((d) => d.text)).toEqual(expected);
    // Spelled out both ways so the assertion cannot pass by coincidence.
    const all = tg.delivered.map((d) => d.text).join("\n");
    expect(all.includes("the user probably wants X")).toBe(showThinking);
    expect(all.includes("💭 ")).toBe(showThinking);

    await agent.stop();
  });

  it("suppresses NO_REPLY when it is the entire response", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "noise" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("drops a mid-turn bare NO_REPLY block but keeps the blocks around it", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => ["before", "NO_REPLY", "after"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["before", "after"]);

    await agent.stop();
  });

  it("suppresses only itself when the LAST block is a bare NO_REPLY", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Under end-of-turn delivery this trailing token suppressed the earlier
    // narration too. Mid-turn it cannot: "did the housekeeping" was already
    // sent when the model wrote the token. The token still ships nothing
    // itself, which is the part that was ever load-bearing.
    mockSdk.responseFn = () => ["did the housekeeping", "NO_REPLY"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["did the housekeeping"]);

    await agent.stop();
  });

  it("drops empty blocks but ships the non-empty ones", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Whitespace-only blocks (e.g. a tool-only assistant event with no text)
    // should not surface as empty iMessages.
    mockSdk.responseFn = () => ["   ", "real content", ""];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("real content");

    await agent.stop();
  });

  it("regression: a failing channel send does not re-run the turn", async () => {
    // Delivery happens after the turn resolves, outside the SDK event loop,
    // so a channel failure must surface as an error message — never as a
    // session reset that re-runs the turn (and repeats its side effects).
    const agent = new Agent();
    const im = new MockChannel("imessage");
    let firstSend = true;
    const realSend = im.send.bind(im);
    im.send = async (msg) => {
      if (firstSend) {
        firstSend = false;
        throw new Error("transient iMessage transport error");
      }
      return realSend(msg);
    };
    agent.addChannel(im);

    mockSdk.responseFn = () => "the reply";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("preserves the sdk session link when stopping during an in-flight turn", async () => {
    resetConfig({
      identities: [{ name: "Shuai", channels: { imessage: "+15551112222" }, replyPolicy: "last-active" }],
    });
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId("dm:shuai", "old-session-id");
    store.setReplyTarget("dm:shuai", { channelName: "imessage", chatId: "+15551112222" });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    let release: (() => void) | undefined;
    mockSdk.responseFn = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "late reply";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "restart now" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));

    await agent.stop();
    release?.();

    const after = new SessionStore(
      mockConfig.sessionsDir,
      20,
      mockConfig.sdkSessionsDir,
    ).getEntry("dm:shuai");
    expect(after?.sdkSessionId).toBe("old-session-id");
    expect(after?.unlinkedAt).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Per-block semantics. Joining first and filtering after changes what
  // ships: the streaming predecessor applied the bare-NO_REPLY rule and the
  // scaffold filter to each block on its own, and placed attachments where
  // the model put them. Non-streaming delivery has to match that.
  // ---------------------------------------------------------------------

  it("drops a mid-turn block whose trailing line is NO_REPLY, narration and all", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // The middle block is housekeeping narration the agent marked
    // not-for-the-channel. Neither the narration nor the token may ship, and
    // the blocks around it must survive.
    mockSdk.responseFn = () => ["A", "housekeeping\nNO_REPLY", "B"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["A", "B"]);
    const all = im.delivered.map((d) => d.text).join("\n");
    expect(all).not.toContain("housekeeping");
    expect(all).not.toContain("NO_REPLY");

    await agent.stop();
  });

  it("drops the ATTACHMENTS of a mid-turn NO_REPLY block, not just its text", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "no-reply-block.png");
    writeFileSync(imagePath, "fake image");

    // A block marked not-for-the-channel ships NOTHING — text, media and
    // stickers alike (owner decision 2026-07-08).
    mockSdk.responseFn = () => ["A", `MEDIA:${imagePath}\nNO_REPLY`, "B"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered.some((d) => d.photo)).toBe(false);
    expect(tg.delivered.map((d) => d.text)).toEqual(["A", "B"]);

    await agent.stop();
  });

  it("cuts only the leaking block when scaffold leaks mid-turn", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Filtering the JOINED response would truncate at the marker and lose B.
    mockSdk.responseFn = () => ["A", "<system-reminder>internal note</system-reminder>", "B"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["A", "B"]);
    expect(im.delivered.map((d) => d.text).join("\n")).not.toContain("system-reminder");

    await agent.stop();
  });

  it("delivers an attachment block in place: A, photo, B", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "in-order.png");
    writeFileSync(imagePath, "fake image");

    mockSdk.responseFn = () => ["A", `MEDIA:${imagePath}`, "B"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "A", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: imagePath, sticker: undefined },
      { chatId: "12345", text: "B", photo: undefined, sticker: undefined },
    ]);

    await agent.stop();
  });

  it("never merges adjacent text-only blocks", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Mid-turn there is nothing to merge WITH: when A completes, B has not
    // been written yet. One completed block is one message.
    mockSdk.responseFn = () => ["A", "B"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered.map((d) => d.text)).toEqual(["A", "B"]);

    await agent.stop();
  });

  it("keeps a caption with the media of its OWN block", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "own-block-caption.png");
    writeFileSync(imagePath, "fake image");

    mockSdk.responseFn = () => ["A", `here it is MEDIA:${imagePath}`, "B"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "A", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "here it is", photo: imagePath, sticker: undefined },
      { chatId: "12345", text: "B", photo: undefined, sticker: undefined },
    ]);

    await agent.stop();
  });

  it("ships STICKER tags as sticker sends without leaking the tag into text", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "here you go STICKER:CAACAgQAAxkBAAE123";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "send sticker" }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "here you go", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: undefined, sticker: "CAACAgQAAxkBAAE123" },
    ]);

    await agent.stop();
  });
});
