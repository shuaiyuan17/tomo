import type { WebUsage, WebUsageWindow } from "../../src/web/protocol.js";
import { i18n } from "./i18n/index.js";
import { formatRelative, formatUnit, formatUnitPair } from "./i18n/format.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: common:usage.state.*

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
  // A failed answer (any state but ok/empty) counts as a failure: retry on
  // the 60 s rule, not at its cache expiry.
  const failed = schedule.failed || !schedule.usage || !usageOk(schedule.usage);
  const due = failed ? schedule.lastAttemptAt + USAGE_RETRY_MS : schedule.usage!.expiresAt + USAGE_MARGIN_MS;
  return Math.max(0, due - now, schedule.lastAttemptAt + USAGE_MIN_GAP_MS - now);
}

/** The answer carries usage (or a definite "no windows"), not a failure. */
export function usageOk(usage: WebUsage): boolean { return usage.state === "ok" || usage.state === "empty"; }

/** At or above this utilisation a window is shown in the warning colour. */
export const USAGE_WARN_PERCENT = 80;

export function isWarn(window: WebUsageWindow): boolean {
  return window.elevated || (window.percent !== null && window.percent >= USAGE_WARN_PERCENT);
}

/** "2h 14m", "5d 3h", "12m", "now" (in the active locale, through Intl units). */
export function formatSpan(ms: number): string {
  if (ms <= 0) return i18n.t("common:usage.now");
  if (ms <= 60_000) return formatUnit(1, "minute");
  const minutes = Math.floor(ms / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  if (days) return formatUnitPair(formatUnit(days, "day"), formatUnit(hours, "hour"));
  if (hours) return formatUnitPair(formatUnit(hours, "hour"), formatUnit(minutes % 60, "minute"));
  return formatUnit(minutes, "minute");
}
/** "Resets in 2h 14m"; `inline` is the lower-case form shown after a window's name. */
export function resetLabel(window: WebUsageWindow, now: number, inline = false): string | undefined {
  if (window.resetsAt === null) return undefined;
  const ms = window.resetsAt - now;
  if (inline) return ms <= 0 ? i18n.t("common:usage.resettingNowInline") : i18n.t("common:usage.resetsInInline", { span: formatSpan(ms) });
  return ms <= 0 ? i18n.t("common:usage.resettingNow") : i18n.t("common:usage.resetsIn", { span: formatSpan(ms) });
}
export function updatedLabel(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return i18n.t("common:usage.notUpdated");
  const ms = Math.max(0, now - updatedAt);
  if (ms < 60_000) return i18n.t("common:usage.updatedJustNow");
  // Whole minutes below an hour, whole hours above.
  const rounded = ms < 3_600_000 ? Math.floor(ms / 60_000) * 60_000 : Math.floor(ms / 3_600_000) * 3_600_000;
  return i18n.t("common:usage.updated", { when: formatRelative(-rounded, "narrow") });
}

/** Main rows (5-hour, 7-day) and per-model rows (shown folded). */
export function splitWindows(windows: WebUsageWindow[]): { main: WebUsageWindow[]; scoped: WebUsageWindow[] } {
  return { main: windows.filter((w) => !w.scoped), scoped: windows.filter((w) => w.scoped) };
}

/** Short labels for the main windows. */
export function windowTitle(window: WebUsageWindow): string {
  if (!window.scoped && window.group === "session") return i18n.t("common:usage.fiveHour");
  if (!window.scoped && window.group === "weekly") return i18n.t("common:usage.sevenDay");
  // A scoped window is named by what it is scoped to (model and surface are names, not copy).
  const scope = [window.model, window.surface].filter(Boolean).join(" · ");
  if (window.kind === "weekly_scoped" && scope) return scope;
  if (window.kind === "session" && scope) return i18n.t("common:usage.scoped", { window: i18n.t("common:usage.fiveHour"), scope });
  // An older daemon, or a kind this page does not know: the daemon's own label.
  return window.label.replace(/^Weekly · /, "");
}

const MESSAGES = {
  empty: "common:usage.state.empty",
  api_key: "common:usage.state.api_key",
  no_token: "common:usage.state.no_token",
  credentials_unreadable: "common:usage.state.credentials_unreadable",
  token_expired: "common:usage.state.token_expired",
  refresh_pending: "common:usage.state.refresh_pending",
  unauthorized: "common:usage.state.unauthorized",
  network: "common:usage.state.network",
  timeout: "common:usage.state.timeout",
  http_error: "common:usage.state.http_error",
  bad_response: "common:usage.state.bad_response",
  unavailable: "common:usage.state.unavailable",
} as const satisfies Record<Exclude<WebUsage["state"], "ok">, string>;
/** What to say for a state other than ok; undefined for ok. */
export function usageNotice(usage: WebUsage): string | undefined {
  return usage.state === "ok" ? undefined : i18n.t(MESSAGES[usage.state]);
}

/**
 * One request at a time, and only the latest one's answer counts:
 * `begin` returns a ticket (or null while one is in flight); `current`
 * says whether a ticket is still the latest; `end` frees the slot.
 */
export class RequestGate {
  private busy = false;
  private latest = 0;
  begin(): number | null { if (this.busy) return null; this.busy = true; return ++this.latest; }
  /** A newer request superseded this one (e.g. a reconnect reset). */
  supersede(): void { this.latest++; this.busy = false; }
  current(ticket: number): boolean { return ticket === this.latest; }
  end(): void { this.busy = false; }
}

/** The plan as a name beside the card's heading: "max" → "Max" (whatever else it says is kept). */
export function planName(plan: string): string { return plan.charAt(0).toUpperCase() + plan.slice(1); }
