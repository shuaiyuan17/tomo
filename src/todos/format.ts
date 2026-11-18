import { canManageJob } from "../cron/scope.js";
import { compareByReview, type TodoItem } from "./store.js";

/**
 * May `callerKey` see and resolve `item`? The cron rule (`canManageJob`),
 * applied to the session that created the item: its own session always; a
 * canonical owner DM additionally sees group items; a group sees only its
 * own. `undefined` is an unscoped surface (the CLI).
 */
export function canSeeTodo(item: Pick<TodoItem, "session">, callerKey?: string): boolean {
  return canManageJob({ sessionKey: item.session }, callerKey);
}

/** `2026-11-20`, in the process's local time. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One plain-text line per item: id, title, next step, who acts, review date. */
export function formatTodoLine(item: TodoItem, now: number, maxSnoozes?: number): string {
  const overdue = Date.parse(item.review_at) <= now;
  const snoozed = item.snoozes > 0 ? ` · snoozed ${item.snoozes}${maxSnoozes ? `/${maxSnoozes}` : ""}` : "";
  const next = item.next !== item.title ? ` · next: ${item.next}` : "";
  const ref = item.ref ? ` · ${item.ref}` : "";
  return `${item.id} ${item.title}${next} · waiting on ${item.waiting_on} · ${overdue ? "due" : "review"} ${shortDate(item.review_at)}${snoozed}${ref}`;
}

/**
 * `tomo todo due`: the `max` longest-overdue items, or "" when nothing is due
 * (so a heartbeat script that prints it adds nothing on a quiet day).
 */
export function formatDue(due: TodoItem[], options: { now: number; max: number; maxSnoozes?: number }): string {
  if (due.length === 0) return "";
  const shown = due.slice(0, options.max);
  const lines = [
    `${due.length} todo${due.length === 1 ? "" : "s"} due for review. Resolve each with todo_resolve: done, drop, snooze or handoff.`,
    ...shown.map((item) => formatTodoLine(item, options.now, options.maxSnoozes)),
  ];
  if (due.length > shown.length) lines.push(`(${due.length - shown.length} more due)`);
  return lines.join("\n");
}

/** Items the default `/todo` shows from Tomo's own list. */
export const TODO_LIST_MINE_LIMIT = 10;

/**
 * The `/todo` reply: plain text (iMessage shows markdown raw). What waits on
 * the owner first, then Tomo's own items (the first ten, or all with `all`),
 * then — with `all` — what waits on someone else.
 */
export function formatTodoList(items: TodoItem[], options: { now: number; all?: boolean; maxSnoozes?: number; hints?: boolean }): string {
  if (items.length === 0) return "No open todos.";
  const sorted = [...items].sort(compareByReview);
  const owner = sorted.filter((i) => i.waiting_on === "owner");
  const mine = sorted.filter((i) => i.waiting_on === "me");
  const external = sorted.filter((i) => i.waiting_on === "external");
  const line = (item: TodoItem) => formatTodoLine(item, options.now, options.maxSnoozes);
  const lines = [`Todos · ${items.length} open (${owner.length} waiting on you, ${mine.length} on me, ${external.length} on others)`];
  if (owner.length) lines.push("", "Waiting on you:", ...owner.map(line));
  const mineShown = options.all ? mine : mine.slice(0, TODO_LIST_MINE_LIMIT);
  if (mineShown.length) lines.push("", "Mine:", ...mineShown.map(line));
  if (options.all && external.length) lines.push("", "Waiting on others:", ...external.map(line));
  const hidden = (mine.length - mineShown.length) + (options.all ? 0 : external.length);
  if (hidden > 0) lines.push("", `${hidden} more (/todo all)`);
  if (options.hints !== false) lines.push("", "/todo add <text> · /todo done <id> · /todo drop <id> [reason]");
  return lines.join("\n");
}
