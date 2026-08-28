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
// Delivery is non-streaming: the turn runs to completion, its content blocks
// are rendered into one response, and that response ships as ONE channel
// message (newlines and all). Nothing pattern-matches the model's words.

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

  it("joins a multi-block turn into one iMessage", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Three text blocks in a single turn (text → tool → text → tool → text).
    // One turn is one reply, so they arrive as one message, not three.
    mockSdk.responseFn = () => ["first block", "second block", "third block"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("first block\nsecond block\nthird block");

    await agent.stop();
  });

  it("joins a multi-block turn into one Telegram message", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => ["alpha", "beta", "gamma"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("alpha\nbeta\ngamma");

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

  it("drops thinking blocks by default, whatever their text looks like", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => [
      { type: "thinking", thinking: "private reasoning that must not be sent", streamAsTextDelta: true },
      "public answer",
    ];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("public answer");

    await agent.stop();
  });

  it("delivers thinking blocks, marked, when showThinking is on", async () => {
    resetConfig({ showThinking: true });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => [
      { type: "thinking", thinking: "the user probably wants X" },
      "public answer",
    ];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("💭 the user probably wants X\npublic answer");

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

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("before\nafter");

    await agent.stop();
  });

  it("suppresses the whole turn when its LAST block is a bare NO_REPLY", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Housekeeping narration that ends with the token is not for the channel
    // (owner decision 2026-07-08) — nothing ships, not even the narration.
    mockSdk.responseFn = () => ["did the housekeeping", "NO_REPLY"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);

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
