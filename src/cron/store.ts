import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { CronJob, CronSchedule } from "./types.js";

const DEFAULT_STORE_PATH = join(homedir(), ".tomo", "data", "cron", "jobs.json");

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
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  markRun(id: string, status: "ok" | "error"): void {
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
    if (job.schedule.kind !== "at") {
      job.nextRunAt = computeNextRun(job.schedule, now);
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
    writeFileSync(this.path, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2) + "\n");
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
