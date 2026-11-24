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

  // Steering makes turns for one key overlap. Two change notes in flight at
  // once could not be taken back separately: the second overwrote the first,
  // whose prefix then went to the durable store on restore (or left the
  // durable batch it rode with stuck in flight on settle).
  describe("with two turns in flight for one key", () => {
    type Internals = {
      drainPendingNotes(key: string): string;
      queuePendingNote(key: string, note: string): boolean;
      turnRunner: { deps: {
        settlePendingNotes(key: string, drained: string): void;
        restoreInterruptedPendingNotes(key: string, drained: string): void;
      } };
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
      return { agent, key, a: agent as unknown as Internals };
    }

    it("a steered turn carries no second note; the first settles with its durable batch", async () => {
      const { agent, key, a } = await liveAgent();
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)"], people: [] };
      a.queuePendingNote(key, "durable note");
      const first = a.drainPendingNotes(key);
      expect(first).toContain("+ - [Coffee](coffee.md)");
      expect(first).toContain("durable note");

      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)", "- [Tea](tea.md)"], people: [] };
      const steered = a.drainPendingNotes(key);
      expect(steered).not.toContain(MEMORY_EVENT);

      a.turnRunner.deps.settlePendingNotes(key, first);
      a.turnRunner.deps.settlePendingNotes(key, steered);
      // The durable batch is settled, nothing stranded in flight or requeued.
      expect(a.pendingNotesQueue.inflight.get(key) ?? []).toHaveLength(0);
      expect(a.pendingNotesQueue.peekNotes(key)).toEqual([]);
      // The change made meanwhile is told by the next turn, and only it.
      const next = a.drainPendingNotes(key);
      expect(next).toContain("+ - [Tea](tea.md)");
      expect(next).not.toContain("Coffee");
      await agent.stop();
    });

    it("a first turn that did not complete puts back only its durable note, and both changes are told again", async () => {
      const { agent, key, a } = await liveAgent();
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)"], people: [] };
      a.queuePendingNote(key, "durable note");
      const first = a.drainPendingNotes(key);
      mockWorkspace.promptContext = { memory: ["- [Travel](travel.md)", "- [Coffee](coffee.md)", "- [Tea](tea.md)"], people: [] };
      const steered = a.drainPendingNotes(key);

      a.turnRunner.deps.settlePendingNotes(key, steered);
      a.turnRunner.deps.restoreInterruptedPendingNotes(key, first);
      const durable = a.pendingNotesQueue.peekNotes(key).join("\n");
      expect(durable).toContain("durable note");
      expect(durable).not.toContain(MEMORY_EVENT);

      const next = a.drainPendingNotes(key);
      expect(next).toContain("+ - [Coffee](coffee.md)");
      expect(next).toContain("+ - [Tea](tea.md)");
      await agent.stop();
    });
  });
});
