import type { WebCronJob } from "../../src/web/protocol.js";

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
export function formatUntil(at: number, now: number, locale?: string): string {
  const diff = at - now;
  if (diff < MINUTE) return diff < -MINUTE ? "overdue" : "due now";
  if (diff < 60 * MINUTE) return `in ${Math.round(diff / MINUTE)} min`;
  const time = new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return diff < 6 * 60 * MINUTE ? `in ${Math.floor(diff / (60 * MINUTE))} h` : `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${new Date(at).toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}
