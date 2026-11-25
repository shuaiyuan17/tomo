import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseResolutions, TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";
import { readWebTodos } from "../src/web/todos-view.js";
import { DAY, NOW, seedTodos } from "./helpers/web-todos-fixture.js";

/** The Study's Todos tab reads the store read-only (src/web/todos-view.ts); the route is in web-study.test.ts. */
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-todos-view-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("web todos view", () => {
  const view = (dir: string, ownerKey?: string, doneTailBytes?: number) => readWebTodos({ dir, ownerKey, groupTitle: () => "A group", doneTailBytes });
  it("shows nothing when no owner is configured, rather than everything", async () => {
    const dir = join(root, "data", "todos");
    seedTodos(dir);
    expect(await view(dir)).toMatchObject({ items: [], recent: [], moreResolved: false, openTotal: 4, limits: { maxOpen: DEFAULT_TODOS.maxOpen, maxSnoozes: DEFAULT_TODOS.maxSnoozes } });
    expect((await view(dir, "dm:owner")).items.map((i) => i.id)).toEqual(["t-3", "t-4", "t-5"]);
    // A group key is not an owner: it would see only its own item.
    expect((await view(dir, "telegram:-2")).items.map((i) => i.id)).toEqual(["t-5"]);
  });
  it("caps the done log at the newest entries and skips lines that are not whole records", async () => {
    const dir = join(root, "data", "todos");
    const store = new TodoStore(dir, { ...DEFAULT_TODOS, maxOpen: 100 });
    for (let i = 0; i < 25; i++) {
      const item = store.add({ title: `Item ${i}`, next: "Do it", waiting_on: "me", session: "dm:owner", source: "self" }, NOW - 30 * DAY);
      store.resolve(item.id, { action: "done", by: "self" }, NOW - (25 - i) * DAY);
    }
    writeFileSync(join(dir, "done.ndjson"), readFileSync(join(dir, "done.ndjson"), "utf8")
      + JSON.stringify({ id: "t-90", session: "dm:owner", title: "HALF-RECORD" }) + "\n" + '{"id":"t-91","session":"dm:ow');
    const value = await view(dir, "dm:owner");
    expect(value.moreResolved).toBe(true);
    expect(value.recent).toHaveLength(20);
    expect(value.recent[0]).toMatchObject({ id: "t-25", title: "Item 24", resolvedAt: NOW - DAY });
    expect(JSON.stringify(value)).not.toContain("HALF-RECORD");
    expect(parseResolutions(readFileSync(join(dir, "done.ndjson"), "utf8")).map((r) => r.id).slice(0, 2)).toEqual(["t-1", "t-2"]);
  });

  it("an incomplete line does not hide a later whole record of the same id", async () => {
    const dir = join(root, "data", "todos");
    seedTodos(dir);
    const log = readFileSync(join(dir, "done.ndjson"), "utf8");
    const good = log.split("\n").find((line) => line.includes('"id":"t-1"'))!;
    // Parseable, has the two fields the store's own dedupe looks at, but is not a resolution.
    const bad = JSON.stringify({ id: "t-1", session: "dm:owner" });
    writeFileSync(join(dir, "done.ndjson"), `${bad}\n${log}`);
    expect(parseResolutions(`${bad}\n${good}\n`)).toEqual([JSON.parse(good)]);
    // Checked before deduping, so the first WHOLE record of an id wins, not the first line.
    expect(parseResolutions(`${bad}\n${good}\n${good.replace('"done"', '"drop"')}\n`).map((r) => r.resolution)).toEqual(["done"]);
    expect((await view(dir, "dm:owner")).recent.map((r) => [r.id, r.resolution])).toEqual([["t-2", "drop"], ["t-1", "done"]]);
    // The store's own read path is unchanged: the same open items as before.
    expect(new TodoStore(dir, DEFAULT_TODOS).list().map((i) => i.id)).toEqual(["t-3", "t-4", "t-5", "t-6"]);
  });

  it("reads only the end of the done log, however long it has grown", async () => {
    const dir = join(root, "data", "todos");
    seedTodos(dir);
    const record = (n: number) => JSON.stringify({ id: `t-${n}`, title: `Old ${n}`, next: "x", waiting_on: "me", review_at: new Date(NOW).toISOString(), session: "dm:owner",
      created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), source: "self", snoozes: 0,
      resolution: "done", resolved_at: new Date(NOW - 400 * DAY + n * 60_000).toISOString(), resolved_by: "self" });
    const lines = Array.from({ length: 3000 }, (_, i) => record(1000 + i));
    writeFileSync(join(dir, "done.ndjson"), lines.join("\n") + "\n");
    const tail = lines.slice(-30).join("\n").length + 10; // the last 30 records and a fragment of the one before
    const value = await view(dir, "dm:owner", tail);
    expect(value.moreResolved).toBe(true);
    expect(value.recent.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `t-${3999 - i}`));
    // Bounded for real: a tail that holds five records yields five, not twenty dug out of the rest.
    const five = await view(dir, "dm:owner", lines.slice(-5).join("\n").length + 10);
    expect(five.recent.map((r) => r.id)).toEqual(["t-3999", "t-3998", "t-3997", "t-3996", "t-3995"]);
    expect(five.moreResolved).toBe(true);
    // The default bound holds too: 3000 records are well over it, and the answer is the same.
    expect(statSync(join(dir, "done.ndjson")).size).toBeGreaterThan(256 * 1024);
    expect((await view(dir, "dm:owner")).recent.map((r) => r.id)).toEqual(value.recent.map((r) => r.id));
    // An interrupted close (logged, still in todos.json) reads as closed.
    const open = JSON.parse(readFileSync(join(dir, "todos.json"), "utf8")) as { items: Array<Record<string, unknown>> };
    writeFileSync(join(dir, "done.ndjson"), lines.join("\n") + "\n" + JSON.stringify({ ...open.items[0], resolution: "done", resolved_at: new Date(NOW).toISOString(), resolved_by: "self" }) + "\n");
    const healed = await view(dir, "dm:owner");
    expect(healed.items.map((i) => i.id)).toEqual(["t-4", "t-5"]);
    expect(healed.openTotal).toBe(3);
    expect(healed.recent[0]).toMatchObject({ id: "t-3", resolution: "done" });
  });
});
