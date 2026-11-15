import { describe, expect, it } from "vitest";
import { buildTaskView, modelLabel, runningCount, elapsed, formatElapsed, lastStep, MAX_TASK_DEPTH, replaceSessionTasks, taskKind, treeGuides } from "../web/src/tasks.js";
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

  it("labels model ids briefly and leaves unknown ids readable", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-haiku-5")).toBe("Haiku 5");
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("3-5-sonnet-20241022");
    expect(modelLabel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("folds two or more finished shell commands under one parent into one row; running ones stay", () => {
    const sh = (id: string, extra: Partial<WebTask> = {}) => task(id, { taskType: "local_bash", parentTaskId: "p", state: "completed", endedAt: 1, ...extra });
    const view = buildTaskView([task("p"), sh("s1", { startedAt: 1 }), sh("s2", { startedAt: 2 }), sh("s3", { startedAt: 3, state: "running", endedAt: undefined }), sh("s4", { startedAt: 4 })], sessions, false);
    const rows = view.groups[0].rows;
    expect(rows.map((r) => r.folded ? `folded:${r.folded.map((t) => t.taskId).join(",")}@${r.depth}` : `${r.task.taskId}@${r.depth}`))
      .toEqual(["p@0", "s3@1", "folded:s1,s2,s4@1"]);
    // A single finished command is not folded.
    const one = buildTaskView([task("p"), sh("s1")], sessions, false).groups[0].rows;
    expect(one.map((r) => r.folded ? "folded" : r.task.taskId)).toEqual(["p", "s1"]);
  });

  it("orphaned finished shells fold per original parent, with keys that survive updates", () => {
    const sh = (id: string, parent: string, startedAt: number) => task(id, { taskType: "local_bash", parentTaskId: parent, state: "completed", endedAt: 1, startedAt });
    const first = buildTaskView([sh("a1", "gone-A", 1), sh("a2", "gone-A", 2), sh("b1", "gone-B", 3), sh("b2", "gone-B", 4)], sessions, false).groups[0].rows;
    expect(first.map((r) => [r.foldKey, r.folded?.map((t) => t.taskId)])).toEqual([["gone-A", ["a1", "a2"]], ["gone-B", ["b1", "b2"]]]);
    const later = buildTaskView([sh("a1", "gone-A", 1), sh("a2", "gone-A", 2), sh("a3", "gone-A", 5), sh("b1", "gone-B", 3), sh("b2", "gone-B", 4)], sessions, false).groups[0].rows;
    expect(later.map((r) => [r.foldKey, r.folded?.length])).toEqual([["gone-A", 3], ["gone-B", 2]]);
    // Parent listed → parent gone: the fold keeps the same key.
    const nested = buildTaskView([task("p"), sh("c1", "p", 1), sh("c2", "p", 2)], sessions, false).groups[0].rows;
    const orphaned = buildTaskView([sh("c1", "p", 1), sh("c2", "p", 2)], sessions, false).groups[0].rows;
    expect([nested.at(-1)!.foldKey, orphaned.at(-1)!.foldKey]).toEqual(["p", "p"]);
  });
});

describe("treeGuides", () => {
  it("a last child's line stops at it; a parent's line passes its earlier children's subtrees", () => {
    // p
    //   a        (more siblings below: line goes on)
    //     a1     (a's last child; p's line passes it on the way to b)
    //   b        (p's last child)
    // q
    expect(treeGuides([0, 1, 2, 1, 0])).toEqual([
      { last: false, through: [] },
      { last: false, through: [] },
      { last: true, through: [1] },
      { last: true, through: [] },
      { last: true, through: [] },
    ]);
  });

  it("a line does not run past a shallower row to a later cousin", () => {
    expect(treeGuides([0, 1, 0, 1]).map((g) => g.last)).toEqual([false, true, true, true]);
    expect(treeGuides([])).toEqual([]);
  });
});
