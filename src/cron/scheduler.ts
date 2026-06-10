import { CronStore } from "./store.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";

const POLL_INTERVAL_MS = 30_000; // Check every 30s

export class CronScheduler {
  private store: CronStore;
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(agent: Agent) {
    this.store = new CronStore();
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
    // A job run can outlast the 30s poll (agent queries are slow), and
    // nextRunAt only advances after the run completes — without this guard
    // every overlapping tick re-fires the same still-due job.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const dueJobs = this.store.getDueJobs();
      for (const job of dueJobs) {
        await this.execute(job.id);
      }
    } catch (err) {
      // markRun can throw on disk errors; don't let it become an unhandled
      // rejection that kills the daemon.
      log.error({ err }, "Cron tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async execute(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;

    log.info({ jobId: job.id, name: job.name }, "Cron triggered: %s", job.message);

    try {
      const cronMessage = `System: Scheduled task "${job.name}" triggered. ${job.message}`;
      await this.agent.handleCronMessage(cronMessage, job.sessionKey);
      this.store.markRun(jobId, "ok");
      log.info({ jobId: job.id }, "Cron completed successfully");
    } catch (err) {
      this.store.markRun(jobId, "error");
      log.error({ err, jobId: job.id }, "Cron execution failed");
    }
  }
}
