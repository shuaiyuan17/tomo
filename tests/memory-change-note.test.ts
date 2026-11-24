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

  // Steering makes turns for one key overlap. The memory note travels as a
  // ticket of its own, never through the durable queue, and only one is in
  // flight per session, so overlapping turns cannot strand or requeue it.
  describe("with two turns in flight for one key", () => {
    type Deps = {
      drainPendingNotes(key: string): string;
      takePromptContextNote(key: string): { prefix: string } | undefined;
      settlePromptContextNote(ticket: unknown, told: boolean): void;
      settlePendingNotes(key: string, drained: string): void;
      restoreInterruptedPendingNotes(key: string, drained: string): void;
    };
    type Internals = {
      queuePendingNote(key: string, note: string): boolean;
      turnRunner: { deps: Deps };
      pendingNotesQueue: { peekNotes(key: string): string[]; inflight: Map<string, unknown[]> };
    };

    async function liveAgent() {
      resetConfig();
      const agent = new Agent();
      const tg = new MockChannel("telegram");
      agent.addChannel(tg);
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)"], people: [] };
      await tg.simulateMessage(makeMsg({ text: "hello" }));
      await drainQueue(agent);
      const key = mockSdk.promptsBySession.at(-1)!.sessionKey;
      const a = agent as unknown as Internals;
      return { agent, key, a, deps: a.turnRunner.deps };
    }

    it("a steered turn carries no second note; both settle cleanly", async () => {
      const { agent, key, a, deps } = await liveAgent();
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)"], people: [] };
      a.queuePendingNote(key, "durable note");
      const drained = deps.drainPendingNotes(key);
      const first = deps.takePromptContextNote(key)!;
      expect(first.prefix).toContain("+ - [Coffee](coffee.md)");
      expect(drained).not.toContain(MEMORY_EVENT);

      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)", "- [Tea](tea.md)"], people: [] };
      expect(deps.takePromptContextNote(key)).toBeUndefined();

      deps.settlePendingNotes(key, drained);
      deps.settlePromptContextNote(first, true);
      expect(a.pendingNotesQueue.inflight.get(key) ?? []).toHaveLength(0);
      expect(a.pendingNotesQueue.peekNotes(key)).toEqual([]);
      const next = deps.takePromptContextNote(key)!;
      expect(next.prefix).toContain("+ - [Tea](tea.md)");
      expect(next.prefix).not.toContain("Coffee");
      await agent.stop();
    });

    it("a first turn that did not complete puts back only its durable note, and both changes are told again", async () => {
      const { agent, key, a, deps } = await liveAgent();
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)"], people: [] };
      a.queuePendingNote(key, "durable note");
      const drained = deps.drainPendingNotes(key);
      const first = deps.takePromptContextNote(key)!;
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)", "- [Tea](tea.md)"], people: [] };

      deps.restoreInterruptedPendingNotes(key, drained);
      deps.settlePromptContextNote(first, false);
      const durable = a.pendingNotesQueue.peekNotes(key).join("\n");
      expect(durable).toContain("durable note");
      expect(durable).not.toContain(MEMORY_EVENT);

      const next = deps.takePromptContextNote(key)!;
      expect(next.prefix).toContain("+ - [Coffee](coffee.md)");
      expect(next.prefix).toContain("+ - [Tea](tea.md)");
      await agent.stop();
    });

    it("a change too large for a note retires the session, and the next turn runs on a fresh one without a note", async () => {
      const { agent, key } = await liveAgent();
      const live = (agent as unknown as { liveSessionManager: { liveSessions: Map<string, unknown> } }).liveSessionManager.liveSessions;
      const first = live.get(key);
      mockWorkspace.promptContext = { memory: ["# New heading", "- [Travel](travel.md)"], people: [] };
      mockSdk.promptsBySession = [];
      const tg = (agent as unknown as { channels: MockChannel[] }).channels.find((c) => c.name === "telegram")!;
      await tg.simulateMessage(makeMsg({ text: "next" }));
      await drainQueue(agent);
      expect(live.get(key)).not.toBe(first);
      expect(mockSdk.promptsBySession.map((p) => p.text).join("\n")).not.toContain(MEMORY_EVENT);
      await agent.stop();
    });
  });
});
