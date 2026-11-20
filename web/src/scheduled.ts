import type { WebCronJob } from "../../src/web/protocol.js";
import { i18n, formatLocale as activeLocale } from "./i18n/index.js";

/** How many upcoming jobs the Tasks rail shows. */
export const SCHEDULED_LIMIT = 5;

/** Enabled jobs with a next run, soonest first, at most `limit`. */
export function upcomingJobs(jobs: readonly WebCronJob[], limit = SCHEDULED_LIMIT): WebCronJob[] {
  return jobs.filter((job): job is WebCronJob & { nextRunAt: number } => job.enabled && typeof job.nextRunAt === "number")
    .sort((a, b) => a.nextRunAt - b.nextRunAt || a.name.localeCompare(b.name))
    .slice(0, limit);
}

const MINUTE = 60_000;
function startOfDay(ms: number): number { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); }

/**
 * When a job runs next, relative to `now`: "due now", "in 12 min", "in 3 h"
 * (under 6 h the same day), "Today 3:00 PM", "Tomorrow 8:00 AM", "Mon 8:00 AM"
 * (this week), else "Nov 20, 8:00 AM". `locale` is for tests.
 */
export function formatUntil(at: number, now: number, locale: string = activeLocale()): string {
  const diff = at - now;
  if (diff < MINUTE) return diff < -MINUTE ? i18n.t("tasks:scheduled.overdue") : i18n.t("tasks:scheduled.dueNow");
  if (diff < 60 * MINUTE) return i18n.t("tasks:scheduled.inMinutes", { count: Math.round(diff / MINUTE) });
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(at);
  const time = format({ hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return diff < 6 * 60 * MINUTE ? i18n.t("tasks:scheduled.inHours", { count: Math.floor(diff / (60 * MINUTE)) }) : i18n.t("tasks:scheduled.today", { time });
  if (days === 1) return i18n.t("tasks:scheduled.tomorrow", { time });
  if (days < 7) return format({ weekday: "short", hour: "numeric", minute: "2-digit" });
  return format({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
