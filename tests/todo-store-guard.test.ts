import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// A real tree: ~/.tomo/{data/todos,workspace}, a store file, and a symlink
// into the store from the workspace.
const tree = vi.hoisted(() => {
  const { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tomo-todo-guard-")));
  const tomoHome = join(home, ".tomo");
  const ws = join(tomoHome, "workspace");
  const data = join(tomoHome, "data");
  const todos = join(data, "todos");
  mkdirSync(todos, { recursive: true });
  mkdirSync(join(data, "sessions"), { recursive: true });
  mkdirSync(join(ws, "memory", "private"), { recursive: true });
  mkdirSync(join(ws, "home"), { recursive: true });
  writeFileSync(join(todos, "todos.json"), '{"version":1,"next_id":2,"items":[{"title":"OWNER SECRET"}]}\n');
  symlinkSync(todos, join(ws, "innocent"));
  process.env.HOME = home;
  return { home, tomoHome, ws, data, todos };
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

const { isTodoStoreWrite, todoGuardDecision, todoStoreGuardHooks, TODO_STORE_WRITE_DENIAL } = await import("../src/agent/todo-store-guard.js");
const { privateMemoryGuardHooks } = await import("../src/agent/private-memory-guard.js");
const { SANDBOX_EXEC_PATH, SANDBOX_SHELL_PATH } = await import("../src/agent/bash-sandbox.js");
const { sandboxRunsHere } = await import("./helpers/sandbox-exec.js");

afterAll(() => rmSync(tree.home, { recursive: true, force: true }));

const ctx = { cwd: tree.ws, todosDir: tree.todos };
const STORE = join(tree.todos, "todos.json");

type HookResult = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<HookResult>;

describe("isTodoStoreWrite — file tools", () => {
  it("denies Write, Edit, MultiEdit and NotebookEdit into the store, however spelled", () => {
    for (const call of [
      { tool_name: "Write", tool_input: { file_path: STORE, content: "{}" } },
      { tool_name: "Edit", tool_input: { file_path: "~/.tomo/data/todos/todos.json", old_string: "a", new_string: "b" } },
      { tool_name: "MultiEdit", tool_input: { file_path: join(tree.todos, "done.ndjson"), edits: [] } },
      { tool_name: "NotebookEdit", tool_input: { notebook_path: join(tree.todos, "x.ipynb") } },
      { tool_name: "Write", tool_input: { file_path: "../data/todos/todos.json" } },
      { tool_name: "Write", tool_input: { file_path: "innocent/todos.json" } },
      { tool_name: "Write", tool_input: { file_path: join(tree.todos, "..", "todos", "new.json") } },
    ]) expect(isTodoStoreWrite(call.tool_name, call.tool_input, ctx), JSON.stringify(call)).toBe(true);
  });

  it("does not judge an input it cannot read (the tool rejects it on its own)", () => {
    expect(isTodoStoreWrite("Write", { content: "x" }, ctx)).toBe(false);
    expect(isTodoStoreWrite("Write", null, ctx)).toBe(false);
    expect(isTodoStoreWrite("Bash", { command: 42 }, ctx)).toBe(false);
  });

  it("leaves other paths and reads alone", () => {
    expect(isTodoStoreWrite("Write", { file_path: join(tree.ws, "memory", "TODO.md") }, ctx)).toBe(false);
    expect(isTodoStoreWrite("Write", { file_path: join(tree.data, "todos-notes.json") }, ctx)).toBe(false);
    expect(isTodoStoreWrite("Read", { file_path: STORE }, ctx)).toBe(false);
  });
});

describe("isTodoStoreWrite — Bash", () => {
  it("denies writes whose target is in the store", () => {
    for (const command of [
      "echo x > ~/.tomo/data/todos/todos.json",
      `echo '{}' > ${STORE}`,
      "echo x >> ~/.tomo/data/todos/done.ndjson",
      `rm ${STORE}`,
      "rm ~/.tomo/data/todos/todos.json",
      "true && rm ~/.tomo/data/todos/todos.json",
      "ls; rm ~/.tomo/data/todos/todos.json",
      "echo $(rm ~/.tomo/data/todos/todos.json)",
      "sudo -n rm ~/.tomo/data/todos/todos.json",
      "FOO=1 /bin/rm ~/.tomo/data/todos/todos.json",
      "rm -rf ~/.tomo/data",
      "cd ~/.tomo && rm -rf data/todos",
      "cd ~/.tomo/data && rm -rf todos",
      "echo x | tee ~/.tomo/data/todos/todos.json",
      `cp /tmp/x.json ${STORE}`,
      `cp -t ${tree.todos} /tmp/x.json`,
      `mv ${join(tree.ws, "x.json")} ${tree.todos}/`,
      `ln -sf /tmp/x ${STORE}`,
      `sed -i '' 's/a/b/' ${STORE}`,
      `perl -i -pe 's/a/b/' ${STORE}`,
      `truncate -s 0 ${STORE}`,
      `dd if=/dev/zero of=${STORE} count=1`,
      "jq . x > innocent/todos.json",
    ]) expect(isTodoStoreWrite("Bash", { command }, ctx), command).toBe(true);
  });

  it("lets reads and quoted text through", () => {
    for (const command of [
      "grep 'data/todos' x.log",
      "grep 'rm' ~/.tomo/data/todos/todos.json",
      "grep -e rm -e mv ~/.tomo/data/todos/done.ndjson",
      "echo rm ~/.tomo/data/todos/todos.json",
      "sed 's/a/b/' ~/.tomo/data/todos/todos.json",
      "git commit -m \"fix data/todos\"",
      "git commit -m \"docs: explain todos.json and done.ndjson\"",
      "cat ~/.tomo/data/todos/todos.json",
      `jq '.items[] | .title' ${STORE}`,
      `cp ${STORE} /tmp/backup.json`,
      `dd if=${STORE} of=/tmp/backup.json`,
      `ln -s ${STORE} /tmp/link.json`,
      "echo 'x > ~/.tomo/data/todos/todos.json'",
      "tomo todo due --max 3",
      "ls /tmp && echo hi > /tmp/out.txt",
      "rm -rf /tmp/scratch",
    ]) expect(isTodoStoreWrite("Bash", { command }, ctx), command).toBe(false);
  });
});

describe("todoGuardDecision — a failing check blocks only calls that name the store", () => {
  const boom = () => { throw new Error("guard bug"); };
  it("denies a call that names the store, allows everything else", () => {
    expect(todoGuardDecision("Bash", { command: "cat ~/.tomo/data/todos/todos.json" }, ctx, boom)).toBe("deny");
    expect(todoGuardDecision("Write", { file_path: STORE }, ctx, boom)).toBe("deny");
    expect(todoGuardDecision("Bash", { command: "ls -la" }, ctx, boom)).toBe("allow");
    expect(todoGuardDecision("Read", { file_path: join(tree.ws, "notes.md") }, ctx, boom)).toBe("allow");
    expect(todoGuardDecision("WebFetch", { url: "https://example.com" }, ctx, boom)).toBe("allow");
  });
});

describe("todoStoreGuardHooks", () => {
  const hook = (todoStoreGuardHooks("dm:shuai", tree.ws, () => tree.todos).PreToolUse[0].hooks[0]) as unknown as Hook;

  it("denies with a reason that points at the tools, and fails closed", async () => {
    const entry = todoStoreGuardHooks("dm:shuai", tree.ws, () => tree.todos).PreToolUse[0];
    expect(entry.onFailure).toBe("block");
    const result = await hook({ tool_name: "Edit", tool_input: { file_path: STORE, old_string: "a", new_string: "b" } });
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBe(TODO_STORE_WRITE_DENIAL);
    expect(TODO_STORE_WRITE_DENIAL).toMatch(/todo_resolve/);
  });

  it("allows everything else", async () => {
    expect(await hook({ tool_name: "Write", tool_input: { file_path: join(tree.ws, "notes.md") } })).toEqual({});
    expect(await hook({ tool_name: "Bash", tool_input: { command: "tomo todo due" } })).toEqual({});
  });
});

// §6 of the design: is data/todos/ out of a group's reach? The private-memory
// guard already bars all of data/ on a barred turn; pinned here for the store.
describe("a group session cannot read the store", () => {
  const groupHook = (privateMemoryGuardHooks("telegram:-100123", () => "group-session").PreToolUse[0].hooks[0]) as unknown as Hook;

  it("denies the file tools", async () => {
    for (const call of [
      { tool_name: "Read", tool_input: { file_path: STORE } },
      { tool_name: "Grep", tool_input: { pattern: "SECRET", path: tree.todos } },
      { tool_name: "Glob", tool_input: { pattern: `${tree.todos}/*.json` } },
    ]) expect((await groupHook(call)).hookSpecificOutput?.permissionDecision, JSON.stringify(call)).toBe("deny");
  });

  const sandboxRuns = sandboxRunsHere(SANDBOX_EXEC_PATH, SANDBOX_SHELL_PATH);
  it.runIf(sandboxRuns)("runs Bash in a kernel sandbox that cannot open the store", async () => {
    for (const command of [`cat ${STORE}`, "cat innocent/todos.json", `ls ${tree.todos}`]) {
      const result = await groupHook({ tool_name: "Bash", tool_input: { command } });
      const wrapped = result.hookSpecificOutput?.updatedInput?.command;
      expect(typeof wrapped, command).toBe("string");
      let out: string;
      let code = 0;
      try {
        out = execFileSync("/bin/zsh", ["-lc", `cd ${tree.ws} && ${wrapped as string}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        code = e.status ?? -1;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(code, command).not.toBe(0);
      expect(out).not.toContain("OWNER SECRET");
    }
    expect(readFileSync(STORE, "utf8")).toContain("OWNER SECRET");
  });
});
