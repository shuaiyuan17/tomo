import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { CronJob, CronSchedule } from "./types.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

const DEFAULT_STORE_PATH = join(homedir(), ".tomo", "data", "cron", "jobs.json");

/** Failed one-shot ("at") jobs retry this many times before being disabled. */
export const ONE_SHOT_MAX_RETRIES = 2;
/** Delay before a failed one-shot job's retry. */
export const ONE_SHOT_RETRY_DELAY_MS = 5 * 60_000;

export class CronStore {
  private jobs: CronJob[] = [];
  private path: string;

  constructor(path = DEFAULT_STORE_PATH) {
    this.path = path;
    this.load();
  }

  list(): CronJob[] {
    return [...this.jobs];
  }

  get(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  add(opts: {
    name: string;
    schedule: CronSchedule;
    message: string;
    sessionKey: string;
    deleteAfterRun?: boolean;
  }): CronJob {
    // Reload before mutating (like markRun/remove): jobs added/removed by
    // separate CLI processes while this instance holds a stale snapshot
    // would otherwise be reverted by the save below.
    this.load();
    const now = Date.now();
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      name: opts.name,
      enabled: true,
      schedule: opts.schedule,
      message: opts.message,
      sessionKey: opts.sessionKey,
      deleteAfterRun: opts.deleteAfterRun ?? (opts.schedule.kind === "at"),
      createdAt: now,
      nextRunAt: computeNextRun(opts.schedule, now),
      lastRunAt: null,
      lastStatus: null,
      lastStartedAt: null,
      lastRunId: null,
    };
    this.jobs.push(job);
    this.save();
    return job;
  }

  /** Rewrite sessionKey on all jobs matching oldKey. Returns count changed. */
  rewriteSessionKey(oldKey: string, newKey: string): number {
    this.load();
    let count = 0;
    for (const job of this.jobs) {
      if (job.sessionKey === oldKey) {
        job.sessionKey = newKey;
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * Enable or disable a job. Enabling recomputes the next run; a one-shot
   * ("at") job whose time already passed fires on the next poll, with its
   * retry budget reset — re-enabling a failed reminder is a manual retry.
   */
  setEnabled(id: string, enabled: boolean): CronJob | undefined {
    this.load();
    const job = this.get(id);
    if (!job) return undefined;
    if (job.enabled === enabled) return job;
    job.enabled = enabled;
    if (enabled) {
      const now = Date.now();
      const next = computeNextRun(job.schedule, now);
      job.nextRunAt = job.schedule.kind === "at" && next === null ? now : next;
      if (job.schedule.kind === "at") delete job.retryCount;
    } else {
      // Clear rather than leave a stale timestamp that list/detail views
      // would show as a "next run" that will never fire.
      job.nextRunAt = null;
    }
    this.save();
    return job;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Record — durably, BEFORE the agent turn is dispatched — that a run has
   * started. `nextRunAt` only advances once a run completes (markRun), and the
   * scheduler's in-flight guard lives in memory, so without this a daemon that
   * restarts mid-run comes back up, sees a due job on disk, and fires it a
   * second time. `lastStartedAt > lastRunAt` is the durable "a run was
   * dispatched and never reported back" flag that recoverInterrupted reads.
   *
   * Returns the new run id, or undefined when the job vanished (removed by a
   * concurrent CLI call between the due-scan and dispatch).
   */
  markStarted(id: string): string | undefined {
    // Reload before mutating, like markRun/add: another process may have
    // changed the file since this instance's last read.
    this.load();
    const job = this.get(id);
    if (!job) return undefined;
    const runId = randomUUID().slice(0, 8);
    job.lastStartedAt = Date.now();
    job.lastRunId = runId;
    // This dispatch supersedes any earlier interrupted run: whatever marker
    // recovery left is being delivered right now.
    job.interruptedAt = null;
    this.save();
    return runId;
  }

  /**
   * Settle runs that were dispatched but never completed — the daemon was
   * restarted or killed mid-turn. Called once per scheduler start, BEFORE the
   * first due-scan, so the normal path never sees these jobs in a half state.
   *
   * The interrupted run is closed out (lastRunAt/lastStatus written, so the
   * job is not re-flagged on every subsequent restart) and the job is sorted
   * into one of two buckets:
   *
   * - `skipped`: one-shot (`deleteAfterRun`) jobs. Their whole point is a
   *   single fire, and that fire already happened; whether it finished is
   *   unknowable. They are disabled with `lastStatus: "interrupted"` so a
   *   human/agent can inspect and re-enable, and can never fire twice.
   * - `resumed`: recurring jobs. Still due on disk, so they will fire on the
   *   next tick — but `interruptedAt` is left set so the scheduler can mark
   *   that fire as a resume in the event body, telling the model to check
   *   state before repeating anything with side effects.
   */
  recoverInterrupted(): { resumed: CronJob[]; skipped: CronJob[] } {
    this.load();
    const now = Date.now();
    const resumed: CronJob[] = [];
    const skipped: CronJob[] = [];
    for (const job of this.jobs) {
      if (!isInterrupted(job)) continue;
      job.interruptedAt = job.lastStartedAt ?? now;
      job.lastRunAt = now;
      job.lastStatus = "interrupted";
      if (job.deleteAfterRun) {
        job.enabled = false;
        job.nextRunAt = null;
        // Nothing left to deliver, so drop the marker with the job's chance
        // to fire — it stays visible via lastStatus.
        job.interruptedAt = null;
        skipped.push({ ...job });
      } else {
        resumed.push({ ...job });
      }
    }
    if (resumed.length > 0 || skipped.length > 0) this.save();
    return { resumed, skipped };
  }

  markRun(id: string, status: "ok" | "error"): void {
    // Reload before mutating: jobs are added/removed by separate CLI
    // processes (tomo cron add) while the daemon's run is in flight; saving
    // the stale poll-time snapshot would silently delete them.
    this.load();
    const job = this.get(id);
    if (!job) return;

    const now = Date.now();
    job.lastRunAt = now;
    job.lastStatus = status;

    if (status === "ok" && job.deleteAfterRun) {
      this.remove(id);
      return;
    }

    // Compute next run for recurring jobs
    if (job.schedule.kind === "every") {
      // Advance from the scheduled due time, not from run completion —
      // otherwise every run's duration (an agent turn can take minutes)
      // accumulates as drift. If the daemon was down long enough that the
      // next slot is already in the past, restart the cadence from now
      // instead of burst-firing missed runs.
      const scheduled = job.nextRunAt ?? now;
      const next = scheduled + job.schedule.everyMs;
      job.nextRunAt = next > now ? next : computeNextRun(job.schedule, now);
    } else if (job.schedule.kind !== "at") {
      job.nextRunAt = computeNextRun(job.schedule, now);
    } else if (status === "error" && (job.retryCount ?? 0) < ONE_SHOT_MAX_RETRIES) {
      // A one-shot job IS the deliverable (a reminder, usually) — a failed
      // run gets a bounded number of delayed retries instead of being
      // silently disabled. Recurring jobs need none of this: their next
      // scheduled run is the retry.
      job.retryCount = (job.retryCount ?? 0) + 1;
      job.nextRunAt = now + ONE_SHOT_RETRY_DELAY_MS;
    } else {
      job.enabled = false;
      job.nextRunAt = null;
    }

    this.save();
  }

  getDueJobs(): CronJob[] {
    // Re-read from disk to pick up jobs added by external CLI calls
    this.load();
    const now = Date.now();
    return this.jobs.filter(
      (j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now,
    );
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.jobs = [];
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8"));
      this.jobs = data.jobs ?? [];
    } catch {
      this.jobs = [];
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomicSync(this.path, { version: 1, jobs: this.jobs });
  }
}

/**
 * A run was dispatched (markStarted) and never reported completion (markRun).
 * Within a live daemon that just means "in flight"; read at scheduler start it
 * means the previous daemon died mid-run.
 *
 * Jobs written before this field existed have no `lastStartedAt`, so they read
 * as never-interrupted — the pre-upgrade backlog is not retro-flagged.
 */
export function isInterrupted(job: CronJob): boolean {
  const started = job.lastStartedAt;
  if (started == null) return false;
  return job.lastRunAt == null || started > job.lastRunAt;
}

export function computeNextRun(schedule: CronSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case "at": {
      const ts = parseAtSchedule(schedule.at);
      return ts > fromMs ? ts : null;
    }
    case "every":
      return fromMs + schedule.everyMs;
    case "cron": {
      const cron = new Cron(schedule.expr, { timezone: schedule.tz });
      const next = cron.nextRun();
      return next ? next.getTime() : null;
    }
  }
}

export function parseScheduleString(input: string): CronSchedule {
  // "in 20m", "in 2h", "in 1d"
  const relMatch = input.match(/^in\s+(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (relMatch) {
    const val = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const ms = unit.startsWith("s") ? val * 1000
      : unit.startsWith("m") ? val * 60_000
      : unit.startsWith("h") ? val * 3_600_000
      : val * 86_400_000;
    return { kind: "at", at: new Date(Date.now() + ms).toISOString() };
  }

  // "every 30m", "every 2h"
  const everyMatch = input.match(/^every\s+(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (everyMatch) {
    const val = Number(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const ms = unit.startsWith("s") ? val * 1000
      : unit.startsWith("m") ? val * 60_000
      : unit.startsWith("h") ? val * 3_600_000
      : val * 86_400_000;
    return { kind: "every", everyMs: ms };
  }

  // ISO-8601 date
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
    return { kind: "at", at: input };
  }

  // Assume cron expression
  return { kind: "cron", expr: input, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function parseAtSchedule(at: string): number {
  return new Date(at).getTime();
}
