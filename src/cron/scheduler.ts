import { CronStore } from "./store.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";

const POLL_INTERVAL_MS = 30_000; // Check every 30s

export class CronScheduler {
  private store: CronStore;
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(agent: Agent) {
    this.store = new CronStore();
    this.agent = agent;
  }

  start(): void {
    log.info("Cron scheduler started");
    // Check immediately on start
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Cron scheduler stopped");
  }

  private async tick(): Promise<void> {
    const dueJobs = this.store.getDueJobs();
    for (const job of dueJobs) {
      await this.execute(job.id);
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
