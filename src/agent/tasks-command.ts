import type { SessionTaskList } from "../web/tasks.js";
import type { WebTask } from "../web/protocol.js";
import { joinText, ownerT, type Locale, type OwnerT, type OwnerText } from "../i18n/index.js";

/** Ended tasks the default `/tasks` reply lists; `/tasks all` lists every one from today. */
export const RECENT_ENDED_LIMIT = 5;
/** Characters of a task's description shown per line. */
export const TASK_DESCRIPTION_LIMIT = 40;

function kindLabel(t: OwnerT<"tasks">, taskType: string): string {
  switch (taskType) {
    case "local_agent": return t("kind.agent");
    case "local_bash": return t("kind.bash");
    case "local_workflow": return t("kind.workflow");
    case "monitor": return t("kind.monitor");
    case "mcp_task": return t("kind.mcp");
    case "remote_agent": return t("kind.remoteAgent");
    default: return taskType;
  }
}
const MARKS: Record<WebTask["state"], string> = {
  running: "▶", completed: "✓", ended: "✓", failed: "✗", stopped: "■",
};

/** Local midnight of `now`'s day: where "today" starts for `/tasks`. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function duration(t: OwnerT<"tasks">, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return t("seconds", { n: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t("minutes", { n: minutes });
  return t("hoursMinutes", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

function clock(at: number, locale: Locale | undefined, timeZone?: string): string {
  // Unset: the 24-hour US clock /tasks has always used.
  return new Date(at).toLocaleTimeString(locale ?? "en-US", { ...(timeZone ? { timeZone } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function describe(t: OwnerT<"tasks">, task: WebTask): string {
  const text = task.description.replace(/\s+/g, " ").trim() || t("noDescription");
  const chars = [...text];
  return chars.length <= TASK_DESCRIPTION_LIMIT ? text : `${chars.slice(0, TASK_DESCRIPTION_LIMIT).join("").trimEnd()}…`;
}

/**
 * The `/tasks` reply: plain text (no markdown — iMessage shows it raw), one
 * line per task. Every running task; then the RECENT_ENDED_LIMIT most recent
 * ended ones from `list.ended` (all of them with `all`).
 */
/** `locale`: config `locale`; undefined (unset) is English text and the clock /tasks always used. */
export function formatTaskList(list: SessionTaskList, options: { now: number; all?: boolean; timeZone?: string; locale?: Locale }): OwnerText {
  const locale = options.locale;
  const t = ownerT("tasks", locale ?? "en");
  const { running, ended } = list;
  if (!running.length && !ended.length) return t("none");
  const failed = ended.filter((task) => task.state === "failed").length;
  const lines = [failed
    ? t("headerFailed", { running: running.length, done: ended.length - failed, failed })
    : t("header", { running: running.length, done: ended.length - failed })];
  for (const task of running) {
    const line = { mark: MARKS.running, description: describe(t, task), kind: kindLabel(t, task.taskType), duration: duration(t, options.now - task.startedAt) };
    lines.push(task.lastActiveAt !== undefined
      ? t("runningLast", { ...line, at: clock(task.lastActiveAt, locale, options.timeZone) })
      : t("running", line));
  }
  const shown = options.all ? ended : ended.slice(0, RECENT_ENDED_LIMIT);
  for (const task of shown) {
    const end = task.endedAt ?? options.now;
    lines.push(t("ended", { mark: MARKS[task.state], description: describe(t, task), kind: kindLabel(t, task.taskType), duration: duration(t, end - task.startedAt), at: clock(end, locale, options.timeZone) }));
  }
  if (shown.length < ended.length) lines.push(t("more", { count: ended.length - shown.length }));
  return joinText(lines);
}
