import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { installAgentTestHooks, resetConfig } from "./helpers/agent-harness.js";
import { sdkOptions } from "../src/agent/sdk-options.js";

installAgentTestHooks();

const internalServer = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;

describe("sdkOptions auto memory", () => {
  it("turns the SDK's own auto memory off: Tomo's memory is the only one", () => {
    resetConfig({ model: "claude-sonnet-5" });
    const opts = sdkOptions(internalServer);
    expect((opts.settings as { autoMemoryEnabled?: boolean }).autoMemoryEnabled).toBe(false);
  });
});
