import { CronStore } from "../../cron/store.js";
import { log } from "../../logger.js";

/**
 * A task's cron jobs (its check-backs), read fresh from the store file every
 * time. The task's own `schedule_create` and the scheduler write through
 * other CronStore instances, and `CronStore.list()` does not reload, so a
 * snapshot kept across turns would miss new jobs and keep deleted ones.
 *
 * An unreadable store is NOT zero jobs: `count` answers `undefined`
 * (unknown), so nobody concludes a check-back was lost or that there is
 * none to wait for, and `removeAll` throws.
 */
export function createTaskCronLink(path: string): { count(key: string): number | undefined; removeAll(key: string): void } {
  const jobsFor = (store: CronStore, key: string) => store.list().filter((job) => job.sessionKey === key);
  return {
    count: (key) => {
      try {
        return jobsFor(new CronStore(path), key).filter((job) => job.enabled).length;
      } catch (err) {
        log.warn({ err, key }, "Sub-session: cron store unreadable; its check-backs are unknown");
        return undefined;
      }
    },
    removeAll: (key) => {
      const store = new CronStore(path);
      for (const job of jobsFor(store, key)) store.remove(job.id);
    },
  };
}
