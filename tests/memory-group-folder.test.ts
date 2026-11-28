import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A group's turns save only in their own folder, groups/<dir>/, and never
// read another group's: through the memory tools and through the file tools.
const tree = vi.hoisted(() => {
  const { mkdtempSync, realpathSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-group-folder-")));
  return { root, ws: join(root, "workspace"), mem: join(root, "workspace", "memory"), data: join(root, "data") };
});

vi.mock("../src/config.js", () => ({
  config: { workspaceDir: tree.ws, tomoHome: tree.root, sessionsDir: `${tree.data}/sessions` },
}));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: tree.mem,
  PRIVATE_MEMORY_DIR: `${tree.mem}/private`,
  HOME_SCENE_DIR: `${tree.ws}/home`,
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { MemoryStore, MIXED_WRITE_REFUSAL, OTHER_GROUP_REFUSAL, groupWriteRefusal } = await import("../src/memory/store.js");
const { buildMemoryTools } = await import("../src/mcp/memory-tools.js");
const { groupMemoryDir, isOtherGroupMemoryPath, collectMemoryFiles } = await import("../src/workspace/memory-index.js");
const { privateMemoryGuardHooks, OTHER_GROUP_MEMORY_DENIAL } = await import("../src/agent/private-memory-guard.js");

afterAll(() => rmSync(tree.root, { recursive: true, force: true }));

const OWN_KEY = "telegram:-100111";
const OTHER_KEY = "telegram:-100222";
const OWN = groupMemoryDir(OWN_KEY);
const OTHER = groupMemoryDir(OTHER_KEY);
const GROUP = { privateBarred: true, canWrite: true, canWriteCore: false, groupDir: OWN };
const MIXED = { privateBarred: true, canWrite: true, canWriteCore: false };
const OWNER = { privateBarred: false, canWrite: true, canWriteCore: true };

const topic = (desc: string, body = "- a fact\n") => `---\ndescription: ${desc}\n---\n${body}`;
const put = (rel: string, text: string) => {
  mkdirSync(join(tree.mem, rel, ".."), { recursive: true });
  writeFileSync(join(tree.mem, rel), text);
};

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };
function tools(access: Record<string, unknown>, readOnly = false) {
  const store = new MemoryStore({ memoryDir: tree.mem, historyDir: join(tree.data, "memory-history") });
  const list = buildMemoryTools({ store: () => store, access: () => access as never, readOnly }) as unknown as ToolHandle[];
  return async (name: string, args: Record<string, unknown>) => {
    const r = await list.find((t) => t.name === name)!.handler(args, {});
    return { text: r.content[0].text, error: r.isError === true };
  };
}

beforeEach(() => {
  rmSync(tree.mem, { recursive: true, force: true });
  put("MEMORY.md", "# M\n- shared line\n");
  put("shared.md", topic("Shared.", "- needle shared\n"));
  put(`${OWN}/plans.md`, topic("Our plans.", "- needle own\n"));
  put(`${OTHER}/secrets.md`, topic("Their plans.", "- needle other\n"));
});

describe("the group folder name", () => {
  it("is groups/ plus the session key's transcript stem", () => {
    expect(groupMemoryDir("telegram:-100123")).toBe("groups/telegram_-100123");
    // Keys that differ only in case get different folders (hash suffix).
    expect(groupMemoryDir("imessage:AbC")).not.toBe(groupMemoryDir("imessage:abc"));
  });

  it("tells another group's folder from the turn's own, case-folded", () => {
    expect(isOtherGroupMemoryPath(`${OTHER}/x.md`, OWN)).toBe(true);
    expect(isOtherGroupMemoryPath(`${OWN.toUpperCase()}/x.md`, OWN)).toBe(false);
    expect(isOtherGroupMemoryPath("groups/stray.md", OWN)).toBe(true);
    expect(isOtherGroupMemoryPath("groups", OWN, true)).toBe(false);
    expect(isOtherGroupMemoryPath(`${OWN}/x.md`, undefined)).toBe(true);
    expect(isOtherGroupMemoryPath("shared.md", OWN)).toBe(false);
  });
});

describe("memory tools on a group's turn", () => {
  it("write in the group's own folder", async () => {
    const call = tools(GROUP);
    const r = await call("memory_write", { path: `${OWN}/trip.md`, content: topic("Trip."), if_version: "new" });
    expect(r.error).toBe(false);
    expect((await call("memory_append", { path: `${OWN}/plans.md`, content: "- more" })).error).toBe(false);
    expect((await call("memory_move", { from: `${OWN}/trip.md`, to: `${OWN}/old/trip.md` })).error).toBe(false);
  });

  it("write nowhere else: shared topic files, MEMORY.md, another group's folder, groups/ itself", async () => {
    const call = tools(GROUP);
    const shared = await call("memory_write", { path: "note.md", content: topic("N."), if_version: "new" });
    expect(shared.error).toBe(true);
    expect(shared.text).toContain(groupWriteRefusal(OWN));
    expect((await call("memory_str_replace", { path: "shared.md", old: "needle shared", new: "x" })).error).toBe(true);
    expect((await call("memory_append", { path: "MEMORY.md", content: "- x" })).error).toBe(true);
    expect((await call("memory_write", { path: "groups/stray.md", content: topic("S."), if_version: "new" })).error).toBe(true);
    const other = await call("memory_write", { path: `${OTHER}/x.md`, content: topic("X."), if_version: "new" });
    expect(other.error).toBe(true);
    expect(other.text).toContain(OTHER_GROUP_REFUSAL);
    // Moving out of the folder, or in from outside, is a write outside it.
    expect((await call("memory_move", { from: `${OWN}/plans.md`, to: "plans.md" })).error).toBe(true);
    expect((await call("memory_move", { from: "shared.md", to: `${OWN}/shared.md` })).error).toBe(true);
    expect(existsSync(join(tree.mem, "note.md"))).toBe(false);
    expect(existsSync(join(tree.mem, "plans.md"))).toBe(false);
  });

  it("does not write through a link out of its folder", async () => {
    mkdirSync(join(tree.mem, "elsewhere"), { recursive: true });
    symlinkSync(join(tree.mem, "elsewhere"), join(tree.mem, OWN, "link"));
    const r = await tools(GROUP)("memory_write", { path: `${OWN}/link/x.md`, content: topic("X."), if_version: "new" });
    expect(r.error).toBe(true);
    expect(existsSync(join(tree.mem, "elsewhere", "x.md"))).toBe(false);
  });

  it("can't read, list or search another group's folder; sees its own", async () => {
    const call = tools(GROUP);
    const read = await call("memory_read", { path: `${OTHER}/secrets.md` });
    expect(read.error).toBe(true);
    expect(read.text).toContain(OTHER_GROUP_REFUSAL);
    expect((await call("memory_read", { path: `${OWN}/plans.md` })).error).toBe(false);
    expect((await call("memory_list", { prefix: `${OTHER}/` })).error).toBe(true);
    const all = (await call("memory_list", {})).text;
    expect(all).toContain(`${OWN}/plans.md`);
    expect(all).not.toContain(OTHER);
    expect((await call("memory_list", { prefix: "groups/" })).text).not.toContain(OTHER);
    const found = (await call("memory_search", { query: "needle" })).text;
    expect(found).toContain("needle own");
    expect(found).toContain("needle shared");
    expect(found).not.toContain("needle other");
  });

  it("a batch spanning several chats writes nothing and reads no group's folder", async () => {
    const call = tools(MIXED);
    const r = await call("memory_write", { path: `${OWN}/x.md`, content: topic("X."), if_version: "new" });
    expect(r.error).toBe(true);
    expect(r.text).toContain(MIXED_WRITE_REFUSAL);
    expect((await call("memory_read", { path: `${OWN}/plans.md` })).error).toBe(true);
    expect((await call("memory_search", { query: "needle" })).text).toBe("shared.md:4: - needle shared");
  });

  it("a group-scoped sub-session reads its own group's folder only", async () => {
    const call = tools({ privateBarred: true, canWrite: false, canWriteCore: false, groupDir: OWN }, true);
    expect((await call("memory_read", { path: `${OWN}/plans.md` })).error).toBe(false);
    expect((await call("memory_read", { path: `${OTHER}/secrets.md` })).error).toBe(true);
  });

  it("the owner reads and writes every group's folder", async () => {
    const call = tools(OWNER);
    expect((await call("memory_read", { path: `${OTHER}/secrets.md` })).error).toBe(false);
    expect((await call("memory_append", { path: `${OTHER}/secrets.md`, content: "- owner" })).error).toBe(false);
    expect(collectMemoryFiles({ memoryDir: tree.mem, excludePrivate: false }).entries.map((e) => e.path)).toContain(`${OTHER}/secrets.md`);
  });
});

type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
const hook = (sessionKey: string, bar: "group-session" | "summoned-turn" | null, steering?: string) =>
  (privateMemoryGuardHooks(sessionKey, () => bar, () => [], () => undefined, () => steering) as unknown as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse[0].hooks[0];
const denied = async (h: Hook, tool: string, input: Record<string, unknown>) =>
  (await h({ tool_name: tool, tool_input: input })).hookSpecificOutput?.permissionDecisionReason === OTHER_GROUP_MEMORY_DENIAL;

describe("file tools on a group's turn", () => {
  it("a group session can't Read, Edit or search another group's folder", async () => {
    const h = hook(OWN_KEY, "group-session");
    expect(await denied(h, "Read", { file_path: join(tree.mem, OTHER, "secrets.md") })).toBe(true);
    expect(await denied(h, "Read", { file_path: join(tree.mem, OTHER.toUpperCase(), "secrets.md") })).toBe(true);
    expect(await denied(h, "Edit", { file_path: join(tree.mem, OTHER, "secrets.md"), old_string: "a", new_string: "b" })).toBe(true);
    // Searches under memory/ are refused outright on a barred turn (the private-memory arm), groups/ included.
    for (const path of [join(tree.mem, "groups"), join(tree.mem, OTHER)]) {
      expect((await h({ tool_name: "Grep", tool_input: { pattern: "needle", path } })).hookSpecificOutput?.permissionDecision, path).toBe("deny");
    }
    // And one rooted at a link into another group's folder.
    symlinkSync(join(tree.mem, OTHER), join(tree.ws, "theirs"));
    try {
      expect((await h({ tool_name: "Glob", tool_input: { pattern: "*.md", path: join(tree.ws, "theirs") } })).hookSpecificOutput?.permissionDecision).toBe("deny");
    } finally { rmSync(join(tree.ws, "theirs")); }
    // Its own folder, and shared files, stay open.
    expect(await denied(h, "Read", { file_path: join(tree.mem, OWN, "plans.md") })).toBe(false);
    expect(await denied(h, "Read", { file_path: join(tree.mem, "shared.md") })).toBe(false);
  });

  it("nor through a link planted in the workspace", async () => {
    symlinkSync(join(tree.mem, OTHER), join(tree.ws, "innocent"));
    try {
      expect(await denied(hook(OWN_KEY, "group-session"), "Read", { file_path: join(tree.ws, "innocent", "secrets.md") })).toBe(true);
    } finally { rmSync(join(tree.ws, "innocent")); }
  });

  it("a summoned turn is held to the steering group's folder", async () => {
    const h = hook("dm:owner", "summoned-turn", OWN_KEY);
    expect(await denied(h, "Read", { file_path: join(tree.mem, OTHER, "secrets.md") })).toBe(true);
    expect(await denied(h, "Read", { file_path: join(tree.mem, OWN, "plans.md") })).toBe(false);
    // No single group steering: every group's folder is closed.
    const mixed = hook("dm:owner", "summoned-turn", undefined);
    expect(await denied(mixed, "Read", { file_path: join(tree.mem, OWN, "plans.md") })).toBe(true);
  });

  it("the owner's own turn is not affected", async () => {
    expect(await denied(hook("dm:owner", null), "Read", { file_path: join(tree.mem, OTHER, "secrets.md") })).toBe(false);
  });
});
