import type { HomeStatus, HomeToolKind, HomeTurnSource } from "../../../src/home/status.js";
import { CRON_FLASH_MS } from "../../../src/home/status.js";
import { skyOf, weatherWords } from "./sky.js";
import { i18n } from "../i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: home:source.*
// i18n-dynamic: home:tool.*
// i18n-dynamic: home:trouble.*
// i18n-dynamic: home:troubleIdle.*

/**
 * Pure helpers for the line under the room: what Tomo is doing, in words,
 * from HomeStatus alone. Also the status's clock conversion.
 */

/** A status as the page holds it: its times moved onto the browser's clock, and the daemon's `at` kept for ordering. */
export interface LocalHomeStatus { status: HomeStatus; daemonAt: number }

/**
 * Every absolute time in the status, moved onto the browser's clock: the
 * daemon's clock read `status.at` when it was computed, and the page got it
 * at `receivedAt` (local), as the Plan usage card does (usage.ts).
 */
export function localizeHomeStatus(status: HomeStatus, receivedAt: number): LocalHomeStatus {
  const shift = receivedAt - status.at;
  const at = (t: number | undefined) => t === undefined ? undefined : t + shift;
  const local: HomeStatus = { ...status, at: receivedAt, subagents: [...status.subagents] };
  const cronAt = at(status.cronAt), nextJobAt = at(status.nextJobAt), idleSince = at(status.idleSince);
  if (cronAt !== undefined) local.cronAt = cronAt;
  if (nextJobAt !== undefined) local.nextJobAt = nextJobAt;
  if (idleSince !== undefined) local.idleSince = idleSince;
  return { status: local, daemonAt: status.at };
}

/** The newer of two statuses, by the daemon's clock (a GET and an event can cross). */
export function newerStatus(a: LocalHomeStatus | undefined, b: LocalHomeStatus | undefined): LocalHomeStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.daemonAt >= a.daemonAt ? b : a;
}

/** A scheduled job fired within the last CRON_FLASH_MS (local clock). */
export function cronFlashing(status: HomeStatus, now: number): boolean {
  return status.cronAt !== undefined && now >= status.cronAt - 1_000 && now - status.cronAt < CRON_FLASH_MS;
}

/** "under a minute", "20 min", "1 h 5 min", "3 h", "2 days". */
export function formatHomeSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return i18n.t("home:span.underMinute");
  if (minutes < 60) return i18n.t("home:span.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours < 3 && minutes % 60 ? i18n.t("home:span.hoursMinutes", { hours, minutes: minutes % 60 }) : i18n.t("home:span.hours", { count: hours });
  return i18n.t("home:span.days", { count: Math.floor(hours / 24) });
}

/** `{idle}`: how long nothing has run ("20 min"), or "" while working. */
export function idleValue(status: HomeStatus, now: number): string {
  return status.working || status.idleSince === undefined ? "" : formatHomeSpan(now - status.idleSince);
}
/** `{next_job}`: "in 12 min", or "" without one. */
export function nextJobValue(status: HomeStatus, now: number): string {
  if (status.nextJobAt === undefined) return "";
  const ms = status.nextJobAt - now;
  return ms <= 0 ? i18n.t("home:next.now") : i18n.t("home:next.in", { span: formatHomeSpan(ms) });
}

const SOURCE = {
  owner: "home:source.owner", cron: "home:source.cron", heartbeat: "home:source.heartbeat", group: "home:source.group", other: "home:source.other",
} as const satisfies Record<HomeTurnSource, string>;
const TOOL = {
  shell: "home:tool.shell", files: "home:tool.files", web: "home:tool.web", search: "home:tool.search", subagent: "home:tool.subagent", other: "home:tool.other",
} as const satisfies Record<HomeToolKind, string>;
const TROUBLE_WORKING = { retry: "home:trouble.retry", rate_limit: "home:trouble.rate_limit", error: "home:trouble.error" } as const satisfies Record<NonNullable<HomeStatus["trouble"]>, string>;
const TROUBLE_IDLE = { retry: "home:troubleIdle.retry", rate_limit: "home:troubleIdle.rate_limit", error: "home:troubleIdle.error" } as const satisfies Record<NonNullable<HomeStatus["trouble"]>, string>;

/**
 * One quiet line: "Working on your message · 2 subagents", "Running a
 * scheduled job", "Idle for 20 min", "Compacting context · retrying".
 * `status` is on the local clock (localizeHomeStatus).
 */
export function homeCaption(status: HomeStatus, now: number): string {
  const parts: string[] = [];
  if (status.compacting) {
    parts.push(i18n.t("home:compacting"));
    if (status.trouble) parts.push(i18n.t(TROUBLE_WORKING[status.trouble]));
  } else if (status.working) {
    parts.push(i18n.t(SOURCE[status.by ?? "other"]));
    if (status.trouble) parts.push(i18n.t(TROUBLE_WORKING[status.trouble]));
    else if (status.tool && status.tool !== "subagent") parts.push(i18n.t(TOOL[status.tool]));
  } else if (status.trouble) parts.push(i18n.t(TROUBLE_IDLE[status.trouble]));
  else if (cronFlashing(status, now)) parts.push(i18n.t("home:cronFired"));
  else parts.push(status.idleSince === undefined ? i18n.t("home:idle") : i18n.t("home:idleFor", { span: formatHomeSpan(now - status.idleSince) }));
  if (status.subagents.length) parts.push(i18n.t("home:subagents", { count: status.subagents.length }));
  if (status.tasks > 0) parts.push(i18n.t("home:tasks", { count: status.tasks }));
  const quiet = !status.working && !status.compacting && !status.trouble && !status.subagents.length && !status.tasks;
  if (quiet && status.nextJobAt !== undefined && status.nextJobAt > now) parts.push(i18n.t("home:nextJob", { when: nextJobValue(status, now) }));
  const weather = weatherWords(skyOf(status, now));
  if (weather) parts.push(weather);
  return parts.join(" · ");
}
