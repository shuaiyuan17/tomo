import type { WebUsage, WebUsageWindow } from "../../src/web/protocol.js";

/** Pure helpers for the Plan usage card. */

/** The card refreshes itself this often while the page is visible. */
export const USAGE_REFRESH_MS = 30 * 60_000;
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
