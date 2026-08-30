import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CronStore,
  isInterrupted,
  ONE_SHOT_MAX_RETRIES,
  ONE_SHOT_RETRY_DELAY_MS,
  parseScheduleString,
} from "../src/cron/store.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-cron");
const TEST_PATH = join(TEST_DIR, "jobs.json");

describe("CronStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates and lists jobs", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "hello",
      sessionKey: "dm:alice",
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("test");
    expect(job.enabled).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("removes jobs", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "hello",
      sessionKey: "dm:alice",
    });

    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("persists to disk and reloads", () => {
    const store1 = new CronStore(TEST_PATH);
    store1.add({
      name: "persistent",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "morning",
      sessionKey: "telegram:12345",
    });

    const store2 = new CronStore(TEST_PATH);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].name).toBe("persistent");
  });

  it("finds due jobs", () => {
    const store = new CronStore(TEST_PATH);
    // "every" job with nextRunAt set to the past
    store.add({
      name: "overdue",
      schedule: { kind: "every", everyMs: 1000 },
      message: "past",
    });
    store.add({
      name: "future",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "later",
      sessionKey: "dm:alice",
    });

    // Persist an overdue nextRunAt directly (getDueJobs reloads from disk)
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs.find((j: { name: string }) => j.name === "overdue").nextRunAt = Date.now() - 1000;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const due = store.getDueJobs();
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("overdue");
  });

  it("marks run and updates state", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "ok");
    const updated = store.get(job.id)!;
    expect(updated.lastStatus).toBe("ok");
    expect(updated.lastRunAt).toBeTruthy();
    expect(updated.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("advances 'every' schedules from the scheduled due time, not run completion", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    // Simulate a run that fired 5s late (poll granularity + a slow agent
    // turn). The next slot must be scheduled-time + interval, so the delay
    // doesn't accumulate as drift run over run.
    const scheduledAt = Date.now() - 5_000;
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = scheduledAt;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    store.markRun(job.id, "ok");
    expect(store.get(job.id)!.nextRunAt).toBe(scheduledAt + 60_000);
  });

  it("restarts the 'every' cadence from now when the next slot is already past", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    // Daemon was down for several intervals: don't burst-fire missed runs.
    const scheduledAt = Date.now() - 300_000;
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = scheduledAt;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const before = Date.now();
    store.markRun(job.id, "ok");
    const next = store.get(job.id)!.nextRunAt!;
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("disables one-shot jobs after run", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "once",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "fire once",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "ok");
    // deleteAfterRun defaults to true for "at" jobs
    expect(store.get(job.id)).toBeUndefined();
  });

  it("schedules a delayed retry when a one-shot job fails", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "reminder",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "important reminder",
      sessionKey: "dm:alice",
    });

    const before = Date.now();
    store.markRun(job.id, "error");

    const updated = store.get(job.id)!;
    expect(updated.enabled).toBe(true);
    expect(updated.lastStatus).toBe("error");
    expect(updated.retryCount).toBe(1);
    expect(updated.nextRunAt).toBeGreaterThanOrEqual(before + ONE_SHOT_RETRY_DELAY_MS);
  });

  it("disables a one-shot job only after exhausting its retries", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "reminder",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "important reminder",
      sessionKey: "dm:alice",
    });

    for (let i = 0; i < ONE_SHOT_MAX_RETRIES; i++) {
      store.markRun(job.id, "error");
      expect(store.get(job.id)!.enabled).toBe(true);
    }

    // Final failure: retries exhausted, job is disabled (kept for inspection).
    store.markRun(job.id, "error");
    const final = store.get(job.id)!;
    expect(final.enabled).toBe(false);
    expect(final.nextRunAt).toBeNull();
    expect(final.retryCount).toBe(ONE_SHOT_MAX_RETRIES);
  });

  it("still deletes a one-shot job when a retry succeeds", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "reminder",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "important reminder",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "error");
    expect(store.get(job.id)!.enabled).toBe(true);

    store.markRun(job.id, "ok");
    expect(store.get(job.id)).toBeUndefined();
  });

  it("does not add retry state to failed recurring jobs", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "error");
    const updated = store.get(job.id)!;
    // The next scheduled run IS the retry for recurring jobs.
    expect(updated.enabled).toBe(true);
    expect(updated.retryCount).toBeUndefined();
    expect(updated.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("defaults deleteAfterRun=true for 'at' schedules when not specified", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "at-default",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "tomorrow",
      sessionKey: "dm:alice",
      // deleteAfterRun intentionally omitted
    });
    expect(job.deleteAfterRun).toBe(true);
  });

  it("defaults deleteAfterRun=false for recurring schedules when not specified", () => {
    const store = new CronStore(TEST_PATH);
    const cronJob = store.add({
      name: "daily",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "morning",
      sessionKey: "dm:alice",
    });
    expect(cronJob.deleteAfterRun).toBe(false);

    const everyJob = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    expect(everyJob.deleteAfterRun).toBe(false);
  });

  it("respects explicit deleteAfterRun override on 'at' schedules", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "at-keep",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "keep me",
      sessionKey: "dm:alice",
      deleteAfterRun: false,
    });
    expect(job.deleteAfterRun).toBe(false);
  });

  it("respects explicit deleteAfterRun=true on recurring schedules", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "fire-once-then-die",
      schedule: { kind: "cron", expr: "0 19 1 5 *" },
      message: "may 1 only this year",
      sessionKey: "dm:alice",
      deleteAfterRun: true,
    });
    expect(job.deleteAfterRun).toBe(true);
  });

  it("add() does not resurrect jobs removed by another process", () => {
    // Simulates the daemon's long-lived store vs a CLI process removing a
    // job while the daemon holds a stale in-memory snapshot.
    const daemonStore = new CronStore(TEST_PATH);
    const stale = daemonStore.add({
      name: "removed-externally",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });

    const cliStore = new CronStore(TEST_PATH);
    cliStore.remove(stale.id);

    daemonStore.add({
      name: "new-job",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "y",
      sessionKey: "dm:alice",
    });

    const names = new CronStore(TEST_PATH).list().map((j) => j.name);
    expect(names).toEqual(["new-job"]);
  });

  it("setEnabled disables and re-enables a recurring job", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    const disabled = store.setEnabled(job.id, false)!;
    expect(disabled.enabled).toBe(false);
    // No stale "next run" on a job that will not fire
    expect(disabled.nextRunAt).toBeNull();
    // Persisted, not just in-memory
    expect(new CronStore(TEST_PATH).get(job.id)!.enabled).toBe(false);

    const before = Date.now();
    const enabled = store.setEnabled(job.id, true)!;
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("setEnabled re-arms an expired one-shot to fire on the next poll", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "reminder",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "important reminder",
      sessionKey: "dm:alice",
    });

    // Exhaust retries so the job ends up disabled
    for (let i = 0; i <= ONE_SHOT_MAX_RETRIES; i++) store.markRun(job.id, "error");
    expect(store.get(job.id)!.enabled).toBe(false);

    const before = Date.now();
    const enabled = store.setEnabled(job.id, true)!;
    expect(enabled.enabled).toBe(true);
    expect(enabled.retryCount).toBeUndefined();
    expect(enabled.nextRunAt).toBeGreaterThanOrEqual(before);
    expect(enabled.nextRunAt).toBeLessThanOrEqual(Date.now());
  });

  it("setEnabled returns undefined for unknown ids and is a no-op when unchanged", () => {
    const store = new CronStore(TEST_PATH);
    expect(store.setEnabled("nope", true)).toBeUndefined();

    const job = store.add({
      name: "tick",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    const next = job.nextRunAt;
    const same = store.setEnabled(job.id, true)!;
    expect(same.enabled).toBe(true);
    expect(same.nextRunAt).toBe(next);
  });

  it("rewrites sessionKey in bulk", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "job-a",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "a",
      sessionKey: "telegram:12345",
    });
    store.add({
      name: "job-b",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "b",
      sessionKey: "telegram:12345",
    });
    store.add({
      name: "job-c",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "c",
      sessionKey: "imessage:+15551234567",
    });

    const count = store.rewriteSessionKey("telegram:12345", "dm:alice");
    expect(count).toBe(2);

    const reloaded = new CronStore(TEST_PATH);
    const jobs = reloaded.list();
    expect(jobs.find((j) => j.name === "job-a")?.sessionKey).toBe("dm:alice");
    expect(jobs.find((j) => j.name === "job-b")?.sessionKey).toBe("dm:alice");
    expect(jobs.find((j) => j.name === "job-c")?.sessionKey).toBe("imessage:+15551234567");
  });

  it("rewriteSessionKey returns 0 when no jobs match", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "j",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    expect(store.rewriteSessionKey("telegram:nothing", "dm:bob")).toBe(0);
  });
});

describe("CronStore interrupted-run recovery", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function addRecurring(store: CronStore) {
    return store.add({
      name: "recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
  }

  it("markStarted records the dispatch durably, before any completion", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    const runId = store.markStarted(job.id);

    expect(runId).toMatch(/^[0-9a-f]{8}$/);
    // Visible to a *different* process reading the same file — that's the
    // whole point: an in-memory flag dies with the daemon.
    const reloaded = new CronStore(TEST_PATH).list()[0];
    expect(reloaded.lastRunId).toBe(runId);
    expect(reloaded.lastStartedAt).toBeGreaterThan(0);
    expect(reloaded.lastRunAt).toBeNull();
    expect(isInterrupted(reloaded)).toBe(true);

    store.markRun(job.id, "ok");
    expect(isInterrupted(new CronStore(TEST_PATH).list()[0])).toBe(false);
  });

  it("markStarted on a vanished job reports undefined instead of resurrecting it", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    store.remove(job.id);
    expect(store.markStarted(job.id)).toBeUndefined();
    expect(new CronStore(TEST_PATH).list()).toHaveLength(0);
  });

  it("flags an interrupted recurring job for a marked resume, once", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    store.markStarted(job.id);

    const first = new CronStore(TEST_PATH).recoverInterrupted();
    expect(first.resumed.map((j) => j.id)).toEqual([job.id]);
    expect(first.skipped).toHaveLength(0);

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.lastStatus).toBe("interrupted");
    expect(after.interruptedAt).toBeGreaterThan(0);
    // Still due — the resumed fire is delivered by the normal scan.
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).not.toBeNull();

    // A second restart before the resume lands must not re-flag it: the run
    // is already accounted for, and the marker is already on the job.
    const second = new CronStore(TEST_PATH).recoverInterrupted();
    expect(second.resumed).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
  });

  it("disables an interrupted once job instead of letting it fire again", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "place the order",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);

    const { resumed, skipped } = new CronStore(TEST_PATH).recoverInterrupted();
    expect(resumed).toHaveLength(0);
    expect(skipped.map((j) => j.id)).toEqual([job.id]);

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("interrupted");
    // No resume marker: this job gets no second fire to carry one.
    expect(after.interruptedAt ?? null).toBeNull();
  });

  it("leaves completed and never-run jobs untouched", () => {
    const store = new CronStore(TEST_PATH);
    const done = addRecurring(store);
    store.markStarted(done.id);
    store.markRun(done.id, "ok");
    const fresh = store.add({
      name: "fresh",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "y",
      sessionKey: "dm:bob",
    });

    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.resumed).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(new CronStore(TEST_PATH).get(fresh.id)?.enabled).toBe(true);
  });

  it("does not retro-flag jobs written before lastStartedAt existed", () => {
    // Pre-upgrade records have no lastStartedAt at all; treating them as
    // interrupted would disable every one-shot on the first upgraded start.
    writeFileSync(TEST_PATH, JSON.stringify({
      version: 1,
      jobs: [{
        id: "legacy01",
        name: "legacy",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
        message: "old",
        sessionKey: "dm:alice",
        deleteAfterRun: true,
        createdAt: Date.now() - 120_000,
        nextRunAt: Date.now() - 60_000,
        lastRunAt: null,
        lastStatus: null,
      }],
    }));

    const store = new CronStore(TEST_PATH);
    expect(isInterrupted(store.list()[0])).toBe(false);
    const outcome = store.recoverInterrupted();
    expect(outcome.resumed).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(store.getDueJobs()).toHaveLength(1);
  });
});

describe("parseScheduleString", () => {
  it("parses relative time", () => {
    const s = parseScheduleString("in 20m");
    expect(s.kind).toBe("at");
    if (s.kind === "at") {
      const ts = new Date(s.at).getTime();
      expect(ts).toBeGreaterThan(Date.now());
      expect(ts).toBeLessThan(Date.now() + 25 * 60_000);
    }
  });

  it("parses interval", () => {
    const s = parseScheduleString("every 2h");
    expect(s).toEqual({ kind: "every", everyMs: 7_200_000 });
  });

  it("parses cron expression", () => {
    const s = parseScheduleString("0 9 * * *");
    expect(s.kind).toBe("cron");
    if (s.kind === "cron") {
      expect(s.expr).toBe("0 9 * * *");
      expect(s.tz).toBeTruthy();
    }
  });

  it("parses ISO date", () => {
    const s = parseScheduleString("2026-12-25T00:00:00Z");
    expect(s.kind).toBe("at");
  });
});
