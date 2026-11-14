import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import type { Channel, IncomingMessage } from "../src/channels/types.js";
import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
  useRealAdmission,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// Second-layer guards: each one sits behind an earlier check that normally
// catches the same case, so the end-to-end suites pass with it deleted. These
// tests pin each layer on its own.

const OWNER_ID = "12345";
const GROUP = "-100777";

interface Internals {
  router: {
    summonGroup(channel: string, chatId: string): void;
    getSummonedIdentity(channel: string, chatId: string): string | undefined;
    allowlists: Record<string, Set<string>>;
    summons: { get(rawKey: string): { entry?: { lastActivityAt: number } } };
  };
  pauses: { pause(rawKey: string, by?: string): void };
  sessions: { getEntry(key: string): unknown };
  handleMessage(channel: Channel, message: IncomingMessage): Promise<void>;
  commands: {
    handleSummonCommand(channel: Channel, command: "summon" | "dismiss", chatId: string, senderName: string, senderId?: string): Promise<void>;
  };
}

const internals = (agent: Agent) => agent as unknown as Internals;
const groupMsg = (text: string) =>
  makeMsg({ chatId: GROUP, text, isGroup: true, isMentioned: true, senderName: "Alice", senderId: "555" });

describe("receipt-time /pause gate (Agent.enqueueMessage)", () => {
  it("a paused group's message does not extend its summon's inactivity clock", async () => {
    // processInboundItems drops the message later anyway; what only the
    // receipt gate prevents is router.resolve() touching the summon.
    resetConfig({ identities: [{ name: "shuai", channels: { telegram: OWNER_ID }, replyPolicy: "last-active" }] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const { router, pauses } = internals(agent);

    router.summonGroup("telegram", GROUP);
    const entry = router.summons.get(`telegram:${GROUP}`).entry!;
    const stale = Date.now() - 10 * 60 * 1000;
    entry.lastActivityAt = stale;
    pauses.pause(`telegram:${GROUP}`, "Alice");

    expect(await tg.simulateMessage(groupMsg("ignored while paused"))).toBe(true);
    await drainQueue(agent);

    expect(router.summons.get(`telegram:${GROUP}`).entry?.lastActivityAt).toBe(stale);
    expect(mockSdk.promptsBySession).toEqual([]);
    await agent.stop();
  });
});

describe("processing-time allowlist re-check (Agent.processInboundItems)", () => {
  it("drops a coalesced batch whose group left the allowlist while it waited", async () => {
    // A batch of several items goes to handleBatchedMessages, which has no
    // allowlist check of its own — this re-check is the only one on that path.
    useRealAdmission();
    resetConfig({ channelAllowlists: { telegram: [GROUP] }, passiveGroups: { telegram: [GROUP] }, steering: false });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("first message")) await gate;
      return "mock response";
    };

    await tg.simulateMessage(groupMsg("first message"));
    await tg.simulateMessage(groupMsg("batched one"));
    await tg.simulateMessage(groupMsg("batched two"));
    internals(agent).router.allowlists.telegram.delete(GROUP);
    release();
    await drainQueue(agent);

    const allTexts = mockSdk.userContents.flat().map((b) => b.text ?? "").join("\n");
    expect(allTexts).toContain("first message");
    expect(allTexts).not.toContain("batched one");
    expect(allTexts).not.toContain("batched two");
    await agent.stop();
  });
});

describe("handleMessage allowlist check", () => {
  it("refuses a chat outside the allowlist even when called past the receipt gate", async () => {
    // Every production caller filters first (enqueueMessage, processInboundItems);
    // this is the last line if a future caller does not.
    useRealAdmission();
    resetConfig({ channelAllowlists: { telegram: [] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await internals(agent).handleMessage(tg, groupMsg("hello from a closed group"));
    await drainQueue(agent);

    expect(mockSdk.promptsBySession).toEqual([]);
    expect(tg.sent).toEqual([]);
    expect(internals(agent).sessions.getEntry(`telegram:${GROUP}`)).toBeUndefined();
    await agent.stop();
  });
});

describe("/summon allowlist check (ChatCommandHandler.handleSummonCommand)", () => {
  it("does not summon into a group outside the allowlist, even for the owner", async () => {
    // ChatCommandHandler.handle() refuses such a chat first; this pins the
    // second check inside the summon handler itself.
    useRealAdmission();
    resetConfig({
      channelAllowlists: { telegram: [] },
      identities: [{ name: "shuai", channels: { telegram: OWNER_ID }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await internals(agent).commands.handleSummonCommand(tg, "summon", GROUP, "Shuai", OWNER_ID);

    expect(internals(agent).router.getSummonedIdentity("telegram", GROUP)).toBeUndefined();
    expect(tg.sent).toEqual([]);
    await agent.stop();
  });
});
