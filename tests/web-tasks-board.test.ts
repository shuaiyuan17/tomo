import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_RETENTION_MS, TaskBoard } from "../src/web/tasks.js";
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
    // Snapshot: every session, live first.
    expect(b.snapshot().map((t) => t.taskId)).toEqual(["a", "c", "b"]);
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

  it("keeps the ambient flag (the panel filters) and bounds the snapshot by bytes", () => {
    const { b } = board();
    b.apply("s", [task("w", { ambient: true }), ...Array.from({ length: 40 }, (_, i) => task(`t${i}`, { description: "d".repeat(200) }))]);
    expect(b.snapshot().find((t) => t.taskId === "w")!.ambient).toBe(true);
    const small = b.snapshot(2_000);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(2_000);
    expect(small.length).toBeGreaterThan(0);
    b.dispose();
  });
});
