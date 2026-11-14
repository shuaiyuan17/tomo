import { clip, type TaskEndStatus, type WatchTask } from "../watch/protocol.js";

/** Text carried per task is short: it renders as one or two lines. */
export const TASK_TEXT_LIMIT = 200;
/** A runaway session cannot grow one `tasks` event without bound. */
export const MAX_TRACKED_TASKS = 64;

interface LevelEntry {
  task_id: string; run_id?: string; task_type?: string; subagent_type?: string;
  description?: string; parent_task_id?: string; ambient?: boolean;
}
type Usage = { total_tokens?: number; tool_uses?: number };
/** The SDK `system` subtypes this tracker reads, with only the fields it uses. */
export type TaskSystemMessage =
  | { subtype: "background_tasks_changed"; tasks?: LevelEntry[] }
  | { subtype: "task_started"; task_id: string; run_id?: string; task_type?: string; subagent_type?: string;
      description?: string; parent_task_id?: string; ambient?: boolean; is_backgrounded?: boolean }
  | { subtype: "task_progress"; task_id: string; run_id?: string; subagent_type?: string; description?: string;
      last_tool_name?: string; summary?: string; usage?: Usage }
  | { subtype: "task_updated"; task_id: string; run_id?: string;
      patch?: { status?: string; description?: string; is_backgrounded?: boolean } }
  | { subtype: "task_notification"; task_id: string; run_id?: string; status?: string; usage?: Usage };

export interface TaskChange { tasks: WatchTask[]; ended: { taskId: string; status: TaskEndStatus }[] }

const TRACKED = new Set(["background_tasks_changed", "task_started", "task_progress", "task_updated", "task_notification"]);
export function isTaskSystemMessage(event: { type?: string; subtype?: string }): boolean {
  return event.type === "system" && typeof event.subtype === "string" && TRACKED.has(event.subtype);
}

function endStatus(value: string | undefined): TaskEndStatus | undefined {
  if (value === "completed" || value === "failed" || value === "stopped") return value;
  if (value === "killed") return "stopped";
  return undefined;
}
const text = (value: string | undefined) => clip((value ?? "").replace(/\s+/g, " ").trim(), TASK_TEXT_LIMIT);

/**
 * Merges the SDK's task streams into one per-session list.
 *
 * The background set comes from `background_tasks_changed`, a LEVEL with
 * REPLACE semantics: a background task is live exactly while it is in the
 * latest payload, so a missed edge cannot leave a stale row. Foreground
 * subagents (a blocking Agent call) are not in that set; they are added on
 * `task_started` with `is_backgrounded: false` and dropped on their end report
 * or when the turn ends (a blocking call cannot outlive its turn). The edge
 * events only ever enrich a known task: progress, usage, the end status.
 *
 * Every method returns the new state when something visible changed, else
 * undefined, so the caller publishes only real changes.
 */
export class TaskTracker {
  private tasks = new Map<string, WatchTask>();

  constructor(private readonly now: () => number = Date.now) {}

  list(): WatchTask[] { return [...this.tasks.values()].map((task) => ({ ...task })); }

  apply(message: TaskSystemMessage): TaskChange | undefined {
    switch (message.subtype) {
      case "background_tasks_changed": return this.applyLevel(message.tasks ?? []);
      case "task_started": return this.applyStarted(message);
      case "task_progress": return this.applyProgress(message);
      case "task_updated": return this.applyUpdated(message);
      case "task_notification": return this.applyNotification(message);
    }
  }

  /** The turn ended: no foreground task can still be running. */
  endTurn(): TaskChange | undefined {
    const ended: TaskChange["ended"] = [];
    let removed = false;
    for (const task of [...this.tasks.values()]) {
      if (task.background) continue;
      this.tasks.delete(task.taskId);
      removed = true;
      if (task.status) ended.push({ taskId: task.taskId, status: task.status });
    }
    return removed ? this.change(ended) : undefined;
  }

  /** The CLI process is gone: its task set is gone with it. */
  reset(): TaskChange | undefined {
    if (this.tasks.size === 0) return undefined;
    this.tasks.clear();
    return this.change([]);
  }

  private change(ended: TaskChange["ended"]): TaskChange { return { tasks: this.list(), ended }; }

  private late(task: WatchTask, runId: string | undefined): boolean {
    // Run ids of one task sort in the order the runs opened; an older one is a late frame.
    return !!runId && !!task.runId && runId < task.runId;
  }

  private applyLevel(entries: LevelEntry[]): TaskChange {
    const seen = new Set<string>();
    const ended: TaskChange["ended"] = [];
    const foreground = [...this.tasks.values()].filter((task) => !task.background).length;
    for (const entry of entries) {
      if (typeof entry?.task_id !== "string" || seen.has(entry.task_id)) continue;
      if (seen.size + foreground >= MAX_TRACKED_TASKS) break;
      seen.add(entry.task_id);
      const old = this.tasks.get(entry.task_id);
      const newRun = !!old && !!entry.run_id && !!old.runId && entry.run_id > old.runId;
      const base: WatchTask = old && !newRun ? old : { taskId: entry.task_id, taskType: "", description: "",
        ambient: false, background: true, startedAt: this.now() };
      this.tasks.set(entry.task_id, {
        ...base,
        ...(entry.run_id ? { runId: entry.run_id } : {}),
        taskType: entry.task_type ?? base.taskType,
        ...(entry.subagent_type ? { subagentType: entry.subagent_type } : {}),
        description: entry.description !== undefined ? text(entry.description) : base.description,
        ...(entry.parent_task_id ? { parentTaskId: entry.parent_task_id } : {}),
        ambient: entry.ambient === true,
        background: true,
      });
    }
    for (const task of [...this.tasks.values()]) {
      if (task.background && !seen.has(task.taskId)) {
        this.tasks.delete(task.taskId);
        if (task.status) ended.push({ taskId: task.taskId, status: task.status });
      }
    }
    return this.change(ended);
  }

  private applyStarted(message: Extract<TaskSystemMessage, { subtype: "task_started" }>): TaskChange | undefined {
    const old = this.tasks.get(message.task_id);
    if (old) {
      if (this.late(old, message.run_id)) return undefined;
      this.tasks.set(old.taskId, { ...old,
        ...(message.subagent_type && !old.subagentType ? { subagentType: message.subagent_type } : {}),
        ...(message.parent_task_id && !old.parentTaskId ? { parentTaskId: message.parent_task_id } : {}),
        taskType: old.taskType || message.task_type || "",
        description: old.description || text(message.description) });
      return this.change([]);
    }
    // A background task joins the level before its task_started. One that is
    // not in the level by now has already finished, so only a foreground
    // start creates a row.
    if (message.is_backgrounded !== false || this.tasks.size >= MAX_TRACKED_TASKS) return undefined;
    this.tasks.set(message.task_id, {
      taskId: message.task_id,
      ...(message.run_id ? { runId: message.run_id } : {}),
      taskType: message.task_type ?? "local_agent",
      ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
      description: text(message.description),
      ...(message.parent_task_id ? { parentTaskId: message.parent_task_id } : {}),
      ambient: message.ambient === true,
      background: false,
      startedAt: this.now(),
    });
    return this.change([]);
  }

  private applyProgress(message: Extract<TaskSystemMessage, { subtype: "task_progress" }>): TaskChange | undefined {
    const old = this.tasks.get(message.task_id);
    if (!old || this.late(old, message.run_id)) return undefined;
    const next: WatchTask = { ...old,
      ...(message.last_tool_name ? { lastTool: clip(message.last_tool_name, 128) } : {}),
      ...(message.summary ? { summary: text(message.summary) } : {}),
      ...(typeof message.usage?.total_tokens === "number" ? { totalTokens: message.usage.total_tokens } : {}),
      ...(typeof message.usage?.tool_uses === "number" ? { toolUses: message.usage.tool_uses } : {}),
    };
    if (old.lastTool === next.lastTool && old.summary === next.summary && old.toolUses === next.toolUses) {
      // Token counts alone tick on every frame; carry them without an event.
      this.tasks.set(old.taskId, next);
      return undefined;
    }
    this.tasks.set(old.taskId, next);
    return this.change([]);
  }

  private applyUpdated(message: Extract<TaskSystemMessage, { subtype: "task_updated" }>): TaskChange | undefined {
    const old = this.tasks.get(message.task_id);
    if (!old || this.late(old, message.run_id)) return undefined;
    const patch = message.patch ?? {};
    const status = endStatus(patch.status);
    if (status && !old.background) {
      this.tasks.delete(old.taskId);
      return this.change([{ taskId: old.taskId, status }]);
    }
    this.tasks.set(old.taskId, { ...old,
      ...(patch.description ? { description: text(patch.description) } : {}),
      ...(patch.is_backgrounded ? { background: true } : {}),
      ...(status ? { status } : {}) });
    return this.change([]);
  }

  private applyNotification(message: Extract<TaskSystemMessage, { subtype: "task_notification" }>): TaskChange | undefined {
    const status = endStatus(message.status);
    if (!status) return undefined;
    const old = this.tasks.get(message.task_id);
    if (!old) return { tasks: this.list(), ended: [{ taskId: message.task_id, status }] };
    if (this.late(old, message.run_id)) return undefined;
    const usage = {
      ...(typeof message.usage?.total_tokens === "number" ? { totalTokens: message.usage.total_tokens } : {}),
      ...(typeof message.usage?.tool_uses === "number" ? { toolUses: message.usage.tool_uses } : {}),
    };
    if (!old.background) {
      this.tasks.delete(old.taskId);
      return this.change([{ taskId: old.taskId, status }]);
    }
    // Still in the level: it leaves with the next background_tasks_changed.
    this.tasks.set(old.taskId, { ...old, ...usage, status });
    return this.change([]);
  }
}
