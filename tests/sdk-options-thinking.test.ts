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
  it("omits thinking blocks when showThinking is off", () => {
    resetConfig({ showThinking: false, model: "claude-sonnet-5" });

    const opts = sdkOptions(internalServer);

    expect(opts.thinking).toEqual({ type: "adaptive", display: "omitted" });
  });

  it("asks the model for thinking blocks when showThinking is on", () => {
    resetConfig({ showThinking: true, model: "claude-sonnet-5" });

    const opts = sdkOptions(internalServer);

    // "summarized" is the only ThinkingAdaptive.display value that yields
    // thinking content blocks (sdk.d.ts: `display?: 'summarized' | 'omitted'`).
    expect(opts.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("differs by the flag alone — same model, same everything else", () => {
    resetConfig({ showThinking: false, model: "claude-opus-4-6" });
    const off = sdkOptions(internalServer);
    resetConfig({ showThinking: true, model: "claude-opus-4-6" });
    const on = sdkOptions(internalServer);

    expect(off.thinking).not.toEqual(on.thinking);
    expect(off.model).toBe(on.model);
  });

  it("leaves models without adaptive thinking alone under either flag", () => {
    resetConfig({ showThinking: true, model: "claude-sonnet-4-5" });
    expect(sdkOptions(internalServer).thinking).toBeUndefined();

    resetConfig({ showThinking: false, model: "claude-sonnet-4-5" });
    expect(sdkOptions(internalServer).thinking).toBeUndefined();
  });
});
