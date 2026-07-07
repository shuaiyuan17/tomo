import { CronStore } from "./store.js";
import type { CronJob } from "./types.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { formatTomoEvent } from "../tomo-event.js";
import { watchBus } from "../watch/bus.js";

const POLL_INTERVAL_MS = 30_000; // Check every 30s

export class CronScheduler {
  private store: CronStore;
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Jobs currently running an agent turn. A run can outlast the 30s poll
  // (agent queries are slow) and nextRunAt only advances after the run
  // completes, so due-job scans must skip these — but ONLY these: holding a
  // whole-tick guard instead would make one slow job delay every job that
  // becomes due while it runs.
  private inFlight = new Set<string>();

  constructor(agent: Agent, store: CronStore = new CronStore()) {
    this.store = store;
    this.agent = agent;
  }

  start(): void {
    log.info("Cron scheduler started");
    // Check immediately on start
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Cron scheduler stopped");
  }

  private async tick(): Promise<void> {
    // The scan-and-dispatch below is synchronous (execute() marks the job
    // in-flight before its first await), so overlapping ticks cannot
    // double-dispatch a job.
    let dueJobs: CronJob[];
    try {
      dueJobs = this.store.getDueJobs().filter((job) => !this.inFlight.has(job.id));
    } catch (err) {
      // getDueJobs can throw on disk errors; don't let it become an
      // unhandled rejection that kills the daemon.
      log.error({ err }, "Cron tick failed");
      return;
    }
    // Dispatch due jobs concurrently: a job's agent turn can take minutes,
    // and running them serially would delay every other due job by that
    // much. Jobs on the same session still serialize through the agent's
    // per-session queue; markRun stays safe because it's fully synchronous
    // (no interleaving within a single load-mutate-save).
    await Promise.allSettled(dueJobs.map((job) => this.execute(job.id)));
  }

  private async execute(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;

    this.inFlight.add(jobId);
    log.info({ jobId: job.id, name: job.name }, "Cron triggered: %s", job.message);
    watchBus.publish({ type: "cron.fired", jobId: job.id, name: job.name });

    try {
      const cronMessage = formatTomoEvent(
        "cron",
        `Scheduled task "${job.name}" triggered. ${job.message}`,
        { name: job.name },
      );
      // handleCronMessage never rejects — it reports the turn's outcome so
      // real agent failures land in lastStatus instead of reading as "ok".
      const ok = await this.agent.handleCronMessage(cronMessage, job.sessionKey);
      this.store.markRun(jobId, ok ? "ok" : "error");
      watchBus.publish({ type: "cron.done", jobId: job.id, name: job.name, ok });
      if (ok) {
        log.info({ jobId: job.id }, "Cron completed successfully");
      } else {
        log.warn({ jobId: job.id }, "Cron run completed with errors");
      }
    } catch (err) {
      // markRun can throw on disk errors.
      log.error({ err, jobId: job.id }, "Cron execution failed");
      try {
        this.store.markRun(jobId, "error");
      } catch (markErr) {
        log.error({ err: markErr, jobId: job.id }, "Could not record cron failure");
      }
    } finally {
      this.inFlight.delete(jobId);
    }
  }
}
