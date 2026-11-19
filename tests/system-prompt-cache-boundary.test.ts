import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// The workspace prompt has a DM and a group variant (private MEMORY/PEOPLE
// lines stripped, no home note). Stand-ins make it obvious which one landed
// where without depending on the developer's real workspace.
vi.mock("../src/workspace/index.js", async () => ({
  ...(await import("./helpers/agent-mocks.js")).workspaceModuleMock(),
  buildSystemPrompt: (opts: { isGroup?: boolean } = {}) =>
    opts.isGroup ? "STATIC WORKSPACE PROMPT (group variant)" : "STATIC WORKSPACE PROMPT (dm variant)",
}));

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { installAgentTestHooks, resetConfig } from "./helpers/agent-harness.js";
import { sdkOptions, type SessionContext } from "../src/agent/sdk-options.js";
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  flattenSystemPrompt,
  staticPromptBlocks,
} from "../src/workspace/system-prompt-blocks.js";

installAgentTestHooks();

const internalServer = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;

function promptFor(ctx: SessionContext | undefined, model?: string): string[] {
  const { systemPrompt } = sdkOptions(internalServer, undefined, model, ctx);
  // Reverting to a single concatenated string would silently disable the
  // cross-session cache; the SDK only splits on the marker in an array.
  expect(Array.isArray(systemPrompt)).toBe(true);
  return systemPrompt as string[];
}

function dynamicBlocks(blocks: string[]): string[] {
  return blocks.slice(blocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) + 1);
}

const groupA: SessionContext = {
  sessionKey: "telegram:-100111",
  sdkSessionId: "sdk-aaa",
  group: { chatTitle: "Alpha", participants: ["Ann", "Bo"], isPassive: true },
};
const groupB: SessionContext = {
  sessionKey: "imessage:any;+;chat222",
  sdkSessionId: "sdk-bbb",
  group: { chatTitle: "Beta", participants: ["Cy"], isPassive: false },
};

describe("system prompt cache boundary", () => {
  it("uses the SDK's own marker string", async () => {
    const real = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>("@anthropic-ai/claude-agent-sdk");
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe(real.SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it("puts the workspace prompt alone before the marker and session context after it", () => {
    resetConfig();
    const blocks = promptFor({ sessionKey: "dm:owner", sdkSessionId: "sdk-123" });

    expect(blocks.filter((b) => b === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toHaveLength(1);
    expect(blocks[0]).toBe("STATIC WORKSPACE PROMPT (dm variant)");
    expect(blocks[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    const dynamic = dynamicBlocks(blocks).join("\n\n");
    expect(dynamic).toContain("# SESSION");
    expect(dynamic).toContain("- Session key: dm:owner");
    expect(dynamic).toContain("- SDK session ID: sdk-123");
    expect(dynamic).toContain("# RUNTIME");
  });

  it("gives two different sessions a byte-identical static prefix", () => {
    resetConfig();
    const a = promptFor(groupA);
    const b = promptFor(groupB);

    expect(staticPromptBlocks(a)).toEqual(staticPromptBlocks(b));
    expect(staticPromptBlocks(a)).toEqual(["STATIC WORKSPACE PROMPT (group variant)"]);
    // ...while everything that differs between them stays after the marker.
    expect(dynamicBlocks(a)).not.toEqual(dynamicBlocks(b));
  });

  it("keeps the model out of the static prefix", () => {
    resetConfig();
    const sonnet = promptFor({ sessionKey: "dm:owner" }, "sonnet");
    const opus = promptFor({ sessionKey: "dm:owner" }, "opus");
    expect(staticPromptBlocks(sonnet)).toEqual(staticPromptBlocks(opus));
    expect(dynamicBlocks(sonnet).join("\n")).toContain("Current model:");
  });

  // The revert catcher: any per-session value before the marker means every
  // session pays to write the whole prefix again. Checked against the exact
  // values each context carries, so moving SESSION/RUNTIME (or any part of
  // them) back in front of the marker fails here.
  it("never lets a per-session value reach the static prefix", () => {
    resetConfig();
    for (const ctx of [groupA, groupB, { sessionKey: "dm:owner", sdkSessionId: "sdk-dm" }]) {
      const staticText = staticPromptBlocks(promptFor(ctx, "sonnet")).join("\n\n");
      const perSession = [
        ctx.sessionKey,
        ctx.sdkSessionId!,
        "# SESSION",
        "# RUNTIME",
        "Current model",
        "Listen mode",
        ...(ctx.group ? [ctx.group.chatTitle!, ...ctx.group.participants!] : []),
      ];
      for (const value of perSession) expect(staticText).not.toContain(value);
    }
  });

  it("flattens to exactly the prompt text tomo sent before the split", () => {
    resetConfig();
    const blocks = promptFor(groupA, "sonnet");
    const flat = flattenSystemPrompt(blocks);
    // The pre-boundary assembly: static + "\n\n# SESSION…" + "\n\n# RUNTIME…".
    // The CLI joins non-marker blocks with a blank line when it does not use
    // scoped caching, so the model must see the same bytes as before.
    expect(flat.startsWith("STATIC WORKSPACE PROMPT (group variant)\n\n# SESSION\n- Session key: telegram:-100111\n")).toBe(true);
    expect(flat).toContain('\n## Group Chat Context\n- Group title: "Alpha"\n- Known participants: Ann, Bo\n');
    expect(flat).toMatch(/\n\n# RUNTIME\n- Current model: [^\n]+\n- Treat this model value as authoritative\.$/);
    expect(flat).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it("still marks the boundary when there is no session context", () => {
    resetConfig();
    const blocks = promptFor(undefined);
    expect(blocks[0]).toBe("STATIC WORKSPACE PROMPT (dm variant)");
    expect(blocks[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(dynamicBlocks(blocks).join("\n")).toContain("# RUNTIME");
    expect(dynamicBlocks(blocks).join("\n")).not.toContain("# SESSION");
  });
});

describe("flattenSystemPrompt (prompt-change hash input)", () => {
  it("ignores the marker, so adding it never reads as a prompt change", () => {
    expect(flattenSystemPrompt(["v1", SYSTEM_PROMPT_DYNAMIC_BOUNDARY])).toBe(flattenSystemPrompt("v1"));
    expect(flattenSystemPrompt([SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "v1"])).toBe("v1");
    expect(flattenSystemPrompt(["a", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "b"])).toBe("a\n\nb");
  });
});
