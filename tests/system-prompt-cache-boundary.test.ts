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
import { groupMemoryDir } from "../src/workspace/memory-index.js";
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

const dmA: SessionContext = { sessionKey: "dm:owner", sdkSessionId: "sdk-dm-1" };
const dmB: SessionContext = { sessionKey: "dm:other", sdkSessionId: "sdk-dm-2" };

/** The model string as rendered, so the legacy reference uses the same one. */
function runtimeModelDisplay(blocks: string[]): string {
  const m = flattenSystemPrompt(blocks).match(/- Current model: ([^\n]+)/);
  expect(m).not.toBeNull();
  return m![1];
}

/** sdkOptions' system-prompt assembly as it was before the boundary, verbatim. */
function legacySystemPrompt(base: string, sessionContext: SessionContext | undefined, modelDisplay: string): string {
  let systemPrompt = base;
  if (sessionContext) {
    const lines = [
      "\n\n# SESSION",
      `- Session key: ${sessionContext.sessionKey}`,
    ];
    if (sessionContext.sdkSessionId) {
      lines.push(`- SDK session ID: ${sessionContext.sdkSessionId}`);
    }
    if (sessionContext.group) {
      const g = sessionContext.group;
      lines.push("");
      lines.push("## Group Chat Context");
      if (g.chatTitle) lines.push(`- Group title: "${g.chatTitle}"`);
      if (g.participants && g.participants.length > 0) {
        lines.push(`- Known participants: ${g.participants.join(", ")}`);
      }
      lines.push("- Incoming messages identify the sender. A canonical PEOPLE name in parentheses refers to the same person.");
      // Added since (memory 2b-2): the group's own memory folder.
      lines.push(`- Memory folder: ${groupMemoryDir(sessionContext.sessionKey)}/ — the only place in memory this chat can save to; memory_list with it shows what is there.`);
      if (g.isPassive) {
        lines.push("- **Listen mode: passive.** You see every message. Reply only when directly addressed or genuinely useful; otherwise reply `NO_REPLY`.");
      } else {
        lines.push("- **Listen mode: mention-required.** Every message you receive explicitly tagged you; respond as in a DM.");
      }
    }
    systemPrompt += lines.join("\n");
  }
  systemPrompt += `\n\n# RUNTIME\n- Current model: ${modelDisplay}\n- Treat this model value as authoritative.`;
  return systemPrompt;
}

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

  it("gives two DM sessions, and two group sessions, a byte-identical static prefix", () => {
    resetConfig();
    const pairs: Array<[SessionContext, SessionContext, string]> = [
      [dmA, dmB, "STATIC WORKSPACE PROMPT (dm variant)"],
      [groupA, groupB, "STATIC WORKSPACE PROMPT (group variant)"],
    ];
    for (const [x, y, expected] of pairs) {
      const a = promptFor(x);
      const b = promptFor(y);
      expect(staticPromptBlocks(a)).toEqual(staticPromptBlocks(b));
      expect(staticPromptBlocks(a)).toEqual([expected]);
      // ...while everything that differs between them stays after the marker.
      expect(dynamicBlocks(a)).not.toEqual(dynamicBlocks(b));
    }
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
    for (const ctx of [groupA, groupB, dmA, dmB]) {
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

  // Byte-for-byte against the pre-boundary assembly (legacySystemPrompt
  // below, copied verbatim from sdk-options.ts before this change). The CLI
  // joins non-marker blocks with a blank line when it does not use scoped
  // caching, so the model must read exactly what it read before.
  it.each([
    ["DM session", dmA],
    ["group session, passive", groupA],
    ["group session, mention-required", groupB],
    ["no session context", undefined],
  ] as Array<[string, SessionContext | undefined]>)("flattens to exactly the pre-change prompt: %s", (_name, ctx) => {
    resetConfig();
    const blocks = promptFor(ctx, "sonnet");
    const isGroup = ctx?.group !== undefined;
    const legacy = legacySystemPrompt(
      isGroup ? "STATIC WORKSPACE PROMPT (group variant)" : "STATIC WORKSPACE PROMPT (dm variant)",
      ctx,
      runtimeModelDisplay(blocks),
    );
    expect(flattenSystemPrompt(blocks)).toBe(legacy);
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
