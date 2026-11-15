import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { installAgentTestHooks, mockConfig, resetConfig } from "./helpers/agent-harness.js";
import { sdkOptions } from "../src/agent/sdk-options.js";
import { TOMO_SESSION_KEY_ENV } from "../src/restart-reason.js";

installAgentTestHooks();

const internalServer = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;

describe("sdkOptions session env", () => {
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
