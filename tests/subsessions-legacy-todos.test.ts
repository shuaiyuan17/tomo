import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropLegacyTaskTodos } from "../src/agent/subsessions/legacy-todos.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import type { SubsessionRecord } from "../src/agent/subsessions/types.js";
import { TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-legacytodos-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** What the old link wrote for a task: its title, and the next step for where the task stood. */
function linkTodo(todos: TodoStore, r: SubsessionRecord, next: string, waiting: "external" | "owner", session = r.parentKey): string {
  const chars = [...`${r.title.trim()} (${r.id})`];
  const max = DEFAULT_TODOS.titleMaxChars;
  const title = chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
  return todos.add({ title, next, waiting_on: waiting, ref: r.sessionKey, session, source: "self" }).id;
}

describe("the todos sub-sessions used to keep", () => {
  const setup = () => {
    const tasks = new SubsessionStore(join(dir, "t.json"));
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    return { tasks, todos };
  };

  it("drops only the ones the old link made and left as it made them, once", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Fix CI", brief: "b" });
    const s2 = tasks.create({ parentKey: "dm:owner", title: "A very long title ".repeat(10), brief: "b" });
    const s3 = tasks.create({ parentKey: "dm:owner", title: "Wait", brief: "b" });
    const old1 = linkTodo(todos, s1, `${s1.id} is working on it (/s ${s1.id})`, "external");
    const old2 = linkTodo(todos, s2, `${s2.id} is waiting for its check-back`, "external");
    const old3 = linkTodo(todos, s3, `Answer ${s3.id}: which branch?`, "owner");
    // Not the link's: another scope, another title, the owner's own, an unknown task.
    const group = linkTodo(todos, s1, `${s1.id} is working on it (/s ${s1.id})`, "external", "telegram:-100");
    const mine = todos.add({ title: `Check what ${s1.id} found`, next: "read it", waiting_on: "me", ref: s1.sessionKey, session: "dm:owner", source: "self" }).id;
    const owners = todos.add({ title: `Fix CI (${s1.id})`, next: `${s1.id} is working on it (/s ${s1.id})`, waiting_on: "external", ref: s1.sessionKey, session: "dm:owner", source: "owner" }).id;
    const unknown = todos.add({ title: "Old (s9)", next: "s9 is working on it (/s s9)", waiting_on: "external", ref: "task:s9", session: "dm:owner", source: "self" }).id;

    const waiting = tasks.list().map((r) => (r.id === s3.id ? { ...r, status: "waiting" as const, waitingOn: "owner" as const, waitingReason: "which branch?" } : r));
    expect(dropLegacyTaskTodos(todos, waiting, () => true)).toEqual({ dropped: 3, complete: true });
    const open = todos.list().map((i) => i.id);
    for (const id of [old1, old2, old3]) expect(open).not.toContain(id);
    expect(open).toEqual(expect.arrayContaining([group, mine, owners, unknown]));
    expect(dropLegacyTaskTodos(todos, waiting, () => true)).toEqual({ dropped: 0, complete: true });
  });

  it("matches a title or step the link clipped at another limit than today's", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "A long title that an older, shorter limit clipped", brief: "b" });
    // Written under a 20-character title limit; the list's limit is larger now.
    const clipped = todos.add({ title: "A long title that a…", next: `${s1.id} is working on it (/s ${s1.id})`, waiting_on: "external", ref: s1.sessionKey, session: "dm:owner", source: "self" }).id;
    // Not a clip of the link's title: another prefix.
    const other = todos.add({ title: "A long story…", next: `${s1.id} is working on it (/s ${s1.id})`, waiting_on: "external", ref: s1.sessionKey, session: "dm:owner", source: "self" }).id;
    expect(dropLegacyTaskTodos(todos, tasks.list(), () => true)).toEqual({ dropped: 1, complete: true });
    const open = todos.list().map((i) => i.id);
    expect(open).not.toContain(clipped);
    expect(open).toContain(other);
  });

  it("leaves one the owner snoozed or handed off: it is theirs now", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Snoozed", brief: "b" });
    const s2 = tasks.create({ parentKey: "dm:owner", title: "Handed off", brief: "b" });
    const s3 = tasks.create({ parentKey: "dm:owner", title: "Moved to me", brief: "b" });
    const snoozed = linkTodo(todos, s1, `${s1.id} is working on it (/s ${s1.id})`, "external");
    todos.resolve(snoozed, { action: "snooze", until: "3d", reason: "after the trip", by: "owner" });
    const handed = linkTodo(todos, s2, `${s2.id} is working on it (/s ${s2.id})`, "external");
    todos.resolve(handed, { action: "handoff", next: "Ask Dev about the flaky test", by: "owner" });
    const moved = linkTodo(todos, s3, `${s3.id} is working on it (/s ${s3.id})`, "external");
    todos.resolve(moved, { action: "handoff", by: "owner" });
    // Handed to the owner with a step that only starts like the link's "Answer sN: …".
    const s4 = tasks.create({ parentKey: "dm:owner", title: "Answered", brief: "b" });
    const answered = linkTodo(todos, s4, `${s4.id} is working on it (/s ${s4.id})`, "external");
    todos.resolve(answered, { action: "handoff", next: `Answer ${s4.id}: ask Dev first`, by: "owner" });
    expect(dropLegacyTaskTodos(todos, tasks.list(), () => true)).toEqual({ dropped: 0, complete: true });
    expect(todos.list().map((i) => i.id)).toEqual(expect.arrayContaining([snoozed, handed, moved, answered]));
  });

  it("moves a finished task's unread result onto the task before its todo goes, and keeps the todo when it cannot", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Done", brief: "b" });
    const read = linkTodo(todos, s1, `Read ${s1.id}'s result, then close this`, "owner");
    const finished: SubsessionRecord = { ...s1, status: "finished" };
    const asks: string[] = [];
    expect(dropLegacyTaskTodos(todos, [finished], () => false)).toEqual({ dropped: 0, complete: false });
    expect(todos.list().map((i) => i.id)).toContain(read);
    expect(dropLegacyTaskTodos(todos, [finished], (id, action) => { asks.push(`${id}: ${action}`); return true; })).toEqual({ dropped: 1, complete: true });
    expect(asks).toEqual([`${s1.id}: Read ${s1.id}'s result`]);
    expect(todos.list().map((i) => i.id)).not.toContain(read);
  });

  it("moves a finished task's result whatever step its todo still shows (a crash before the link said Read)", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Crashed", brief: "b" });
    const working = linkTodo(todos, s1, `${s1.id} is working on it (/s ${s1.id})`, "external");
    const asks: string[] = [];
    expect(dropLegacyTaskTodos(todos, [{ ...s1, status: "finished" }], (id, action) => { asks.push(`${id}: ${action}`); return true; })).toEqual({ dropped: 1, complete: true });
    expect(asks).toEqual([`${s1.id}: Read ${s1.id}'s result`]);
    expect(todos.list().map((i) => i.id)).not.toContain(working);
  });

  it("keeps an archived task's unread result as the owner's todo, and drops a stale one of a task woken since", () => {
    const { tasks, todos } = setup();
    const s1 = tasks.create({ parentKey: "dm:owner", title: "Archived", brief: "b" });
    const s2 = tasks.create({ parentKey: "dm:owner", title: "Woken", brief: "b" });
    const s3 = tasks.create({ parentKey: "dm:owner", title: "Cancelled", brief: "b" });
    const archived = linkTodo(todos, s1, `Read ${s1.id}'s result, then close this`, "owner");
    const woken = linkTodo(todos, s2, `Read ${s2.id}'s result, then close this`, "owner");
    const asked = linkTodo(todos, s3, `${s3.id} is waiting for its check-back`, "external");
    const records: SubsessionRecord[] = [{ ...s1, status: "archived" }, { ...s2, status: "active" }, { ...s3, status: "cancelled" }];
    const asks: string[] = [];
    expect(dropLegacyTaskTodos(todos, records, (id) => { asks.push(id); return true; })).toEqual({ dropped: 2, complete: true });
    const open = todos.list().map((i) => i.id);
    expect(open).toContain(archived);
    expect(open).not.toContain(woken);
    expect(open).not.toContain(asked);
    expect(asks).toEqual([]);
  });

  it("never throws on a todo list it cannot read, and says it is not done", () => {
    const broken = { limits: DEFAULT_TODOS, list: () => { throw new Error("unreadable"); } } as unknown as TodoStore;
    expect(dropLegacyTaskTodos(broken, [], () => true)).toEqual({ dropped: 0, complete: false });
  });
});
