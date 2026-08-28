import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  expectNoChangeFor,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  queryState,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// ===== Steering (config.steering) =====
//
// With steering enabled, a message that arrives while a turn is in flight is
// injected into the live session via LiveSession.steer() instead of waiting
// in the per-session queue. Two outcomes exist: the CLI merges it into the
// in-flight turn (echoed back as a `user` event, one combined result), or it
// misses the turn's tool boundaries and runs as its own follow-up turn.

type SteerableSession = {
  isBusy(): boolean;
  pendingSteers: unknown[];
};

function getLiveSession(agent: InstanceType<typeof Agent>, key: string): SteerableSession {
  const sessions = (agent as unknown as {
    liveSessionManager: { liveSessions: Map<string, SteerableSession> };
  }).liveSessionManager.liveSessions;
  return sessions.get(key)!;
}

describe("steering", () => {
  it("dedupes concurrent live-session creation during steered retry storms", async () => {
    resetConfig({ steering: true });
    const agent = new Agent();
    const internals = agent as unknown as {
      liveSessionManager: { getOrCreateLiveSession: (key: string) => Promise<unknown> };
      mcpOAuthManager: {
        buildServersWithAuth: (...args: unknown[]) => Promise<unknown>;
      };
    };

    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const originalBuild = internals.mcpOAuthManager.buildServersWithAuth.bind(internals.mcpOAuthManager);
    let buildCalls = 0;
    internals.mcpOAuthManager.buildServersWithAuth = vi.fn(async (...args: unknown[]) => {
      buildCalls++;
      await buildGate;
      return originalBuild(...args);
    });

    const p1 = internals.liveSessionManager.getOrCreateLiveSession("telegram:12345");
    await waitFor(() => expect(buildCalls).toBe(1));

    const p2 = internals.liveSessionManager.getOrCreateLiveSession("telegram:12345");
    const p3 = internals.liveSessionManager.getOrCreateLiveSession("telegram:12345");
    await expectNoChangeFor(() => expect(buildCalls).toBe(1));

    releaseBuild!();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(s2).toBe(s1);
    expect(s3).toBe(s1);
    expect(buildCalls).toBe(1);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("steers a mid-turn message by default instead of queueing it (follow-up turn outcome)", async () => {
    resetConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockSdk.responseFn = async (text) => {
      if (text.includes("FIRST")) {
        order.push("first-start");
        await gate;
        order.push("first-end");
        return "reply one";
      }
      if (text.includes("SECOND")) {
        order.push("second-run");
        return "reply two";
      }
      return "misc";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(order).toEqual(["first-start"]));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));

    // The steered message is injected while the first turn is still gated —
    // it does NOT wait in the per-session queue.
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(1));
    expect(order).toEqual(["first-start"]);

    release!();
    await waitFor(() => {
      const texts = tg.delivered.map((d) => d.text);
      expect(texts).toContain("reply one");
      expect(texts).toContain("reply two");
    });

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    // The steered message ran as its own turn — no coalescing banner.
    expect(tg.delivered.map((d) => d.text).join("\n")).not.toContain("quick succession");
    expect(tg.delivered.some((d) => d.text.startsWith("[error]"))).toBe(false);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("delivers a merged steered message once, as the owning turn's single reply", async () => {
    resetConfig({ steering: true });
    mockSdk.steerEcho = true;
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockSdk.responseFn = async (text) => {
      if (text.includes("FIRST")) {
        await gate;
        return "reply one";
      }
      if (text.includes("SECOND")) return "reply two";
      return "misc";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").isBusy()).toBe(true));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(1));

    release!();
    // One turn is one reply: both blocks of the merged turn arrive together
    // in a single message rather than as two sends.
    await waitFor(() => {
      expect(tg.delivered.map((d) => d.text)).toEqual(["reply one\nreply two"]);
    });

    // The steered request resolved as merged and must not deliver anything
    // extra (no duplicate, no error).
    await expectNoChangeFor(() => {
      expect(tg.delivered).toHaveLength(1);
      expect(tg.delivered.some((d) => d.text.startsWith("[error]"))).toBe(false);
    });
    expect(getLiveSession(agent, "telegram:12345").isBusy()).toBe(false);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("keeps queueing mid-turn messages when steering is disabled", async () => {
    resetConfig({ steering: false });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockSdk.responseFn = async (text) => {
      if (text.includes("FIRST")) {
        order.push("first-start");
        await gate;
        order.push("first-end");
        return "reply one";
      }
      order.push("second-run");
      return "reply two";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(order).toEqual(["first-start"]));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));
    await expectNoChangeFor(() => expect(order).toEqual(["first-start"]));
    expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(0);

    release!();
    await drainQueue(agent);

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    await agent.stop();
  });
});
