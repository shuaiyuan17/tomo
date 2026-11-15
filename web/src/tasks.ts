import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { isShellTask } from "./shell.js";

/** Render logic for the Tasks panel, kept pure so it is testable. */

/**
 * A task row, or — for two or more finished shell commands under the same
 * parent — one folded row ("3 shell commands done") listing them in `folded`.
 */
export interface TaskRow { task: WebTask; depth: number; folded?: WebTask[];
  /** Stable key of a folded row: its parent's id (listed or not), or "root". */
  foldKey?: string }
export interface TaskGroup { sessionId: string; title: string; kind: "dm" | "group"; rows: TaskRow[] }
export interface TaskView { groups: TaskGroup[]; running: number; hiddenAmbient: number }

/** Nesting deeper than this is drawn at this depth (narrow screens). */
export const MAX_TASK_DEPTH = 4;

/** A `tasks` event replaces one session's list and leaves the others. */
export function replaceSessionTasks(old: WebTask[], sessionId: string, tasks: WebTask[]): WebTask[] {
  return [...old.filter((task) => task.sessionId !== sessionId), ...tasks];
}

const TASK_TYPES: Record<string, string> = {
  local_agent: "subagent", local_bash: "shell", local_workflow: "workflow", monitor: "monitor",
  mcp_task: "MCP task", remote_agent: "remote agent",
};
export function taskKind(task: WebTask): string {
  return task.subagentType || TASK_TYPES[task.taskType] || task.taskType || "task";
}

export const STATE_LABELS: Record<WebTask["state"], string> = {
  running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", ended: "Ended",
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Ended tasks stop the clock at their end time. */
export function elapsed(task: WebTask, now: number): number {
  return (task.endedAt ?? now) - task.startedAt;
}

/** What a running task is doing now, when progress reported anything. */
export function lastStep(task: WebTask): string | undefined {
  if (task.summary) return task.summary;
  if (task.lastTool) return `${task.lastTool}${task.toolUses ? ` · ${task.toolUses} tool uses` : ""}`;
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
    return { sessionId, title: session?.title ?? "Conversation", kind: session?.kind ?? "group", rows: tree(list) };
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
  const rows: TaskRow[] = [];
  const placed = new Set<string>();
  const visit = (task: WebTask, depth: number) => {
    if (placed.has(task.taskId)) return;
    placed.add(task.taskId);
    rows.push({ task, depth: Math.min(depth, MAX_TASK_DEPTH) });
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
