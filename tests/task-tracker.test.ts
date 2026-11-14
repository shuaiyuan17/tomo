import { describe, expect, it } from "vitest";
import { isTaskSystemMessage, MAX_TRACKED_TASKS, TASK_TEXT_LIMIT, TaskTracker } from "../src/agent/task-tracker.js";

function tracker() {
  let now = 1_000;
  const t = new TaskTracker(() => now);
  return { t, tick: (ms: number) => { now += ms; } };
}
const level = (...tasks: Array<Record<string, unknown>>) => ({ subtype: "background_tasks_changed" as const, tasks: tasks as never });
const ids = (t: TaskTracker) => t.list().map((task) => task.taskId);

describe("TaskTracker — background_tasks_changed (REPLACE)", () => {
  it("adds, keeps and removes tasks exactly as each payload says", () => {
    const { t, tick } = tracker();
    t.apply(level({ task_id: "a", task_type: "local_agent", subagent_type: "Explore", description: "map the repo" }));
    expect(t.list()).toEqual([{ taskId: "a", taskType: "local_agent", subagentType: "Explore", description: "map the repo",
      ambient: false, background: true, startedAt: 1_000 }]);
    tick(5_000);
    // Replace: a stays (first-seen time kept), b joins.
    t.apply(level({ task_id: "a", task_type: "local_agent", description: "map the repo" }, { task_id: "b", task_type: "local_bash", description: "npm test" }));
    expect(ids(t)).toEqual(["a", "b"]);
    expect(t.list().find((task) => task.taskId === "a")!.startedAt).toBe(1_000);
    expect(t.list().find((task) => task.taskId === "b")!.startedAt).toBe(6_000);
    // Replace with a set that lacks a: a is gone, without any end edge.
    const change = t.apply(level({ task_id: "b", task_type: "local_bash", description: "npm test" }));
    expect(ids(t)).toEqual(["b"]);
    expect(change!.tasks.map((task) => task.taskId)).toEqual(["b"]);
    t.apply(level());
    expect(t.list()).toEqual([]);
  });

  it("keeps the ambient flag and parent link so consumers can filter and nest", () => {
    const { t } = tracker();
    t.apply(level({ task_id: "w", task_type: "monitor", description: "watch", ambient: true },
      { task_id: "c", task_type: "local_agent", description: "child", parent_task_id: "p" }));
    expect(t.list()).toMatchObject([{ taskId: "w", ambient: true }, { taskId: "c", ambient: false, parentTaskId: "p" }]);
  });

  it("a newer run of the same task restarts its clock; a late frame of an older run is ignored", () => {
    const { t, tick } = tracker();
    t.apply(level({ task_id: "a", run_id: "r2", task_type: "local_agent", description: "x" }));
    tick(1_000);
    t.apply({ subtype: "task_progress", task_id: "a", run_id: "r1", description: "x", last_tool_name: "Old", usage: { total_tokens: 1, tool_uses: 1 } } as never);
    expect(t.list()[0].lastTool).toBeUndefined();
    t.apply(level({ task_id: "a", run_id: "r3", task_type: "local_agent", description: "x" }));
    expect(t.list()[0]).toMatchObject({ runId: "r3", startedAt: 2_000 });
  });

  it("a level entry naming an older run does not move the run id back", () => {
    const { t } = tracker();
    t.apply(level({ task_id: "a", run_id: "r2", task_type: "local_agent", description: "x" }));
    t.apply(level({ task_id: "a", run_id: "r1", task_type: "local_agent", description: "stale" }));
    expect(t.list()[0]).toMatchObject({ runId: "r2", description: "x" });
    // So r1's progress and end report are still recognised as late.
    expect(t.apply({ subtype: "task_progress", task_id: "a", run_id: "r1", description: "x", last_tool_name: "Old" })).toBeUndefined();
    expect(t.apply({ subtype: "task_notification", task_id: "a", run_id: "r1", status: "failed" })).toBeUndefined();
    expect(t.list()[0].status).toBeUndefined();
  });

  it("clips text and bounds the number of tracked tasks", () => {
    const { t } = tracker();
    t.apply(level({ task_id: "a", task_type: "local_agent", description: "y".repeat(5_000) }));
    expect(t.list()[0].description.length).toBe(TASK_TEXT_LIMIT + 1);
    t.apply(level(...Array.from({ length: 200 }, (_, i) => ({ task_id: `t${i}`, task_type: "local_bash", description: "d" }))));
    expect(t.list()).toHaveLength(MAX_TRACKED_TASKS);
  });
});

describe("TaskTracker — edge events", () => {
  it("tracks a foreground subagent from task_started until its end report, never carrying the prompt", () => {
    const { t } = tracker();
    t.apply({ subtype: "task_started", task_id: "f", task_type: "local_agent", subagent_type: "Plan", description: "plan it",
      is_backgrounded: false, prompt: "SECRET PROMPT" } as never);
    expect(t.list()).toMatchObject([{ taskId: "f", background: false, subagentType: "Plan" }]);
    expect(JSON.stringify(t.list())).not.toContain("SECRET");
    // A background level change does not drop a foreground task.
    t.apply(level());
    expect(ids(t)).toEqual(["f"]);
    const change = t.apply({ subtype: "task_notification", task_id: "f", status: "completed", usage: { total_tokens: 9, tool_uses: 2 } });
    expect(change).toEqual({ tasks: [], ended: [{ taskId: "f", status: "completed" }] });
  });

  it("drops foreground tasks when the turn ends, and ignores background task_started not in the level", () => {
    const { t } = tracker();
    t.apply({ subtype: "task_started", task_id: "bg", description: "already done", is_backgrounded: true });
    expect(t.list()).toEqual([]);
    t.apply({ subtype: "task_started", task_id: "f", description: "x", is_backgrounded: false });
    expect(t.endTurn()).toEqual({ tasks: [], ended: [] });
    expect(t.endTurn()).toBeUndefined();
  });

  it("records progress (last tool, summary, usage) and only reports visible changes", () => {
    const { t } = tracker();
    t.apply(level({ task_id: "a", task_type: "local_agent", description: "x" }));
    const first = t.apply({ subtype: "task_progress", task_id: "a", description: "x", last_tool_name: "Grep", summary: "Searching  for\nusages", usage: { total_tokens: 10, tool_uses: 1 } });
    expect(first!.tasks[0]).toMatchObject({ lastTool: "Grep", summary: "Searching for usages", totalTokens: 10, toolUses: 1 });
    // Only the token count moved: no event, but the count is kept.
    expect(t.apply({ subtype: "task_progress", task_id: "a", description: "x", last_tool_name: "Grep", summary: "Searching for usages", usage: { total_tokens: 50, tool_uses: 1 } })).toBeUndefined();
    expect(t.list()[0].totalTokens).toBe(50);
    expect(t.apply({ subtype: "task_progress", task_id: "unknown", description: "x", usage: { total_tokens: 1, tool_uses: 1 } })).toBeUndefined();
  });

  it("carries an end status reported before or after the task leaves the level", () => {
    const { t } = tracker();
    t.apply(level({ task_id: "a", task_type: "local_agent", description: "x" }, { task_id: "b", task_type: "local_agent", description: "y" }));
    // Notification first (the usual order): status rides on the record, then the level removes it.
    t.apply({ subtype: "task_notification", task_id: "a", status: "failed" });
    expect(t.list().find((task) => task.taskId === "a")!.status).toBe("failed");
    expect(t.apply(level({ task_id: "b", task_type: "local_agent", description: "y" }))!.ended).toEqual([{ taskId: "a", status: "failed" }]);
    // Level first: the late notification is forwarded as an end report.
    t.apply(level());
    expect(t.apply({ subtype: "task_notification", task_id: "b", status: "stopped" })).toEqual({ tasks: [], ended: [{ taskId: "b", status: "stopped" }] });
  });

  it("task_updated backgrounds a foreground task and ends it on a terminal status", () => {
    const { t } = tracker();
    t.apply({ subtype: "task_started", task_id: "f", description: "x", is_backgrounded: false });
    t.apply({ subtype: "task_updated", task_id: "f", patch: { is_backgrounded: true } });
    expect(t.list()[0].background).toBe(true);
    expect(t.endTurn()).toBeUndefined();
    t.apply({ subtype: "task_started", task_id: "g", description: "y", is_backgrounded: false });
    expect(t.apply({ subtype: "task_updated", task_id: "g", patch: { status: "killed" } })!.ended).toEqual([{ taskId: "g", status: "stopped" }]);
  });

  it("reset() empties the set (the CLI process is gone)", () => {
    const { t } = tracker();
    expect(t.reset()).toBeUndefined();
    t.apply(level({ task_id: "a", task_type: "local_agent", description: "x" }));
    expect(t.reset()).toEqual({ tasks: [], ended: [] });
  });

  it("recognises only the task system subtypes", () => {
    expect(isTaskSystemMessage({ type: "system", subtype: "task_progress" })).toBe(true);
    expect(isTaskSystemMessage({ type: "system", subtype: "compact_boundary" })).toBe(false);
    expect(isTaskSystemMessage({ type: "assistant", subtype: "task_progress" })).toBe(false);
  });
});
