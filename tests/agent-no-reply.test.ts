import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
  sdkMock,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ===== NO_REPLY suppression =====

describe("NO_REPLY suppression", () => {
  it("suppresses NO_REPLY for regular DM messages", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("does not show iMessage group typing when a quick passive turn returns NO_REPLY", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("delays iMessage typing and clears it when a slow passive turn returns NO_REPLY", async () => {
    vi.useFakeTimers();
    resetConfig({ imessagePassiveTypingStartDelayMs: 100 });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "NO_REPLY";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    const drained = drainQueue(agent);

    await vi.advanceTimersByTimeAsync(99);
    expect(im.typingStarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(im.typingStarts).toEqual(["iMessage;+;group123"]);

    await vi.advanceTimersByTimeAsync(50);
    await drained;

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStops).toEqual([
      { chatId: "iMessage;+;group123", options: { clear: true } },
    ]);

    await agent.stop();
  });

  it("delivers normal responses via streaming", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "A real answer";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("A real answer");

    await agent.stop();
  });

  it("asks the SDK to omit adaptive thinking display for Claude models", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { thinking?: { type: string; display?: string } };
    };
    expect(lastCall.options?.thinking).toEqual({ type: "adaptive", display: "omitted" });

    await agent.stop();
  });

  it("delivers SDK assistant text even when no stream delta arrives", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.emitStreamDeltas = false;
    mockSdk.responseFn = () => "There's an issue with the selected model (claude-sonnet-4-7). It may not exist or you may not have access to it. Run --model to pick a different model.";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toContain("selected model");
    expect(tg.delivered[0].text).toContain("claude-sonnet-4-7");

    await agent.stop();
  });
});
