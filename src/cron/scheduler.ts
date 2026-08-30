import { CronStore } from "./store.js";
import type { CronJob } from "./types.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { formatTomoEvent } from "../tomo-event.js";
import { watchBus } from "../watch/bus.js";

const POLL_INTERVAL_MS = 30_000; // Check every 30s
/**
 * How many times an outcome write is retried before the job is parked. The
 * turn already ran; what is failing is bookkeeping, so retrying is cheap and
 * giving up must not look like "never ran".
 */
const ACK_MAX_ATTEMPTS = 3;

interface PendingAck {
  ok: boolean;
  runId: string;
  attempts: number;
}

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
  /**
   * Runs whose turn finished but whose outcome could not be written to the
   * store. Their nextRunAt is therefore still in the past, so they would be
   * re-dispatched on the next scan — the very duplicate this PR exists to
   * prevent, just from a failed write instead of a restart. Held out of the
   * scan and retried on every tick.
   */
  private pendingAcks = new Map<string, PendingAck>();
  /** Interrupted-run recovery has completed (once per process). */
  private recovered = false;

  constructor(agent: Agent, store: CronStore = new CronStore()) {
    this.store = store;
    this.agent = agent;
  }

  start(): void {
    log.info("Cron scheduler started");
    // The first tick runs recovery before it scans — see tick().
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
    // Outcome writes that failed earlier come first: until one lands, its job
    // still looks due on disk.
    this.flushPendingAcks();

    // Settling runs the previous daemon left in flight is a PRECONDITION for
    // scanning, not a best-effort side quest. The in-flight guard is
    // memory-only and nextRunAt only advances when a run completes, so a scan
    // that runs before recovery lands re-fires whatever was mid-turn when the
    // daemon went down (`tomo restart` from inside a cron turn being the
    // common case) — a one-shot a second time, a recurring job without its
    // [resumed] marker. If recovery cannot persist, skip the scan entirely
    // and retry on the next tick; a late job beats a duplicated one.
    if (!this.ensureRecovered()) return;

    // The scan-and-dispatch below is synchronous (execute() marks the job
    // in-flight before its first await), so overlapping ticks cannot
    // double-dispatch a job.
    let dueJobs: CronJob[];
    try {
      dueJobs = this.store
        .getDueJobs()
        .filter((job) => !this.inFlight.has(job.id) && !this.pendingAcks.has(job.id));
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

  /** True when it is safe to scan for due jobs. Retried on every tick. */
  private ensureRecovered(): boolean {
    if (this.recovered) return true;
    let outcome: ReturnType<CronStore["recoverInterrupted"]>;
    try {
      outcome = this.store.recoverInterrupted();
    } catch (err) {
      log.error(
        { err },
        "Cron interrupted-run recovery failed; skipping the due-scan until it succeeds",
      );
      return false;
    }
    this.recovered = true;
    for (const { job, reason } of outcome.skipped) {
      log.warn(
        { jobId: job.id, name: job.name, startedAt: job.lastStartedAt, runId: job.lastRunId, reason },
        reason === "once"
          // One-shot: the single fire it was entitled to already happened. Do
          // not repeat it — the run may have sent the message, placed the
          // order, etc.
          ? "Cron one-shot was interrupted by a restart; not re-firing (disabled, re-enable to retry)"
          : "Cron job was interrupted on every recent resume; disabled to break the crash loop",
      );
    }
    for (const job of outcome.resumed) {
      log.warn(
        {
          jobId: job.id,
          name: job.name,
          startedAt: job.lastStartedAt,
          runId: job.lastRunId,
          attempt: job.resumeAttempts,
        },
        "Cron run was interrupted by a restart; next fire will be marked as resumed",
      );
    }
    return true;
  }

  private async execute(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;

    // Snapshot the fields we need: markStarted reloads the store from disk,
    // which replaces the object `job` points at.
    const { name, message, sessionKey } = job;
    const interruptedAt = job.interruptedAt ?? null;

    // Everything past this point is inside the try, so no failure — including
    // a markStarted write error — can leave the job wedged in `inFlight`
    // (which would make it invisible to every later scan in this process).
    this.inFlight.add(jobId);
    try {
      // Persist "this run started" BEFORE dispatching. markStarted is
      // synchronous, so it lands on disk within the same synchronous stretch
      // as the in-flight guard: a daemon killed at any point from here on
      // leaves an unacknowledged run token, which recovery reads on the next
      // start. It also clears interruptedAt, so the marker below is delivered
      // exactly once.
      const runId = this.store.markStarted(jobId);
      if (runId === undefined) {
        // Removed between the due-scan and dispatch (concurrent CLI/tool call).
        return;
      }
      log.info({ jobId, name, runId }, "Cron triggered: %s", message);
      watchBus.publish({ type: "cron.fired", jobId, name });

      const cronMessage = formatTomoEvent(
        "cron",
        `Scheduled task "${name}" triggered. ${message}` + resumedNote(interruptedAt),
        { name },
      );
      // The turn's outcome and the recording of that outcome are separate
      // failures with opposite handling: a turn that reports failure earns a
      // retry, a write that fails after a SUCCESSFUL turn must never be
      // recorded as one (that is how a completed one-shot ends up back on the
      // failure-retry path and runs twice). So the outcome is captured first
      // and persisted second, by a path that cannot invent an error.
      let ok: boolean;
      try {
        // handleCronMessage never rejects — it reports the turn's outcome so
        // real agent failures land in lastStatus instead of reading as "ok".
        // waitForHandoff makes a run that is handed to a summoned session
        // resolve when that turn actually completes, not when it is queued.
        ok = await this.agent.handleCronMessage(cronMessage, sessionKey, { waitForHandoff: true });
      } catch (err) {
        // Unreachable by contract; a broken contract must not read as success.
        log.error({ err, jobId, runId }, "Cron turn rejected");
        ok = false;
      }
      watchBus.publish({ type: "cron.done", jobId, name, ok });
      if (ok) {
        log.info({ jobId, runId }, "Cron completed successfully");
      } else {
        log.warn({ jobId, runId }, "Cron run completed with errors");
      }
      this.ackRun(jobId, ok, runId);
    } catch (err) {
      // Only reachable before the turn was dispatched (markStarted or event
      // formatting). Nothing ran, so nothing is recorded: the job stays due
      // and the next tick tries again.
      log.error({ err, jobId }, "Cron dispatch failed");
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  /**
   * Record a finished run's outcome. On a write failure the run is queued for
   * retry rather than dropped — an unrecorded outcome leaves the job due,
   * which is how a completed run gets repeated.
   */
  private ackRun(jobId: string, ok: boolean, runId: string): void {
    try {
      this.store.markRun(jobId, ok ? "ok" : "error");
    } catch (err) {
      log.error({ err, jobId, runId, ok }, "Could not record cron outcome; will retry");
      this.pendingAcks.set(jobId, { ok, runId, attempts: 1 });
    }
  }

  /** Retry outcome writes that failed on an earlier tick. */
  private flushPendingAcks(): void {
    for (const [jobId, pending] of [...this.pendingAcks]) {
      if (pending.attempts < ACK_MAX_ATTEMPTS) {
        try {
          this.store.markRun(jobId, pending.ok ? "ok" : "error");
          this.pendingAcks.delete(jobId);
          log.info({ jobId, runId: pending.runId }, "Recorded cron outcome on retry");
        } catch (err) {
          pending.attempts++;
          log.error({ err, jobId, runId: pending.runId, attempts: pending.attempts }, "Cron outcome write failed again");
        }
        continue;
      }
      // Out of retries. Park the job instead of letting it look due: its turn
      // ran, and a one-shot in particular must not come back through the
      // failure-retry path as though it never fired.
      try {
        this.store.markUnacked(jobId, pending.ok ? "ok" : "error");
        this.pendingAcks.delete(jobId);
        log.warn(
          { jobId, runId: pending.runId, ok: pending.ok },
          "Cron outcome could not be recorded; job disabled as finished-but-unacked",
        );
      } catch (err) {
        // The store is unwritable. Keep holding the job out of the scan (this
        // process will not repeat it) and keep trying. Residual ambiguity: if
        // the daemon restarts while in this state the run token is still
        // unacknowledged, so recovery treats the run as interrupted — a
        // one-shot is disabled rather than re-fired, a recurring job gets one
        // [resumed] fire. Both are the safe reading of "we do not know".
        log.error({ err, jobId, runId: pending.runId }, "Cron job could not be parked after a failed outcome write");
      }
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
