import { CronStoreReadError } from "../cron/store.js";

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
