import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropLegacyTaskTodos } from "../src/agent/subsessions/legacy-todos.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-legacytodos-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the todos sub-sessions used to keep", () => {
  it("drops only the ones the old link made, once", () => {
    const tasks = new SubsessionStore(join(dir, "t.json"));
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Fix CI", brief: "b" });
    const s2 = tasks.create({ parentKey: "dm:owner", title: "A very long title ".repeat(10), brief: "b" });
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const link = (title: string, ref: string, session = "dm:owner") => todos.add({ title, next: "s working on it", waiting_on: "external", ref, session, source: "self" }).id;
    const clipped = [...`${s2.title.trim()} (${s2.id})`];
    const old1 = link(`Fix CI (${s1.id})`, s1.sessionKey);
    const old2 = link(`${clipped.slice(0, DEFAULT_TODOS.titleMaxChars - 1).join("")}…`, s2.sessionKey);
    // Not the link's: another scope, another title, the owner's own, an unknown task.
    const group = link(`Fix CI (${s1.id})`, s1.sessionKey, "telegram:-100");
    const mine = link(`Check what ${s1.id} found`, s1.sessionKey);
    const owners = todos.add({ title: `Fix CI (${s1.id})`, next: "x", waiting_on: "me", ref: s1.sessionKey, session: "dm:owner", source: "owner" }).id;
    const unknown = link("Old (s9)", "task:s9");

    expect(dropLegacyTaskTodos(todos, tasks.list())).toBe(2);
    const open = todos.list().map((i) => i.id);
    expect(open).not.toContain(old1);
    expect(open).not.toContain(old2);
    expect(open).toEqual(expect.arrayContaining([group, mine, owners, unknown]));
    expect(dropLegacyTaskTodos(todos, tasks.list())).toBe(0);
  });

  it("never throws on a todo list it cannot read", () => {
    const broken = { limits: DEFAULT_TODOS, list: () => { throw new Error("unreadable"); } } as unknown as TodoStore;
    expect(dropLegacyTaskTodos(broken, [])).toBe(0);
  });
});
