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
