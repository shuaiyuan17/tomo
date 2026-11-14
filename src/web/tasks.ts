import { clip, type TaskEndStatus, type WatchTask } from "../watch/protocol.js";
import type { WebTask } from "./protocol.js";

/** An ended task stays on the board this long, shown as ended, then goes. */
export const TASK_RETENTION_MS = 60_000;
/** Per session; live tasks are kept before ended ones. */
export const MAX_SESSION_TASKS = 64;
/** Across all sessions, so the snapshot below has a fixed worst-case size. */
export const MAX_BOARD_TASKS = 128;
/** Description length in the snapshot (live updates carry up to 200). */
export const SNAPSHOT_DESCRIPTION_LIMIT = 80;
/**
 * Worst-case JSON size of `snapshot()`: MAX_BOARD_TASKS compact entries, each
 * well under 2 KiB even when every string is escaped. channels/web.ts reserves
 * this much of the snapshot IPC frame, so the snapshot is never truncated and
 * the browser can treat it as the complete list.
 */
export const MAX_SNAPSHOT_TASK_BYTES = MAX_BOARD_TASKS * 2 * 1024;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const LABEL_LIMIT = 40;

export interface TaskBoardOptions {
  now?: () => number;
  retainMs?: number;
}

/**
 * The daemon-side state behind the web "working now" panel: each visible
 * session's live tasks (REPLACE, from the `tasks` watch event) plus tasks that
 * ended within the retention window. Runs in the daemon so a browser that
 * connects late still sees what just finished. Publishes one session's full
 * list whenever it changes.
 */
export class TaskBoard {
  private sessions = new Map<string, Map<string, WebTask>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly retainMs: number;

  constructor(private readonly publish: (sessionId: string, tasks: WebTask[]) => void, options: TaskBoardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retainMs = options.retainMs ?? TASK_RETENTION_MS;
  }

  /**
   * Every task on the board (complete: the board itself is capped), in a
   * compact form — short description, no progress summary — whose size is
   * bounded by MAX_SNAPSHOT_TASK_BYTES. Summaries return with the next
   * per-session update. `visible` drops sessions the browser may not read.
   */
  snapshot(visible: (sessionId: string) => boolean = () => true): WebTask[] {
    return [...this.sessions].filter(([sessionId]) => visible(sessionId)).flatMap(([, tasks]) => [...tasks.values()])
      .map(({ summary: _summary, ...task }) => ({ ...task, description: clip(task.description, SNAPSHOT_DESCRIPTION_LIMIT) }));
  }

  /** Forget a session's tasks (its source changed); the browser is told. */
  clear(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.publish(sessionId, []);
    this.schedule();
  }

  apply(sessionId: string, live: WatchTask[], ended: { taskId: string; status: TaskEndStatus }[] = []): void {
    const now = this.now();
    const old = this.sessions.get(sessionId) ?? new Map<string, WebTask>();
    const next = new Map<string, WebTask>();
    for (const task of live) {
      // Bounded fields keep the snapshot size a guarantee (see above).
      if (!TASK_ID.test(task.taskId)) continue;
      const previous = old.get(task.taskId);
      const reported = task.status;
      next.set(task.taskId, {
        sessionId,
        taskId: task.taskId,
        taskType: clip(task.taskType, LABEL_LIMIT),
        ...(task.subagentType ? { subagentType: clip(task.subagentType, LABEL_LIMIT) } : {}),
        description: clip(task.description, 200),
        ...(task.parentTaskId && TASK_ID.test(task.parentTaskId) ? { parentTaskId: task.parentTaskId } : {}),
        ambient: task.ambient,
        startedAt: task.startedAt,
        // The end report can arrive while the task is still in the SDK's set.
        state: reported ?? "running",
        ...(reported ? { endedAt: previous?.endedAt ?? now } : {}),
        ...(task.lastTool ? { lastTool: clip(task.lastTool, LABEL_LIMIT) } : {}),
        ...(task.summary ? { summary: clip(task.summary, 200) } : {}),
        ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {}),
        ...(task.toolUses !== undefined ? { toolUses: task.toolUses } : {}),
      });
    }
    for (const [id, task] of old) {
      if (next.has(id)) continue;
      // Left the live set: keep it, ended, for the retention window.
      next.set(id, task.state === "running" ? { ...task, state: "ended", endedAt: now } : task);
    }
    for (const report of ended) {
      const task = next.get(report.taskId);
      if (task && task.state === "ended") next.set(task.taskId, { ...task, state: report.status });
    }
    this.store(sessionId, old, next);
  }

  /** Drop expired ended tasks now. Exposed for the timer and for tests. */
  prune(): void {
    for (const [sessionId, tasks] of [...this.sessions]) this.store(sessionId, tasks, new Map(tasks));
  }

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }

  private store(sessionId: string, old: Map<string, WebTask>, next: Map<string, WebTask>): void {
    const now = this.now();
    for (const [id, task] of next) {
      if (task.endedAt !== undefined && task.state !== "running" && now - task.endedAt >= this.retainMs) next.delete(id);
    }
    let others = 0;
    for (const [id, tasks] of this.sessions) if (id !== sessionId) others += tasks.size;
    const allowed = Math.max(0, Math.min(MAX_SESSION_TASKS, MAX_BOARD_TASKS - others));
    let list = [...next.values()];
    if (list.length > allowed) {
      const live = list.filter((task) => task.endedAt === undefined);
      const done = list.filter((task) => task.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!);
      list = [...live, ...done].slice(0, allowed);
    }
    const kept = new Map(list.map((task) => [task.taskId, task]));
    if (kept.size) this.sessions.set(sessionId, kept); else this.sessions.delete(sessionId);
    if (JSON.stringify([...old.values()]) !== JSON.stringify(list)) this.publish(sessionId, list.map((task) => ({ ...task })));
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let next = Infinity;
    for (const tasks of this.sessions.values()) {
      for (const task of tasks.values()) if (task.endedAt !== undefined) next = Math.min(next, task.endedAt + this.retainMs);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.prune(); }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }
}
