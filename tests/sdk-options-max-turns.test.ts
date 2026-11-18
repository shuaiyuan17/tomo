import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { installAgentTestHooks, resetConfig } from "./helpers/agent-harness.js";
import { buildHooksOption, makeTurnBudget, sdkOptions } from "../src/agent/sdk-options.js";

installAgentTestHooks();

const internalServer = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;

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
