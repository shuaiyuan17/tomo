import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

// A real tree on disk: a home with ~/.tomo/{data,workspace}, a real usage
// ledger file and a real private note, and symlinks pointing into both.
const tree = vi.hoisted(() => {
  const { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tomo-search-roots-")));
  const tomoHome = join(home, ".tomo");
  const ws = join(tomoHome, "workspace");
  const data = join(tomoHome, "data");
  mkdirSync(join(data, "usage"), { recursive: true });
  mkdirSync(join(data, "sessions"), { recursive: true });
  writeFileSync(join(data, "usage", "2026-11.ndjson"), '{"trigger":"DM SNIPPET"}\n');
  mkdirSync(join(ws, "memory", "private"), { recursive: true });
  writeFileSync(join(ws, "memory", "private", "note.txt"), "SECRET\n");
  writeFileSync(join(ws, "memory", "MEMORY.md"), "public\n");
  mkdirSync(join(ws, "notes"), { recursive: true });
  writeFileSync(join(ws, "notes", "todo.txt"), "buy milk\n");
  symlinkSync(tomoHome, join(ws, "notes", "up"));          // a link to an ANCESTOR of both
  symlinkSync(join(data, "usage"), join(ws, "ledger"));     // a link INTO data/
  symlinkSync(join(ws, "memory", "private"), join(ws, "p")); // a link INTO private/
  process.env.HOME = home;
  return { home, tomoHome, ws, data };
});

vi.mock("../src/config.js", () => ({
  config: { workspaceDir: tree.ws, tomoHome: tree.tomoHome, sessionsDir: `${tree.data}/sessions` },
}));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: `${tree.ws}/memory`,
  PRIVATE_MEMORY_DIR: `${tree.ws}/memory/private`,
  HOME_SCENE_DIR: `${tree.ws}/home`,
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { privateMemoryGuardHooks, barredSearchDenialReason } = await import("../src/agent/private-memory-guard.js");

afterAll(() => rmSync(tree.home, { recursive: true, force: true }));

type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
const hook = (bar: "group-session" | "summoned-turn" | null) =>
  (privateMemoryGuardHooks("telegram:-100", () => bar) as unknown as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse[0].hooks[0];

describe("a barred turn may not search at, inside or above a barred directory", () => {
  const refused: Array<[string, string, Record<string, unknown>]> = [
    // Relative globs from an ancestor: the probe arm never modelled these.
    ["relative glob into the ledger from ~/.tomo", "Grep", { pattern: "trigger", path: "~/.tomo", glob: "data/usage/*.ndjson" }],
    ["relative glob into the ledger, Glob", "Glob", { path: "~/.tomo", pattern: "data/usage/*.ndjson" }],
    ["relative glob into private/ with a suffix the probes never had", "Grep", { pattern: "SECRET", path: tree.ws, glob: "memory/private/*.txt" }],
    ["relative glob into private/ from memory/", "Glob", { path: "memory", pattern: "private/*.txt" }],
    // `**` from far above.
    ["** from the home directory", "Glob", { path: "~", pattern: "**/*.ndjson" }],
    ["** from ~/.tomo, Grep", "Grep", { pattern: "SNIPPET", path: tree.tomoHome, glob: "**" }],
    // Symlinks: as spelled the root is an innocent workspace folder.
    ["a symlink to an ancestor", "Grep", { pattern: "SNIPPET", path: "notes/up", glob: "data/**" }],
    ["a symlink to an ancestor, with a suffix-specific relative glob", "Glob", { path: "notes/up", pattern: "data/usage/*.ndjson" }],
    ["a symlink into data/", "Glob", { path: "ledger", pattern: "*" }],
    ["a symlink into private/", "Grep", { pattern: "SECRET", path: "p" }],
    // At and inside.
    ["data/ itself", "Grep", { pattern: "x", path: "~/.tomo/data" }],
    ["inside data/", "Glob", { path: `${tree.data}/usage`, pattern: "*.ndjson" }],
  ];

  for (const bar of ["group-session", "summoned-turn"] as const) {
    for (const [what, tool, input] of refused) {
      it(`${bar}: refuses ${what}`, async () => {
        const result = await hook(bar)({ tool_name: tool, tool_input: input });
        expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
        expect(result.hookSpecificOutput?.permissionDecisionReason).toBeTruthy();
      });
    }
  }

  it("names the way round: point path at a specific subdirectory", async () => {
    const result = await hook("group-session")({ tool_name: "Grep", tool_input: { pattern: "x", path: "~/.tomo", glob: "data/usage/*.ndjson" } });
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBe(barredSearchDenialReason("group-session"));
  });

  it("still lets a barred turn search a workspace subfolder, and the owner search anything", async () => {
    for (const input of [
      { tool_name: "Grep", tool_input: { pattern: "milk", path: "notes", glob: "*.txt" } },
      { tool_name: "Glob", tool_input: { path: "notes", pattern: "*.txt" } },
      { tool_name: "Grep", tool_input: { pattern: "milk", path: `${tree.ws}/notes` } },
    ]) expect(await hook("group-session")(input), JSON.stringify(input)).toEqual({});
    for (const [, tool, input] of refused) expect(await hook(null)({ tool_name: tool, tool_input: input })).toEqual({});
  });
});
