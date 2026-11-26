import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

// A real tree: ~/.tomo/{data/tomo.db + -wal/-shm, workspace}, and a symlink to
// data/ from the workspace.
const tree = vi.hoisted(() => {
  const { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tomo-db-guard-")));
  const tomoHome = join(home, ".tomo");
  const ws = join(tomoHome, "workspace");
  const data = join(tomoHome, "data");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(ws, "memory", "private"), { recursive: true });
  mkdirSync(join(ws, "home"), { recursive: true });
  for (const f of ["tomo.db", "tomo.db-wal", "tomo.db-shm"]) writeFileSync(join(data, f), "x");
  symlinkSync(data, join(ws, "innocent"));
  process.env.HOME = home;
  return { home, tomoHome, ws, data, db: join(data, "tomo.db") };
});

vi.mock("../src/config.js", () => ({
  config: { workspaceDir: tree.ws, tomoHome: tree.tomoHome, sessionsDir: `${tree.data}/sessions`, dbPath: tree.db },
}));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: `${tree.ws}/memory`,
  PRIVATE_MEMORY_DIR: `${tree.ws}/memory/private`,
  HOME_SCENE_DIR: `${tree.ws}/home`,
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { isDbWrite, DB_WRITE_DENIAL } = await import("../src/agent/db-guard.js");
const { buildHooksOption } = await import("../src/agent/sdk-options.js");

afterAll(() => rmSync(tree.home, { recursive: true, force: true }));
const ctx = { cwd: tree.ws, dbPath: tree.db };

describe("isDbWrite", () => {
  it("denies file tools and shell writers aimed at the database or its sidecars, however spelled", () => {
    for (const [tool, input] of [
      ["Write", { file_path: tree.db, content: "" }],
      ["Edit", { file_path: `${tree.db}-wal`, old_string: "a", new_string: "b" }],
      ["Write", { file_path: join(tree.ws, "innocent", "tomo.db-shm"), content: "" }],
      ["Bash", { command: `rm ${tree.db}-wal` }],
      ["Bash", { command: "rm -f ~/.tomo/data/tomo.db-shm" }],
      ["Bash", { command: `echo x > ${tree.db}` }],
      ["Bash", { command: `cp /tmp/other.db ${tree.db}` }],
      ["Bash", { command: "cd ~/.tomo/data && mv tomo.db tomo.old" }],
      ["Bash", { command: "rm -rf ~/.tomo/data" }],
      ["Bash", { command: `sqlite3 ${tree.db} "delete from pending_notes"` }],
      ["Bash", { command: "cd innocent && sqlite3 tomo.db 'update meta set value = 1'" }],
      ["Bash", { command: `/usr/bin/sqlite3 -cmd '.timeout 1' ${tree.db}` }],
    ] as const) {
      expect(isDbWrite(tool, input, ctx), JSON.stringify(input)).toBe(true);
    }
  });

  it("denies removing or overwriting the maintenance lock (~/.tomo/tomo.lock): a new file would let a repair run beside the daemon", () => {
    const lock = join(tree.tomoHome, "tomo.lock");
    for (const [tool, input] of [
      ["Write", { file_path: lock, content: "" }],
      ["Bash", { command: `rm ${lock}` }],
      ["Bash", { command: "rm -f ~/.tomo/tomo.lock" }],
      ["Bash", { command: "cd ~/.tomo && mv tomo.lock x" }],
      ["Bash", { command: `rm ${lock}-journal` }],
    ] as const) {
      expect(isDbWrite(tool, input, ctx), JSON.stringify(input)).toBe(true);
    }
    expect(isDbWrite("Bash", { command: `ls -la ${tree.tomoHome}` }, ctx)).toBe(false);
  });

  it("lets reads through", () => {
    for (const command of [
      `sqlite3 -readonly ${tree.db} 'select * from pending_notes'`,
      "tomo db dump pending_notes",
      `ls -la ${tree.data}`,
      `cp ${tree.db} /tmp/look.db`,
      `grep -c note ${tree.db}`,
      `sqlite3 /tmp/other.db 'delete from t'`,
    ]) {
      expect(isDbWrite("Bash", { command }, ctx), command).toBe(false);
    }
    expect(isDbWrite("Read", { file_path: tree.db }, ctx)).toBe(false);
  });
});

describe("on every session", () => {
  type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
  it("the hooks built for a session deny a direct write with a reason that names the read path", async () => {
    const hooks = (buildHooksOption({ maxTurns: 10, sessionKey: "dm:owner", dbPath: () => tree.db }) as { hooks: { PreToolUse: Array<{ hooks: Hook[] }> } }).hooks;
    const decisions = await Promise.all(hooks.PreToolUse.flatMap((m) => m.hooks).map((h) => h({ tool_name: "Bash", tool_input: { command: `rm ${tree.db}-wal` } })));
    const denied = decisions.find((d) => d.hookSpecificOutput?.permissionDecision === "deny");
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toBe(DB_WRITE_DENIAL);
    expect(DB_WRITE_DENIAL).toContain("tomo db dump");
  });
});
