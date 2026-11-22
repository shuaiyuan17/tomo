import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";

/**
 * Hooks into the store's atomic write — after it built the new content from
 * its read, before the rename. `before` stands in for another writer that got
 * the lock anyway (a lock reclaimed from a slow, live holder); `crash` throws
 * as a process dying there would.
 */
const hook = { before: null as null | (() => void), sticky: false, crash: false };

vi.mock("../src/fs-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fs-utils.js")>();
  return {
    ...actual,
    writeJsonAtomicSync: (path: string, value: unknown, opts?: { beforeRename?: () => void; fsync?: boolean }) => {
      if (hook.crash) { hook.crash = false; throw new Error("simulated crash"); }
      const fire = hook.before;
      if (!hook.sticky) hook.before = null;
      fire?.();
      return actual.writeJsonAtomicSync(path, value, opts);
    },
  };
});

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-todo-durable-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
vi.mock("../src/config.js", () => ({ config: { tomoHome: ROOT }, TOMO_HOME: ROOT }));

const { TodoStore, TodoStoreConflictError } = await import("../src/todos/store.js");
const { FileLockTimeoutError } = await import("../src/file-lock.js");

let dir: string;
beforeEach(() => {
  dir = join(ROOT, `c-${Math.random().toString(36).slice(2)}`);
  hook.before = null;
  hook.sticky = false;
  hook.crash = false;
});

const input = (title: string) => ({ title, next: "x", waiting_on: "me" as const, session: "dm:shuai", source: "self" as const });
const disk = () => JSON.parse(readFileSync(join(dir, "todos.json"), "utf-8")) as { next_id: number; items: { id: string; title: string }[] };
const doneLines = () => readFileSync(join(dir, "done.ndjson"), "utf-8").trim().split("\n");

describe("a write that lost its lock does not overwrite the other writer", () => {
  it("redoes the change on a fresh read, keeping both", () => {
    const store = new TodoStore(dir);
    store.add(input("first"));
    // Same process, so the other store re-enters the lock — exactly the
    // "someone else is inside" state a reclaimed lock produces.
    hook.before = () => { new TodoStore(dir).add(input("interloper")); };
    const mine = store.add(input("mine"));
    expect(disk().items.map((i) => i.title)).toEqual(["first", "interloper", "mine"]);
    expect(mine.id).toBe("t-3");
    expect(disk().next_id).toBe(4);
  });

  it("gives up with a conflict error, publishing nothing, if it keeps happening", () => {
    const store = new TodoStore(dir);
    store.add(input("first"));
    let n = 0;
    hook.sticky = true;
    hook.before = () => {
      n += 1;
      writeFileSync(join(dir, "todos.json"), JSON.stringify({ version: 1, next_id: 9, items: [], other: n }));
    };
    expect(() => store.add(input("mine"))).toThrow(TodoStoreConflictError);
    hook.before = null;
    expect(disk()).toMatchObject({ next_id: 9, items: [], other: n });
  });
});

describe("the store's lock is never taken from a live holder", () => {
  it("a second writer waits (and times out) while the holder is alive and slow, past the stale window", () => {
    const store = new TodoStore(dir, undefined, { staleMs: 10, timeoutMs: 200 });
    store.add(input("first"));
    const before = readFileSync(join(dir, "todos.json"), "utf-8");
    // A holder in this host that is alive (this very process) and has held it for a minute.
    mkdirSync(join(dir, "todos.json.lock"));
    writeFileSync(join(dir, "todos.json.lock", "owner.slow"), JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000, host: hostname() }));
    expect(() => store.add(input("second"))).toThrow(FileLockTimeoutError);
    expect(readFileSync(join(dir, "todos.json"), "utf-8")).toBe(before);
    rmSync(join(dir, "todos.json.lock"), { recursive: true });
    expect(store.add(input("second")).id).toBe("t-2");
  });
});

describe("closing an item survives a crash between its two writes", () => {
  it("counts it as done once, with one record, and heals todos.json", () => {
    const store = new TodoStore(dir);
    store.add(input("a"));
    store.add(input("b"));
    hook.crash = true;
    expect(() => store.resolve("t-1", { action: "done", by: "self" })).toThrow("simulated crash");
    // done.ndjson has it, todos.json still does too.
    expect(doneLines()).toHaveLength(1);
    expect(disk().items.map((i) => i.id)).toEqual(["t-1", "t-2"]);

    const reloaded = new TodoStore(dir);
    expect(reloaded.list().map((i) => i.id)).toEqual(["t-2"]);
    expect(reloaded.due(Date.now() + 365 * 86_400_000).map((i) => i.id)).toEqual(["t-2"]);
    // Closing it again is a no-op success, not a second record.
    expect(reloaded.resolve("t-1", { action: "done", by: "self" }).action).toBe("done");
    expect(reloaded.resolve("t-1", { action: "drop", reason: "again", by: "self" }).action).toBe("done");
    expect(doneLines()).toHaveLength(1);
    // A snooze of a closed item is still refused.
    expect(() => reloaded.resolve("t-1", { action: "snooze", until: "2d", reason: "x", by: "self" })).toThrow(/No open todo t-1/);
    // The next write drops it from todos.json.
    reloaded.add(input("c"));
    expect(disk().items.map((i) => i.id)).toEqual(["t-2", "t-3"]);
  });

  it("does not show another conversation's closed item through the no-op", () => {
    const store = new TodoStore(dir);
    store.add(input("owner thing"));
    store.resolve("t-1", { action: "done", by: "self" });
    expect(() => store.resolve("t-1", { action: "done", by: "self" }, Date.now(), (i) => i.session === "telegram:-100777")).toThrow(/No open todo t-1/);
  });

  it("starts a new line after a torn one, so the next record still parses", () => {
    const store = new TodoStore(dir);
    store.add(input("a"));
    store.add(input("b"));
    store.resolve("t-1", { action: "done", by: "self" });
    writeFileSync(join(dir, "done.ndjson"), `${readFileSync(join(dir, "done.ndjson"), "utf-8")}{"id":"t-9","sess`);
    store.resolve("t-2", { action: "drop", reason: "no", by: "self" });
    const lines = doneLines();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2])).toMatchObject({ id: "t-2", resolution: "drop" });
    expect(new TodoStore(dir).list()).toEqual([]);
    expect(store.resolve("t-2", { action: "done", by: "self" }).action).toBe("drop");
    expect(doneLines()).toHaveLength(3);
  });

  it("keeps the whole record when a bad record of the same id comes first", () => {
    const store = new TodoStore(dir);
    store.add(input("a"));
    store.add(input("b"));
    hook.crash = true;
    expect(() => store.resolve("t-1", { action: "drop", reason: "no longer needed", by: "owner" })).toThrow("simulated crash");
    // A line that has an id and a session but is not a whole record (no
    // resolution, no timestamp) sits ahead of the real record for t-1.
    const good = readFileSync(join(dir, "done.ndjson"), "utf-8");
    writeFileSync(join(dir, "done.ndjson"), `${JSON.stringify({ id: "t-1", session: "dm:shuai", title: "a" })}\n${good}`);

    const reloaded = new TodoStore(dir);
    // Still closed: todos.json heals from the whole record.
    expect(reloaded.list().map((i) => i.id)).toEqual(["t-2"]);
    // The no-op re-close answers from the whole record, not the bad one.
    const again = reloaded.resolve("t-1", { action: "done", by: "self" });
    expect(again.action).toBe("drop");
    expect(again.item).toMatchObject({ id: "t-1", title: "a" });
    expect(doneLines()).toHaveLength(2);
  });

  it("skips a torn last line in done.ndjson", () => {
    const store = new TodoStore(dir);
    store.add(input("a"));
    store.resolve("t-1", { action: "done", by: "self" });
    writeFileSync(join(dir, "done.ndjson"), `${readFileSync(join(dir, "done.ndjson"), "utf-8")}{"id":"t-`);
    expect(new TodoStore(dir).list()).toEqual([]);
  });
});
