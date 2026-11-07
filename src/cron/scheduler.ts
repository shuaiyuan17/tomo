import { CronStore, type StaleSkip } from "./store.js";
import type { CronJob } from "./types.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { formatTomoEvent } from "../tomo-event.js";
import { watchBus } from "../watch/bus.js";
import { formatDuration } from "./format.js";

/**
 * Due-scan cadence. Exported because it is also the floor on how often a job
 * can fire: `MIN_EVERY_MS` in store.ts mirrors it, and a test pins the two
 * together so shortening one without the other cannot go unnoticed.
 */
export const POLL_INTERVAL_MS = 30_000; // Check every 30s
/**
 * How many times an outcome write is retried before the job is parked. The
 * turn already ran; what is failing is bookkeeping, so retrying is cheap and
 * giving up must not look like "never ran".
 */
const ACK_MAX_ATTEMPTS = 3;
/** Retry cadence for an owner report that could not be delivered. */
export const OWNER_REPORT_RETRY_MS = 10 * 60_000;

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
  /** Earliest time the next owner report may be attempted. */
  private nextOwnerReportAt = 0;
  private reportingToOwner = false;

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

    // Lateness before the due-scan: after downtime, recurring runs missed by
    // more than their staleness window move to their next slot instead of
    // all firing in this one tick. Done BEFORE the owner report below so an
    // outage's skips and parked one-shots go out as ONE message.
    try {
      const busy = new Set([...this.inFlight, ...this.pendingAcks.keys()]);
      const skipped = this.store.skipStaleRuns(busy);
      for (const skip of skipped) logStaleSkip(skip);
      if (skipped.length > 0) this.nextOwnerReportAt = 0;
      // A one-shot retry queued by recovery that still has not gone out
      // (the scan or dispatch kept failing) and is now past its window.
      const expired = this.store.expireStaleOneShotRetries(busy);
      for (const job of expired) {
        log.warn({ jobId: job.id, name: job.name }, "Cron one-shot retry went stale before it could run; disabled, owner will be told");
      }
      if (expired.length > 0) this.nextOwnerReportAt = 0;
    } catch (err) {
      log.error({ err }, "Cron staleness check failed");
    }

    // Tell the owner what will not happen on its own: skipped runs and parked
    // one-shots. On the first tick, whenever something new happens, and —
    // until a report goes through — every OWNER_REPORT_RETRY_MS.
    if (!this.reportingToOwner && Date.now() >= this.nextOwnerReportAt) {
      this.nextOwnerReportAt = Date.now() + OWNER_REPORT_RETRY_MS;
      this.reportingToOwner = true;
      void this.reportToOwner().finally(() => { this.reportingToOwner = false; });
    }

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
        reason === "once-stale"
          ? "Cron one-shot was interrupted by a restart too long ago to retry; disabled, owner will be told"
          : reason === "once-retried"
            ? "Cron one-shot was interrupted again after its one retry; disabled, owner will be told"
            : reason === "once-disabled"
              ? "Cron one-shot was interrupted by a restart while disabled; not retried, owner will be told"
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

  /**
   * One DM to the owner (direct, no model turn) covering everything that will
   * not happen on its own:
   *
   * - recurring runs skipped as stale — so an outage is not discovered weeks
   *   later as "the backup never ran that night";
   * - one-shots parked after an interruption — a reminder that would
   *   otherwise never arrive. Each job is reported once (interruptNotifiedAt).
   *
   * Batched: an outage's worth of skips and parks lands in one message. Both
   * are pending ON DISK (skipNotice, interruptNotifiedAt), so a failed DM or a
   * restart loses nothing; a failed attempt is retried after
   * OWNER_REPORT_RETRY_MS.
   */
  private async reportToOwner(): Promise<void> {
    let parked: CronJob[];
    let skips: CronJob[];
    try {
      parked = this.store.unreportedParkedOneShots();
      skips = this.store.unreportedSkips();
    } catch (err) {
      log.error({ err }, "Could not read skipped or parked cron jobs to report");
      return;
    }
    if (parked.length === 0 && skips.length === 0) return;

    const sections: string[] = [];
    if (skips.length > 0) {
      sections.push([
        `${skips.length === 1 ? "A scheduled run was" : `${skips.length} scheduled runs were`} ` +
          "missed (Tomo was down or behind) by more than the job's catch-up window, so " +
          `${skips.length === 1 ? "it was" : "they were"} skipped rather than run late:`,
        ...skips.map((job) => {
          const { lateByMs, windowMs } = job.skipNotice!;
          const next = job.nextRunAt ? `; next run ${new Date(job.nextRunAt).toLocaleString()}` : "";
          return `- "${job.name}" [${job.id}]: ${formatDuration(lateByMs)} late, window ${formatDuration(windowMs)}${next}`;
        }),
        "If one is still needed, ask me to do it now. To make a job always catch up: `tomo cron edit <id> --stale-after 0`.",
      ].join("\n"));
    }
    if (parked.length > 0) {
      sections.push([
        `${parked.length === 1 ? "A scheduled one-time task was" : `${parked.length} scheduled one-time tasks were`} ` +
          "interrupted by a restart and will not run on their own:",
        ...parked.map((job) => {
          const started = job.lastStartedAt ?? job.lastRunAt;
          const when = started ? ` (started ${new Date(started).toLocaleString()})` : "";
          return `- "${job.name}" [${job.id}]${when}: ${excerpt(job.message)}`;
        }),
        "Re-run one with `tomo cron enable <id>`, or remove it with `tomo cron remove <id>`.",
      ].join("\n"));
    }
    const ids = { skipped: skips.map((job) => job.id), parked: parked.map((job) => job.id) };
    let delivered: boolean;
    try {
      // Owner only: the excerpts may come from any session's jobs.
      delivered = await this.agent.notifyOwner(sections.join("\n\n"));
    } catch (err) {
      log.error({ err, ...ids }, "Could not tell the owner about skipped or interrupted cron runs; will retry");
      return;
    }
    if (!delivered) {
      // Nothing was delivered; it all stays pending on disk for a later try.
      log.warn(ids, "No owner DM to report skipped or interrupted cron runs to; will retry");
      return;
    }
    log.info(ids, "Told the owner about skipped or interrupted cron runs");
    // Each acknowledgement on its own: one failing must not re-send the other.
    try { this.store.markSkipNoticesSent(ids.skipped); } catch (err) {
      log.error({ err, jobIds: ids.skipped }, "Could not record that skipped cron runs were reported");
    }
    try { this.store.markInterruptNotified(ids.parked); } catch (err) {
      log.error({ err, jobIds: ids.parked }, "Could not record that interrupted cron one-shots were reported");
    }
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
        ok = await this.agent.handleCronMessage(cronMessage, sessionKey, { waitForHandoff: true, jobName: name });
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

function logStaleSkip({ job, lateByMs, windowMs }: StaleSkip): void {
  log.warn(
    { jobId: job.id, name: job.name, lateByMs, windowMs, nextRunAt: job.nextRunAt },
    `Cron run skipped: missed its slot by ${formatDuration(lateByMs)}, more than its ${formatDuration(windowMs)} staleness window; next run ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "none"}`,
  );
}

function excerpt(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
