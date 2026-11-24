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
  mockWorkspace,
  resetConfig,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

const MEMORY_EVENT = '<tomo-event type="memory" name="changed"';

// A live session keeps the MEMORY.md / roster it was built with, and hears what
// changed as a one-off note on its next turn. That note describes ONE session's
// prompt, so it must never sit in the durable pending-notes store: replayed
// after a restart, to a session built from newer files, it would claim lines
// that may since have changed again.
describe("memory change note on a live session", () => {
  it("rides the next turn once, and is never in the durable notes store", async () => {
    resetConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const store = (agent as unknown as { sessions: { getPendingNotes(key: string): string[] } }).sessions;

    mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)"], people: [] };
    await tg.simulateMessage(makeMsg({ text: "hello" }));
    await drainQueue(agent);
    const key = mockSdk.promptsBySession.at(-1)!.sessionKey;

    // The agent saves a memory: the index gains a line.
    mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)"], people: [] };

    // What a crash in the middle of the next turn would replay.
    let durableDuringTurn: string[] | undefined;
    mockSdk.responseFn = () => {
      durableDuringTurn = store.getPendingNotes(key);
      return "ok";
    };
    mockSdk.promptsBySession = [];
    await tg.simulateMessage(makeMsg({ text: "what's new?" }));
    await drainQueue(agent);

    const told = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(told).toContain(MEMORY_EVENT);
    expect(told).toContain("+ - [Coffee](coffee.md)");
    expect(durableDuringTurn).toBeDefined();
    expect(durableDuringTurn!.join("\n")).not.toContain(MEMORY_EVENT);

    // Told once.
    mockSdk.promptsBySession = [];
    await tg.simulateMessage(makeMsg({ text: "and now?" }));
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.text).join("\n")).not.toContain(MEMORY_EVENT);
    await agent.stop();
  });
});
