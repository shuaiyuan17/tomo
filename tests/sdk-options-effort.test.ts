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

// `effort` used to be shown on the web config page but never reached the SDK.
// These pin the option-level contract: the configured level is what the
// session is started with (Options.effort in sdk.d.ts).
describe("sdkOptions effort", () => {
  it("passes the configured effort to the SDK", () => {
    resetConfig({ effort: "low", model: "claude-opus-5" });
    expect(sdkOptions(internalServer).effort).toBe("low");
  });

  it("does not send the option at all when effort is unset", () => {
    resetConfig({ effort: null, model: "claude-opus-5" });
    expect("effort" in sdkOptions(internalServer)).toBe(false);
  });

  it("changes with the setting alone — same model, same everything else", () => {
    resetConfig({ effort: "low", model: "claude-opus-5" });
    const low = sdkOptions(internalServer);
    resetConfig({ effort: "max", model: "claude-opus-5" });
    const max = sdkOptions(internalServer);
    expect(low.effort).toBe("low");
    expect(max.effort).toBe("max");
    expect(low.model).toBe(max.model);
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
