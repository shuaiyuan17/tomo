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
import { serializeRestartReason } from "../src/restart-reason.js";

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
    writeFileSync(agentEnv.restartReasonFilePath, serializeRestartReason({ reason, sessionKey: GROUP_KEY }), "utf-8");

    mockSdk.responseFn = (text) => (text.includes(RESTART_MARKER) ? "Back online, resuming." : "unexpected");
    await agent.start();
    await drainQueue(agent);

    // The reason file is consumed exactly once.
    expect(existsSync(agentEnv.restartReasonFilePath)).toBe(false);

    // The restart notice ran on exactly one session's context...
    const prompts = restartPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(reason);

    // ...and the response went to the initiating group chat, never the DM.
    expect(tg.sent.map((m) => m.chatId)).toEqual([GROUP_CHAT]);
    expect(tg.sent[0].text).toBe("Back online, resuming.");

    await agent.stop();
  });

  it("delivers an attributed reason to the initiating DM session without touching groups", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    writeFileSync(
      agentEnv.restartReasonFilePath,
      serializeRestartReason({ reason: "Claude login refreshed via owner DM", sessionKey: "dm:shuai" }),
      "utf-8",
    );

    mockSdk.responseFn = (text) => (text.includes(RESTART_MARKER) ? "Login restart done." : "unexpected");
    await agent.start();
    await drainQueue(agent);

    expect(restartPrompts()).toHaveLength(1);
    expect(tg.sent.map((m) => m.chatId)).toEqual([DM_CHAT]);

    await agent.stop();
  });

  it("keeps legacy blessed-session delivery for an unattributed old-format plain-text reason", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: DM_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await seedDmAndGroupSessions(agent, tg);

    // Exactly what an older binary (or `tomo update`) writes: bare text.
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

    writeFileSync(
      agentEnv.restartReasonFilePath,
      serializeRestartReason({ reason: "private resume context", sessionKey: "telegram:-999vanished" }),
      "utf-8",
    );

    await agent.start();
    await drainQueue(agent);

    // Misdelivery is the bug this guards against: no session may see the
    // reason, so it is dropped (with a log line) rather than rerouted.
    expect(restartPrompts()).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
    expect(existsSync(agentEnv.restartReasonFilePath)).toBe(false);

    await agent.stop();
  });
});
