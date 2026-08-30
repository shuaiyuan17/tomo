import { CronStoreReadError } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";

/**
 * The jobs file exists but could not be read or parsed. That is now an error
 * rather than an empty store (silently reporting "no scheduled tasks" over an
 * unreadable file is how a real backlog goes unnoticed), so the CLI has to
 * say so in one line instead of dumping a stack trace at the user.
 */
export function cronStoreErrorMessage(err: CronStoreReadError): string {
  return `cron store unreadable: ${err.path}`;
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
      console.error("Fix or remove the file and retry; the daemon recreates it empty.");
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
 * that 500s or a `tomo watch` client that gets dropped because jobs.json is
 * corrupt hides every OTHER thing they were reporting.
 *
 * The caller gets the path back rather than a bare empty list precisely so it
 * can say "unreadable" instead of "none" — the distinction this PR exists to
 * preserve. Non-read errors still propagate.
 */
export function readCronJobsSafely(store: { list(): CronJob[] }): SafeCronRead {
  try {
    return { jobs: store.list() };
  } catch (err) {
    if (!(err instanceof CronStoreReadError)) throw err;
    return { jobs: [], unreadablePath: err.path };
  }
}
