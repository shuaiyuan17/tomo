import { clip, type TaskEndStatus, type WatchTask } from "../watch/protocol.js";
import { redactCommand } from "./redact-command.js";
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
/** Ended tasks kept per session for the `/tasks` chat command (never published). */
export const MAX_SESSION_HISTORY = 100;
/** An ended task older than this leaves the `/tasks` history. */
export const HISTORY_RETENTION_MS = 36 * 60 * 60 * 1000;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** One session's tasks as the `/tasks` chat command reads them (see `TaskBoard.listFor`). */
export interface SessionTaskList {
  /** Running, non-ambient, oldest first. */
  running: Array<WebTask & { lastActiveAt?: number }>;
  /** Ended at or after `since`, non-ambient, newest first. */
  ended: WebTask[];
}
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
  /** For each shown browser session: task id → the slot it came from. */
  private shownSlots = new Map<string, Map<string, string>>();
  /** tool_use id per slot and task (never published; used to read a shell's full command). */
  private toolUses = new Map<string, Map<string, string>>();
  /** Models learned per slot and task (kept across REPLACE updates). */
  private models = new Map<string, Map<string, string>>();
  /**
   * Per slot: tasks that ended, kept past the panel's retention window (up to
   * MAX_SESSION_HISTORY, HISTORY_RETENTION_MS) for the `/tasks` chat command.
   * Fed by the same `apply` as the panel; never published to the browser.
   */
  private history = new Map<string, Map<string, WebTask>>();
  /** Per slot and task: when progress last changed (for `/tasks`; never published). */
  private activity = new Map<string, Map<string, number>>();
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
   * A task the browser can see right now, by its browser session id: exactly
   * the set the last `publish` sent (expiry, the owner rule and the capacity
   * share all applied) — re-run first, so it is current. Returns the slot it
   * is stored under. Nothing the panel does not show can be opened.
   */
  locate(sessionId: string, taskId: string): { slot: string; task: WebTask } | undefined {
    this.publish();
    const slot = this.shownSlots.get(sessionId)?.get(taskId);
    const task = this.shown.get(sessionId)?.find((t) => t.taskId === taskId);
    return slot !== undefined && task ? { slot, task: { ...task } } : undefined;
  }

  /** Record a task's model (read from its transcript) and republish. */
  setModel(slot: string, taskId: string, model: string): void {
    const models = this.models.get(slot) ?? new Map<string, string>();
    if (models.get(taskId) === model) return;
    models.set(taskId, model);
    this.models.set(slot, models);
    const task = this.sessions.get(slot)?.get(taskId);
    if (task) { this.sessions.get(slot)!.set(taskId, { ...task, model }); this.publish(); }
  }

  /** The tool_use id a task was started by, if known. */
  toolUseOf(slot: string, taskId: string): string | undefined { return this.toolUses.get(slot)?.get(taskId); }

  /** Does the board hold any task (live or retained) under a slot `match` accepts? */
  holdsAny(match: (slot: string) => boolean): boolean {
    for (const slot of this.sessions.keys()) if (match(slot)) return true;
    return false;
  }

  /** Whether the board still holds this task (live or recently ended). */
  holds(slot: string, taskId: string): boolean { return this.sessions.get(slot)?.has(taskId) ?? false; }

  /** Whether a task's model is already known. */
  hasModel(slot: string, taskId: string): boolean { return this.models.get(slot)?.has(taskId) ?? false; }

  apply(sessionId: string, live: WatchTask[], ended: { taskId: string; status: TaskEndStatus }[] = []): void {
    const now = this.now();
    const old = this.sessions.get(sessionId) ?? new Map<string, WebTask>();
    const next = new Map<string, WebTask>();
    for (const task of live) {
      // Bounded fields keep the snapshot size a guarantee (see above).
      if (!TASK_ID.test(task.taskId)) continue;
      if (task.toolUseId) { const uses = this.toolUses.get(sessionId) ?? new Map<string, string>(); uses.set(task.taskId, task.toolUseId); this.toolUses.set(sessionId, uses); }
      const previous = old.get(task.taskId);
      const reported = task.status;
      if (previous && (previous.toolUses !== task.toolUses || previous.lastTool !== task.lastTool
        || previous.summary !== task.summary || previous.totalTokens !== task.totalTokens)) {
        const seen = this.activity.get(sessionId) ?? new Map<string, number>();
        seen.set(task.taskId, now);
        this.activity.set(sessionId, seen);
      }
      next.set(task.taskId, {
        sessionId,
        taskId: task.taskId,
        taskType: clip(task.taskType, LABEL_LIMIT),
        ...(task.subagentType ? { subagentType: clip(task.subagentType, LABEL_LIMIT) } : {}),
        ...(this.models.get(sessionId)?.get(task.taskId) ? { model: this.models.get(sessionId)!.get(task.taskId)! } : {}),
        // Shell commands are redacted here, before any send (see redact-command.ts).
        description: clip(task.taskType === "local_bash" ? redactCommand(task.description) : task.description, 200),
        ...(task.parentTaskId && TASK_ID.test(task.parentTaskId) ? { parentTaskId: task.parentTaskId } : {}),
        ambient: task.ambient,
        ...(task.background ? { background: true as const } : {}),
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

  /**
   * One slot's tasks for the `/tasks` chat command: exactly the slot asked
   * for, never another (the caller picks the slot the chat may see). Running
   * tasks come from the panel's live state; ended ones from the panel plus
   * the history kept past its retention window. Ambient tasks (watchers) are
   * left out, as the panel hides them by default.
   */
  listFor(slot: string, since: number): SessionTaskList {
    const activity = this.activity.get(slot);
    const running = [...(this.sessions.get(slot)?.values() ?? [])]
      .filter((task) => task.state === "running" && task.endedAt === undefined && !task.ambient)
      .sort((a, b) => a.startedAt - b.startedAt || a.taskId.localeCompare(b.taskId))
      .map((task) => ({ ...task, ...(activity?.get(task.taskId) !== undefined ? { lastActiveAt: activity.get(task.taskId)! } : {}) }));
    const live = new Set(running.map((task) => task.taskId));
    const ended = [...(this.history.get(slot)?.values() ?? [])]
      // A resumed task (same id) is listed as running, not also as done.
      .filter((task) => !task.ambient && !live.has(task.taskId) && task.endedAt! >= since)
      .sort((a, b) => b.endedAt! - a.endedAt!)
      .map((task) => ({ ...task }));
    return { running, ended };
  }

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }

  private store(sessionId: string, next: Map<string, WebTask>): void {
    // Per session, live tasks first, then the most recently ended.
    const list = [...next.values()];
    // An ended task whose work runs on counts as live here, so the cap never drops it before that work.
    const settled = settledTimes(next);
    const live = list.filter((task) => settled.get(task.taskId) === undefined).sort(capOrder(next));
    const done = list.filter((task) => settled.get(task.taskId) !== undefined).sort(settledOrder(next, settled));
    const kept = [...live, ...done].slice(0, MAX_SESSION_TASKS);
    this.remember(sessionId, list.filter((task) => task.endedAt !== undefined));
    if (kept.length) this.sessions.set(sessionId, new Map(kept.map((task) => [task.taskId, task])));
    else this.sessions.delete(sessionId);
    this.publish();
  }

  /** Record ended tasks (and later status patches) in the slot's `/tasks` history. */
  private remember(slot: string, done: WebTask[]): void {
    const cutoff = this.now() - HISTORY_RETENTION_MS;
    const history = this.history.get(slot) ?? new Map<string, WebTask>();
    for (const task of done) history.set(task.taskId, task);
    const list = [...history.values()].filter((task) => task.endedAt! >= cutoff)
      .sort((a, b) => b.endedAt! - a.endedAt!).slice(0, MAX_SESSION_HISTORY);
    if (list.length) this.history.set(slot, new Map(list.map((task) => [task.taskId, task])));
    else this.history.delete(slot);
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
      const settled = settledTimes(tasks);
      for (const [id, task] of tasks) {
        const at = settled.get(id);
        if (at !== undefined && task.state !== "running" && now - at >= this.retainMs) tasks.delete(id);
      }
      if (!tasks.size) this.sessions.delete(sessionId);
    }
    for (const [slot, uses] of [...this.toolUses]) {
      const tasks = this.sessions.get(slot);
      for (const id of [...uses.keys()]) if (!tasks?.has(id)) uses.delete(id);
      if (!uses.size) this.toolUses.delete(slot);
    }
    for (const [slot, seen] of [...this.activity]) {
      const tasks = this.sessions.get(slot);
      for (const id of [...seen.keys()]) if (tasks?.get(id)?.state !== "running") seen.delete(id);
      if (!seen.size) this.activity.delete(slot);
    }
    for (const [slot, models] of [...this.models]) {
      const tasks = this.sessions.get(slot);
      for (const id of [...models.keys()]) if (!tasks?.has(id)) models.delete(id);
      if (!models.size) this.models.delete(slot);
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
    // Activity first: running (an ended task whose work runs on included),
    // then recently ended; watchers (ambient) only get what is left, so they
    // never take a running task's place.
    const settled = new Map(ids.map((id) => [id, settledTimes(this.sessions.get(id)!)]));
    for (const [ambient, ended] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const queues = ids.map((id) => {
        const at = settled.get(id)!;
        const tasks = [...this.sessions.get(id)!.values()]
          .filter((task) => (at.get(task.taskId) !== undefined) === ended && task.ambient === ambient);
        return { id, tasks: ended ? tasks.sort(settledOrder(this.sessions.get(id)!, at)) : tasks.sort(capOrder(this.sessions.get(id)!)) };
      });
      for (let round = 0; room > 0 && queues.some((q) => q.tasks.length > round); round++) {
        for (const queue of queues) {
          if (room > 0 && queue.tasks[round]) { picked.get(queue.id)!.push(queue.tasks[round]); room--; }
        }
      }
    }
    const out = new Map<string, WebTask[]>();
    const slots = new Map<string, Map<string, string>>();
    for (const [slot, tasks] of picked) {
      const target = targets.get(slot)!;
      out.set(target, [...(out.get(target) ?? []), ...tasks.map((task) => ({ ...task, sessionId: target }))]);
      const bySlot = slots.get(target) ?? new Map<string, string>();
      for (const task of tasks) bySlot.set(task.taskId, slot);
      slots.set(target, bySlot);
    }
    this.shownSlots = slots;
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
      for (const at of settledTimes(tasks).values()) if (at !== undefined) next = Math.min(next, at + this.retainMs);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }
}

/**
 * Unsettled tasks in the order a cap keeps them: those running first (oldest
 * first), then ended ones whose work runs on, deepest in the task tree first
 * (ties: newest first). A parent is only kept once every running task of its
 * session is, and once every ended task between it and that work, so the
 * rail can always trace it to its running work. Parent cycles are cut.
 */
function capOrder(tasks: ReadonlyMap<string, WebTask>): (a: WebTask, b: WebTask) => number {
  const depth = treeDepth(tasks);
  return (a, b) => {
    const ended = Number(a.endedAt !== undefined) - Number(b.endedAt !== undefined);
    if (ended !== 0) return ended;
    if (a.endedAt === undefined) return a.startedAt - b.startedAt;
    return depth(b) - depth(a) || b.startedAt - a.startedAt;
  };
}

/**
 * Settled tasks in the order a cap keeps them: the most recently settled
 * first; on a tie (a parent settles when its last descendant ends) the
 * deeper one first, so a parent is never kept without the task that holds
 * its later settled time.
 */
function settledOrder(tasks: ReadonlyMap<string, WebTask>, settled: ReadonlyMap<string, number | undefined>): (a: WebTask, b: WebTask) => number {
  const depth = treeDepth(tasks);
  return (a, b) => settled.get(b.taskId)! - settled.get(a.taskId)! || depth(b) - depth(a);
}

/** A task's depth in its session's task tree (listed ancestors only; parent cycles cut). */
function treeDepth(tasks: ReadonlyMap<string, WebTask>): (task: WebTask) => number {
  const depths = new Map<string, number>();
  return (task) => {
    const known = depths.get(task.taskId);
    if (known !== undefined) return known;
    let n = 0;
    const seen = new Set([task.taskId]);
    for (let parent = task.parentTaskId; parent && !seen.has(parent) && tasks.has(parent); parent = tasks.get(parent)!.parentTaskId) {
      seen.add(parent);
      n += 1;
    }
    depths.set(task.taskId, n);
    return n;
  };
}

/**
 * When each of a session's tasks settled: its own end, or the last end of the
 * work it started (its listed descendants), whichever is later; undefined
 * while it or any of that work still runs. An ended subagent whose background
 * command runs on stays listed (the rail shows it working) and leaves the
 * retention window after the last of it ends. Ambient descendants (watchers)
 * are not counted, as the rail does not count them (web/src/tasks.ts).
 * Parent cycles are cut.
 */
export function settledTimes(tasks: ReadonlyMap<string, WebTask>): Map<string, number | undefined> {
  const children = new Map<string, WebTask[]>();
  for (const task of tasks.values()) {
    const parent = task.parentTaskId;
    // Watchers (ambient) do not hold their parent: the rail does not show them as its work by default.
    if (parent && parent !== task.taskId && tasks.has(parent) && !task.ambient) children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const result = new Map<string, number | undefined>();
  const visiting = new Set<string>();
  const settle = (task: WebTask): number | undefined => {
    if (result.has(task.taskId)) return result.get(task.taskId);
    if (task.endedAt === undefined || visiting.has(task.taskId)) return task.endedAt;
    visiting.add(task.taskId);
    let at: number | undefined = task.endedAt;
    for (const child of children.get(task.taskId) ?? []) {
      const sub = settle(child);
      if (sub === undefined) { at = undefined; break; }
      at = Math.max(at, sub);
    }
    visiting.delete(task.taskId);
    result.set(task.taskId, at);
    return at;
  };
  for (const task of tasks.values()) settle(task);
  return result;
}
