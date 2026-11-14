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
  /**
   * Called ONCE per send (see `publish`) to take one snapshot of who may see
   * what; the function it returns routes each stored slot (e.g. a session
   * key) to its browser session id, or undefined while hidden. Every slot in
   * one send is routed by the same snapshot, so a rule change mid-send cannot
   * merge two sources into one browser session. Never cached across sends:
   * nothing sent can be taken back. Hidden slots keep receiving events.
   */
  router?: () => (slot: string) => string | undefined;
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

  private readonly router: () => (slot: string) => string | undefined;

  constructor(private readonly send: (sessionId: string, tasks: WebTask[]) => void, options: TaskBoardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retainMs = options.retainMs ?? TASK_RETENTION_MS;
    this.router = options.router ?? (() => (slot) => slot);
  }

  /**
   * The reconnect snapshot: passes the same gate as every update, then
   * returns exactly what the browser now holds, in a compact form (short
   * description and summary) bounded by MAX_SNAPSHOT_TASK_BYTES, so it is
   * never truncated.
   */
  snapshot(): WebTask[] {
    this.publish();
    return [...this.shown.values()].flat()
      .map((task) => ({ ...task, description: clip(task.description, SNAPSHOT_DESCRIPTION_LIMIT),
        ...(task.summary !== undefined ? { summary: clip(task.summary, SNAPSHOT_SUMMARY_LIMIT) } : {}) }));
  }


  /**
   * A task the browser can see right now, by its browser session id: the
   * slot it is stored under and its type. Uses the same one-snapshot router
   * as `publish`, so nothing hidden from the panel can be opened.
   */
  locate(sessionId: string, taskId: string): { slot: string; task: WebTask } | undefined {
    const route = this.router();
    for (const [slot, tasks] of this.sessions) {
      if (route(slot) !== sessionId) continue;
      const task = tasks.get(taskId);
      if (task) return { slot, task: { ...task, sessionId } };
    }
    return undefined;
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

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }

  private store(sessionId: string, next: Map<string, WebTask>): void {
    // Per session, live tasks first, then the most recently ended.
    const list = [...next.values()];
    const live = list.filter((task) => task.endedAt === undefined);
    const done = list.filter((task) => task.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!);
    const kept = [...live, ...done].slice(0, MAX_SESSION_TASKS);
    if (kept.length) this.sessions.set(sessionId, new Map(kept.map((task) => [task.taskId, task])));
    else this.sessions.delete(sessionId);
    this.publish();
  }

  /**
   * THE GATE. Every send to the browser — after an event, a capacity change,
   * the retention timer, an owner-key re-check, or a reconnect snapshot —
   * goes through here, and nowhere else calls `send`.
   *
   * It expires ended tasks, routes each stored slot once, now, and shares
   * the board's capacity among the slots the browser may see only: running
   * non-ambient tasks first, round-robin across sessions so one busy session
   * cannot crowd out another; ended tasks next; watchers last. A session that
   * is not visible is sent as empty. A running task that does not fit stays
   * stored and appears as soon as there is room.
   */
  publish(): void {
    const now = this.now();
    for (const [sessionId, tasks] of [...this.sessions]) {
      for (const [id, task] of tasks) {
        if (task.endedAt !== undefined && task.state !== "running" && now - task.endedAt >= this.retainMs) tasks.delete(id);
      }
      if (!tasks.size) this.sessions.delete(sessionId);
    }
    const route = this.router();
    const targets = new Map<string, string>();
    for (const slot of this.sessions.keys()) {
      const target = route(slot);
      if (target !== undefined) targets.set(slot, target);
    }
    const ids = [...targets.keys()].sort();
    const picked = new Map<string, WebTask[]>(ids.map((id) => [id, []]));
    let room = MAX_BOARD_TASKS;
    // Activity first: running, then recently ended; watchers (ambient) only
    // get what is left, so they never take a running task's place.
    for (const [ambient, ended] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const queues = ids.map((id) => {
        const tasks = [...this.sessions.get(id)!.values()]
          .filter((task) => (task.endedAt !== undefined) === ended && task.ambient === ambient);
        return { id, tasks: ended ? tasks.sort((a, b) => b.endedAt! - a.endedAt!) : tasks.sort((a, b) => a.startedAt - b.startedAt) };
      });
      for (let round = 0; room > 0 && queues.some((q) => q.tasks.length > round); round++) {
        for (const queue of queues) {
          if (room > 0 && queue.tasks[round]) { picked.get(queue.id)!.push(queue.tasks[round]); room--; }
        }
      }
    }
    const out = new Map<string, WebTask[]>();
    for (const [slot, tasks] of picked) {
      const target = targets.get(slot)!;
      out.set(target, [...(out.get(target) ?? []), ...tasks.map((task) => ({ ...task, sessionId: target }))]);
    }
    for (const id of new Set([...this.shown.keys(), ...out.keys()])) {
      const list = out.get(id) ?? [];
      const before = this.shown.get(id) ?? [];
      if (JSON.stringify(before) === JSON.stringify(list)) continue;
      if (list.length) this.shown.set(id, list); else this.shown.delete(id);
      this.send(id, list.map((task) => ({ ...task })));
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
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }
}
