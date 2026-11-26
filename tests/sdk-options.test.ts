import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { installAgentTestHooks, mockConfig, mockWorkspace, resetConfig } from "./helpers/agent-harness.js";
import { buildHooksOption, buildSdkEnv, makeTurnBudget, sdkOptions } from "../src/agent/sdk-options.js";
import { TOMO_SESSION_KEY_ENV } from "../src/restart-reason.js";

// What sdkOptions() builds for a session: env, tools and connectors, the
// settings the SDK is started with (auto memory, effort, max turns, thinking).
// How hooks are merged is tests/sdk-options-hooks-merge.test.ts.

installAgentTestHooks();

const internalServer = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;

describe("sdkOptions: the session key in the child env", () => {
  it("stamps the session key into the SDK child env for DM sessions", () => {
    resetConfig();
    const opts = sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" });
    expect(opts.env?.[TOMO_SESSION_KEY_ENV]).toBe("dm:shuai");
  });

  it("stamps the session key for group sessions even when SDK auto-compact stays on", () => {
    resetConfig();
    mockConfig.lcm.groupCompactStyle = "sdk";
    const opts = sdkOptions(internalServer, undefined, undefined, { sessionKey: "telegram:-100123" });
    expect(opts.env?.[TOMO_SESSION_KEY_ENV]).toBe("telegram:-100123");
    mockConfig.lcm.groupCompactStyle = "lcm";
  });

  it("passes the daemon env through when there is no session context", () => {
    resetConfig();
    process.env.TOMO_TEST_PASSTHROUGH = "yes";
    try {
      const opts = sdkOptions(internalServer);
      expect(opts.env?.TOMO_TEST_PASSTHROUGH).toBe("yes");
    } finally {
      delete process.env.TOMO_TEST_PASSTHROUGH;
    }
  });
});

/**
 * `@path` mentions are expanded by the CLI with no tool call, so the PreToolUse
 * private-memory guard cannot see them. CLAUDE_CODE_DISABLE_FILE_MENTIONS must
 * reach EVERY SDK child — including the branch that used to return no env at
 * all (no session context, subscription auth, no gateway).
 */
describe("sdkOptions disables @file mentions", () => {
  const cases: Array<[string, () => ReturnType<typeof sdkOptions>]> = [
    ["no session context", () => sdkOptions(internalServer)],
    ["DM session", () => sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" })],
    ["group session", () => sdkOptions(internalServer, undefined, undefined, { sessionKey: "telegram:-100123" })],
    ["api-key auth", () => {
      mockConfig.auth = { ...mockConfig.auth, method: "api-key", apiKey: "sk-test" } as typeof mockConfig.auth;
      return sdkOptions(internalServer);
    }],
    ["LiteLLM gateway", () => {
      mockConfig.litellm = { mode: "anthropic-compatible", baseUrl: "http://127.0.0.1:4000", apiKey: "gw" };
      return sdkOptions(internalServer);
    }],
  ];
  for (const [label, build] of cases) {
    it(`sets CLAUDE_CODE_DISABLE_FILE_MENTIONS=1 (${label})`, () => {
      resetConfig();
      const opts = build();
      try {
        expect(opts.env?.CLAUDE_CODE_DISABLE_FILE_MENTIONS).toBe("1");
      } finally {
        mockConfig.litellm = null;
        resetConfig();
      }
    });
  }
});

/**
 * Where a session's credentials go. A generic anthropic-compatible LiteLLM
 * proxy routes every session; a chatgpt-subscription proxy serves only its
 * chatgpt/* models, so a Claude-model session must bypass it — and scrub a
 * gateway URL the daemon itself inherited. A direct Anthropic key never
 * reaches a gateway. (The Agent-level twin, a /model switch back and forth,
 * is in tests/agent-commands.test.ts.)
 */
describe("buildSdkEnv: gateway and API-key routing", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const gateway = (mode: "anthropic-compatible" | "chatgpt-subscription", apiKey = "sk-litellm-test") =>
    ({ mode, baseUrl: "http://localhost:4000", apiKey });
  const apiKeyAuth = (apiKey: string, apiKeySource: "config" | "environment" = "config") =>
    ({ method: "api-key" as const, apiKey, apiKeySource, error: null });

  it.each([
    {
      name: "an anthropic-compatible gateway gets its own key, never the direct one",
      config: { auth: apiKeyAuth("sk-anthropic-direct"), litellm: gateway("anthropic-compatible") },
      expected: { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_API_KEY: "sk-litellm-test" },
    },
    {
      name: "a gateway without a key of its own gets no inherited Anthropic key",
      parentEnv: { ANTHROPIC_API_KEY: "sk-anthropic-parent" },
      config: { auth: apiKeyAuth("sk-anthropic-parent", "environment"), litellm: gateway("anthropic-compatible", "") },
      expected: { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_API_KEY: undefined },
    },
    {
      name: "a direct Claude session gets the configured Anthropic key and no gateway",
      sessionKey: "telegram:-100123",
      config: { auth: apiKeyAuth("sk-anthropic-test") },
      expected: { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: "sk-anthropic-test" },
    },
    {
      name: "a chatgpt-subscription gateway routes its own chatgpt/* model",
      model: "chatgpt/gpt-5.5",
      config: { litellm: gateway("chatgpt-subscription") },
      expected: { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_API_KEY: "sk-litellm-test" },
    },
    {
      name: "a chatgpt-subscription gateway is bypassed, inherited URL scrubbed, for a Claude model",
      parentEnv: { ANTHROPIC_BASE_URL: "http://localhost:4000" },
      model: "claude-sonnet-5[1m]",
      config: { litellm: gateway("chatgpt-subscription") },
      expected: { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: undefined },
    },
    {
      // The daemon's own ANTHROPIC_API_KEY (auth resolves it as source
      // "environment") must survive the bypass: the session goes to Anthropic
      // direct, so it needs that key, not the gateway's.
      name: "a chatgpt-subscription gateway is bypassed and the inherited Anthropic key kept, for a Claude model",
      parentEnv: { ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_API_KEY: "sk-anthropic-parent" },
      model: "claude-sonnet-5[1m]",
      config: { auth: apiKeyAuth("sk-anthropic-parent", "environment"), litellm: gateway("chatgpt-subscription") },
      expected: { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: "sk-anthropic-parent" },
    },
  ])("$name", ({ parentEnv, config, model, sessionKey, expected }) => {
    for (const [name, value] of Object.entries(parentEnv ?? {})) vi.stubEnv(name, value);
    resetConfig(config as Parameters<typeof resetConfig>[0]);
    const env = buildSdkEnv({ disableAutoCompact: false, model: model ?? mockConfig.model, sessionKey: sessionKey ?? "dm:shuai" });
    expect({ ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }).toEqual(expected);
  });

  it("sets DISABLE_AUTO_COMPACT only for a session whose compaction Tomo runs (LCM)", () => {
    resetConfig();
    expect(buildSdkEnv({ disableAutoCompact: true, model: mockConfig.model, sessionKey: "dm:shuai" }).DISABLE_AUTO_COMPACT).toBe("1");
    expect(buildSdkEnv({ disableAutoCompact: false, model: mockConfig.model, sessionKey: "dm:shuai" })).not.toHaveProperty("DISABLE_AUTO_COMPACT");
    // Through sdkOptions: the owner's DM is LCM-compacted, a group on `sdk` style is not.
    mockConfig.lcm.groupCompactStyle = "sdk";
    try {
      expect(sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" }).env?.DISABLE_AUTO_COMPACT).toBe("1");
      expect(sdkOptions(internalServer, undefined, undefined, { sessionKey: "telegram:-100123" }).env).not.toHaveProperty("DISABLE_AUTO_COMPACT");
    } finally {
      mockConfig.lcm.groupCompactStyle = "lcm";
    }
  });

  it("keeps the 1-hour prompt-cache TTL on unless the environment says otherwise", () => {
    // Without the flag, api-key and gateway auth silently drop to the 5-minute
    // TTL and idle sessions re-pay full cache writes on their system prompts.
    resetConfig({ auth: apiKeyAuth("sk-anthropic-test") });
    vi.stubEnv("ENABLE_PROMPT_CACHING_1H", undefined);
    expect(buildSdkEnv({ disableAutoCompact: false, model: mockConfig.model, sessionKey: "dm:shuai" }).ENABLE_PROMPT_CACHING_1H).toBe("1");
    vi.stubEnv("ENABLE_PROMPT_CACHING_1H", "0");
    expect(buildSdkEnv({ disableAutoCompact: false, model: mockConfig.model, sessionKey: "dm:shuai" }).ENABLE_PROMPT_CACHING_1H).toBe("0");
  });
});

describe("sdkOptions: the serving model, named in the system prompt", () => {
  // A model cannot reliably introspect its own identity: the runtime section
  // states it, resolved from an alias to its concrete id.
  it.each([
    { name: "a Claude alias, resolved", config: { model: "sonnet" }, contains: ["# RUNTIME", "claude-sonnet-5"] },
    { name: "a LiteLLM gateway model", config: { model: "chatgpt/gpt-5.5", litellm: { mode: "chatgpt-subscription" as const, baseUrl: "http://localhost:4000", apiKey: "sk-litellm-test" } }, contains: ["# RUNTIME", "chatgpt/gpt-5.5"] },
  ])("$name", ({ config, contains }) => {
    resetConfig(config);
    const prompt = (sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" }).systemPrompt as unknown as string[]).join("\n\n");
    for (const text of contains) expect(prompt).toContain(text);
  });
});

describe("sdkOptions: the delegation note follows subsessions.enabled", () => {
  it.each([true, false])("subsessions.enabled %s reaches buildSystemPrompt; a task session builds its own prompt", (enabled) => {
    resetConfig({ subsessions: { ...mockConfig.subsessions, enabled } });
    mockWorkspace.lastBuildOptions = undefined;
    sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" });
    expect(mockWorkspace.lastBuildOptions).toMatchObject({ isGroup: false, subsessions: enabled });
    mockWorkspace.lastBuildOptions = undefined;
    sdkOptions(internalServer, undefined, undefined, {
      sessionKey: "task:s1",
      subsession: { staticPrompt: "task prompt", maxTurns: 10, groupScope: false } as never,
    });
    expect(mockWorkspace.lastBuildOptions).toBeUndefined();
  });
});

describe("sdkOptions: web-only affordances on the owner's DM", () => {
  // The predicted next message and the per-task Stop are shown only by the
  // web UI, so only the owner's DM asks for them, and only with the web UI on.
  it("asks for prompt suggestions and the per-task Stop on the owner's DM with the web UI on, nowhere else", () => {
    resetConfig({ web: { enabled: true } as never });
    const dm = sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" }) as Record<string, unknown>;
    expect(dm.promptSuggestions).toBe(true);
    expect(dm.perTaskStopAffordance).toBe(true);
    for (const opts of [
      sdkOptions(internalServer, undefined, undefined, { sessionKey: "telegram:-100123" }),
      sdkOptions(internalServer),
    ] as Array<Record<string, unknown>>) {
      expect(opts).not.toHaveProperty("promptSuggestions");
      expect(opts).not.toHaveProperty("perTaskStopAffordance");
    }
    resetConfig();
    expect(sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" })).not.toHaveProperty("promptSuggestions");
  });
});

/**
 * `allowedTools` names every tomo-internal tool explicitly, so a tool added to
 * the MCP server and forgotten here is one the model is offered and then
 * refused. `schedule_enable` and the five `pet_*` tools sat in that gap.
 */
describe("sdkOptions allowedTools", () => {
  it("allows every tool the tomo-internal MCP server registers", async () => {
    resetConfig();
    const { createTomoInternalMcpServer } = await import("../src/mcp/internal-server.js");
    // Handlers are never called here — only the registered names are read.
    const server = createTomoInternalMcpServer({} as never, "dm:shuai");
    const registered = (server as unknown as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name);
    expect(registered.length).toBeGreaterThan(0);

    const allowed = sdkOptions(internalServer).allowedTools;
    const missing = registered.filter((name) => !allowed.includes(`mcp__tomo-internal__${name}`));
    expect(missing).toEqual([]);
  });
});

describe("sdkOptions claude.ai connectors", () => {
  it("disables claude.ai connectors for a group's own session", () => {
    resetConfig();
    for (const key of ["telegram:-100123", "imessage:any;+;chat123"]) {
      const opts = sdkOptions(internalServer, undefined, undefined, { sessionKey: key });
      expect((opts.settings as { disableClaudeAiConnectors?: boolean }).disableClaudeAiConnectors).toBe(true);
    }
  });

  it("keeps claude.ai connectors for the owner's DM and keyless (cron) sessions", () => {
    resetConfig();
    const dm = sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" });
    expect(dm.settings).not.toHaveProperty("disableClaudeAiConnectors");
    expect(sdkOptions(internalServer).settings).not.toHaveProperty("disableClaudeAiConnectors");
  });
});

describe("sdkOptions sub-session (task:) sessions", () => {
  const subsession = { staticPrompt: "task prompt", groupScope: false, maxTurns: 200 };
  const external = { gmail: { type: "http", url: "https://example.invalid/mcp" } } as never;

  it("loads no claude.ai connector and no external MCP server, even scoped to the owner's DM", () => {
    resetConfig();
    mockConfig.mcpServers = { gmail: { server: { type: "http", url: "https://example.invalid/mcp" } } } as never;
    mockConfig.mcpAllowedTools = ["mcp__gmail__send"] as never;
    // A plugin that carries its own .mcp.json.
    const pluginDir = mkdtempSync(join(tmpdir(), "tomo-plugin-"));
    mkdirSync(join(pluginDir, "skills"));
    writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { mail: { type: "http", url: "https://example.invalid/mcp" } } }));
    mockConfig.plugins = [{ ref: pluginDir, isPath: true }];
    try {
      for (const opts of [
        sdkOptions(internalServer, undefined, undefined, { sessionKey: "task:s1", subsession }),
        sdkOptions(internalServer, undefined, undefined, { sessionKey: "task:s1", subsession }, undefined, external),
        // A task key without its context still fails closed.
        sdkOptions(internalServer, undefined, undefined, { sessionKey: "task:s1" }, undefined, external),
      ]) {
        expect((opts.settings as { disableClaudeAiConnectors?: boolean }).disableClaudeAiConnectors).toBe(true);
        expect(Object.keys(opts.mcpServers)).toEqual(["tomo-internal"]);
        expect(opts.allowedTools).not.toContain("mcp__gmail__send");
        // The internal allowlist is unchanged.
        expect(opts.allowedTools).toContain("mcp__tomo-internal__task_finish");
        // Nothing the CLI discovers itself: no project/user MCP config, no plugin's MCP servers.
        expect((opts as { strictMcpConfig?: boolean }).strictMcpConfig).toBe(true);
        expect(opts.plugins).toEqual([{ type: "local", path: pluginDir, skipMcpDiscovery: true }]);
      }
      // The owner's DM keeps both.
      const dm = sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:shuai" }, undefined, external);
      expect(Object.keys(dm.mcpServers)).toContain("gmail");
      expect(dm.settings).not.toHaveProperty("disableClaudeAiConnectors");
      expect(dm).not.toHaveProperty("strictMcpConfig");
      expect(dm.plugins).toEqual([{ type: "local", path: pluginDir }]);
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
      mockConfig.plugins = [];
      mockConfig.mcpServers = undefined;
      mockConfig.mcpAllowedTools = undefined as never;
      resetConfig();
    }
  });
});

describe("sdkOptions todo-store guard", () => {
  type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
  it("denies a direct write to the store on every session, the owner's own DM included", async () => {
    resetConfig();
    const store = `${mockConfig.tomoHome}/data/todos/todos.json`;
    for (const ctx of [{ sessionKey: "dm:shuai" }, { sessionKey: "telegram:-100123" }, undefined]) {
      const opts = sdkOptions(internalServer, undefined, undefined, ctx) as { hooks?: { PreToolUse?: Array<{ hooks: Hook[] }> } };
      const hooks = (opts.hooks?.PreToolUse ?? []).flatMap((entry) => entry.hooks);
      const results = await Promise.all(hooks.map((hook) => hook({ tool_name: "Write", tool_input: { file_path: store, content: "{}" } })));
      expect(results.some((r) => r.hookSpecificOutput?.permissionDecisionReason?.includes("todo tools")), JSON.stringify(ctx)).toBe(true);
    }
  });
});

describe("sdkOptions auto memory", () => {
  it("turns the SDK's own auto memory off: Tomo's memory is the only one", () => {
    resetConfig({ model: "claude-sonnet-5" });
    const opts = sdkOptions(internalServer);
    expect((opts.settings as { autoMemoryEnabled?: boolean }).autoMemoryEnabled).toBe(false);
  });
});

// `effort` used to be shown on the web config page but never reached the SDK.
// These pin the option-level contract: the configured level is what the
// session is started with (Options.effort in sdk.d.ts).
describe("sdkOptions effort", () => {
  it("passes the configured effort to the SDK, and only the setting changes it", () => {
    resetConfig({ effort: "low", model: "claude-opus-5" });
    const low = sdkOptions(internalServer);
    resetConfig({ effort: "max", model: "claude-opus-5" });
    const max = sdkOptions(internalServer);
    expect(low.effort).toBe("low");
    expect(max.effort).toBe("max");
    expect(low.model).toBe(max.model);
  });

  it("does not send the option at all when effort is unset", () => {
    resetConfig({ effort: null, model: "claude-opus-5" });
    expect("effort" in sdkOptions(internalServer)).toBe(false);
  });

  it("prefers the session's override over the global level", () => {
    resetConfig({ effort: "high", sessionEffortOverrides: { "dm:owner": "low" }, model: "claude-opus-5" });
    expect(sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:owner" }).effort).toBe("low");
    expect(sdkOptions(internalServer, undefined, undefined, { sessionKey: "dm:other" }).effort).toBe("high");
  });

  it("applies to a per-session model override too", () => {
    resetConfig({ effort: "medium", model: "claude-sonnet-5" });
    expect(sdkOptions(internalServer, undefined, "claude-opus-5").effort).toBe("medium");
  });

  it("is not sent to a non-Claude LiteLLM provider model", () => {
    resetConfig({ effort: "high", model: "chatgpt/gpt-5.5" });
    expect("effort" in sdkOptions(internalServer)).toBe(false);
  });
});

// maxTurns 0 means "no limit". The SDK only passes --max-turns to the CLI when
// the option is truthy, so leaving the key out is what makes it unlimited; and
// the 75%/90% wrap-up reminders count toward a wall that no longer exists.
describe("maxTurns: 0 means no limit", () => {
  it("passes the limit through when one is set", () => {
    resetConfig({ maxTurns: 50 });
    expect(sdkOptions(internalServer).maxTurns).toBe(50);
  });

  it("leaves maxTurns out of the SDK options entirely when it is 0", () => {
    resetConfig({ maxTurns: 0 });
    const opts = sdkOptions(internalServer);
    expect(opts).not.toHaveProperty("maxTurns");
  });

  it("installs no turn-budget reminder when there is no limit", () => {
    const limited = buildHooksOption({ maxTurns: 50, turnBudget: makeTurnBudget() }) as { hooks: Record<string, unknown[]> };
    const unlimited = buildHooksOption({ maxTurns: 0, turnBudget: makeTurnBudget() }) as { hooks?: Record<string, unknown[]> };
    expect(limited.hooks.PostToolBatch).toHaveLength(1);
    // With nothing else asked for, no hook is registered at all.
    expect(unlimited.hooks?.PostToolBatch ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// showThinking has a MODEL-side half.
//
// On Sonnet/Opus 4.6+ we request adaptive thinking, and `display: "omitted"`
// is what hides reasoning: the SDK then emits no `thinking` content blocks at
// all. LiveSession can only render blocks it is given, so with "omitted"
// pinned on, `showThinking: true` is a no-op on a real model however the
// downstream rendering behaves. These assertions live at the option level for
// exactly that reason — a downstream test that fabricates a thinking block
// cannot see this.
// ---------------------------------------------------------------------------

describe("sdkOptions thinking display", () => {
  // Same model, same everything else: the flag alone flips the display.
  it.each(["claude-sonnet-5", "claude-opus-4-6"])("omits thinking blocks with showThinking off, asks for them with it on (%s)", (model) => {
    resetConfig({ showThinking: false, model });
    const off = sdkOptions(internalServer);
    resetConfig({ showThinking: true, model });
    const on = sdkOptions(internalServer);

    expect(off.thinking).toEqual({ type: "adaptive", display: "omitted" });
    // "summarized" is the only ThinkingAdaptive.display value that yields
    // thinking content blocks (sdk.d.ts: `display?: 'summarized' | 'omitted'`).
    expect(on.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(off.model).toBe(on.model);
  });

  it("leaves models without adaptive thinking alone under either flag", () => {
    resetConfig({ showThinking: true, model: "claude-sonnet-4-5" });
    expect(sdkOptions(internalServer).thinking).toBeUndefined();

    resetConfig({ showThinking: false, model: "claude-sonnet-4-5" });
    expect(sdkOptions(internalServer).thinking).toBeUndefined();
  });

  it("sends no thinking option to a LiteLLM provider model", () => {
    resetConfig({ showThinking: true, model: "chatgpt/gpt-5.5" });
    expect(sdkOptions(internalServer).thinking).toBeUndefined();
  });
});
