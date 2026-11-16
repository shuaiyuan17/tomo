import type { WebCostCategory, WebCostDay, WebCostHour, WebCostLimitWindow, WebCostTurn } from "../../src/web/protocol.js";

/**
 * Pure helpers for the Study's Cost page (cost-page.tsx). Every dollar figure
 * is the SDK's estimate at API list prices, never a bill; dates are the
 * owner's local `YYYY-MM-DD` as the API sends them.
 */

export const CATEGORIES: { key: WebCostCategory; label: string; hint: string; color: string }[] = [
  { key: "you", label: "You", hint: "Turns started by a message: yours, or one in a group", color: "var(--series-1)" },
  { key: "background", label: "Background", hint: "Heartbeats and turns that pick up finished background work", color: "var(--series-2)" },
  { key: "scheduled", label: "Scheduled", hint: "Cron jobs and other scheduled turns", color: "var(--series-3)" },
];
export const categoryOf = (key: WebCostCategory) => CATEGORIES.find((c) => c.key === key)!;

/** Weeks in the calendar. */
export const CALENDAR_WEEKS = 10;
/** Heatmap bin edges in dollars: bin 0 is $0, bin 5 is $200 and up. */
export const BINS = [0.01, 25, 50, 100, 200];
export const bin = (value: number) => Math.min(5, BINS.filter((edge) => value >= edge).length);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (value: string | null | undefined): value is string => !!value && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** `date` moved by `days`, calendar arithmetic only (no time zone). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Monday = 0 … Sunday = 6. */
export const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
/** The browser's own local date: only a first guess, the API's `glance.today` decides. */
export function localDate(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The calendar's first day: the Monday CALENDAR_WEEKS - 1 weeks before the one holding `today`. */
export const calendarStart = (today: string) => addDays(today, -weekday(today) - 7 * (CALENDAR_WEEKS - 1));

/**
 * Columns of seven (Mon–Sun) from calendarStart to `today`; days after today
 * are null, and so is any day the API did not send.
 */
export function calendarWeeks(days: readonly WebCostDay[], today: string): (WebCostDay | null)[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const start = calendarStart(today);
  return Array.from({ length: CALENDAR_WEEKS }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = addDays(start, week * 7 + day);
    return date > today ? null : byDate.get(date) ?? null;
  }));
}

/** The day the URL asks for, if it is a real date not after today. */
export function pickDay(requested: string | null | undefined, today: string): string {
  return isDate(requested) && requested <= today ? requested : today;
}
/** The Cost tab showing `date` (today's link carries no date). */
export const costDayHash = (date: string | null) => (date ? `#study/cost/${date}` : "#study/cost");

export function usd(value: number, precise = false): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.005) return "<$0.01";
  if (precise || value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
export function duration(ms: number | undefined): string | undefined {
  if (ms == null) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const atNoon = (date: string) => new Date(`${date}T12:00:00Z`);
export const shortDay = (date: string) => atNoon(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const longDay = (date: string) => atNoon(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
export const monthOf = (date: string) => atNoon(date).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
/** A turn's clock time on the owner's clock (the zone the days are split in). */
export function clock(ts: number, timeZone: string): string {
  try { return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }); }
  catch { return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
}

/** The eyebrow over a day: "Today so far", "Yesterday" or "That day". */
export function dayEyebrow(date: string, today: string): string {
  return date === today ? "Today so far" : date === addDays(today, -1) ? "Yesterday" : "That day";
}

/** "1.7× a typical day", "40% below a typical day", "About a typical day". */
export function versusTypical(cost: number, typical: number | undefined): string | undefined {
  if (!typical || typical <= 0) return undefined;
  const ratio = cost / typical;
  if (ratio >= 1.15) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× a typical day`;
  if (ratio <= 0.85) return `${Math.round((1 - ratio) * 100)}% below a typical day`;
  return "About a typical day";
}

/** The hour with the most cost, or undefined for an empty day. */
export function busiestHour(hours: readonly WebCostHour[]): number | undefined {
  let best: WebCostHour | undefined;
  for (const h of hours) if (h.costUsd > 0 && (!best || h.costUsd > best.costUsd)) best = h;
  return best?.hour;
}
export const hourLabel = (hour: number) => `${hour}:00`;

/** What a turn was about: its trigger, else what started it. */
export function turnTitle(turn: WebCostTurn): string {
  if (turn.trigger) return turn.trigger;
  if (turn.jobName) return turn.jobName;
  switch (turn.source) {
    case "heartbeat": return "Heartbeat";
    case "background": return "Background work finished";
    case "restart": return "After a restart";
    case "delegate": return "Delegated message";
    case "cron": return "Scheduled job";
    default: return turn.category === "scheduled" ? "Scheduled turn" : "Turn";
  }
}
export function turnMeta(turn: WebCostTurn): string {
  const parts = [categoryOf(turn.category).label, turn.session.label];
  const took = duration(turn.durationMs);
  if (took) parts.push(took);
  if (turn.tools !== undefined) parts.push(`${turn.tools} tool${turn.tools === 1 ? "" : "s"}`);
  if (turn.backfilled) parts.push("from the activity log");
  return parts.join(" · ");
}

/** The windows the quota bar shows: the plan-wide 5-hour and 7-day ones that carry a percentage, in that order. */
export function quotaWindows(windows: readonly WebCostLimitWindow[]): { title: string; window: WebCostLimitWindow }[] {
  const kind = (w: WebCostLimitWindow) => w.scoped ? undefined
    : w.group === "session" || w.window === "five_hour" ? "session"
    : w.group === "weekly" || w.window === "seven_day" ? "weekly" : undefined;
  const out: { title: string; window: WebCostLimitWindow }[] = [];
  for (const [want, title] of [["session", "5-hour"], ["weekly", "7-day"]] as const) {
    const window = windows.find((w) => kind(w) === want && typeof w.percent === "number" && Number.isFinite(w.percent));
    if (window) out.push({ title, window });
  }
  return out;
}

/** "resets in 2h 14m", "resets Tue 9:00 AM"; undefined without a reset time or once it has passed. */
export function resetsIn(resetsAt: string | undefined, now: number): string | undefined {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  const ms = at - now;
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(ms / 3_600_000), m = Math.max(1, Math.round((ms % 3_600_000) / 60_000));
    return h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  }
  return `resets ${new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** A recorded day's share of a whole, rounded; 0 for an empty whole. */
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}
