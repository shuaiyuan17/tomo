import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const tree = vi.hoisted(() => {
  const { mkdirSync, mkdtempSync, realpathSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tomo-memory-guard-")));
  const ws = join(home, ".tomo", "workspace");
  mkdirSync(join(ws, "memory", "private", "journal"), { recursive: true });
  mkdirSync(join(ws, "memory", "incoming-files"), { recursive: true });
  mkdirSync(join(ws, "memory", "notes"), { recursive: true });
  mkdirSync(join(ws, "memory", "project.v2"), { recursive: true });
  process.getBuiltinModule("node:fs").writeFileSync(join(home, "LICENSE"), "MIT");
  process.env.HOME = home;
  return { home, ws, mem: join(ws, "memory") };
});
afterAll(() => rmSync(tree.home, { recursive: true, force: true }));

const logged = vi.hoisted(() => ({ warn: [] as Array<[unknown, string]> }));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn((o: unknown, m: string) => { logged.warn.push([o, m]); }) },
}));
vi.mock("../src/config.js", () => ({ config: { workspaceDir: tree.ws, tomoHome: join(tree.home, ".tomo"), sessionsDir: join(tree.home, ".tomo", "data", "sessions") } }));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: `${tree.ws}/memory`,
  PRIVATE_MEMORY_DIR: `${tree.ws}/memory/private`,
  HOME_SCENE_DIR: `${tree.ws}/home`,
  PRIVATE_MEMORY_SUBDIR: "private",
}));

const { memoryStoreWriteTarget, memoryGuardTarget, memoryStoreGuardHooks, MEMORY_STORE_WRITE_DENIAL } = await import("../src/agent/memory-store-guard.js");
const { buildHooksOption } = await import("../src/agent/sdk-options.js");
const { SUBSESSION_MEMORY_WRITE_DENIAL } = await import("../src/agent/subsessions/memory-guard.js");

const ctx = { cwd: tree.ws, memoryDir: tree.mem };
const hits = (tool: string, input: Record<string, unknown>) => memoryStoreWriteTarget(tool, input, ctx) !== null;
const bash = (command: string) => hits("Bash", { command });

describe("memory-store guard: file tools", () => {
  it.each([
    ["Write", { file_path: `${tree.mem}/travel.md` }],
    ["Write", { file_path: "memory/travel.md" }],
    ["Edit", { file_path: "~/.tomo/workspace/memory/MEMORY.md" }],
    ["MultiEdit", { file_path: `${tree.mem}/private/journal/2026-11-27.md` }],
    ["Edit", { file_path: `${tree.mem}/Notes/X.MD` }],
    ["Write", { file_path: `${tree.mem}/people/kevin.md` }],
    ["Write", { file_path: "memory/../memory/x.md" }],
    ["Write", { file_path: `${tree.mem}/incoming-summary.md` }],
  ])("%s %j is refused", (tool, input) => {
    expect(hits(tool, input)).toBe(true);
  });

  it.each([
    ["Read", { file_path: `${tree.mem}/travel.md` }],
    ["Grep", { pattern: "x", path: tree.mem }],
    ["Glob", { pattern: "**/*.md", path: tree.mem }],
    ["Write", { file_path: `${tree.mem}/incoming-files/report.md` }],
    ["Write", { file_path: `${tree.mem}/notes/data.json` }],
    ["Write", { file_path: `${tree.ws}/SOUL.md` }],
    ["Write", { file_path: `${tree.ws}/projects/memory.md` }],
  ])("%s %j passes", (tool, input) => {
    expect(hits(tool, input)).toBe(false);
  });

  it("follows a symlink into memory/", () => {
    const link = join(tree.ws, "notes-link");
    symlinkSync(tree.mem, link);
    expect(hits("Write", { file_path: `${link}/x.md` })).toBe(true);
  });
});

describe("memory-store guard: Bash", () => {
  it.each([
    "cat >> memory/private/journal/2026-11-27.md <<'EOF'\n### 10:00\nquiet day\nEOF",
    "echo '- fact' >> ~/.tomo/workspace/memory/MEMORY.md",
    `printf x > ${tree.mem}/a.md`,
    "echo x | tee -a memory/a.md",
    "sed -i '' 's/a/b/' memory/a.md",
    "cp /tmp/draft.md memory/notes/",
    "cp /tmp/draft.md memory/notes/new.md",
    "mv memory/a.md memory/archive/a.md",
    "rm memory/a.md",
    "rm -rf memory/notes",
    "rm -rf memory",
    "rm -rf ~/.tomo/workspace",
    "touch memory/new.md",
    "cd memory && echo x > a.md",
    "cd ~/.tomo/workspace/memory/private && cat >> journal/d.md <<EOF\nx\nEOF",
    'printf x > "memory/trip notes.md"',
    "rm 'memory/trip notes.md'",
    "cp -R /tmp/notes memory/",
    "mv /tmp/notes memory/notes",
    "rm -rf memory/project.v2",
    "echo x > memory/incoming-summary.md",
    'cp "/tmp/draft.md" memory/note.md',
    "rm memory/incoming-summary.md",
    "mv memory/incoming-summary.md /tmp/",
    "rm memory/trip\\ notes.md",
    "printf x > memory/trip\\ notes.md",
    "rm 2>&1 memory/note.md",
  ])("refuses %j", (command) => {
    expect(bash(command)).toBe(true);
  });

  it.each([
    "cat memory/MEMORY.md",
    "grep -rn 'aisle' memory/",
    "ls memory/private/journal",
    "mv memory/incoming-files/a.pdf memory/incoming-files/old/",
    "rm memory/incoming-files/report.md",
    "cp memory/a.md /tmp/a.md",
    "echo 'memory/a.md' > /tmp/out.txt",
    "git commit -m 'echo > memory/a.md'",
    "cp /tmp/photo.png memory/notes/",
    'cp "memory/note.md" /tmp/note.md',
    "cp /tmp/report.md memory/incoming-files/",
    "mv /tmp/report.md memory/incoming-files/",
    `cp ${tree.home}/LICENSE memory/`,
  ])("lets %j through", (command) => {
    expect(bash(command)).toBe(false);
  });
});

describe("memory-store guard: the hook and its modes", () => {
  beforeEach(() => { logged.warn.length = 0; });
  const run = async (mode: "enforce" | "warn" | "off", input: { tool_name: string; tool_input: unknown; agent_id?: string; agent_type?: string }) => {
    const hook = memoryStoreGuardHooks("dm:alex", tree.ws, () => tree.ws, () => mode).PreToolUse[0];
    expect(hook.onFailure).toBe("block");
    return hook.hooks[0](input);
  };
  const write = { tool_name: "Write", tool_input: { file_path: `${tree.mem}/x.md` } };

  it("enforce denies with the reason naming the memory tools", async () => {
    const out = await run("enforce", write) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(MEMORY_STORE_WRITE_DENIAL);
    expect(MEMORY_STORE_WRITE_DENIAL).toContain("hand what should be saved back to the main conversation");
  });

  it("enforce denies a subagent's write too, and logs which subagent", async () => {
    const out = await run("enforce", { ...write, agent_id: "a1", agent_type: "memory-auditor" }) as { hookSpecificOutput?: { permissionDecision: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(logged.warn[0][0]).toMatchObject({ key: "dm:alex", tool: "Write", agentType: "memory-auditor", agentId: "a1" });
  });

  it("warn allows and logs the session, tool and path", async () => {
    expect(await run("warn", write)).toEqual({});
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0][0]).toMatchObject({ key: "dm:alex", tool: "Write", path: `${tree.mem}/x.md` });
    expect(logged.warn[0][1]).toContain("warn");
  });

  it("off neither denies nor logs", async () => {
    expect(await run("off", write)).toEqual({});
    expect(logged.warn).toHaveLength(0);
  });

  it("lets a read through in every mode, silently", async () => {
    for (const mode of ["enforce", "warn"] as const) {
      expect(await run(mode, { tool_name: "Read", tool_input: { file_path: `${tree.mem}/x.md` } })).toEqual({});
    }
    expect(logged.warn).toHaveLength(0);
  });

  it("a judgement that throws denies only a call naming a memory .md", () => {
    const boom = () => { throw new Error("boom"); };
    expect(memoryGuardTarget("Bash", { command: "echo > memory/a.md" }, ctx, boom)).not.toBeNull();
    expect(memoryGuardTarget("Bash", { command: "ls /tmp" }, ctx, boom)).toBeNull();
  });
});

describe("memory-store guard: installed on every session but a sub-session", () => {
  type Decision = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<Decision>;
  const reasons = async (args: Parameters<typeof buildHooksOption>[0], input: { tool_name: string; tool_input: unknown }) => {
    const built = buildHooksOption(args) as { hooks?: { PreToolUse: Array<{ hooks: Hook[] }> } };
    const decisions = await Promise.all((built.hooks?.PreToolUse ?? []).flatMap((m) => m.hooks).map((h) => h(input)));
    return decisions.filter((d) => d.hookSpecificOutput?.permissionDecision === "deny").map((d) => d.hookSpecificOutput?.permissionDecisionReason);
  };
  const write = { tool_name: "Write", tool_input: { file_path: `${tree.mem}/x.md` } };

  it("denies a direct write on the owner's DM and on a group session", async () => {
    for (const sessionKey of ["dm:alex", "telegram:-100123"]) {
      expect(await reasons({ maxTurns: 10, sessionKey, memoryStoreGuard: () => "enforce" }, write)).toContain(MEMORY_STORE_WRITE_DENIAL);
    }
  });

  it("follows the mode per call", async () => {
    let mode: "enforce" | "warn" | "off" = "warn";
    const args = { maxTurns: 10, sessionKey: "dm:alex", memoryStoreGuard: () => mode };
    expect(await reasons(args, write)).toEqual([]);
    mode = "enforce";
    expect(await reasons(args, write)).toEqual([MEMORY_STORE_WRITE_DENIAL]);
  });

  it("leaves a sub-session to its own guard, which keeps it out of all of memory/", async () => {
    const denied = await reasons({ maxTurns: 10, sessionKey: "task:s1", memoryStoreGuard: () => "enforce", subsessionMemoryGuard: true }, write);
    expect(denied).toEqual([SUBSESSION_MEMORY_WRITE_DENIAL]);
  });
});
