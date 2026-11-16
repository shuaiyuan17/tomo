import type { SessionTaskList } from "../web/tasks.js";
import type { WebTask } from "../web/protocol.js";

/** Ended tasks the default `/tasks` reply lists; `/tasks all` lists every one from today. */
export const RECENT_ENDED_LIMIT = 5;
/** Characters of a task's description shown per line. */
export const TASK_DESCRIPTION_LIMIT = 40;

const KINDS: Record<string, string> = {
  local_agent: "agent", local_bash: "bash", local_workflow: "workflow", monitor: "monitor",
  mcp_task: "mcp", remote_agent: "remote agent",
};
const MARKS: Record<WebTask["state"], string> = {
  running: "▶", completed: "✓", ended: "✓", failed: "✗", stopped: "■",
};

/** Local midnight of `now`'s day: where "today" starts for `/tasks`. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function clock(at: number, timeZone?: string): string {
  return new Date(at).toLocaleTimeString("en-US", { ...(timeZone ? { timeZone } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function describe(task: WebTask): string {
  const text = task.description.replace(/\s+/g, " ").trim() || "(no description)";
  const chars = [...text];
  return chars.length <= TASK_DESCRIPTION_LIMIT ? text : `${chars.slice(0, TASK_DESCRIPTION_LIMIT).join("").trimEnd()}…`;
}

/**
 * The `/tasks` reply: plain text (no markdown — iMessage shows it raw), one
 * line per task. Every running task; then the RECENT_ENDED_LIMIT most recent
 * ended ones from `list.ended` (all of them with `all`).
 */
export function formatTaskList(list: SessionTaskList, options: { now: number; all?: boolean; timeZone?: string }): string {
  const { running, ended } = list;
  if (!running.length && !ended.length) return "No tasks running.";
  const failed = ended.filter((task) => task.state === "failed").length;
  const header = `Tasks · ${running.length} running, ${ended.length - failed} done${failed ? `, ${failed} failed` : ""} today`;
  const lines = [header];
  for (const task of running) {
    const last = task.lastActiveAt !== undefined ? ` · last ${clock(task.lastActiveAt, options.timeZone)}` : "";
    lines.push(`${MARKS.running} ${describe(task)} · ${KINDS[task.taskType] ?? task.taskType} · ${duration(options.now - task.startedAt)}${last}`);
  }
  const shown = options.all ? ended : ended.slice(0, RECENT_ENDED_LIMIT);
  for (const task of shown) {
    const end = task.endedAt ?? options.now;
    lines.push(`${MARKS[task.state]} ${describe(task)} · ${KINDS[task.taskType] ?? task.taskType} · ${duration(end - task.startedAt)} · ${clock(end, options.timeZone)}`);
  }
  if (shown.length < ended.length) lines.push(`… ${ended.length - shown.length} more today (/tasks all)`);
  return lines.join("\n");
}
