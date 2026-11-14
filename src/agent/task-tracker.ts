import { clip, type TaskEndStatus, type WatchTask } from "../watch/protocol.js";

/** Text carried per task is short: it renders as one or two lines. */
export const TASK_TEXT_LIMIT = 200;
/** A runaway session cannot grow one `tasks` event without bound. */
export const MAX_TRACKED_TASKS = 64;
/** How long an ended foreground run is remembered (as long as the panel keeps it). */
export const TOMBSTONE_MS = 60_000;

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
  /**
   * Foreground runs that already ended, by `task_id` + `run_id`, so a late
   * `task_started` of that same run cannot bring the row back.
   */
  private tombstones = new Map<string, number>();

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
      this.bury(task);
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

  /** Drop an ended foreground task and remember its run. */
  private bury(task: WatchTask): void {
    this.tasks.delete(task.taskId);
    const now = this.now();
    for (const [key, at] of this.tombstones) if (now - at >= TOMBSTONE_MS) this.tombstones.delete(key);
    this.tombstones.set(`${task.taskId}\0${task.runId ?? ""}`, now);
  }
  private buried(taskId: string, runId: string | undefined): boolean {
    const at = this.tombstones.get(`${taskId}\0${runId ?? ""}`);
    return at !== undefined && this.now() - at < TOMBSTONE_MS;
  }

  private change(ended: TaskChange["ended"]): TaskChange { return { tasks: this.list(), ended }; }

  /**
   * The one rule for every edge event (start, progress, updated,
   * notification): the task as that frame should see it, or undefined when
   * the task is unknown or the frame names an older run (late).
   */
  private edge(taskId: string, runId: string | undefined): WatchTask | undefined {
    const old = this.tasks.get(taskId);
    if (!old || this.late(old, runId)) return undefined;
    return this.advance(old, runId);
  }

  /**
   * Any frame naming a newer run moves the task to it — not only the level —
   * so that an end report of the older run, arriving after, is seen as late.
   * A new run starts clean: its clock, progress and end status are its own.
   */
  private advance(task: WatchTask, runId: string | undefined): WatchTask {
    if (!runId || task.runId === runId) return task;
    if (!task.runId) return { ...task, runId };
    const fresh: WatchTask = { ...task, runId, startedAt: this.now() };
    for (const key of ["status", "lastTool", "summary", "totalTokens", "toolUses"] as const) delete fresh[key];
    return fresh;
  }

  private late(task: WatchTask, runId: string | undefined): boolean {
    // sdk.d.ts (run_id): "The run ids of one task sort, by plain string
    // comparison, in the order the runs opened; a frame that names a run
    // sorting before the one a reader shows is late." The id only advances.
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
      // An entry naming an older run than the one shown is late: the task
      // stays live, but nothing about it (above all its run id) goes back.
      if (old && this.late(old, entry.run_id)) continue;
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
      const current = this.edge(message.task_id, message.run_id);
      if (!current) return undefined;
      this.tasks.set(old.taskId, { ...current,
        ...(message.subagent_type && !current.subagentType ? { subagentType: message.subagent_type } : {}),
        ...(message.parent_task_id && !current.parentTaskId ? { parentTaskId: message.parent_task_id } : {}),
        taskType: current.taskType || message.task_type || "",
        description: current.description || text(message.description) });
      return this.change([]);
    }
    // A background task joins the level before its task_started. One that is
    // not in the level by now has already finished, so only a foreground
    // start creates a row.
    if (message.is_backgrounded !== false || this.tasks.size >= MAX_TRACKED_TASKS) return undefined;
    // A late start of a foreground run that already ended does not revive it.
    if (this.buried(message.task_id, message.run_id)) return undefined;
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
    const current = this.edge(message.task_id, message.run_id);
    if (!old || !current) return undefined;
    const next: WatchTask = { ...current,
      ...(message.last_tool_name ? { lastTool: clip(message.last_tool_name, 128) } : {}),
      ...(message.summary ? { summary: text(message.summary) } : {}),
      ...(typeof message.usage?.total_tokens === "number" ? { totalTokens: message.usage.total_tokens } : {}),
      ...(typeof message.usage?.tool_uses === "number" ? { toolUses: message.usage.tool_uses } : {}),
    };
    if (current === old && old.lastTool === next.lastTool && old.summary === next.summary && old.toolUses === next.toolUses) {
      // Token counts alone tick on every frame; carry them without an event.
      this.tasks.set(old.taskId, next);
      return undefined;
    }
    this.tasks.set(old.taskId, next);
    return this.change([]);
  }

  private applyUpdated(message: Extract<TaskSystemMessage, { subtype: "task_updated" }>): TaskChange | undefined {
    const old = this.tasks.get(message.task_id);
    const current = this.edge(message.task_id, message.run_id);
    if (!old || !current) return undefined;
    const patch = message.patch ?? {};
    // As for notifications: once this run has ended, its end is not rewritten.
    const status = current.status ? undefined : endStatus(patch.status);
    if (status && !current.background) {
      this.bury(current);
      return this.change([{ taskId: old.taskId, status }]);
    }
    this.tasks.set(old.taskId, { ...current,
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
    const current = this.edge(message.task_id, message.run_id);
    if (!current) return undefined;
    // The first end of a run is final: a repeated or conflicting late report
    // (completed, then failed) changes nothing.
    if (current.status) {
      // Still record what this frame taught us (a run id the record lacked).
      if (current === old) return undefined;
      this.tasks.set(old.taskId, current);
      return this.change([]);
    }
    const usage = {
      ...(typeof message.usage?.total_tokens === "number" ? { totalTokens: message.usage.total_tokens } : {}),
      ...(typeof message.usage?.tool_uses === "number" ? { toolUses: message.usage.tool_uses } : {}),
    };
    if (!current.background) {
      this.bury(current);
      return this.change([{ taskId: old.taskId, status }]);
    }
    // Still in the level: it leaves with the next background_tasks_changed.
    // The status is terminal for this run; only a newer run clears it.
    this.tasks.set(old.taskId, { ...current, ...usage, status });
    return this.change([]);
  }
}
