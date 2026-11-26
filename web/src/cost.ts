import type { WebCostCategory, WebCostDay, WebCostHour, WebCostLimitWindow, WebCostTurn } from "../../src/web/protocol.js";
import { formatLocale, i18n } from "./i18n/index.js";
import { formatDate, formatUnit, formatUnitPair } from "./i18n/format.js";

/**
 * Pure helpers for the Study's Cost page (cost-page.tsx). Every dollar figure
 * is the SDK's estimate at API list prices, never a bill; dates are the
 * owner's local `YYYY-MM-DD` as the API sends them.
 */

/** Who started a turn; `label` and `hint` are read in the active locale. */
export const CATEGORIES: { readonly key: WebCostCategory; readonly label: string; readonly hint: string; readonly color: string }[] = [
  { key: "you", get label() { return i18n.t("cost:category.you"); }, get hint() { return i18n.t("cost:category.youHint"); }, color: "var(--series-1)" },
  { key: "background", get label() { return i18n.t("cost:category.background"); }, get hint() { return i18n.t("cost:category.backgroundHint"); }, color: "var(--series-2)" },
  { key: "scheduled", get label() { return i18n.t("cost:category.scheduled"); }, get hint() { return i18n.t("cost:category.scheduledHint"); }, color: "var(--series-3)" },
  { key: "tasks", get label() { return i18n.t("cost:category.tasks"); }, get hint() { return i18n.t("cost:category.tasksHint"); }, color: "var(--series-4)" },
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

/** Dollars in the active locale's digits ("$1,234", "$3.46"); always US dollars, the SDK's unit. */
const dollars = (value: number, digits: number) => new Intl.NumberFormat(formatLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
  minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export function usd(value: number, precise = false): string {
  if (value === 0) return dollars(0, 0);
  if (Math.abs(value) < 0.005) return i18n.t("cost:lessThan", { value: dollars(0.01, 2) });
  if (precise || value < 10) return dollars(value, 2);
  return dollars(Math.round(value), 0);
}
export function duration(ms: number | undefined): string | undefined {
  if (ms == null) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? formatUnit(s, "second") : s < 3600 ? formatUnitPair(formatUnit(Math.floor(s / 60), "minute"), formatUnit(s % 60, "second"))
    : formatUnitPair(formatUnit(Math.floor(s / 3600), "hour"), formatUnit(Math.floor((s % 3600) / 60), "minute"));
}

const atNoon = (date: string) => new Date(`${date}T12:00:00Z`);
export const shortDay = (date: string) => formatDate(atNoon(date), { month: "short", day: "numeric", timeZone: "UTC" });
export const longDay = (date: string) => formatDate(atNoon(date), { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
export const monthOf = (date: string) => formatDate(atNoon(date), { month: "short", timeZone: "UTC" });
/** A short weekday name, Monday = 0 (2024-01-01 was a Monday). */
export const weekdayName = (day: number) => formatDate(atNoon(addDays("2024-01-01", day)), { weekday: "short", timeZone: "UTC" });
/** A turn's clock time on the owner's clock (the zone the days are split in). */
export function clock(ts: number, timeZone: string): string {
  try { return formatDate(ts, { hour: "numeric", minute: "2-digit", timeZone }); }
  catch { return formatDate(ts, { hour: "numeric", minute: "2-digit" }); }
}

/** The eyebrow over a day: "Today so far", "Yesterday" or "That day". */
export function dayEyebrow(date: string, today: string): string {
  return date === today ? i18n.t("cost:day.today") : date === addDays(today, -1) ? i18n.t("cost:day.yesterday") : i18n.t("cost:day.other");
}

/** "1.7× a typical day", "40% below a typical day", "About a typical day". */
export function versusTypical(cost: number, typical: number | undefined): string | undefined {
  if (!typical || typical <= 0) return undefined;
  const ratio = cost / typical;
  const digits = ratio >= 10 ? 0 : 1;
  if (ratio >= 1.15) return i18n.t("cost:typical.above", { ratio: new Intl.NumberFormat(formatLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio) });
  if (ratio <= 0.85) return i18n.t("cost:typical.below", { percent: Math.round((1 - ratio) * 100) });
  return i18n.t("cost:typical.about");
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
    case "heartbeat": return i18n.t("cost:turn.heartbeat");
    case "background": return i18n.t("cost:turn.background");
    case "restart": return i18n.t("cost:turn.restart");
    case "delegate": return i18n.t("cost:turn.delegate");
    case "cron": return i18n.t("cost:turn.cron");
    case "task": return i18n.t("cost:turn.task");
    case "task-relay": return turn.taskId ? i18n.t("cost:turn.relayFor", { id: turn.taskId }) : i18n.t("cost:turn.relay");
    default: return turn.category === "scheduled" ? i18n.t("cost:turn.scheduled") : i18n.t("cost:turn.other");
  }
}
export function turnMeta(turn: WebCostTurn): string {
  const parts = [categoryOf(turn.category).label, turn.session.label];
  // A relay turn runs on the owning session: say which task it was for.
  if (turn.source === "task-relay" && turn.taskId) parts.splice(2, 0, i18n.t("cost:turn.relayFor", { id: turn.taskId }));
  const took = duration(turn.durationMs);
  if (took) parts.push(took);
  if (turn.tools !== undefined) parts.push(i18n.t("cost:turn.tools", { count: turn.tools }));
  if (turn.backfilled) parts.push(i18n.t("cost:turn.backfilled"));
  return parts.join(" · ");
}

/** The windows the quota bar shows: the plan-wide 5-hour and 7-day ones that carry a percentage, in that order. */
export function quotaWindows(windows: readonly WebCostLimitWindow[]): { title: string; window: WebCostLimitWindow }[] {
  const kind = (w: WebCostLimitWindow) => w.scoped ? undefined
    : w.group === "session" || w.window === "five_hour" ? "session"
    : w.group === "weekly" || w.window === "seven_day" ? "weekly" : undefined;
  const out: { title: string; window: WebCostLimitWindow }[] = [];
  for (const [want, title] of [["session", i18n.t("common:usage.fiveHour")], ["weekly", i18n.t("common:usage.sevenDay")]] as const) {
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
    return i18n.t("common:usage.resetsInInline", { span: h ? formatUnitPair(formatUnit(h, "hour"), formatUnit(m, "minute")) : formatUnit(m, "minute") });
  }
  return i18n.t("cost:resetsAt", { when: formatDate(at, { weekday: "short", hour: "numeric", minute: "2-digit" }) });
}

/** A recorded day's share of a whole, rounded; 0 for an empty whole. */
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}
