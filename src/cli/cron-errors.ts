import { CronStoreReadError } from "../cron/store.js";
import type { CreatableSchedule } from "../cron/schedule.js";
import type { CronJob } from "../cron/types.js";

/**
 * The store could not be read (the database cannot be opened, or an old jobs
 * file is in the way). That is an error rather than an empty store (silently
 * reporting "no scheduled tasks" over an unreadable one is how a real backlog
 * goes unnoticed), so the CLI says so in one line instead of a stack trace.
 */
export function cronStoreErrorMessage(err: CronStoreReadError): string {
  return `cron store unreadable: ${err.path}${err.detail ? ` (${err.detail})` : ""}`;
}

/**
 * Run a store operation for a scriptable command: a read failure prints the
 * one-liner and exits non-zero, so callers can tell "no jobs" from "could not
 * look". Anything else propagates unchanged.
 */
export function withCronStore<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CronStoreReadError) {
      console.error(cronStoreErrorMessage(err));
      console.error("Nothing was changed. `tomo db check` shows the database's state; Tomo imports an old jobs file when it starts.");
      process.exit(1);
    }
    throw err;
  }
}

export interface SafeCronRead {
  jobs: CronJob[];
  /** Set when the store could not be read; `jobs` is then empty, not "none". */
  unreadablePath?: string;
}

/**
 * Read the job list for a surface that must keep working without it — the
 * status report, the watch snapshot, the metrics scrape. Those must degrade
 * to "the cron section is unavailable" rather than failing whole: a scrape
 * that 500s or a `tomo watch` client that gets dropped because the store is
 * corrupt hides every OTHER thing they were reporting.
 *
 * The caller gets the path back rather than a bare empty list precisely so it
 * can say "unreadable" instead of "none". Non-read errors still propagate.
 */
export function readCronJobsSafely(store: { list(): CronJob[] }): SafeCronRead {
  try {
    return { jobs: store.list() };
  } catch (err) {
    if (!(err instanceof CronStoreReadError)) throw err;
    return { jobs: [], unreadablePath: err.path };
  }
}

/**
 * The `tomo cron add` refusal line for a schedule that cannot be created.
 *
 * Both refusals are one line: `parseScheduleString` accepts anything it does
 * not recognise as `kind: "cron"`, so a typo reaches croner, and croner throws
 * only when the expression is evaluated — which used to surface as a raw
 * stack trace under the user's command. The MCP tool has always formatted its
 * half; this is the same shape for the CLI.
 */
export function cronAddRefusal(
  scheduleText: string,
  parsed: Exclude<CreatableSchedule, { kind: "ok" }>,
): string {
  return parsed.kind === "unparseable"
    ? `Cannot schedule "${scheduleText}": not a schedule expression — ${parsed.detail}`
    : `Cannot schedule "${scheduleText}": ${parsed.reason}, so the job could never fire.`;
}
