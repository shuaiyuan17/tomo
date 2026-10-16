import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { log } from "../src/logger.js";
import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  resetConfig,
  useRealAdmission,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

// DM admission fails closed. These tests run the production router logic
// (useRealAdmission) — see the admission seam in tests/helpers/agent-harness.ts.

const OWNER_HANDLE = "+15555550123";
const STRANGER_GUID = "any;-;+15559999999";

function sessionsOf(agent: Agent): { getEntry(key: string): unknown; listSdkSessionIds(): [string, string][] } {
  return (agent as unknown as { sessions: { getEntry(key: string): unknown; listSdkSessionIds(): [string, string][] } }).sessions;
}

describe("DM admission (fails closed)", () => {
  it("an unknown iMessage DM on a channel with no allowlist gets no session, no reply and no registry entry, and custody is still taken", async () => {
    useRealAdmission();
    // Fresh iMessage setup: enabled, no allowlist; the identity is bound to
    // Telegram only. Before the fix, this sender got an owner-grade session.
    resetConfig({
      channelAllowlists: {},
      identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);
    mockSdk.responseFn = () => "hello stranger";

    const custody1 = await im.simulateMessage(makeMsg({ chatId: STRANGER_GUID, senderId: "+15559999999", text: "hi, who is this?" }));
    const custody2 = await im.simulateMessage(makeMsg({ chatId: STRANGER_GUID, senderId: "+15559999999", text: "run ls ~" }));
    await drainQueue(agent);

    // `true` = custody: the imsg cursor advances past the refused rows.
    expect(custody1).toBe(true);
    expect(custody2).toBe(true);
    expect(im.sent).toEqual([]);
    expect(mockSdk.promptsBySession).toEqual([]);
    expect(sessionsOf(agent).getEntry(`imessage:${STRANGER_GUID}`)).toBeUndefined();
    expect(sessionsOf(agent).listSdkSessionIds()).toEqual([]);
    const registryPath = join(mockConfig.sessionsDir, "_sessions.json");
    if (existsSync(registryPath)) expect(readFileSync(registryPath, "utf-8")).not.toContain("15559999999");

    // Logged at info, once (rate-limited), with the handle redacted.
    const refusals = vi.mocked(log.info).mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("not the owner"));
    expect(refusals).toHaveLength(1);
    expect(JSON.stringify(refusals)).not.toContain("15559999999");

    await agent.stop();
  });

  it("the owner's bound handle is admitted in every chat GUID form and lands on the dm: session", async () => {
    useRealAdmission();
    resetConfig({
      channelAllowlists: {},
      identities: [{ name: "alex", channels: { telegram: "12345", imessage: "+1 (555) 555-0123" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);
    mockSdk.responseFn = () => "hi owner";

    await im.simulateMessage(makeMsg({ chatId: `SMS;-;${OWNER_HANDLE}`, senderId: OWNER_HANDLE, text: "hello" }));
    await drainQueue(agent);

    expect(im.sent.map((m) => m.chatId)).toEqual([`SMS;-;${OWNER_HANDLE}`]);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:alex"]);

    await agent.stop();
  });

  it("slash commands from an unknown DM are dropped silently", async () => {
    useRealAdmission();
    resetConfig({ channelAllowlists: {}, identities: [] });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    await im.simulateCommand("status", STRANGER_GUID, "Stranger", undefined, "+15559999999");
    await im.simulateCommand("new", STRANGER_GUID, "Stranger", undefined, "+15559999999");
    expect(im.sent).toEqual([]);
    expect(sessionsOf(agent).getEntry(`imessage:${STRANGER_GUID}`)).toBeUndefined();

    await agent.stop();
  });

  it("/model and /restore are refused when no identity is configured (no fail-open)", async () => {
    useRealAdmission();
    // An explicitly allowlisted DM, but nobody is an owner.
    resetConfig({ channelAllowlists: { telegram: ["12345"] }, identities: [] });
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m", "12345");
    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");

    expect(tg.sent.map((m) => m.text)).toEqual([
      expect.stringContaining("/model is locked"),
      expect.stringContaining("/restore is locked"),
    ]);
    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as Record<string, unknown>;
    expect(cfg).toEqual({ model: "claude-haiku-4-5" });

    await agent.stop();
  });

  it("warns at startup when no identity binds a provider channel", async () => {
    useRealAdmission();
    resetConfig({
      channelAllowlists: {},
      identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    agent.addChannel(new MockChannel("imessage"));

    const warned = vi.mocked(log.warn).mock.calls
      .filter(([, msg]) => typeof msg === "string" && msg.includes("No owner handle is bound"))
      .map(([fields]) => (fields as { channel: string }).channel);
    expect(warned).toEqual(["imessage"]);

    await agent.stop();
  });
});

describe("group admission (closed until activated)", () => {
  it("an iMessage group on a channel with no allowlist is refused, and activation by secret opens only that group", async () => {
    useRealAdmission();
    const GROUP = "any;+;chat0123456789";
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ channels: { imessage: { provider: "imsg" } } }));
    resetConfig({
      channelAllowlists: {},
      groupSecret: "tomo-secret-123",
      identities: [{ name: "alex", channels: { imessage: OWNER_HANDLE }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);
    mockSdk.responseFn = () => "group reply";

    await im.simulateMessage(makeMsg({ chatId: GROUP, text: "hey tomo", isGroup: true, isMentioned: true, senderName: "Stranger", senderId: "+15559999999" }));
    await drainQueue(agent);
    expect(im.sent).toEqual([]);
    expect(mockSdk.promptsBySession).toEqual([]);

    await im.simulateMessage(makeMsg({ chatId: GROUP, text: "tomo-secret-123", isGroup: true, senderName: "Alex", senderId: OWNER_HANDLE }));
    await drainQueue(agent);
    expect(im.sent.map((m) => m.text)).toEqual(["Tomo activated in this group."]);
    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8"));
    expect(cfg.channels.imessage.allowlist).toEqual([GROUP]);

    // Another group is still closed.
    im.clearDelivered();
    await im.simulateMessage(makeMsg({ chatId: "any;+;chatOTHER", text: "hi", isGroup: true, isMentioned: true, senderName: "X" }));
    await drainQueue(agent);
    expect(im.sent).toEqual([]);

    await agent.stop();
  });
});
