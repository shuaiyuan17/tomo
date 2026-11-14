import type { WebUsage, WebUsageWindow } from "../../src/web/protocol.js";

/** Pure helpers for the Plan usage card. */

/** Asked again this long after the server's cache expires (it refreshes on that request). */
export const USAGE_MARGIN_MS = 5_000;
/** After a failed request to Tomo, try again this long after that attempt. */
export const USAGE_RETRY_MS = 60_000;
/** Never ask again sooner than this after the last attempt (no zero-delay loops). */
export const USAGE_MIN_GAP_MS = 5_000;

/**
 * Every absolute time in the answer, moved onto the browser's clock: the
 * daemon's clock is `serverNow` at the moment the answer arrived
 * (`receivedAt`, local), so a skewed browser clock does not shift expiry,
 * "updated" or reset times.
 */
export function localizeUsage(usage: WebUsage, receivedAt: number): WebUsage {
  const shift = receivedAt - usage.serverNow;
  const at = (t: number) => t + shift;
  return { ...usage, fetchedAt: at(usage.fetchedAt), updatedAt: usage.updatedAt === null ? null : at(usage.updatedAt),
    nextRefreshAt: at(usage.nextRefreshAt), expiresAt: at(usage.expiresAt), serverNow: receivedAt,
    windows: usage.windows.map((w) => ({ ...w, resetsAt: w.resetsAt === null ? null : at(w.resetsAt) })) };
}

export interface UsageSchedule {
  /** The last answer, already on the local clock (see localizeUsage). */
  usage?: WebUsage;
  /** The last request to Tomo failed. */
  failed: boolean;
  /** Local time of the last request. */
  lastAttemptAt: number;
}
/**
 * How long until the next read, all on the local clock: the cache's expiry
 * plus a margin; after a failed request, 60 s after that attempt (so a tab
 * coming back later retries at once); never sooner than USAGE_MIN_GAP_MS
 * after the last attempt.
 */
export function nextUsageDelay(schedule: UsageSchedule, now: number): number {
  const due = schedule.failed || !schedule.usage ? schedule.lastAttemptAt + USAGE_RETRY_MS : schedule.usage.expiresAt + USAGE_MARGIN_MS;
  return Math.max(0, due - now, schedule.lastAttemptAt + USAGE_MIN_GAP_MS - now);
}

/** At or above this utilisation a window is shown in the warning colour. */
export const USAGE_WARN_PERCENT = 80;

export function isWarn(window: WebUsageWindow): boolean {
  return window.elevated || (window.percent !== null && window.percent >= USAGE_WARN_PERCENT);
}

/** "2h 14m", "5d 3h", "12m", "now". */
export function formatSpan(ms: number): string {
  if (ms <= 60_000) return ms <= 0 ? "now" : "1m";
  const minutes = Math.floor(ms / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
export function resetLabel(window: WebUsageWindow, now: number): string | undefined {
  if (window.resetsAt === null) return undefined;
  const ms = window.resetsAt - now;
  return ms <= 0 ? "Resetting now" : `Resets in ${formatSpan(ms)}`;
}
export function updatedLabel(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return "Not updated yet";
  const ms = Math.max(0, now - updatedAt);
  if (ms < 60_000) return "Updated just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated ${Math.floor(minutes / 60)} h ago`;
}

/** Main rows (5-hour, 7-day) and per-model rows (shown folded). */
export function splitWindows(windows: WebUsageWindow[]): { main: WebUsageWindow[]; scoped: WebUsageWindow[] } {
  return { main: windows.filter((w) => !w.scoped), scoped: windows.filter((w) => w.scoped) };
}

/** Short labels for the main windows. */
export function windowTitle(window: WebUsageWindow): string {
  if (!window.scoped && window.group === "session") return "5-hour";
  if (!window.scoped && window.group === "weekly") return "7-day";
  return window.label.replace(/^Weekly · /, "");
}

const MESSAGES: Record<Exclude<WebUsage["state"], "ok">, string> = {
  empty: "claude.ai returned no usage windows.",
  api_key: "API-key auth has no subscription limits.",
  no_token: "No Claude Code login on this machine. Log in with Claude Code.",
  credentials_unreadable: "Couldn't read the Claude Code login (is the Keychain locked?).",
  token_expired: "The Claude Code login has expired. Log in again.",
  refresh_pending: "The login is refreshing. Try again after the next message.",
  unauthorized: "claude.ai refused the Claude Code login. Log in again.",
  network: "Couldn't reach claude.ai.",
  timeout: "claude.ai didn't answer in time.",
  http_error: "claude.ai returned an error.",
  bad_response: "claude.ai sent a response that couldn't be read.",
  unavailable: "Usage isn't available here.",
};
/** What to say for a state other than ok; undefined for ok. */
export function usageNotice(usage: WebUsage): string | undefined {
  return usage.state === "ok" ? undefined : MESSAGES[usage.state];
}
