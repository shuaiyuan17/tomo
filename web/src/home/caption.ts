import type { HomeStatus, HomeToolKind, HomeTurnSource } from "../../../src/home/status.js";
import { CRON_FLASH_MS } from "../../../src/home/status.js";
import { skyOf, weatherWords } from "./sky.js";

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
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours < 3 && minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** `{idle}`: how long nothing has run ("20 min"), or "" while working. */
export function idleValue(status: HomeStatus, now: number): string {
  return status.working || status.idleSince === undefined ? "" : formatHomeSpan(now - status.idleSince);
}
/** `{next_job}`: "in 12 min", or "" without one. */
export function nextJobValue(status: HomeStatus, now: number): string {
  if (status.nextJobAt === undefined) return "";
  const ms = status.nextJobAt - now;
  return ms <= 0 ? "now" : `in ${formatHomeSpan(ms)}`;
}

const SOURCE: Record<HomeTurnSource, string> = {
  owner: "Working on your message", cron: "Running a scheduled job", heartbeat: "Thinking on its own",
  group: "Answering a group chat", other: "Working",
};
const TOOL: Record<HomeToolKind, string> = {
  shell: "running a command", files: "working with files", web: "on the web", search: "searching",
  subagent: "handing work to a subagent", other: "using a tool",
};
const TROUBLE_WORKING: Record<NonNullable<HomeStatus["trouble"]>, string> = { retry: "retrying", rate_limit: "rate-limited, waiting", error: "hit an error" };
const TROUBLE_IDLE: Record<NonNullable<HomeStatus["trouble"]>, string> = { retry: "Retrying", rate_limit: "Rate-limited, waiting", error: "The last turn hit an error" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One quiet line: "Working on your message · 2 subagents", "Running a
 * scheduled job", "Idle for 20 min", "Compacting context · retrying".
 * `status` is on the local clock (localizeHomeStatus).
 */
export function homeCaption(status: HomeStatus, now: number): string {
  const parts: string[] = [];
  if (status.compacting) {
    parts.push("Compacting context");
    if (status.trouble) parts.push(TROUBLE_WORKING[status.trouble]);
  } else if (status.working) {
    parts.push(SOURCE[status.by ?? "other"]);
    if (status.trouble) parts.push(TROUBLE_WORKING[status.trouble]);
    else if (status.tool && status.tool !== "subagent") parts.push(TOOL[status.tool]);
  } else if (status.trouble) parts.push(TROUBLE_IDLE[status.trouble]);
  else if (cronFlashing(status, now)) parts.push("A scheduled job just fired");
  else parts.push(status.idleSince === undefined ? "Idle" : `Idle for ${formatHomeSpan(now - status.idleSince)}`);
  if (status.subagents.length) parts.push(count(status.subagents.length, "subagent", "subagents"));
  if (status.tasks > 0) parts.push(count(status.tasks, "background task", "background tasks"));
  const quiet = !status.working && !status.compacting && !status.trouble && !status.subagents.length && !status.tasks;
  if (quiet && status.nextJobAt !== undefined && status.nextJobAt > now) parts.push(`next job ${nextJobValue(status, now)}`);
  const weather = weatherWords(skyOf(status, now));
  if (weather) parts.push(weather);
  return parts.join(" · ");
}
