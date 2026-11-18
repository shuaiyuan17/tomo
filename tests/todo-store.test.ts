import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-todo-store-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

vi.mock("../src/config.js", () => ({ config: { tomoHome: ROOT }, TOMO_HOME: ROOT }));

const { TodoStore, TodoRuleError, TodoStoreReadError, parseReviewWhen, todosDir } = await import("../src/todos/store.js");
const { DEFAULT_TODOS } = await import("../src/todos/limits.js");
const { canSeeTodo, formatDue, formatTodoList } = await import("../src/todos/format.js");

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const OWNER = "dm:shuai";
const GROUP = "telegram:-100777";
const OTHER_GROUP = "telegram:-100888";

let dir: string;
let store: InstanceType<typeof TodoStore>;
beforeEach(() => {
  dir = join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  store = new TodoStore(dir);
});

const add = (over: Partial<Parameters<typeof store.add>[0]> = {}, at = NOW) => store.add({
  title: "Add the app-layer test",
  next: "Write the failing test",
  waiting_on: "me",
  session: OWNER,
  source: "self",
  ...over,
}, at);

function expectRule(fn: () => unknown, pattern: RegExp) {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(TodoRuleError);
  expect((caught as Error).message).toMatch(pattern);
}

describe("todosDir", () => {
  it("lives under <tomoHome>/data/todos", () => {
    expect(todosDir()).toBe(join(ROOT, "data", "todos"));
  });
});

describe("adding", () => {
  it("writes an item with stable ids, default review by who acts, and no Markdown mirror", () => {
    const a = add();
    const b = add({ waiting_on: "owner", title: "Keep the scaffold regex?" });
    expect(a.id).toBe("t-1");
    expect(b.id).toBe("t-2");
    expect(Date.parse(a.review_at)).toBe(NOW + DEFAULT_TODOS.reviewDaysSelf * DAY);
    expect(Date.parse(b.review_at)).toBe(NOW + DEFAULT_TODOS.reviewDaysWaiting * DAY);
    const disk = JSON.parse(readFileSync(join(dir, "todos.json"), "utf-8"));
    expect(disk.items.map((i: { id: string }) => i.id)).toEqual(["t-1", "t-2"]);
    expect(disk.next_id).toBe(3);
    expect(existsSync(join(dir, "todos.md"))).toBe(false);
  });

  it("requires title, next and waiting_on", () => {
    expectRule(() => add({ title: "  " }), /title is required/);
    expectRule(() => add({ next: "" }), /next is required/);
    expectRule(() => add({ next: undefined }), /next is required/);
    expectRule(() => add({ waiting_on: "someone" as never }), /waiting_on must be one of/);
    expect(store.list()).toEqual([]);
  });

  it("refuses a title over the limit and multi-line fields", () => {
    expect(add({ title: "x".repeat(DEFAULT_TODOS.titleMaxChars) }).title).toHaveLength(120);
    expectRule(() => add({ title: "x".repeat(DEFAULT_TODOS.titleMaxChars + 1) }), /121 characters; the limit is 120/);
    expectRule(() => add({ next: "y".repeat(DEFAULT_TODOS.nextMaxChars + 1) }), /next is 201 characters/);
    expectRule(() => add({ title: "line one\nline two" }), /one line/);
    expect(store.list()).toHaveLength(1);
  });

  it("refuses at the open cap, listing the five least recently touched it can see", () => {
    for (let i = 0; i < DEFAULT_TODOS.maxOpen; i++) add({ title: `item ${i}`, session: i % 2 ? GROUP : OWNER }, NOW + i);
    let caught: Error | undefined;
    try {
      store.add({ title: "one too many", next: "x", waiting_on: "me", session: GROUP, source: "self" }, NOW + 100, (item) => canSeeTodo(item, GROUP));
    } catch (err) { caught = err as Error; }
    expect(caught).toBeInstanceOf(TodoRuleError);
    expect(caught!.message).toMatch(/30 todos are open; the limit is 30/);
    // Only the group's own items are named to a group caller.
    expect(caught!.message).toContain("t-2 item 1");
    expect(caught!.message).not.toContain("t-1 item 0");
    expect(caught!.message.match(/^- t-/gm)).toHaveLength(5);
    expect(store.list()).toHaveLength(30);
  });

  it("never refuses the owner at the cap, but counts what they add", () => {
    for (let i = 0; i < DEFAULT_TODOS.maxOpen; i++) add({ title: `item ${i}` });
    const owner = store.add({ title: "Call the bank", waiting_on: "me", session: OWNER, source: "owner" }, NOW);
    expect(owner.source).toBe("owner");
    expect(owner.next).toBe("Call the bank");
    expect(store.list()).toHaveLength(31);
    expectRule(() => add(), /31 todos are open/);
  });

  it("takes the numbers from config", () => {
    const tight = new TodoStore(join(dir, "tight"), { ...DEFAULT_TODOS, maxOpen: 1, titleMaxChars: 5 });
    tight.add({ title: "short", next: "x", waiting_on: "me", session: OWNER, source: "self" }, NOW);
    expectRule(() => tight.add({ title: "short", next: "x", waiting_on: "me", session: OWNER, source: "self" }, NOW), /limit is 1\./);
    expectRule(() => tight.add({ title: "longer", next: "x", waiting_on: "me", session: OWNER, source: "owner" }, NOW), /limit is 5/);
  });
});

describe("parseReviewWhen", () => {
  it("accepts days, weeks and dates in the future within the horizon", () => {
    expect(parseReviewWhen("3d", NOW)).toBe(NOW + 3 * DAY);
    expect(parseReviewWhen("2W", NOW)).toBe(NOW + 14 * DAY);
    expect(parseReviewWhen("2026-12-01", NOW)).toBe(new Date(2026, 11, 1).getTime());
    expect(() => parseReviewWhen("2026-11-17", NOW)).toThrow(/not in the future/);
    expect(() => parseReviewWhen("0d", NOW)).toThrow(/not in the future/);
    expect(() => parseReviewWhen("2026-02-30", NOW)).toThrow(/not a real date/);
    expect(() => parseReviewWhen("next week", NOW)).toThrow(/not a review time/);
    expect(() => parseReviewWhen("91d", NOW)).toThrow(/more than 90 days/);
  });
});

describe("the four actions", () => {
  const doneLog = () => readFileSync(join(dir, "done.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));

  it("done moves the item to done.ndjson with its evidence", () => {
    const item = add();
    const result = store.resolve(item.id, { action: "done", evidence: "PR #512", by: "self" }, NOW + 1);
    expect(result.action).toBe("done");
    expect(store.list()).toEqual([]);
    expect(doneLog()).toEqual([expect.objectContaining({ id: "t-1", resolution: "done", evidence: "PR #512", resolved_by: "self" })]);
    // Ids are never reused.
    expect(add().id).toBe("t-2");
  });

  it("drop needs a reason", () => {
    const item = add();
    expectRule(() => store.resolve(item.id, { action: "drop", by: "self" }, NOW), /drop needs a reason/);
    store.resolve(item.id, { action: "drop", reason: "Superseded by #500.", by: "self" }, NOW);
    expect(doneLog()).toEqual([expect.objectContaining({ resolution: "drop", reason: "Superseded by #500." })]);
  });

  it("snooze needs until and reason, may change next, and is capped", () => {
    const item = add();
    expectRule(() => store.resolve(item.id, { action: "snooze", reason: "waiting", by: "self" }, NOW), /needs `until`/);
    expectRule(() => store.resolve(item.id, { action: "snooze", until: "3d", by: "self" }, NOW), /needs a reason/);
    for (let i = 1; i <= DEFAULT_TODOS.maxSnoozes; i++) {
      const { item: s } = store.resolve(item.id, { action: "snooze", until: "2d", reason: `try ${i}`, next: `step ${i}`, by: "self" }, NOW);
      expect(s.snoozes).toBe(i);
      expect(s.snooze_reason).toBe(`try ${i}`);
      expect(s.next).toBe(`step ${i}`);
      expect(Date.parse(s.review_at)).toBe(NOW + 2 * DAY);
    }
    expectRule(() => store.resolve(item.id, { action: "snooze", until: "2d", reason: "again", by: "self" }, NOW), /snoozed 3 times, the limit\. Decide: done, drop, or handoff/);
    // Still resolvable the other three ways.
    expect(store.resolve(item.id, { action: "handoff", by: "self" }, NOW).item.waiting_on).toBe("owner");
  });

  it("handoff hands it to the owner with the waiting review", () => {
    const item = add();
    const { item: h } = store.resolve(item.id, { action: "handoff", next: "Ask: keep or delete?", by: "self" }, NOW + 5);
    expect(h).toMatchObject({ waiting_on: "owner", next: "Ask: keep or delete?", updated_at: new Date(NOW + 5).toISOString() });
    expect(Date.parse(h.review_at)).toBe(NOW + 5 + DEFAULT_TODOS.reviewDaysWaiting * DAY);
    expectRule(() => store.resolve(item.id, { action: "handoff", by: "self" }, NOW), /already waiting on the owner/);
  });

  it("has no fifth action and does not let done or drop carry a new next step", () => {
    const item = add();
    expectRule(() => store.resolve(item.id, { action: "comment" as never, by: "self" }, NOW), /action must be one of done, drop, snooze, handoff/);
    expectRule(() => store.resolve(item.id, { action: "done", next: "more", by: "self" }, NOW), /closes the item/);
  });

  it("reports an unknown id and an item the caller may not see the same way", () => {
    const own = add({ session: OWNER });
    expectRule(() => store.resolve("t-99", { action: "done", by: "self" }, NOW), /No open todo t-99/);
    expectRule(() => store.resolve(own.id, { action: "done", by: "self" }, NOW, (i) => canSeeTodo(i, GROUP)), /No open todo t-1 in this conversation/);
    expect(store.list()).toHaveLength(1);
  });
});

describe("session scope", () => {
  it("a group sees only its own items; the owner DM sees all", () => {
    add({ session: OWNER, title: "owner private errand" });
    add({ session: GROUP, title: "group trip" });
    add({ session: OTHER_GROUP, title: "other group secret" });
    const titles = (key: string) => store.list().filter((i) => canSeeTodo(i, key)).map((i) => i.title);
    expect(titles(GROUP)).toEqual(["group trip"]);
    expect(titles(OTHER_GROUP)).toEqual(["other group secret"]);
    expect(titles(OWNER)).toEqual(["owner private errand", "group trip", "other group secret"]);
    // A non-canonical dm key does not get owner powers.
    expect(titles("dm:shuai yuan")).toEqual([]);
  });
});

describe("an unreadable store is an error, never an empty list", () => {
  const corruptions: Array<[string, string]> = [
    ["not JSON", "{ nope"],
    ["wrong shape", JSON.stringify({ version: 1, next_id: 1, items: "x" })],
    ["bad item", JSON.stringify({ version: 1, next_id: 5, items: [{ id: "t-1" }] })],
    ["duplicate ids", JSON.stringify({ version: 1, next_id: 5, items: [item("t-1"), item("t-1")] })],
    ["id at or past next_id", JSON.stringify({ version: 1, next_id: 1, items: [item("t-1")] })],
  ];
  function item(id: string) {
    return { id, title: "x", next: "y", waiting_on: "me", review_at: new Date(NOW).toISOString(), session: OWNER, created_at: "", updated_at: "", source: "self", snoozes: 0 };
  }

  for (const [label, content] of corruptions) {
    it(`${label}: reads and writes refuse, and the file is left as it was`, () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "todos.json"), content);
      expect(() => store.list()).toThrow(TodoStoreReadError);
      expect(() => add()).toThrow(TodoStoreReadError);
      expect(() => store.resolve("t-1", { action: "done", by: "self" }, NOW)).toThrow(TodoStoreReadError);
      expect(readFileSync(join(dir, "todos.json"), "utf-8")).toBe(content);
      expect(existsSync(join(dir, "done.ndjson"))).toBe(false);
    });
  }

  it.skipIf(process.getuid?.() === 0)("an unreadable file (EACCES) is an error too", () => {
    add();
    chmodSync(join(dir, "todos.json"), 0o000);
    try {
      expect(() => store.list()).toThrow(TodoStoreReadError);
      expect(() => add()).toThrow(TodoStoreReadError);
    } finally {
      chmodSync(join(dir, "todos.json"), 0o600);
    }
    expect(store.list()).toHaveLength(1);
  });
});

describe("formatting", () => {
  it("due output is empty when nothing is due, and capped otherwise", () => {
    expect(formatDue([], { now: NOW, max: 3 })).toBe("");
    for (let i = 0; i < 5; i++) add({ title: `item ${i}` }, NOW - 10 * DAY + i);
    const due = store.due(NOW);
    expect(due.map((i) => i.id)).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"]);
    const text = formatDue(due, { now: NOW, max: 3, maxSnoozes: 3 });
    expect(text.split("\n")).toHaveLength(5);
    expect(text).toMatch(/^5 todos due for review\./);
    expect(text).toContain("t-1 item 0 · next: Write the failing test · waiting on me · due 2026-11-10");
    expect(text).not.toContain("t-4");
    expect(text.endsWith("(2 more due)")).toBe(true);
  });

  it("the /todo list puts what waits on the owner first and caps Tomo's own at ten", () => {
    for (let i = 0; i < 12; i++) add({ title: `mine ${i}` }, NOW + i);
    add({ title: "ask him", waiting_on: "owner" });
    add({ title: "vendor reply", waiting_on: "external" });
    const text = formatTodoList(store.list(), { now: NOW });
    expect(text.indexOf("Waiting on you:")).toBeLessThan(text.indexOf("Mine:"));
    expect(text).toContain("mine 9");
    expect(text).not.toContain("mine 10");
    expect(text).not.toContain("vendor reply");
    expect(text).toContain("3 more (/todo all)");
    const all = formatTodoList(store.list(), { now: NOW, all: true });
    expect(all).toContain("mine 11");
    expect(all).toContain("Waiting on others:\nt-14 vendor reply");
    expect(formatTodoList([], { now: NOW })).toBe("No open todos.");
  });
});
