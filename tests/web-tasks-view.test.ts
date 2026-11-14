import { describe, expect, it } from "vitest";
import { buildTaskView, runningCount, elapsed, formatElapsed, lastStep, MAX_TASK_DEPTH, replaceSessionTasks, taskKind } from "../web/src/tasks.js";
import type { WebSession, WebTask } from "../src/web/protocol.js";

const session = (id: string, title: string, kind: "dm" | "group"): WebSession =>
  ({ id, title, kind, writable: kind === "dm", lastActiveAt: null, stats: { contextUsed: 0, contextMax: 0 } });
const sessions = [session("g2", "Zebra group", "group"), session("dm", "Owner conversation", "dm"), session("g1", "Alpha group", "group")];
const task = (taskId: string, extra: Partial<WebTask> = {}): WebTask => ({
  sessionId: "dm", taskId, taskType: "local_agent", description: taskId, ambient: false, startedAt: 0, state: "running", ...extra });
const rows = (view: ReturnType<typeof buildTaskView>, i = 0) => view.groups[i].rows.map((r) => `${r.task.taskId}@${r.depth}`);

describe("task panel view", () => {
  it("groups by session: the DM first, then groups by title", () => {
    const view = buildTaskView([task("x", { sessionId: "g2" }), task("y", { sessionId: "g1" }), task("z")], sessions, false);
    expect(view.groups.map((g) => g.title)).toEqual(["Owner conversation", "Alpha group", "Zebra group"]);
    expect(buildTaskView([task("q", { sessionId: "unknown" })], sessions, false).groups[0].title).toBe("Conversation");
  });

  it("nests by parentTaskId; a missing parent makes a top-level row", () => {
    const view = buildTaskView([
      task("child", { parentTaskId: "root", startedAt: 2 }), task("root", { startedAt: 1 }),
      task("grand", { parentTaskId: "child", startedAt: 3 }), task("orphan", { parentTaskId: "gone", startedAt: 4 }),
    ], sessions, false);
    expect(rows(view)).toEqual(["root@0", "child@1", "grand@2", "orphan@0"]);
  });

  it("caps depth and survives a parent cycle", () => {
    const chain = Array.from({ length: 8 }, (_, i) => task(`t${i}`, { startedAt: i, ...(i ? { parentTaskId: `t${i - 1}` } : {}) }));
    expect(buildTaskView(chain, sessions, false).groups[0].rows.at(-1)!.depth).toBe(MAX_TASK_DEPTH);
    const cycle = buildTaskView([task("a", { parentTaskId: "b" }), task("b", { parentTaskId: "a" })], sessions, false);
    expect(cycle.groups[0].rows).toHaveLength(2);
  });

  it("hides ambient tasks by default and counts them; the toggle shows them", () => {
    const list = [task("w", { ambient: true }), task("c", { parentTaskId: "w" })];
    const hidden = buildTaskView(list, sessions, false);
    expect(rows(hidden)).toEqual(["c@0"]);
    expect(hidden.hiddenAmbient).toBe(1);
    expect(rows(buildTaskView(list, sessions, true))).toEqual(["w@0", "c@1"]);
    expect(buildTaskView([task("w", { ambient: true })], sessions, false).groups).toEqual([]);
  });

  it("counts only running tasks; ended ones stop the clock", () => {
    const view = buildTaskView([task("a"), task("b", { state: "completed", endedAt: 30_000 })], sessions, false);
    expect(view.running).toBe(1);
    expect(elapsed(task("b", { startedAt: 1_000, endedAt: 31_000 }), 99_000)).toBe(30_000);
    expect(elapsed(task("a", { startedAt: 1_000 }), 4_500)).toBe(3_500);
  });

  it("formats elapsed time, kind and last step", () => {
    expect([formatElapsed(-5), formatElapsed(9_999), formatElapsed(65_000), formatElapsed(3_725_000)]).toEqual(["0s", "9s", "1m 05s", "1h 02m"]);
    expect(taskKind(task("a", { subagentType: "Explore" }))).toBe("Explore");
    expect(taskKind(task("a", { taskType: "local_bash" }))).toBe("shell");
    expect(taskKind(task("a", { taskType: "something_new" }))).toBe("something_new");
    expect(lastStep(task("a"))).toBeUndefined();
    expect(lastStep(task("a", { lastTool: "Grep", toolUses: 3 }))).toBe("Grep · 3 tool uses");
    expect(lastStep(task("a", { lastTool: "Grep", summary: "Reading the config" }))).toBe("Reading the config");
  });

  it("a tasks update replaces one session and keeps the others", () => {
    const old = [task("a"), task("b", { sessionId: "g1" })];
    expect(replaceSessionTasks(old, "dm", [task("c")]).map((t) => t.taskId)).toEqual(["b", "c"]);
    expect(replaceSessionTasks(old, "g1", []).map((t) => t.taskId)).toEqual(["a"]);
  });

  it("the topbar count includes running, non-ambient tasks only", () => {
    expect(runningCount([task("a"), task("b", { ambient: true }), task("c", { state: "completed", endedAt: 1 }), task("d", { sessionId: "g1" })])).toBe(2);
  });
});
