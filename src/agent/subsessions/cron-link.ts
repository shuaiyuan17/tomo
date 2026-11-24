import { CronStore } from "../../cron/store.js";
import { log } from "../../logger.js";

/**
 * A task's cron jobs (its check-backs), read fresh from the store file every
 * time. The task's own `schedule_create` and the scheduler write through
 * other CronStore instances, and `CronStore.list()` does not reload, so a
 * snapshot kept across turns would miss new jobs and keep deleted ones.
 */
export function createTaskCronLink(path: string): { count(key: string): number; removeAll(key: string): void } {
  const jobsFor = (store: CronStore, key: string) => {
    try {
      return store.list().filter((job) => job.sessionKey === key);
    } catch (err) {
      log.warn({ err, key }, "Sub-session: cron store unreadable");
      return [];
    }
  };
  return {
    count: (key) => jobsFor(new CronStore(path), key).filter((job) => job.enabled).length,
    removeAll: (key) => {
      const store = new CronStore(path);
      for (const job of jobsFor(store, key)) store.remove(job.id);
    },
  };
}
