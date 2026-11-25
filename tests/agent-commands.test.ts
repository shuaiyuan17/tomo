import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// The config lock, as in production, except that a contended one gives up
// after 100 ms instead of withFileLockSync's 5 s default: the /restore test
// below holds it from "another process" and would otherwise wait it out.
vi.mock("../src/config-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config-file.js")>();
  const { withFileLockSync } = await import("../src/file-lock.js");
  return {
    ...actual,
    withConfigLockSync: <T>(configPath: string, fn: () => T): T =>
      withFileLockSync(actual.configLockPath(configPath), fn, { timeoutMs: 100 }),
  };
});

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  lastQueryOptions,
  mockSdk,
  ownerIdentity,
  resetConfig,
} from "./helpers/agent-harness.js";
import { PetStore } from "../src/mcp/pet-store.js";


installAgentTestHooks();

const CHATGPT_GATEWAY = { mode: "chatgpt-subscription" as const, baseUrl: "http://localhost:4000", apiKey: "sk-litellm-test" };

/** config.json as the daemon left it on disk. */
function readConfigFile(): { model?: string; sessionModelOverrides?: Record<string, string> } {
  return JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as { model?: string; sessionModelOverrides?: Record<string, string> };
}

/** Swap the agent's Claude login flow for spies: no real `claude` process. */
function withFakeLogin<T extends Record<string, ReturnType<typeof vi.fn>>>(agent: InstanceType<typeof Agent>, overrides: T = {} as T) {
  const fakeLogin = { start: vi.fn(), complete: vi.fn(), cancel: vi.fn(), stop: vi.fn(), ...overrides };
  (agent as unknown as { commands: { claudeLogin: typeof fakeLogin } }).commands.claudeLogin = fakeLogin;
  return fakeLogin;
}

// ===== Commands =====

describe("chat commands", () => {
  it("/login runs a two-step owner-DM flow and schedules restart after verification", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = withFakeLogin(agent, {
      start: vi.fn(async () => ({ url: "https://claude.com/login?state=test", reused: false })),
      complete: vi.fn(async () => ({ verified: true })),
      cancel: vi.fn(() => false),
    });

    await tg.simulateCommand("login", "12345", "Shuai", undefined, "12345");

    expect(fakeLogin.start).toHaveBeenCalledWith("shuai");
    expect(tg.sent[0].text).toContain("https://claude.com/login?state=test");
    expect(tg.sent[0].text).toContain("/login <code>");

    await tg.simulateCommand("login", "12345", "Shuai", "secret-code#test", "12345");

    expect(fakeLogin.complete).toHaveBeenCalledWith("shuai", "secret-code#test");
    expect(tg.sent[1].text).toBe("Claude login verified. Restarting Tomo...");
    expect(readFileSync(agentEnv.restartReasonFilePath, "utf-8")).toContain("Claude login refreshed");

    await agent.stop();
  });

  it("/login distinguishes a saved login from a failed verification probe and still restarts", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    withFakeLogin(agent, {
      complete: vi.fn(async () => ({
        verified: false,
        verificationError: "Claude login verification failed: network unavailable",
      })),
      cancel: vi.fn(() => false),
    });
    const scheduleRestart = vi.fn();
    (agent as unknown as { commands: { scheduleRestart: typeof scheduleRestart } }).commands.scheduleRestart = scheduleRestart;

    await tg.simulateCommand("login", "12345", "Shuai", "secret-code#test", "12345");

    expect(tg.sent[0].text).toContain("credentials were saved");
    expect(tg.sent[0].text).toContain("verification probe failed");
    expect(tg.sent[0].text).toContain("network unavailable");
    expect(readFileSync(agentEnv.restartReasonFilePath, "utf-8")).toContain("verification probe failed");
    expect(scheduleRestart).toHaveBeenCalledOnce();

    await agent.stop();
  });

  it("/login rejects groups without starting auth or creating a session", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = withFakeLogin(agent);
    const internals = agent as unknown as { sessions: InstanceType<typeof SessionStore> };

    await tg.simulateCommand("login", "-100123", "Shuai", undefined, "12345");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("private DM");
    expect(internals.sessions.listActiveEntries()).toHaveLength(0);

    await agent.stop();
  });

  // Owner-only commands refuse anyone else, in a DM or an allowlisted group,
  // and leave config, the model overrides and the login flow untouched.
  // (Group-only refusals — "use this in a private DM" — are tested per command above.)
  it.each([
    { cmd: "login", chatId: "99999", allowlist: undefined },
    { cmd: "usage", chatId: "12345", allowlist: ["12345"] },
    { cmd: "restore", chatId: "-100777", allowlist: ["12345", "-100777"] },
    { cmd: "model", chatId: "-100777", allowlist: ["12345", "-100777"], args: "opus-1m" },
  ])("/$cmd refuses a sender who is not the configured owner ($chatId)", async ({ cmd, chatId, allowlist, args }) => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      ...(allowlist ? { channelAllowlists: { telegram: allowlist } } : {}),
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const login = withFakeLogin(agent);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand(cmd, chatId, "Other", args, "99999");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Only the owner");
    expect(login.start).not.toHaveBeenCalled();
    expect(readConfigFile()).toEqual({ model: "claude-haiku-4-5" });
    expect(mockConfig.sessionModelOverrides).toEqual({});

    await agent.stop();
  });

  it("/login with no identities configured points at identity setup instead of a bare refusal", async () => {
    resetConfig({ identities: [] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = withFakeLogin(agent);

    await tg.simulateCommand("login", "12345", "Shuai", undefined, "12345");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("No owner is configured");
    expect(tg.sent[0].text).toContain("tomo config");

    await agent.stop();
  });

  it("/mcp lists live external-server status and starts one explicit login", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const getServerStatuses = vi.fn(() => [{
      name: "cloudflare-api",
      state: "not-mounted" as const,
      oauth: true,
      mounted: false,
      authRequired: true,
    }]);
    const startLogin = vi.fn(async () => ({
      url: "https://auth.example/authorize?state=test",
      reused: false,
      startedAt: Date.now(),
    }));
    const internals = agent as unknown as {
      mcpOAuthManager: {
        getServerStatuses: typeof getServerStatuses;
        startLogin: typeof startLogin;
      };
    };
    internals.mcpOAuthManager.getServerStatuses = getServerStatuses;
    internals.mcpOAuthManager.startLogin = startLogin;

    await tg.simulateCommand("mcp", "12345", "Shuai", undefined, "12345");

    expect(getServerStatuses).toHaveBeenCalledOnce();
    // No conversation is running: no live state is invented for it.
    expect(tg.sent[0].text).toContain("no live session");
    expect(tg.sent[0].text).toContain("cloudflare-api — no live session · login required · /mcp login cloudflare-api");

    await tg.simulateCommand("mcp", "12345", "Shuai", "login cloudflare-api", "12345");

    expect(startLogin).toHaveBeenCalledWith("cloudflare-api", expect.any(Object));
    expect(tg.sent[1].text).toContain("MCP login started");
    expect(tg.sent[1].text).toContain("https://auth.example/authorize?state=test");
    expect(tg.sent[1].text).toContain("paste the full localhost redirect URL");

    await agent.stop();
  });

  it("/mcp is owner-DM-only and does not create a group session when refused", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      channelAllowlists: { telegram: ["12345", "-100123"] },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const startLogin = vi.fn();
    const internals = agent as unknown as {
      mcpOAuthManager: { startLogin: typeof startLogin };
      sessions: InstanceType<typeof SessionStore>;
    };
    internals.mcpOAuthManager.startLogin = startLogin;

    await tg.simulateCommand("mcp", "-100123", "Shuai", "login cloudflare-api", "12345");

    expect(startLogin).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("private DM");
    expect(internals.sessions.listActiveEntries()).toHaveLength(0);

    await agent.stop();
  });

  it("/mcp reports the live session's real connection state, not whether a server is mounted", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      mcpServers: {
        docs: { server: { type: "http", url: "https://docs.example/mcp" } },
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "start session" }));
    await drainQueue(agent);
    tg.clearDelivered();
    // Mounted in the session, but the SDK says the connection failed; the
    // in-process server is reported too, though it is not in config.json.
    mockSdk.mcpStatus = [{ name: "docs", status: "failed" }, { name: "tomo-internal", status: "connected" }];
    mockSdk.mcpReconnectFails = true;

    await tg.simulateCommand("mcp", "12345", "Shuai", undefined, "12345");

    expect(tg.sent[0].text).toContain("(live session)");
    expect(tg.sent[0].text).toContain("docs — failed · no OAuth · /mcp reconnect docs");
    expect(tg.sent[0].text).not.toContain("docs — connected");
    expect(tg.sent[0].text).toContain("tomo-internal — connected · session-provided");
    // Reading the status never reconnects anything by itself.
    expect(mockSdk.mcpReconnects).toEqual([]);

    mockSdk.mcpReconnectFails = false;
    await tg.simulateCommand("mcp", "12345", "Shuai", "reconnect docs", "12345");
    expect(mockSdk.mcpReconnects).toEqual(["docs"]);
    expect(tg.sent.at(-1)!.text).toContain('Reconnected "docs"');

    await agent.stop();
  });

  it("/mcp says when the SDK does not report connection state", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      mcpServers: { docs: { server: { type: "http", url: "https://docs.example/mcp" } } },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: "start session" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("mcp", "12345", "Shuai", undefined, "12345");

    expect(tg.sent[0].text).toContain("did not report its connection state");
    expect(tg.sent[0].text).toContain("docs — status unknown · no OAuth");

    await agent.stop();
  });

  it("consumes a matching pasted MCP callback in the owner DM before it reaches model context", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const completeAuthorizationFromChat = vi.fn()
      .mockResolvedValueOnce({
        status: "completed" as const,
        serverName: "cloudflare-api",
        expiresAt: 4_600_000,
      })
      .mockResolvedValueOnce({ status: "unknown-state" as const });
    const internals = agent as unknown as {
      mcpOAuthManager: { completeAuthorizationFromChat: typeof completeAuthorizationFromChat };
      sessions: InstanceType<typeof SessionStore>;
    };
    internals.mcpOAuthManager.completeAuthorizationFromChat = completeAuthorizationFromChat;

    const callback = "http://localhost:53682/callback?code=secret&state=pending";
    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: callback }));

    expect(completeAuthorizationFromChat).toHaveBeenCalledWith(callback);
    expect(tg.sent[0].text).toContain('MCP login completed for "cloudflare-api"');
    expect(mockSdk.userContents).toHaveLength(0);
    expect(internals.sessions.listActiveEntries()).toHaveLength(0);

    await tg.simulateMessage(makeMsg({
      chatId: "12345",
      senderId: "12345",
      text: "http://localhost:53682/callback?code=other&state=unknown",
    }));

    expect(tg.sent[1].text).toContain("does not match an active login");
    expect(mockSdk.userContents).toHaveLength(0);

    await agent.stop();
  });

  it("passes an ordinary URL with a code query parameter through as normal DM content", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const ordinaryUrl = "https://github.com/login/device?code=promo-code";
    mockSdk.responseFn = (text) => text.includes(ordinaryUrl) ? "I see the ordinary link." : "unexpected";

    await tg.simulateMessage(makeMsg({ chatId: "12345", senderId: "12345", text: ordinaryUrl }));
    await drainQueue(agent);

    const prompt = mockSdk.userContents.flat().map((block) => block.text ?? "").join("");
    expect(prompt).toContain(ordinaryUrl);
    expect(tg.delivered.map((message) => message.text)).toContain("I see the ordinary link.");

    await agent.stop();
  });

  it("never treats a group-pasted localhost callback as OAuth completion", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      channelAllowlists: { telegram: ["12345", "-100123"] },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const completeAuthorizationFromChat = vi.fn();
    const internals = agent as unknown as {
      mcpOAuthManager: { completeAuthorizationFromChat: typeof completeAuthorizationFromChat };
    };
    internals.mcpOAuthManager.completeAuthorizationFromChat = completeAuthorizationFromChat;
    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      senderId: "12345",
      text: "http://localhost:53682/callback?code=secret&state=pending",
      isGroup: true,
      isMentioned: true,
    }));
    await drainQueue(agent);

    expect(completeAuthorizationFromChat).not.toHaveBeenCalled();

    await agent.stop();
  });

  it("/new resets the session: the SDK link is dropped and the next turn starts fresh", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const sessions = (agent as unknown as { sessions: InstanceType<typeof SessionStore> }).sessions;

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    expect(sessions.getSdkSessionId("telegram:12345")).toBe("mock-sdk-session-123");
    tg.clearDelivered();

    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("New session");
    expect(sessions.getSdkSessionId("telegram:12345")).toBeUndefined();

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi again" }));
    await drainQueue(agent);
    expect(lastQueryOptions().resume).toBeUndefined();

    await agent.stop();
  });

  it("replies in the configured locale: Chinese under zh-Hans, English when unset", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("new", "12345", "TestUser");
    await tg.simulateCommand("status", "12345", "TestUser");
    expect(tg.sent[0].text).toBe("🆕 New session started.");
    expect(tg.sent[1].text).toMatch(/^📋 Status\n\nSession: /);
    expect(tg.sent[1].text).toContain("Model:");

    resetConfig({ locale: "zh-Hans" });
    await tg.simulateCommand("new", "12345", "TestUser");
    await tg.simulateCommand("status", "12345", "TestUser");
    await tg.simulateCommand("pause", "12345", "TestUser");
    expect(tg.sent[2].text).toBe("🆕 已开始新的 session。");
    expect(tg.sent[3].text).toMatch(/^📋 状态\n\nSession：telegram:12345\n渠道：telegram\n模型：/);
    expect(tg.sent[3].text).toContain("活跃：");
    expect(tg.sent[4].text).toBe("⚠️ /pause 只能在群聊里使用。");

    await agent.stop();
  });

  it("/cost shows current-session cost windows", async () => {
    const logsDir = join(agentEnv.tmpDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const now = Date.now();
    const run = (time: number, session: string, cost: string) => JSON.stringify({
      time,
      session,
      cost,
      msg: "Run completed (end_turn)",
    });
    writeFileSync(join(logsDir, "tomo.log"), [
      run(now - 2 * 60 * 60 * 1000, "telegram:12345", "$0.1000"),
      run(now - 3 * 24 * 60 * 60 * 1000, "telegram:12345", "$0.2000"),
      run(now - 20 * 24 * 60 * 60 * 1000, "telegram:12345", "$0.3000"),
      run(now - 2 * 60 * 60 * 1000, "telegram:99999", "$9.0000"),
    ].join("\n") + "\n");

    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("cost", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Cost for telegram:12345");
    expect(tg.sent[0].text).toContain("1d: $0.1000 (1 run, $0.1000/run)");
    expect(tg.sent[0].text).toContain("7d: $0.3000 (2 runs, $0.1500/run)");
    expect(tg.sent[0].text).toContain("1mo: $0.6000 (3 runs, $0.2000/run)");
    expect(tg.sent[0].text).not.toContain("$9.0000");

    await agent.stop();
  });

  it("/usage refuses in a group chat (owner DM only)", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
      channelAllowlists: { telegram: ["12345", "-100777"] },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("usage", "-100777", "GroupMember", undefined, "99999");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("private DM");

    await agent.stop();
  });

  it("/usage stays locked (does not fall open) when no identities are configured", async () => {
    // Channels are open by default, so with zero identities a bare DM must NOT
    // read account usage — it points at identity setup, exactly like /login.
    resetConfig({ identities: [] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("usage", "12345", "Anyone", undefined, "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("No owner is configured");
    expect(tg.sent[0].text).toContain("tomo config");

    await agent.stop();
  });

  it("/pet reports when Tomo has no pet", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pet", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("🦀 Tomo doesn't have a pet yet. Ask Tomo to hatch one!");

    await agent.stop();
  });

  it("/pet shows the current pet status", async () => {
    const store = new PetStore(join(agentEnv.tmpDir, "data", "pet.json"));
    const pet = store.create("Mochi", "star fox");
    pet.stage = "baby";
    pet.hunger = 82;
    pet.happiness = 74;
    pet.energy = 61;
    pet.health = 95;
    pet.affection = 12;
    pet.care_mistakes = 1;
    store.save(pet);

    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pet", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("🦀 Mochi the star fox");
    expect(tg.sent[0].text).toContain("Stage: baby");
    expect(tg.sent[0].text).toContain("Mood: happy");
    expect(tg.sent[0].text).toContain("Hunger: 82/100 · Happiness: 74/100");
    expect(tg.sent[0].text).toContain("Energy: 61/100 · Health: 95/100");
    expect(tg.sent[0].text).toContain("Bond: 7 · Care mistakes: 1");

    await agent.stop();
  });

  it("routes back through the ChatGPT gateway after switching from a Claude model", async () => {
    resetConfig({
      identities: [ownerIdentity("owner", { telegram: "12345" })],
      model: "chatgpt/gpt-5.5",
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "ChatGPT turn" }));
    await drainQueue(agent);

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m", "12345");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Claude turn" }));
    await drainQueue(agent);

    expect(lastQueryOptions().model).toBe("claude-opus-5-5[1m]");
    expect(lastQueryOptions().env?.ANTHROPIC_BASE_URL).toBeUndefined();

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5", "12345");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Back to ChatGPT" }));
    await drainQueue(agent);

    const back = lastQueryOptions();
    expect(back.model).toBe("chatgpt/gpt-5.5");
    expect(back.resume).toBe("mock-sdk-session-123");
    expect(back.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(back.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("/status shows LiteLLM gateway mode", async () => {
    resetConfig({
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("status", "12345", "TestUser");

    expect(tg.sent[0].text).toContain("Gateway: LiteLLM (ChatGPT subscription)");

    await agent.stop();
  });

  it("/model persists a session override to config", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "sonnet-1m", "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("🔄 Switched to claude-sonnet-5-5[1m]");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["dm:owner"]).toBe("claude-sonnet-5-5[1m]");
    expect(mockConfig.sessionModelOverrides["dm:owner"]).toBe("claude-sonnet-5-5[1m]");

    const backup = JSON.parse(readFileSync(agentEnv.configBackupPath, "utf-8")) as { model?: string };
    expect(backup.model).toBe("claude-haiku-4-5");

    await agent.stop();
  });

  it("/model keeps the active SDK session so provider switches preserve continuity", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    const store = (agent as unknown as { sessions: { getSdkSessionId(key: string): string | undefined } }).sessions;
    expect(store.getSdkSessionId("dm:owner")).toBe("mock-sdk-session-123");

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m", "12345");

    expect(tg.sent.at(-1)?.text).toBe("🔄 Switched to claude-opus-5-5[1m]");
    expect(store.getSdkSessionId("dm:owner")).toBe("mock-sdk-session-123");

    await agent.stop();
  });

  it.each([
    { name: "a known full model id", arg: "claude-opus-4-8[1m]" },
    { name: "a future direct model id", arg: "claude-sonnet-5-1" },
    { name: "a LiteLLM provider/model name when a gateway is configured", arg: "chatgpt/gpt-5.5", litellm: CHATGPT_GATEWAY },
  ])("/model accepts $name", async ({ arg, litellm }) => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })], ...(litellm ? { litellm } : {}) });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", arg, "12345");

    expect(tg.sent.map((m) => m.text)).toEqual([`🔄 Switched to ${arg}`]);
    expect(readConfigFile().sessionModelOverrides?.["dm:owner"]).toBe(arg);

    await agent.stop();
  });

  it.each([
    { name: "a non-chatgpt provider model in ChatGPT subscription mode", arg: "openrouter/openai/gpt-4o-mini", litellm: CHATGPT_GATEWAY, reply: "only routes chatgpt/* models" },
    { name: "a LiteLLM provider/model name without a gateway", arg: "chatgpt/gpt-5.5", reply: "needs a LiteLLM gateway" },
    { name: "an invalid model name", arg: "not a model", reply: "Unknown model" },
  ])("/model rejects $name and does not write config", async ({ arg, litellm, reply }) => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })], ...(litellm ? { litellm } : {}) });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", arg, "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain(reply);
    expect(readConfigFile().sessionModelOverrides).toBeUndefined();
    expect(mockConfig.sessionModelOverrides["dm:owner"]).toBeUndefined();

    await agent.stop();
  });

  it("/restore does not replace config.json while another writer holds the config lock", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "current" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "backup" }, null, 2) + "\n");
    // A live writer in another process (`tomo config` mid-save) holds the lock.
    const lockPath = `${agentEnv.configFilePath}.lock`;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.planted"), JSON.stringify({ pid: process.ppid, ts: Date.now(), host: hostname() }) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");

    expect(tg.sent[0].text).toContain("restore failed");
    expect(readConfigFile()).toEqual({ model: "current" });
    await agent.stop();
  });

  it("/restore restores config.json from config.json.bak", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Restored config.json");

    const restored = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as { model?: string };
    expect(restored.model).toBe("claude-sonnet-4-6");
    expect(readFileSync(agentEnv.restartReasonFilePath, "utf-8")).toContain("Restored");

    await agent.stop();
  });

  it("/restore locks out follow-up commands during restart", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");
    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");
    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(3);
    expect(tg.sent[0].text).toContain("Restored config.json");
    expect(tg.sent[1].text).toContain("Restore is already in progress");
    expect(tg.sent[2].text).toContain("Restore is already in progress");

    await agent.stop();
  });

  it("drops normal messages during restore restart", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hello?" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toContain("Restored config.json");

    await agent.stop();
  });

  it("ignores commands from chats outside the channel allowlist", async () => {
    resetConfig({
      channelAllowlists: { telegram: ["12345"] },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("status", "99999", "Stranger", undefined, "99999");
    await tg.simulateCommand("restore", "99999", "Stranger", undefined, "99999");
    await tg.simulateCommand("model", "99999", "Stranger", "opus-1m", "99999");

    // Silent drop, exactly like disallowed inbound messages — no reply at all.
    expect(tg.sent).toHaveLength(0);
    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      model?: string;
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.model).toBe("claude-haiku-4-5");
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("still serves commands from the owner's DM when an allowlist is configured", async () => {
    resetConfig({
      channelAllowlists: { telegram: ["12345"] },
      identities: [ownerIdentity("owner", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("status", "12345", "TestUser", undefined, "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Session:");

    await agent.stop();
  });

  it("/model reports an error instead of crashing when config.json is malformed", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, "{ this is not json\n");

    await tg.simulateCommand("model", "12345", "TestUser", "sonnet-1m", "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("[error]");
    expect(tg.sent[0].text).toContain("model unchanged");
    // Neither the in-memory override nor the broken file was touched.
    expect(mockConfig.sessionModelOverrides["dm:owner"]).toBeUndefined();
    expect(readFileSync(agentEnv.configFilePath, "utf-8")).toBe("{ this is not json\n");

    await agent.stop();
  });

  it("/restore reports when no config backup exists", async () => {
    resetConfig({ identities: [ownerIdentity("owner", { telegram: "12345" })] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("restore", "12345", "TestUser", undefined, "12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("No config backup found");

    await agent.stop();
  });
});

// ===== /pause and /resume =====

describe("/pause and /resume", () => {
  const GROUP = "-100123";
  const groupMsg = (text: string) => makeMsg({ chatId: GROUP, text, isGroup: true, isMentioned: true });

  it("pauses a group (messages dropped without reaching the SDK) until /resume", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Sanity: the group is handled before pausing.
    await tg.simulateMessage(groupMsg("hello before pause"));
    await drainQueue(agent);
    expect(tg.delivered.some((d) => d.text === "mock response")).toBe(true);
    tg.clearDelivered();

    await tg.simulateCommand("pause", GROUP, "GroupMember", undefined, "99999");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("paused");
    tg.clearDelivered();
    mockSdk.userContents = [];

    await tg.simulateMessage(groupMsg("this should be ignored"));
    await tg.simulateMessage(groupMsg("this too"));
    await drainQueue(agent);

    // Completely ignored: no reply, and nothing ever reached the model.
    expect(tg.delivered).toHaveLength(0);
    expect(mockSdk.userContents).toHaveLength(0);

    await tg.simulateCommand("resume", GROUP, "OtherMember", undefined, "88888");
    expect(tg.sent.at(-1)?.text).toContain("Tomo is back");
    tg.clearDelivered();

    await tg.simulateMessage(groupMsg("hello after resume"));
    await drainQueue(agent);
    expect(tg.delivered.some((d) => d.text === "mock response")).toBe(true);
    // The paused-period messages never entered the context of the new turn.
    const allTexts = mockSdk.userContents.flat().map((b) => b.text ?? "").join("\n");
    expect(allTexts).not.toContain("this should be ignored");
    expect(allTexts).not.toContain("this too");

    await agent.stop();
  });

  it("drops a group message queued behind an in-flight turn when /pause lands while it waits", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Block the first turn so the second message queues behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("first message")) await gate;
      return "mock response";
    };

    await tg.simulateMessage(groupMsg("first message"));
    // Accepted before the pause, but waiting in the session queue.
    await tg.simulateMessage(groupMsg("second message, queued"));
    await tg.simulateCommand("pause", GROUP, "GroupMember");
    release();
    await drainQueue(agent);

    // Turn 1 completed; the queued message was dropped at processing time.
    const allTexts = mockSdk.userContents.flat().map((b) => b.text ?? "").join("\n");
    expect(allTexts).toContain("first message");
    expect(allTexts).not.toContain("second message, queued");
    expect(tg.delivered.filter((d) => d.text === "mock response")).toHaveLength(1);

    await agent.stop();
  });

  it("any group member can pause and resume, even with identities configured", async () => {
    resetConfig({
      identities: [ownerIdentity("shuai", { telegram: "12345" })],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Sender 99999 is NOT a configured identity — /pause must still work.
    await tg.simulateCommand("pause", GROUP, "RandomMember", undefined, "99999");
    expect(tg.sent[0].text).toContain("paused");

    await tg.simulateCommand("resume", GROUP, "AnotherMember", undefined, "77777");
    expect(tg.sent[1].text).toContain("Tomo is back");

    await agent.stop();
  });

  it("rejects /pause and /resume in DMs", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pause", "12345", "TestUser");
    expect(tg.sent[0].text).toBe("⚠️ /pause only works in group chats.");

    await tg.simulateCommand("resume", "12345", "TestUser");
    expect(tg.sent[1].text).toBe("⚠️ /resume only works in group chats.");

    // DM messages still flow normally.
    tg.clearDelivered();
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    expect(tg.delivered.some((d) => d.text === "mock response")).toBe(true);

    await agent.stop();
  });

  it("reports already-paused and not-paused states", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("resume", GROUP, "GroupMember");
    expect(tg.sent[0].text).toContain("isn't paused");

    await tg.simulateCommand("pause", GROUP, "GroupMember");
    await tg.simulateCommand("pause", GROUP, "GroupMember");
    expect(tg.sent[2].text).toContain("already paused");

    await agent.stop();
  });

  it("only pauses the group it was sent in", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pause", GROUP, "GroupMember");
    tg.clearDelivered();

    await tg.simulateMessage(makeMsg({ chatId: "-100777", text: "other group", isGroup: true, isMentioned: true }));
    await drainQueue(agent);
    expect(tg.delivered.some((d) => d.text === "mock response")).toBe(true);

    await agent.stop();
  });

  it("/status shows the paused state", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pause", GROUP, "GroupMember");
    tg.clearDelivered();

    await tg.simulateCommand("status", GROUP, "GroupMember");
    expect(tg.sent[0].text).toContain("Paused: yes");

    await agent.stop();
  });

  it("pause state survives a daemon restart", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateCommand("pause", GROUP, "GroupMember");
    await agent.stop();

    // Fresh Agent, same tomoHome — pauses.json is reloaded.
    const agent2 = new Agent();
    const tg2 = new MockChannel("telegram");
    agent2.addChannel(tg2);

    await tg2.simulateMessage(groupMsg("still ignored"));
    await drainQueue(agent2);
    expect(tg2.delivered).toHaveLength(0);

    await tg2.simulateCommand("resume", GROUP, "GroupMember");
    expect(tg2.sent[0].text).toContain("Tomo is back");

    await agent2.stop();
  });
});
