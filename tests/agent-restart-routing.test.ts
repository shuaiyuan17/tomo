import { describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";
import { restartReasonSessionFile, writeRestartReasonFile } from "../src/restart-reason.js";
import { log } from "../src/logger.js";

installAgentTestHooks();

const GROUP_CHAT = "-100group";
const GROUP_KEY = `telegram:${GROUP_CHAT}`;
const DM_CHAT = "12345";
const RESTART_MARKER = "Restarted. Reason:";

/** Seed both a DM session (identity shuai ↔ 12345) and a group session. */
async function seedDmAndGroupSessions(agent: InstanceType<typeof Agent>, tg: MockChannel): Promise<void> {
  mockSdk.responseFn = () => "seeded";
  await tg.simulateMessage(makeMsg({ chatId: DM_CHAT, text: "Hi" }));
  await tg.simulateMessage(makeMsg({
    chatId: GROUP_CHAT,
    text: "@tomo hi",
    isGroup: true,
    isMentioned: true,
    senderName: "Alice",
  }));
  await drainQueue(agent);
  tg.clearDelivered();
  mockSdk.userContents = [];
}

/** All prompt texts the mock SDK received that contain the restart marker. */
function restartPrompts(): string[] {
  return mockSdk.userContents
    .map((content) => content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join(""))
    .filter((text) => text.includes(RESTART_MARKER));
}

describe("restart reason routing", () => {
  it("delivers an attributed reason to the initiating group session, and only there", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    const reason = "mirroir session reload, resume reading the notes";
    writeRestartReasonFile(agentEnv.restartReasonFilePath, { reason, sessionKey: GROUP_KEY });

    mockSdk.responseFn = (text) => (text.includes(RESTART_MARKER) ? "Back online, resuming." : "unexpected");
    await agent.start();
    await drainQueue(agent);

    // The reason file and its sidecar are consumed exactly once.
    expect(existsSync(agentEnv.restartReasonFilePath)).toBe(false);
    expect(existsSync(restartReasonSessionFile(agentEnv.restartReasonFilePath))).toBe(false);

    // The restart notice ran on exactly one session's context...
    const prompts = restartPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(reason);

    // ...and the response went to the initiating group chat, never the DM.
    expect(tg.sent.map((m) => m.chatId)).toEqual([GROUP_CHAT]);
    expect(tg.sent[0].text).toBe("Back online, resuming.");

    await agent.stop();
  });

  it("keeps a persisted summon exclusive when a group restart reason is resumed", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });

    // Seed the raw group session and persist the summon in one daemon
    // instance, then reconstruct the Agent to exercise the real restart edge.
    const beforeRestart = new Agent();
    const firstTg = new MockChannel("telegram");
    beforeRestart.addChannel(firstTg);
    await seedDmAndGroupSessions(beforeRestart, firstTg);
    const internals = beforeRestart as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
    };
    internals.router.summonGroup("telegram", GROUP_CHAT, "shuai");
    await beforeRestart.stop();

    const afterRestart = new Agent();
    const secondTg = new MockChannel("telegram");
    afterRestart.addChannel(secondTg);
    mockSdk.responseFn = () => "NO_REPLY";

    await afterRestart.handleRestartForSession(
      `${RESTART_MARKER} resume the group-owned task`,
      GROUP_KEY,
    );
    await drainQueue(afterRestart);

    const prompts = restartPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('type="summon-reminder"');
    expect(prompts[0]).toContain(GROUP_KEY);
    const liveSessions = afterRestart as unknown as {
      liveSessionManager: { isAlive(key: string): boolean };
    };
    expect(liveSessions.liveSessionManager.isAlive("dm:shuai")).toBe(true);
    expect(liveSessions.liveSessionManager.isAlive(GROUP_KEY)).toBe(false);
    expect(secondTg.delivered).toHaveLength(0);

    await afterRestart.stop();
  });

  it("delivers an attributed reason to the initiating DM session without touching groups", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    writeRestartReasonFile(agentEnv.restartReasonFilePath, {
      reason: "Claude login refreshed via owner DM",
      sessionKey: "dm:shuai",
    });

    mockSdk.responseFn = (text) => (text.includes(RESTART_MARKER) ? "Login restart done." : "unexpected");
    await agent.start();
    await drainQueue(agent);

    expect(restartPrompts()).toHaveLength(1);
    expect(tg.sent.map((m) => m.chatId)).toEqual([DM_CHAT]);

    await agent.stop();
  });

  it("keeps legacy blessed-session delivery for a reason with no attribution sidecar (old-binary file)", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    // Exactly what an older binary (or an unattributed `tomo restart`)
    // leaves on disk: bare reason text, no sidecar.
    writeFileSync(agentEnv.restartReasonFilePath, "Updated from v0.8.11 to v0.8.12", "utf-8");

    mockSdk.responseFn = (text) => (text.includes(RESTART_MARKER) ? "Update applied." : "unexpected");
    await agent.start();
    await drainQueue(agent);

    const prompts = restartPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Updated from v0.8.11 to v0.8.12");

    // Legacy behavior: the first DM session gets it; the group stays silent.
    expect(tg.sent.map((m) => m.chatId)).toEqual([DM_CHAT]);

    await agent.stop();
  });

  it("drops a reason attributed to an unknown session instead of rerouting it", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    writeRestartReasonFile(agentEnv.restartReasonFilePath, {
      reason: "private resume context",
      sessionKey: "telegram:-999vanished",
    });

    await agent.start();
    await drainQueue(agent);

    // Misdelivery is the bug this guards against: no session may see the
    // reason, so it is dropped rather than rerouted...
    expect(restartPrompts()).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
    expect(existsSync(agentEnv.restartReasonFilePath)).toBe(false);

    // ...and the warn log is the only trace an operator gets that the
    // reason vanished, so pin it.
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "telegram:-999vanished" }),
      expect.stringContaining("unknown session"),
    );

    await agent.stop();
  });
});
