import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { isShellTask } from "./shell.js";
import { formatLocale, i18n } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: tasks:state.*

/** Render logic for the Tasks panel, kept pure so it is testable. */

/**
 * A task row, or — for two or more finished shell commands under the same
 * parent — one folded row ("3 shell commands done") listing them in `folded`.
 */
export interface TaskRow { task: WebTask; depth: number; folded?: WebTask[];
  /** Stable key of a folded row: its parent's id (listed or not), or "root". */
  foldKey?: string;
  /**
   * Set on a task that itself ended while work it started (a background
   * command, a subagent: any listed descendant) still runs: the row reads as
   * working until the last of it ends.
   */
  childrenRunning?: true;
  /** A task that ended before work it started: when the last of that ended (its row's time runs until then). */
  settledAt?: number }
export interface TaskGroup { sessionId: string; title: string; kind: "dm" | "group"; rows: TaskRow[] }
export interface TaskView { groups: TaskGroup[]; running: number; hiddenAmbient: number }

/** Nesting deeper than this is drawn at this depth (narrow screens). */
export const MAX_TASK_DEPTH = 4;

/** A `tasks` event replaces one session's list and leaves the others. */
export function replaceSessionTasks(old: WebTask[], sessionId: string, tasks: WebTask[]): WebTask[] {
  return [...old.filter((task) => task.sessionId !== sessionId), ...tasks];
}

const TASK_TYPES: Record<string, `tasks:type.${string}`> = {
  local_agent: "tasks:type.local_agent", local_bash: "tasks:type.local_bash", local_workflow: "tasks:type.local_workflow", monitor: "tasks:type.monitor",
  mcp_task: "tasks:type.mcp_task", remote_agent: "tasks:type.remote_agent",
};
export function taskKind(task: WebTask): string {
  // i18n-dynamic: tasks:type.*
  const type = TASK_TYPES[task.taskType] as "tasks:type.local_agent" | undefined;
  return task.subagentType || (type && i18n.t(type)) || task.taskType || i18n.t("tasks:type.task");
}

const STATE_LABELS = {
  running: "tasks:state.running", completed: "tasks:state.completed", failed: "tasks:state.failed", stopped: "tasks:state.stopped", ended: "tasks:state.ended",
} as const satisfies Record<WebTask["state"], string>;
/** A task's state in words: "Running", "Done", "Failed", "Stopped", "Ended". */
export function stateLabel(state: WebTask["state"]): string { return i18n.t(STATE_LABELS[state]); }

/** "1h 02m", "1m 05s", "9s": the clock beside a task, units through Intl, minutes and seconds padded so it does not jump. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const unit = (value: number, unit: "hour" | "minute" | "second", pad = false) =>
    new Intl.NumberFormat(formatLocale(), { style: "unit", unit, unitDisplay: "narrow", minimumIntegerDigits: pad ? 2 : 1 }).format(value);
  const pair = (first: string, second: string) => i18n.t("common:format.unitPair", { first, second });
  if (h) return pair(unit(h, "hour"), unit(m, "minute", true));
  if (m) return pair(unit(m, "minute"), unit(s, "second", true));
  return unit(s, "second");
}

/** Ended tasks stop the clock at their end time. */
export function elapsed(task: WebTask, now: number): number {
  return (task.endedAt ?? now) - task.startedAt;
}

/** A row's time: until now while it or work it started runs, else until the last of it ended. */
export function rowElapsed(row: Pick<TaskRow, "task" | "childrenRunning" | "settledAt">, now: number): number {
  if (row.childrenRunning) return now - row.task.startedAt;
  return (row.settledAt ?? row.task.endedAt ?? now) - row.task.startedAt;
}

/** What a running task is doing now, when progress reported anything. */
export function lastStep(task: WebTask): string | undefined {
  if (task.summary) return task.summary;
  if (task.lastTool) return task.toolUses ? i18n.t("tasks:lastStep", { tool: task.lastTool, count: task.toolUses }) : task.lastTool;
  return undefined;
}

/**
 * Group by session (the owner's DM first, then groups by title), and within a
 * session order tasks as a tree by `parentTaskId`. A parent that is not in the
 * visible list (unknown, pruned, or a hidden ambient task) makes its child a
 * top-level row. Ambient tasks are hidden unless `showAmbient`.
 */
export function buildTaskView(tasks: WebTask[], sessions: WebSession[], showAmbient: boolean): TaskView {
  const visible = tasks.filter((task) => showAmbient || !task.ambient);
  const bySession = new Map<string, WebTask[]>();
  for (const task of visible) bySession.set(task.sessionId, [...(bySession.get(task.sessionId) ?? []), task]);
  const catalog = new Map(sessions.map((session) => [session.id, session]));
  const groups: TaskGroup[] = [...bySession].map(([sessionId, list]) => {
    const session = catalog.get(sessionId);
    return { sessionId, title: session?.title ?? i18n.t("common:nav.conversation"), kind: session?.kind ?? "group", rows: tree(list) };
  });
  groups.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "dm" ? -1 : 1));
  return {
    groups,
    running: visible.filter((task) => task.state === "running").length,
    hiddenAmbient: showAmbient ? 0 : tasks.filter((task) => task.ambient).length,
  };
}

function tree(list: WebTask[]): TaskRow[] {
  const ids = new Set(list.map((task) => task.taskId));
  const children = new Map<string, WebTask[]>();
  const roots: WebTask[] = [];
  for (const task of [...list].sort((a, b) => a.startedAt - b.startedAt || a.taskId.localeCompare(b.taskId))) {
    const parent = task.parentTaskId;
    if (parent && parent !== task.taskId && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), task]);
    else roots.push(task);
  }
  // A task that ended while what it started still runs: running (any
  // descendant), and when the last of them ended. Guarded against parent cycles.
  const settled = new Map<string, { running: boolean; end?: number }>();
  const settle = (task: WebTask, seen: Set<string>): { running: boolean; end?: number } => {
    const known = settled.get(task.taskId);
    if (known) return known;
    if (seen.has(task.taskId)) return { running: false };
    seen.add(task.taskId);
    let running = false;
    let end = task.endedAt;
    const later = (at: number | undefined) => { if (at !== undefined && (end === undefined || at > end)) end = at; };
    for (const child of children.get(task.taskId) ?? []) {
      if (child.state === "running") { running = true; continue; }
      const sub = settle(child, seen);
      if (sub.running) running = true;
      later(child.endedAt);
      later(sub.end);
    }
    const result = { running, ...(end !== undefined ? { end } : {}) };
    settled.set(task.taskId, result);
    return result;
  };
  const rows: TaskRow[] = [];
  const placed = new Set<string>();
  const visit = (task: WebTask, depth: number) => {
    if (placed.has(task.taskId)) return;
    placed.add(task.taskId);
    const row: TaskRow = { task, depth: Math.min(depth, MAX_TASK_DEPTH) };
    if (task.state !== "running" && children.has(task.taskId)) {
      const after = settle(task, new Set());
      if (after.running) row.childrenRunning = true;
      else if (after.end !== undefined && after.end !== task.endedAt) row.settledAt = after.end;
    }
    rows.push(row);
    visitAll(children.get(task.taskId) ?? [], depth + 1, task.taskId);
  };
  // Finished shell commands under one parent fold into a single row after
  // their running siblings; running ones always show.
  // Top-level tasks whose parent left the list are grouped by that parent,
  // never merged with another parent's or with true roots.
  const visitAll = (siblings: WebTask[], depth: number, parentKey: string) => {
    const done = siblings.filter((t) => isShellTask(t.taskType) && t.state !== "running" && !children.has(t.taskId));
    const byParent = new Map<string, WebTask[]>();
    for (const t of done) {
      // Keyed by the parent's id whether or not it is still listed, so the
      // key does not change when a parent leaves (or comes back).
      const key = parentKey || t.parentTaskId || "root";
      byParent.set(key, [...(byParent.get(key) ?? []), t]);
    }
    const folded = new Set<string>();
    for (const list of byParent.values()) if (list.length >= 2) for (const t of list) folded.add(t.taskId);
    for (const sibling of siblings) if (!folded.has(sibling.taskId)) visit(sibling, depth);
    for (const [key, list] of byParent) {
      if (list.length < 2) continue;
      for (const t of list) placed.add(t.taskId);
      rows.push({ task: list[0], depth: Math.min(depth, MAX_TASK_DEPTH), folded: list, foldKey: key });
    }
  };
  visitAll(roots, 0, "");
  // A parent cycle has no root; show its members rather than drop them.
  for (const task of list) visit(task, 0);
  return rows;
}

/**
 * The tree lines of a list of rows drawn top to bottom, given each row's depth. For each row:
 * `last` — no later sibling, so its own line stops at its elbow; `through` — the shallower
 * levels (1 … depth-1) whose line passes this row on its way to a later sibling.
 */
export interface TreeGuide { last: boolean; through: number[] }
export function treeGuides(depths: readonly number[]): TreeGuide[] {
  /** Whether a later row sits at `level` before the list climbs above it. */
  const continues = (from: number, level: number) => {
    for (let j = from + 1; j < depths.length; j++) {
      if (depths[j] < level) return false;
      if (depths[j] === level) return true;
    }
    return false;
  };
  return depths.map((depth, i) => ({
    last: !continues(i, depth),
    through: Array.from({ length: Math.max(0, depth - 1) }, (_, k) => k + 1).filter((level) => continues(i, level)),
  }));
}

/** The topbar badge: running tasks that count as activity (not watchers). */
export function runningCount(tasks: WebTask[]): number {
  return tasks.filter((task) => task.state === "running" && !task.ambient).length;
}

/**
 * A short label for a model id: `claude-opus-5-5` → "Opus 5.5",
 * `claude-fable-5-2` → "Fable 5.2", `claude-sonnet-4-5-20250929` → "Sonnet 4.5".
 * Anything else is shown as is, minus a `claude-` prefix.
 */
export function modelLabel(raw: string): string {
  // A context-window tag (`[1m]`) is not part of the name.
  const id = raw.replace(/\[[^\]]*\]$/, "");
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (match) {
    const [, family, major, minor] = match;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor !== undefined ? `.${minor}` : ""}`;
  }
  return id.replace(/^claude-/, "");
}
