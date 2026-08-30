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
    // Settle runs the previous daemon left in flight BEFORE the first scan.
    // The in-flight guard above is memory-only, and nextRunAt only advances
    // when a run completes, so without this the first tick re-fires whatever
    // was mid-turn when the daemon went down (`tomo restart` during a cron
    // run being the common case) as if it had never run.
    this.recoverInterrupted();
    // Check immediately on start
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  private recoverInterrupted(): void {
    let outcome: ReturnType<CronStore["recoverInterrupted"]>;
    try {
      outcome = this.store.recoverInterrupted();
    } catch (err) {
      log.error({ err }, "Cron interrupted-run recovery failed");
      return;
    }
    for (const job of outcome.skipped) {
      // One-shot: the single fire it was entitled to already happened. Do not
      // repeat it — the run may have sent the message, placed the order, etc.
      log.warn(
        { jobId: job.id, name: job.name, startedAt: job.lastStartedAt, runId: job.lastRunId },
        "Cron one-shot was interrupted by a restart; not re-firing (disabled, inspect and re-enable to retry)",
      );
    }
    for (const job of outcome.resumed) {
      log.warn(
        { jobId: job.id, name: job.name, startedAt: job.lastStartedAt, runId: job.lastRunId },
        "Cron run was interrupted by a restart; next fire will be marked as resumed",
      );
    }
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
    // Snapshot the fields we need: markStarted reloads the store from disk,
    // which replaces the object `job` points at.
    const { name, message, sessionKey } = job;
    const interruptedAt = job.interruptedAt ?? null;
    // Persist "this run started" BEFORE dispatching. markStarted is
    // synchronous, so it lands on disk within the same synchronous stretch as
    // the in-flight guard: a daemon killed at any point from here on leaves
    // lastStartedAt > lastRunAt, which recovery reads on the next start.
    // It also clears interruptedAt, so the marker below is delivered once.
    const runId = this.store.markStarted(jobId);
    if (runId === undefined) {
      // Removed between the due-scan and dispatch (concurrent CLI/tool call).
      this.inFlight.delete(jobId);
      return;
    }
    log.info({ jobId: job.id, name, runId }, "Cron triggered: %s", message);
    watchBus.publish({ type: "cron.fired", jobId: job.id, name });

    try {
      const cronMessage = formatTomoEvent(
        "cron",
        `Scheduled task "${name}" triggered. ${message}` + resumedNote(interruptedAt),
        { name },
      );
      // handleCronMessage never rejects — it reports the turn's outcome so
      // real agent failures land in lastStatus instead of reading as "ok".
      const ok = await this.agent.handleCronMessage(cronMessage, sessionKey);
      this.store.markRun(jobId, ok ? "ok" : "error");
      watchBus.publish({ type: "cron.done", jobId: job.id, name, ok });
      if (ok) {
        log.info({ jobId: job.id }, "Cron completed successfully");
      } else {
        log.warn({ jobId: job.id }, "Cron run completed with errors");
      }
    } catch (err) {
      // markRun can throw on disk errors.
      log.error({ err, jobId: job.id, runId }, "Cron execution failed");
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

/**
 * Body suffix for a fire that is standing in for a run the previous daemon
 * never finished. The model has no other way to tell this apart from a normal
 * trigger, and the work may be half-done — say so explicitly rather than
 * letting a non-idempotent task (an order, an email, a message, a submission)
 * be repeated as if it had never happened.
 */
function resumedNote(interruptedAt: number | null): string {
  if (interruptedAt === null) return "";
  return (
    `\n\n[resumed] A previous run of this task started at ` +
    `${new Date(interruptedAt).toISOString()} and never reported completion — ` +
    `the daemon restarted mid-run. It may have finished, partly finished, or ` +
    `done nothing. Check current state before repeating anything with side ` +
    `effects (sending, posting, ordering, writing, submitting).`
  );
}
