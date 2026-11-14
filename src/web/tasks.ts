import { clip, type TaskEndStatus, type WatchTask } from "../watch/protocol.js";
import type { WebTask } from "./protocol.js";

/** An ended task stays on the board this long, shown as ended, then goes. */
export const TASK_RETENTION_MS = 60_000;
/** Per session; live tasks are kept before ended ones. */
export const MAX_SESSION_TASKS = 64;
/** Across all sessions, so the snapshot below has a fixed worst-case size. */
export const MAX_BOARD_TASKS = 128;
/** Text length in the snapshot (live updates carry up to 200). */
export const SNAPSHOT_DESCRIPTION_LIMIT = 80;
export const SNAPSHOT_SUMMARY_LIMIT = 120;
/**
 * Worst-case JSON size of `snapshot()`: MAX_BOARD_TASKS compact entries, each
 * well under 3 KiB even when every string is escaped. channels/web.ts reserves
 * this much of the snapshot IPC frame, so the snapshot is never truncated and
 * the browser can treat it as the complete list.
 */
export const MAX_SNAPSHOT_TASK_BYTES = MAX_BOARD_TASKS * 3 * 1024;
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
  /** Everything known, per session (bounded by MAX_SESSION_TASKS). */
  private sessions = new Map<string, Map<string, WebTask>>();
  /** What the browser was last sent, per session (bounded by MAX_BOARD_TASKS). */
  private shown = new Map<string, WebTask[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly retainMs: number;

  constructor(private readonly publish: (sessionId: string, tasks: WebTask[]) => void, options: TaskBoardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retainMs = options.retainMs ?? TASK_RETENTION_MS;
  }

  /**
   * Exactly what the browser has been sent (the visible board), in a compact
   * form — short description and summary — whose size is bounded by
   * MAX_SNAPSHOT_TASK_BYTES, so it is never truncated. `visible` drops
   * sessions the browser may not read.
   */
  snapshot(visible: (sessionId: string) => boolean = () => true): WebTask[] {
    return [...this.shown].filter(([sessionId]) => visible(sessionId)).flatMap(([, tasks]) => tasks)
      .map((task) => ({ ...task, description: clip(task.description, SNAPSHOT_DESCRIPTION_LIMIT),
        ...(task.summary !== undefined ? { summary: clip(task.summary, SNAPSHOT_SUMMARY_LIMIT) } : {}) }));
  }

  /** Forget a session's tasks (its source changed); the browser is told at once. */
  clear(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.refresh();
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
    this.store(sessionId, next);
  }

  /** Drop expired ended tasks now. Exposed for the timer and for tests. */
  prune(): void { this.refresh(); }

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }

  private store(sessionId: string, next: Map<string, WebTask>): void {
    // Per session, live tasks first, then the most recently ended.
    const list = [...next.values()];
    const live = list.filter((task) => task.endedAt === undefined);
    const done = list.filter((task) => task.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!);
    const kept = [...live, ...done].slice(0, MAX_SESSION_TASKS);
    if (kept.length) this.sessions.set(sessionId, new Map(kept.map((task) => [task.taskId, task])));
    else this.sessions.delete(sessionId);
    this.refresh();
  }

  /**
   * Expire ended tasks, share the board's capacity fairly, and publish every
   * session whose visible list changed. Capacity goes to running tasks first,
   * round-robin across sessions so one busy session cannot crowd out another;
   * ended tasks fill what is left. A running task that does not fit stays
   * stored here and appears as soon as there is room.
   */
  private refresh(): void {
    const now = this.now();
    for (const [sessionId, tasks] of [...this.sessions]) {
      for (const [id, task] of tasks) {
        if (task.endedAt !== undefined && task.state !== "running" && now - task.endedAt >= this.retainMs) tasks.delete(id);
      }
      if (!tasks.size) this.sessions.delete(sessionId);
    }
    const ids = [...this.sessions.keys()].sort();
    const picked = new Map<string, WebTask[]>(ids.map((id) => [id, []]));
    let room = MAX_BOARD_TASKS;
    for (const ended of [false, true]) {
      const queues = ids.map((id) => {
        const tasks = [...this.sessions.get(id)!.values()].filter((task) => (task.endedAt !== undefined) === ended);
        return { id, tasks: ended ? tasks.sort((a, b) => b.endedAt! - a.endedAt!) : tasks.sort((a, b) => a.startedAt - b.startedAt) };
      });
      for (let round = 0; room > 0 && queues.some((q) => q.tasks.length > round); round++) {
        for (const queue of queues) {
          if (room > 0 && queue.tasks[round]) { picked.get(queue.id)!.push(queue.tasks[round]); room--; }
        }
      }
    }
    for (const id of new Set([...this.shown.keys(), ...picked.keys()])) {
      const list = picked.get(id) ?? [];
      const before = this.shown.get(id) ?? [];
      if (JSON.stringify(before) === JSON.stringify(list)) continue;
      if (list.length) this.shown.set(id, list); else this.shown.delete(id);
      this.publish(id, list.map((task) => ({ ...task })));
    }
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
