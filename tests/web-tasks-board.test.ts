import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BOARD_TASKS, MAX_SESSION_TASKS, SNAPSHOT_DESCRIPTION_LIMIT, SNAPSHOT_SUMMARY_LIMIT, TASK_RETENTION_MS, TaskBoard } from "../src/web/tasks.js";
import type { WatchTask } from "../src/watch/protocol.js";
import type { WebTask } from "../src/web/protocol.js";

const task = (taskId: string, extra: Partial<WatchTask> = {}): WatchTask => ({
  taskId, taskType: "local_agent", description: `task ${taskId}`, ambient: false, background: true, startedAt: 0, ...extra });

function board() {
  const published: Array<[string, WebTask[]]> = [];
  const b = new TaskBoard((sessionId, tasks) => published.push([sessionId, tasks]), { now: () => Date.now() });
  return { b, published };
}
afterEach(() => vi.useRealTimers());

describe("TaskBoard", () => {
  it("replaces one session's live set and pushes that session's full list", () => {
    const { b, published } = board();
    b.apply("s1", [task("a"), task("b")]);
    b.apply("s2", [task("c")]);
    expect(published.map(([id, tasks]) => [id, tasks.map((t) => `${t.taskId}:${t.state}`)])).toEqual([
      ["s1", ["a:running", "b:running"]], ["s2", ["c:running"]]]);
    b.apply("s1", [task("a")]);
    expect(published.at(-1)![0]).toBe("s1");
    expect(published.at(-1)![1].map((t) => `${t.taskId}:${t.state}`)).toEqual(["a:running", "b:ended"]);
    // Snapshot: every session.
    expect(b.snapshot().map((t) => t.taskId)).toEqual(["a", "b", "c"]);
    // An unchanged payload publishes nothing.
    const count = published.length;
    b.apply("s2", [task("c")]);
    expect(published.length).toBe(count);
    b.dispose();
  });

  it("keeps an ended task for the retention window, then removes it and publishes", () => {
    vi.useFakeTimers({ now: 10_000 });
    const { b, published } = board();
    b.apply("s1", [task("a", { startedAt: 1_000 })]);
    vi.advanceTimersByTime(4_000);
    b.apply("s1", []);
    expect(b.snapshot()).toMatchObject([{ taskId: "a", state: "ended", endedAt: 14_000 }]);
    vi.advanceTimersByTime(TASK_RETENTION_MS - 1);
    expect(b.snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(b.snapshot()).toEqual([]);
    expect(published.at(-1)).toEqual(["s1", []]);
    b.dispose();
  });

  it("applies the reported end status whichever arrives first", () => {
    vi.useFakeTimers({ now: 0 });
    const { b } = board();
    b.apply("s", [task("a"), task("b")]);
    // Status while still live: shown as ended at once, clock stopped.
    vi.advanceTimersByTime(2_000);
    b.apply("s", [task("a", { status: "failed" }), task("b")]);
    vi.advanceTimersByTime(2_000);
    b.apply("s", [task("b")]);
    // Status after it left: patches the generic "ended".
    b.apply("s", [], [{ taskId: "b", status: "completed" }]);
    expect(b.snapshot().map((t) => [t.taskId, t.state, t.endedAt]).sort()).toEqual([["a", "failed", 2_000], ["b", "completed", 4_000]]);
    b.dispose();
  });

  it("keeps the ambient flag; the snapshot is compact and complete; the board is capped across sessions", () => {
    const { b } = board();
    b.apply("s", [task("w", { ambient: true, summary: "progress text" }), task("x", { description: "d".repeat(200) })]);
    const snap = b.snapshot();
    expect(snap.find((t) => t.taskId === "w")).toMatchObject({ ambient: true });
    expect(snap.find((t) => t.taskId === "w")!.summary).toBe("progress text");
    expect(snap.find((t) => t.taskId === "x")!.description.length).toBe(SNAPSHOT_DESCRIPTION_LIMIT + 1);
    for (let i = 0; i < 5; i++) b.apply(`g${i}`, Array.from({ length: 60 }, (_, n) => task(`t${i}-${n}`)));
    expect(b.snapshot()).toHaveLength(MAX_BOARD_TASKS);
    // The watcher in "s" yields its place to running work elsewhere.
    expect(b.snapshot((id) => id === "s").map((t) => t.taskId)).toEqual(["x"]);
    b.dispose();
  });

  it("keeps a clipped summary in the snapshot, so a reconnect still shows it", () => {
    const { b } = board();
    b.apply("s", [task("a", { summary: "s".repeat(200) })]);
    expect(b.snapshot()[0].summary).toBe(`${"s".repeat(SNAPSHOT_SUMMARY_LIMIT)}…`);
    b.dispose();
  });

  it("shares capacity fairly, running tasks before ended ones, and restores a crowded-out running task", () => {
    vi.useFakeTimers({ now: 0 });
    const { b, published } = board();
    // Session "a" fills the board with ended tasks, then many running ones.
    b.apply("a", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`old${i}`)));
    b.apply("a", []);
    b.apply("b", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`b${i}`, { startedAt: i })));
    b.apply("c", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`c${i}`, { startedAt: i })));
    const late = Array.from({ length: 10 }, (_, i) => task(`z${i}`, { startedAt: 100 + i }));
    b.apply("z", late);
    const shown = b.snapshot();
    expect(shown).toHaveLength(MAX_BOARD_TASKS);
    // Running tasks win over ended ones, and the last session still gets all of its running tasks.
    expect(shown.filter((t) => t.state === "running")).toHaveLength(MAX_BOARD_TASKS);
    expect(shown.filter((t) => t.sessionId === "z")).toHaveLength(10);
    const counts = ["b", "c"].map((id) => shown.filter((t) => t.sessionId === id).length);
    expect(Math.abs(counts[0] - counts[1])).toBeLessThanOrEqual(1);
    const hidden = Array.from({ length: MAX_SESSION_TASKS }, (_, i) => `b${i}`).find((id) => !shown.some((t) => t.taskId === id))!;
    expect(hidden).toBeDefined();
    // Room frees up: the crowded-out running task is published without any event of its own session.
    b.apply("c", []);
    vi.advanceTimersByTime(TASK_RETENTION_MS);
    expect(b.snapshot().some((t) => t.taskId === hidden)).toBe(true);
    expect(published.filter(([id]) => id === "b").at(-1)![1].some((t) => t.taskId === hidden)).toBe(true);
    b.dispose();
  });

  it("ambient tasks never take a running task's place", () => {
    const { b } = board();
    b.apply("a", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`w${i}`, { ambient: true })));
    b.apply("b", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`b${i}`)));
    b.apply("c", Array.from({ length: MAX_SESSION_TASKS }, (_, i) => task(`c${i}`)));
    const shown = b.snapshot();
    expect(shown).toHaveLength(MAX_BOARD_TASKS);
    expect(shown.filter((t) => t.ambient)).toHaveLength(0);
    b.apply("c", []);
    // Ended tasks still outrank watchers; watchers fill only what is left.
    expect(b.snapshot().filter((t) => !t.ambient)).toHaveLength(MAX_BOARD_TASKS);
    b.dispose();
  });

  it("drops tasks with unbounded ids and clear() empties one session", () => {
    const { b, published } = board();
    b.apply("s", [task("ok", { parentTaskId: "p".repeat(500) }), task("x".repeat(500))]);
    expect(b.snapshot().map((t) => [t.taskId, t.parentTaskId])).toEqual([["ok", undefined]]);
    b.clear("s");
    expect(published.at(-1)).toEqual(["s", []]);
    expect(b.snapshot()).toEqual([]);
    b.dispose();
  });
});
