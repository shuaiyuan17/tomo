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

// ===== Per-block streaming delivery (iMessage + Telegram) =====

describe("per-block streaming delivery", () => {
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

  it("iMessage ships each text block separately on multi-block turns", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Three text blocks in a single turn (e.g. text → tool → text → tool → text).
    // Without per-block ship, only the last block would survive the streaming
    // buffer reset; with it, every block lands as its own message.
    mockSdk.responseFn = () => ["first block", "second block", "third block"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(3);
    expect(im.delivered.map((d) => d.text)).toEqual(["first block", "second block", "third block"]);

    await agent.stop();
  });

  it("Telegram ships each text block as its own streamed message", async () => {
    // Telegram now matches iMessage in shape: each block becomes its own
    // sendMessage. Edit-in-place still applies *within* a block as deltas
    // arrive; commitBlock seals it before the next block starts.
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => ["alpha", "beta", "gamma"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(3);
    expect(tg.delivered.map((d) => d.text)).toEqual(["alpha", "beta", "gamma"]);

    await agent.stop();
  });

  // End-to-end proof for the outbound leak filter: a REAL leak shape observed
  // in the transcripts (思考: preamble + reply glued on after the seam + a
  // trailing bare `count` sentinel) must reach the channel as just the reply,
  // as a single message. Exercises turn-runner -> scaffold-filter ->
  // DeliveryPipeline.makeBlockHandler -> StreamingMessage -> channel.send.
  it("strips a leaked thinking preamble and count sentinel before the channel sees it", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () =>
      "思考:有意思——我已经发现过这个错误了。\n\n让我看看当时记了什么。 这个错我 8/24 凌晨就抓到过\n不是新发现\n\ncount";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["这个错我 8/24 凌晨就抓到过\n不是新发现"]);
    expect(im.delivered.some((d) => d.text === "count")).toBe(false);
    expect(im.delivered.some((d) => d.text.includes("思考:"))).toBe(false);

    await agent.stop();
  });

  it("delivers a message that merely MENTIONS count and 思考 completely untouched", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Near-miss guard at the delivery level: ordinary prose using both trigger
    // words, plus a shell flag. Losing this text would be invisible.
    const real = "`count` 和 `思考` 都是正常词 —— `git rev-list --count` 是真命令\n值得思考的是 the count was 136";
    mockSdk.responseFn = () => real;

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual([real]);

    await agent.stop();
  });

  it("ships newline-delimited text within a block as ONE iMessage", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "line A\nline B\nline C";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    // One reply, one message (owner decision 2026-08-27).
    expect(im.delivered.map((d) => d.text)).toEqual(["line A\nline B\nline C"]);

    await agent.stop();
  });

  it("trims the outbound message and never sends a blank Telegram bubble", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "  first burst  \n\n \n  second burst  ";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    // Leading indentation on interior lines survives (code blocks, nested
    // lists); only per-line TRAILING whitespace and the outer edges are trimmed.
    expect(tg.delivered.map((d) => d.text)).toEqual(["first burst\n\n\n  second burst"]);

    await agent.stop();
  });

  it("still rewrites a legacy [[NL]] to a real newline, never a literal token", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "intro[[NL]]detail\nnext";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered.map((d) => d.text)).toEqual(["intro\ndetail\nnext"]);
    expect(im.delivered.some((d) => d.text.includes("[[NL]]"))).toBe(false);

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

  it("does not stream text-shaped deltas from thinking blocks", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => [
      { type: "thinking", thinking: "private reasoning that must not be sent", streamAsTextDelta: true },
      "public answer",
    ];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.streamUpdates.map((d) => d.text)).toEqual(["public answer"]);
    expect(tg.delivered.map((d) => d.text)).toEqual(["public answer"]);

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

  it("drops a NO_REPLY block but ships the others around it", async () => {
    // Mid-turn NO_REPLY (e.g. a tool-only block whose text resolved to bare
    // NO_REPLY) is suppressed by both channels' streaming guards.
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => ["before", "NO_REPLY", "after"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(2);
    expect(im.delivered.map((d) => d.text)).toEqual(["before", "after"]);

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

  it("regression: a throwing commitBlock does not kill the live session", async () => {
    // onBlockComplete fires inside the SDK event loop. If commitBlock throws
    // (e.g. transient BlueBubbles HTTP error), the error must not propagate
    // into LiveSession.consumeEvents — that would mark the session dead and
    // trip runWithRetry's "session error" branch, double-firing the turn.
    const agent = new Agent();
    const im = new MockChannel("imessage");

    // Override commitBlock to throw on the first call only. The test verifies
    // the turn still resolves cleanly, the response is captured, and the
    // session isn't restarted (would manifest as queryState.maxConcurrent > 1
    // or duplicate deliveries).
    let firstCall = true;
    const origCreate = im.createStreamingMessage.bind(im);
    im.createStreamingMessage = (chatId: string, replyTo?: string) => {
      const stream = origCreate(chatId, replyTo);
      const realCommit = stream.commitBlock.bind(stream);
      stream.commitBlock = async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("transient BlueBubbles HTTP error");
        }
        return realCommit();
      };
      return stream;
    };
    agent.addChannel(im);

    mockSdk.responseFn = () => ["block-a", "block-b"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    // Block A's commit threw → no delivery for A. Block B succeeds.
    // (We don't assert on A specifically — just that the turn didn't double-fire.)
    expect(queryState.maxConcurrent).toBe(1);
    // Exactly one block delivered (block-b). Block-a was lost to the thrown
    // commitBlock, but the run completed instead of restarting.
    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("block-b");

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
