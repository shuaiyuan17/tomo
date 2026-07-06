import type { CronSchedule } from "./types.js";

/** Human-readable schedule description, shared by the cron CLI and the config view. */
export function formatSchedule(s: CronSchedule): string {
  switch (s.kind) {
    case "at": {
      const ts = new Date(s.at);
      return `once at ${isNaN(ts.getTime()) ? s.at : ts.toLocaleString()}`;
    }
    case "every":
      return `every ${formatDuration(s.everyMs)}`;
    case "cron":
      return `${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
  }
}

/** "45s", "20m", "2h 30m", "3d" — largest two units, no zero parts. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHr < 24) return remMin ? `${totalHr}h ${remMin}m` : `${totalHr}h`;
  const days = Math.floor(totalHr / 24);
  const remHr = totalHr % 24;
  return remHr ? `${days}d ${remHr}h` : `${days}d`;
}

/** Relative timestamp: "in 20m", "3h ago", "now". */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  if (Math.abs(diff) < 30_000) return diff >= 0 ? "now" : "just now";
  const dur = formatDuration(Math.abs(diff));
  return diff >= 0 ? `in ${dur}` : `${dur} ago`;
}
