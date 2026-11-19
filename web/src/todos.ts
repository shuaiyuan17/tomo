import type { WebTodoItem, WebTodos } from "../../src/web/protocol.js";
import { safeHref } from "./links.js";

export type WaitingOn = WebTodoItem["waitingOn"];

/** Section order: what needs the owner first, then the agent's own, then what waits on someone else. */
export const WAITING_ORDER: readonly WaitingOn[] = ["owner", "me", "external"];

/** An item is due for review once its review time has passed (the store's rule). */
export function isDue(item: Pick<WebTodoItem, "reviewAt">, now: number): boolean {
  return item.reviewAt <= now;
}

const idNumber = (item: Pick<WebTodoItem, "id">) => Number(item.id.slice(2)) || 0;

/**
 * Soonest review first, ties in id order. Due items are the ones whose review
 * time has passed, so this pins them to the top, longest overdue first.
 * Returns a new array.
 */
export function sortTodos<T extends Pick<WebTodoItem, "id" | "reviewAt">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.reviewAt - b.reviewAt || idNumber(a) - idNumber(b));
}

export interface TodoGroup { waitingOn: WaitingOn; items: WebTodoItem[]; due: number }

/** The open items by who moves next, in WAITING_ORDER, each sorted by `sortTodos`. Empty groups are left out. */
export function groupTodos(items: readonly WebTodoItem[], now: number): TodoGroup[] {
  return WAITING_ORDER.map((waitingOn) => {
    const own = sortTodos(items.filter((item) => item.waitingOn === waitingOn));
    return { waitingOn, items: own, due: own.filter((item) => isDue(item, now)).length };
  }).filter((group) => group.items.length > 0);
}

export type CapState = "ok" | "near" | "full";
export interface TodoSummary {
  /** Open items in the store: what the cap counts. */
  open: number; max: number;
  /** 0–100, for the bar. */
  percent: number;
  /** `near` from 80% of the cap, `full` at or over it. */
  cap: CapState;
  /** Shown items due for review. */
  due: number;
  /** Shown items per section. */
  waiting: Record<WaitingOn, number>;
  /** Open items that are not shown (they belong to a conversation this view may not see). */
  hidden: number;
}

export function summarizeTodos(value: Pick<WebTodos, "items" | "openTotal" | "limits">, now: number): TodoSummary {
  const max = Math.max(1, value.limits.maxOpen);
  const open = Math.max(value.openTotal, value.items.length);
  const waiting: Record<WaitingOn, number> = { owner: 0, me: 0, external: 0 };
  for (const item of value.items) waiting[item.waitingOn]++;
  return {
    open, max, percent: Math.min(100, Math.round(open / max * 100)),
    cap: open >= max ? "full" : open >= max * 0.8 ? "near" : "ok",
    due: value.items.filter((item) => isDue(item, now)).length,
    waiting, hidden: open - value.items.length,
  };
}

const DAY_MS = 86_400_000;
/** Whole calendar days from `now` to `at` in local time (negative: in the past). */
function calendarDays(at: number, now: number): number {
  const day = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  return Math.round((day(at) - day(now)) / DAY_MS);
}

function shortDate(at: number, now: number): string {
  const date = new Date(at);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

/** "Due 3 days ago" / "Due today" for a passed review time; "Review tomorrow" / "Review in 5 days" / "Review Dec 3" otherwise. */
export function reviewLabel(reviewAt: number, now: number): string {
  const days = calendarDays(reviewAt, now);
  if (reviewAt <= now) {
    if (days >= 0) return "Due today";
    if (days === -1) return "Due yesterday";
    return `Due ${-days} days ago`;
  }
  if (days <= 0) return "Review today";
  if (days === 1) return "Review tomorrow";
  if (days <= 14) return `Review in ${days} days`;
  return `Review ${shortDate(reviewAt, now)}`;
}

/** "Nov 17" (with the year when it is not this one): when an item was closed. */
export function closedLabel(at: number, now: number): string {
  const days = calendarDays(at, now);
  return days === 0 ? "today" : days === -1 ? "yesterday" : shortDate(at, now);
}

/** "Snoozed 2 of 3", or null for an item never snoozed. `last` when no snooze is left. */
export function snoozeLabel(snoozes: number, max: number): { text: string; last: boolean } | null {
  if (snoozes <= 0) return null;
  return { text: `Snoozed ${snoozes} of ${max}`, last: snoozes >= max };
}

export interface RefTarget { label: string; href?: string }

const GITHUB_ITEM = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/;
const REPO_ITEM = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/**
 * How a `ref` (or a done item's evidence) is shown. An http(s) URL is a link;
 * a GitHub pull request or issue reads as `owner/repo#123`, and that
 * shorthand written by hand links to it. Anything else (a file path, a note)
 * is plain text: never a link the page would have to guess a target for.
 */
export function refTarget(ref: string): RefTarget {
  const text = ref.trim();
  const github = GITHUB_ITEM.exec(text);
  if (github) return { label: `${github[1]}/${github[2]}#${github[3]}`, href: text };
  if (safeHref(text)) {
    try {
      const url = new URL(text);
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      return { label: url.hostname.replace(/^www\./, "") + path, href: text };
    } catch { return { label: text }; }
  }
  const short = REPO_ITEM.exec(text);
  // GitHub redirects /issues/<n> to the pull request when <n> is one.
  if (short) return { label: text, href: `https://github.com/${short[1]}/${short[2]}/issues/${short[3]}` };
  return { label: text };
}
