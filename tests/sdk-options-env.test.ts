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

  it("leaves the env untouched when there is no session context", () => {
    resetConfig();
    const opts = sdkOptions(internalServer);
    expect(opts.env).toBeUndefined();
  });
});
