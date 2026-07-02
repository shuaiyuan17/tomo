import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  resetConfig,
  sdkMock,
} from "./helpers/agent-harness.js";
import { PetStore } from "../src/mcp/pet-store.js";


installAgentTestHooks();

// ===== Commands =====

describe("chat commands", () => {
  it("/login runs a two-step owner-DM flow and schedules restart after verification", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(async () => ({ url: "https://claude.com/login?state=test", reused: false })),
      complete: vi.fn(async () => ({ verified: true })),
      cancel: vi.fn(() => false),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
    };
    internals.commands.claudeLogin = fakeLogin;

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
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(),
      complete: vi.fn(async () => ({
        verified: false,
        verificationError: "Claude login verification failed: network unavailable",
      })),
      cancel: vi.fn(() => false),
      stop: vi.fn(),
    };
    const scheduleRestart = vi.fn();
    const internals = agent as unknown as {
      commands: {
        claudeLogin: typeof fakeLogin;
        scheduleRestart: typeof scheduleRestart;
      };
    };
    internals.commands.claudeLogin = fakeLogin;
    internals.commands.scheduleRestart = scheduleRestart;

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
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
      sessions: InstanceType<typeof SessionStore>;
    };
    internals.commands.claudeLogin = fakeLogin;

    await tg.simulateCommand("login", "-100123", "Shuai", undefined, "12345");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("private DM");
    expect(internals.sessions.listActiveEntries()).toHaveLength(0);

    await agent.stop();
  });

  it("/login rejects a private sender who is not a configured owner", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
    };
    internals.commands.claudeLogin = fakeLogin;

    await tg.simulateCommand("login", "99999", "Other", undefined, "99999");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("configured owner");

    await agent.stop();
  });

  it("/new resets the session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("New session");

    await agent.stop();
  });

  it("/status shows session info", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("status", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Session:");
    expect(tg.sent[0].text).toContain("Model:");

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

  it("/pet reports when Tomo has no pet", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pet", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Tomo doesn't have a pet yet. Ask Tomo to hatch one!");

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
    expect(tg.sent[0].text).toContain("🐾 Mochi the star fox");
    expect(tg.sent[0].text).toContain("Stage: baby");
    expect(tg.sent[0].text).toContain("Mood: happy");
    expect(tg.sent[0].text).toContain("Hunger: 82/100 · Happiness: 74/100");
    expect(tg.sent[0].text).toContain("Energy: 61/100 · Health: 95/100");
    expect(tg.sent[0].text).toContain("Bond: 7 · Care mistakes: 1");

    await agent.stop();
  });

  it("passes LiteLLM gateway env to the Claude Agent SDK child", async () => {
    resetConfig({
      auth: {
        method: "api-key",
        apiKey: "sk-anthropic-direct",
        apiKeySource: "config",
        error: null,
      },
      litellm: {
        mode: "anthropic-compatible",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("does not forward a parent Anthropic API key to a gateway without its own key", async () => {
    const oldApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-parent";
    let agent: InstanceType<typeof Agent> | null = null;
    try {
      resetConfig({
        auth: {
          method: "api-key",
          apiKey: "sk-anthropic-parent",
          apiKeySource: "environment",
          error: null,
        },
        litellm: {
          mode: "anthropic-compatible",
          baseUrl: "http://localhost:4000",
          apiKey: "",
        },
      });
      agent = new Agent();
      const tg = new MockChannel("telegram");
      agent.addChannel(tg);

      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
      await drainQueue(agent);

      const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as {
        options?: { env?: Record<string, string | undefined> };
      };
      expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
      expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (oldApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oldApiKey;
      }
      await agent?.stop();
    }
  });

  it("passes a configured Anthropic API key to direct Claude sessions", async () => {
    resetConfig({
      auth: {
        method: "api-key",
        apiKey: "sk-anthropic-test",
        apiKeySource: "config",
        error: null,
      },
      lcm: {
        ...mockConfig.lcm,
        groupCompactStyle: "sdk",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "Hi",
      isGroup: true,
      isMentioned: true,
    }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-anthropic-test");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();

    await agent.stop();
  });

  it("routes a chatgpt-subscription gateway when the model is a LiteLLM model", async () => {
    resetConfig({
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

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("bypasses a chatgpt-subscription gateway for a Claude-model session", async () => {
    const oldBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://localhost:4000";
    let agent: InstanceType<typeof Agent> | null = null;
    try {
      resetConfig({
        // Gateway only serves chatgpt/*, but this session resolves to a Claude model
        // (default config.model) — it must hit Anthropic directly, not the proxy.
        model: "claude-sonnet-5[1m]",
        litellm: {
          mode: "chatgpt-subscription",
          baseUrl: "http://localhost:4000",
          apiKey: "sk-litellm-test",
        },
      });
      agent = new Agent();
      const tg = new MockChannel("telegram");
      agent.addChannel(tg);

      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
      await drainQueue(agent);

      const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as {
        options?: { env?: Record<string, string | undefined> };
      };
      expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    } finally {
      if (oldBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = oldBaseUrl;
      }
      await agent?.stop();
    }
  });

  it("routes back through the ChatGPT gateway after switching from a Claude model", async () => {
    resetConfig({
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

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Claude turn" }));
    await drainQueue(agent);

    let calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    let lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined>; model?: string };
    };
    expect(lastCall.options?.model).toBe("claude-opus-4-8[1m]");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Back to ChatGPT" }));
    await drainQueue(agent);

    calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined>; model?: string; resume?: string };
    };
    expect(lastCall.options?.model).toBe("chatgpt/gpt-5.5");
    expect(lastCall.options?.resume).toBe("mock-sdk-session-123");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("surfaces the resolved Claude model in the system prompt", async () => {
    resetConfig({ model: "sonnet" });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { options?: { systemPrompt?: string } };
    expect(lastCall.options?.systemPrompt).toContain("# RUNTIME — Current Model");
    // alias "sonnet" must be resolved to its concrete id, not echoed raw
    expect(lastCall.options?.systemPrompt).toContain("claude-sonnet-5");

    await agent.stop();
  });

  it("surfaces a LiteLLM gateway model in the system prompt", async () => {
    resetConfig({
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

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { options?: { systemPrompt?: string } };
    expect(lastCall.options?.systemPrompt).toContain("chatgpt/gpt-5.5");

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
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "sonnet-1m");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to claude-sonnet-5[1m]");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("claude-sonnet-5[1m]");
    expect(mockConfig.sessionModelOverrides["telegram:12345"]).toBe("claude-sonnet-5[1m]");

    const backup = JSON.parse(readFileSync(agentEnv.configBackupPath, "utf-8")) as { model?: string };
    expect(backup.model).toBe("claude-haiku-4-5");

    await agent.stop();
  });

  it("/model keeps the active SDK session so provider switches preserve continuity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    const store = (agent as unknown as { sessions: { getSdkSessionId(key: string): string | undefined } }).sessions;
    expect(store.getSdkSessionId("telegram:12345")).toBe("mock-sdk-session-123");

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m");

    expect(tg.sent.at(-1)?.text).toBe("Switched to claude-opus-4-8[1m]");
    expect(store.getSdkSessionId("telegram:12345")).toBe("mock-sdk-session-123");

    await agent.stop();
  });

  it("/model accepts known full model IDs", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "claude-opus-4-8[1m]");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to claude-opus-4-8[1m]");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("claude-opus-4-8[1m]");

    await agent.stop();
  });

  it("/model accepts future direct model IDs", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "claude-sonnet-5-1");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to claude-sonnet-5-1");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("claude-sonnet-5-1");

    await agent.stop();
  });

  it("/model accepts LiteLLM provider/model names when a gateway is configured", async () => {
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
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to chatgpt/gpt-5.5");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("chatgpt/gpt-5.5");

    await agent.stop();
  });

  it("/model rejects non-chatgpt provider models in ChatGPT subscription mode", async () => {
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
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "openrouter/openai/gpt-4o-mini");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("only routes chatgpt/* models");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/model rejects LiteLLM provider/model names without a gateway and does not write config", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("needs a LiteLLM gateway");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/model rejects invalid model names without writing config", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "not a model");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Unknown model");

    const cfg = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/restore restores config.json from config.json.bak", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Restored config.json");

    const restored = JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as { model?: string };
    expect(restored.model).toBe("claude-sonnet-4-6");
    expect(readFileSync(agentEnv.restartReasonFilePath, "utf-8")).toContain("Restored");

    await agent.stop();
  });

  it("/restore locks out follow-up commands during restart", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(3);
    expect(tg.sent[0].text).toContain("Restored config.json");
    expect(tg.sent[1].text).toContain("Restore is already in progress");
    expect(tg.sent[2].text).toContain("Restore is already in progress");

    await agent.stop();
  });

  it("drops normal messages during restore restart", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(agentEnv.configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hello?" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toContain("Restored config.json");

    await agent.stop();
  });

  it("/restore reports when no config backup exists", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("restore", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("No config backup found");

    await agent.stop();
  });
});
