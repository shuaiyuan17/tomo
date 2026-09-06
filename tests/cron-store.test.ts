import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CronStore,
  CronStoreReadError,
  MAX_RESUME_ATTEMPTS,
  isInterrupted,
  mergeWithDisk,
  ONE_SHOT_MAX_RETRIES,
  ONE_SHOT_RETRY_DELAY_MS,
  parseScheduleString,
  parseCreatableSchedule,
  unschedulableReason,
} from "../src/cron/store.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cronAddRefusal, readCronJobsSafely } from "../src/cli/cron-errors.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

type CronJobLike = Record<string, unknown> & { id: string };

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

  it("setEnabled refuses to re-arm a recurring job with no occurrence left", () => {
    // The other half of the dead-job shape `schedule_create` refuses. `add` is
    // deliberately permissive, and a recurring schedule can also run OUT of
    // occurrences after the job was created — enabling it then wrote
    // `enabled: true, nextRunAt: null`: a job every surface reports as
    // scheduled that the 30s scan can never pick up.
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "feb 30th",
      schedule: parseScheduleString("0 0 30 2 *"),
      message: "never",
      sessionKey: "dm:alice",
    });
    store.setEnabled(job.id, false);

    expect(store.setEnabled(job.id, true)).toBe("unschedulable");
    // And it is a true no-op: still disabled, on disk as well as in memory.
    const after = new CronStore(TEST_PATH).get(job.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
  });

  it("setEnabled still re-arms a past one-shot — that is not the same thing", () => {
    // `unschedulableReason` calls a past `at` unschedulable, and for CREATION
    // it is. Re-enabling one is the opposite: "run this again now" is exactly
    // what the caller means, and setEnabled arms it for the next poll. The
    // gate must not swallow that.
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "fired reminder",
      schedule: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
      message: "again",
      sessionKey: "dm:alice",
    });
    store.setEnabled(job.id, false);

    const enabled = store.setEnabled(job.id, true);
    expect(enabled).not.toBe("unschedulable");
    expect((enabled as { enabled: boolean }).enabled).toBe(true);
    expect((enabled as { nextRunAt: number }).nextRunAt).toBeLessThanOrEqual(Date.now());
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
    expect(skipped.map((s) => s.job.id)).toEqual([job.id]);
    expect(skipped[0].reason).toBe("once");

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("interrupted");
    // No resume marker: this job gets no second fire to carry one.
    expect(after.interruptedAt ?? null).toBeNull();
  });

  it("disables an interrupted at-job kept as a record (once: false) instead of re-firing it", () => {
    // `schedule_create ... once: false` on an "at" schedule means "keep the
    // job around after it fires", NOT "run it repeatedly". markRun already
    // treats kind "at" as single-fire (no recomputed nextRunAt), so recovery
    // must park it too — resuming leaves the job due with an unacknowledged
    // token, i.e. one extra fire per daemon restart, forever.
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "keep-the-record",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "place the order",
      sessionKey: "dm:alice",
      deleteAfterRun: false,
    });
    expect(job.deleteAfterRun).toBe(false);
    store.markStarted(job.id);

    const { resumed, skipped } = new CronStore(TEST_PATH).recoverInterrupted();
    expect(resumed).toHaveLength(0);
    expect(skipped.map((s) => s.job.id)).toEqual([job.id]);
    expect(skipped[0].reason).toBe("once");

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();

    // And it stays parked across the next restart rather than coming back due.
    const second = new CronStore(TEST_PATH).recoverInterrupted();
    expect(second.resumed).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
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

describe("CronStore crash-loop cap and clock independence", () => {
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

  it("stops resuming a job that is interrupted on every restart", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);

    // A turn that takes the daemon down with it: dispatch, die, recover,
    // dispatch again... Without a cap this repeats forever, once per restart.
    for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
      store.markStarted(job.id);
      const outcome = new CronStore(TEST_PATH).recoverInterrupted();
      expect(outcome.resumed).toHaveLength(1);
      expect(outcome.resumed[0].resumeAttempts).toBe(attempt);
      expect(outcome.skipped).toHaveLength(0);
    }

    store.markStarted(job.id);
    const final = new CronStore(TEST_PATH).recoverInterrupted();
    expect(final.resumed).toHaveLength(0);
    expect(final.skipped.map((s) => s.reason)).toEqual(["resume-cap"]);

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("interrupted");
  });

  it("a run that reaches an outcome clears the crash-loop budget", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    expect(new CronStore(TEST_PATH).list()[0].resumeAttempts).toBe(1);

    const live = new CronStore(TEST_PATH);
    live.markStarted(job.id);
    live.markRun(job.id, "ok");
    expect(new CronStore(TEST_PATH).list()[0].resumeAttempts).toBeUndefined();

    // ...so the next interruption starts counting from one again.
    live.markStarted(job.id);
    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.resumed[0].resumeAttempts).toBe(1);
  });

  it("reads completion from the run token, not the clock", () => {
    // A completed run whose wall clock stepped BACKWARDS mid-turn (NTP
    // correction, VM snapshot resume): lastRunAt is earlier than
    // lastStartedAt. A timestamp comparison calls that interrupted and
    // re-fires finished work; the run token says it completed.
    const started = Date.now();
    writeFileSync(TEST_PATH, JSON.stringify({
      version: 1,
      jobs: [{
        id: "clockjmp",
        name: "clock-jumper",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        message: "x",
        sessionKey: "dm:alice",
        deleteAfterRun: false,
        createdAt: started - 120_000,
        nextRunAt: started + 60_000,
        lastStartedAt: started,
        lastRunAt: started - 5_000,
        lastRunId: "run-1",
        lastCompletedRunId: "run-1",
        lastStatus: "ok",
      }],
    }));

    const store = new CronStore(TEST_PATH);
    expect(isInterrupted(store.list()[0])).toBe(false);
    const outcome = store.recoverInterrupted();
    expect(outcome.resumed).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].lastStatus).toBe("ok");
  });

  it("still flags a dispatch whose token was never acknowledged, whatever the clock says", () => {
    const started = Date.now();
    writeFileSync(TEST_PATH, JSON.stringify({
      version: 1,
      jobs: [{
        id: "clockjm2",
        name: "clock-jumper",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        message: "x",
        sessionKey: "dm:alice",
        deleteAfterRun: false,
        createdAt: started - 120_000,
        nextRunAt: started - 1_000,
        lastStartedAt: started,
        // Clock stepped FORWARD after the previous completion, so the naive
        // comparison reads "already finished" and the interrupted run is lost.
        lastRunAt: started + 5_000,
        lastRunId: "run-2",
        lastCompletedRunId: "run-1",
        lastStatus: "ok",
      }],
    }));

    expect(isInterrupted(new CronStore(TEST_PATH).list()[0])).toBe(true);
    expect(new CronStore(TEST_PATH).recoverInterrupted().resumed).toHaveLength(1);
  });

  it("markUnacked parks a finished run whose outcome could not be recorded", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "place the order",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    store.markUnacked(job.id, "ok");

    const after = new CronStore(TEST_PATH).list()[0];
    // Not deleted (that write is what failed) but not retriable either, and
    // the run token is acknowledged so recovery leaves it alone.
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("ok");
    expect(isInterrupted(after)).toBe(false);
    expect(new CronStore(TEST_PATH).getDueJobs()).toHaveLength(0);
  });

  it("re-enabling clears the interrupted state so recovery leaves the job alone", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(false);

    const reenabled = new CronStore(TEST_PATH).setEnabled(job.id, true);
    expect(reenabled?.enabled).toBe(true);
    expect(reenabled?.lastStatus).toBeNull();

    // Without clearing the token, the next daemon start would settle this as
    // interrupted all over again and disable the job the operator just fixed.
    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.skipped).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(true);
  });
});

describe("CronStore concurrent writers", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function addRecurring(store: CronStore) {
    return store.add({
      name: "recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
  }

  /**
   * Land another process's write inside this store's load→save window. `get`
   * is called after the reload and before the save in every mutator, which is
   * exactly the gap a real second process can slip into.
   */
  function interleave(store: CronStore, other: () => void): void {
    const realGet = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce((id: string) => {
      const found = realGet(id);
      other();
      return found;
    });
  }

  it("a CLI write does not erase a dispatch record the daemon made mid-write", () => {
    const daemon = new CronStore(TEST_PATH);
    const job = addRecurring(daemon);

    // The CLI process reloads, then the daemon dispatches a run, then the CLI
    // saves. Its snapshot predates lastRunId — the losing write would take
    // the only durable evidence of the in-flight run with it, and the restart
    // that follows would re-fire the job.
    const cli = new CronStore(TEST_PATH);
    let runId: string | undefined;
    interleave(cli, () => { runId = daemon.markStarted(job.id); });
    cli.setEnabled(job.id, false);

    const merged = new CronStore(TEST_PATH).list()[0];
    expect(merged.enabled).toBe(false);      // the CLI's own edit lands
    expect(merged.lastRunId).toBe(runId);    // ...without reverting the daemon's
    expect(merged.lastStartedAt).toBeGreaterThan(0);
    expect(isInterrupted(merged)).toBe(true);
  });

  it("a dispatch record does not revert a session rename made mid-write", () => {
    const daemon = new CronStore(TEST_PATH);
    const job = addRecurring(daemon);

    const cli = new CronStore(TEST_PATH);
    interleave(daemon, () => { cli.rewriteSessionKey("dm:alice", "dm:bob"); });
    const runId = daemon.markStarted(job.id);

    const merged = new CronStore(TEST_PATH).list()[0];
    expect(merged.sessionKey).toBe("dm:bob");
    expect(merged.lastRunId).toBe(runId);
  });

  it("a job added mid-write survives, and one removed mid-write stays removed", () => {
    const daemon = new CronStore(TEST_PATH);
    const job = addRecurring(daemon);
    const doomed = daemon.add({
      name: "doomed",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "y",
      sessionKey: "dm:carol",
    });

    const cli = new CronStore(TEST_PATH);
    interleave(daemon, () => {
      cli.add({ name: "late", schedule: { kind: "every", everyMs: 60_000 }, message: "z", sessionKey: "dm:dave" });
      cli.remove(doomed.id);
    });
    daemon.markStarted(job.id);

    const names = new CronStore(TEST_PATH).list().map((j) => j.name).sort();
    expect(names).toEqual(["late", "recurring"]);
  });

  it("mergeWithDisk treats clearing a field as an edit, not as an absence", () => {
    // `interruptedAt = null` (marker consumed) against a baseline that had no
    // such key at all. Reading undefined and null as the same value would let
    // a concurrent writer's stale non-null value survive, and the [resumed]
    // marker would be delivered twice.
    const base = {
      id: "a", name: "a", enabled: true, message: "m", sessionKey: "dm:alice",
      deleteAfterRun: false, createdAt: 1, nextRunAt: 10, lastRunAt: null,
      lastStatus: null, schedule: { kind: "every", everyMs: 60_000 },
    };
    const merged = mergeWithDisk(
      new Map([["a", { ...base }]]) as never,
      [{ ...base, interruptedAt: null }] as never,
      [{ ...base, interruptedAt: 1234 }] as never,
    ) as unknown as CronJobLike[];

    expect(merged[0].interruptedAt).toBeNull();
  });

  it("mergeWithDisk keeps each writer's own edits and both deletions", () => {
    const base = (over: Partial<CronJobLike> = {}): CronJobLike => ({
      id: "a", name: "a", enabled: true, message: "m", sessionKey: "dm:alice",
      deleteAfterRun: false, createdAt: 1, nextRunAt: 10, lastRunAt: null,
      lastStatus: null, schedule: { kind: "every", everyMs: 60_000 }, ...over,
    });
    const baseline = new Map([["a", base()], ["gone", base({ id: "gone" })]]);
    const ours = [base({ enabled: false }), base({ id: "mine" })];
    const theirs = [base({ lastRunId: "r1" }), base({ id: "gone" }), base({ id: "yours" })];

    const merged = mergeWithDisk(
      baseline as never,
      ours as never,
      theirs as never,
    ) as unknown as CronJobLike[];
    const byId = new Map(merged.map((j) => [j.id, j]));

    expect(byId.get("a")?.enabled).toBe(false);   // our field edit
    expect(byId.get("a")?.lastRunId).toBe("r1");  // their field edit
    expect(byId.has("gone")).toBe(false);         // we deleted it
    expect(byId.has("mine")).toBe(true);          // we added it
    expect(byId.has("yours")).toBe(true);         // they added it
  });
});

describe("CronStore unreadable file", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("treats an absent file as empty and a corrupt one as a failure", () => {
    // No file yet is a normal state — a fresh install has no jobs.
    expect(new CronStore(TEST_PATH).list()).toEqual([]);

    // A corrupt file is not an empty one. Reporting "no jobs" here is what
    // lets interrupted-run recovery believe it has nothing to do.
    writeFileSync(TEST_PATH, "{ not json");
    const store = new CronStore(TEST_PATH);
    expect(() => store.list()).toThrow(CronStoreReadError);
    expect(() => store.recoverInterrupted()).toThrow(CronStoreReadError);
    expect(() => store.getDueJobs()).toThrow(CronStoreReadError);
  });

  it("never overwrites a file it could not read", () => {
    writeFileSync(TEST_PATH, "{ not json");
    const store = new CronStore(TEST_PATH);
    expect(() => store.add({
      name: "x",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    })).toThrow(CronStoreReadError);
    // The old behaviour (read error -> empty list) would have published an
    // empty store over the real one.
    expect(readFileSync(TEST_PATH, "utf-8")).toBe("{ not json");
  });

  it("rejects a well-formed file with no jobs array", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ version: 1 }));
    expect(() => new CronStore(TEST_PATH).list()).toThrow(CronStoreReadError);
  });

  it("rejects a jobs array whose entries are not job records", () => {
    // `{"jobs":[null]}` used to pass the array check and then blow up as a
    // TypeError on the first `job.id` — in the scheduler's due-scan, not at
    // load — so nothing recognised it as the unreadable store it is.
    for (const jobs of [[null], ["water"], [{ id: "abc12345" }], [{
      id: "abc12345",
      name: "x",
      enabled: true,
      schedule: { kind: "weekly" },
      message: "x",
      sessionKey: "dm:alice",
      deleteAfterRun: false,
      createdAt: 1,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
    }]]) {
      writeFileSync(TEST_PATH, JSON.stringify({ version: 1, jobs }));
      const store = new CronStore(TEST_PATH);
      expect(() => store.list()).toThrow(CronStoreReadError);
      expect(() => store.getDueJobs()).toThrow(CronStoreReadError);
      expect(readCronJobsSafely(store).unreadablePath).toBe(TEST_PATH);
    }
  });

  it("refuses every read once a reload fails, not only a failed first load", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "x",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    const contents = readFileSync(TEST_PATH, "utf-8");
    expect(store.list()).toHaveLength(1);

    writeFileSync(TEST_PATH, "{ not json");
    expect(() => store.getDueJobs()).toThrow(CronStoreReadError);
    // The pre-fix behaviour: the failed reload left the earlier snapshot in
    // place, so `list()` — and through it the watch snapshot, the metrics
    // scrape and `tomo status` — kept reporting a healthy store.
    expect(() => store.list()).toThrow(CronStoreReadError);
    expect(readCronJobsSafely(store)).toEqual({ jobs: [], unreadablePath: TEST_PATH });

    writeFileSync(TEST_PATH, contents);
    expect(store.getDueJobs()).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("recovers once the file is readable again", () => {
    const good = new CronStore(TEST_PATH);
    good.add({
      name: "x",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    const contents = readFileSync(TEST_PATH, "utf-8");

    writeFileSync(TEST_PATH, "{ not json");
    const store = new CronStore(TEST_PATH);
    expect(() => store.list()).toThrow(CronStoreReadError);

    writeFileSync(TEST_PATH, contents);
    expect(store.getDueJobs()).toEqual([]);   // reload clears the error
    expect(store.list()).toHaveLength(1);
  });
});

describe("readCronJobsSafely", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns jobs when the store is readable", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "x",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    const result = readCronJobsSafely(new CronStore(TEST_PATH));
    expect(result.jobs).toHaveLength(1);
    expect(result.unreadablePath).toBeUndefined();
  });

  it("degrades to an empty list AND the path when the store is unreadable", () => {
    writeFileSync(TEST_PATH, "{ not json");
    const result = readCronJobsSafely(new CronStore(TEST_PATH));
    // Both halves matter: the caller keeps working (watch snapshot, metrics
    // scrape, status report) and can still say "unreadable" rather than
    // "none" — an empty list on its own would restore the original lie.
    expect(result.jobs).toEqual([]);
    expect(result.unreadablePath).toBe(TEST_PATH);
  });

  it("does not swallow errors that are not read failures", () => {
    const exploding = { list(): never { throw new TypeError("boom"); } };
    expect(() => readCronJobsSafely(exploding)).toThrow(TypeError);
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

/** February 30th: a well-formed pattern croner accepts and never matches. */
const NEVER_CRON = "0 0 30 2 *";

describe("unschedulableReason", () => {
  const now = Date.parse("2026-05-01T12:00:00Z");

  it("passes a schedule that still has a future run", () => {
    expect(unschedulableReason({ kind: "every", everyMs: 60_000 }, now)).toBeNull();
    expect(unschedulableReason(parseScheduleString("0 9 * * *"), now)).toBeNull();
    expect(unschedulableReason({ kind: "at", at: "2026-05-01T13:00:00Z" }, now)).toBeNull();
  });

  it("names the past one-shot — the shape the model produces off a stale clock", () => {
    expect(unschedulableReason({ kind: "at", at: "2026-04-30T09:00:00Z" }, now))
      .toMatch(/is in the past$/);
  });

  it("names an `at` string that is not a date at all", () => {
    // `parseAtSchedule` returns NaN, which is neither > now nor a real time —
    // a different failure from "already happened" and worth saying so.
    expect(unschedulableReason({ kind: "at", at: "next tuesday-ish" }, now))
      .toMatch(/not a date\/time that can be parsed/);
  });

  it("names a recurring pattern with no occurrence left", () => {
    // The case a try/catch around computeNextRun cannot see: croner accepts
    // the pattern and simply returns null forever.
    expect(unschedulableReason(parseScheduleString(NEVER_CRON), now))
      .toBe("it has no future occurrence");
  });
});

describe("`tomo cron add` refusal", () => {
  it("refuses a time that has already passed, in one line", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const parsed = parseCreatableSchedule(past);
    expect(parsed.kind).toBe("unschedulable");
    expect(cronAddRefusal(past, parsed as Exclude<typeof parsed, { kind: "ok" }>))
      .toMatch(/^Cannot schedule ".*": .* is in the past, so the job could never fire\.$/);
  });

  it("refuses a recurring pattern that can never come round again", () => {
    const parsed = parseCreatableSchedule(NEVER_CRON);
    expect(parsed.kind).toBe("unschedulable");
    expect(cronAddRefusal(NEVER_CRON, parsed as Exclude<typeof parsed, { kind: "ok" }>))
      .toBe(`Cannot schedule "${NEVER_CRON}": it has no future occurrence, so the job could never fire.`);
  });

  it("turns croner's throw into one line instead of a stack trace", () => {
    // `parseScheduleString` funnels anything it does not recognise into
    // `kind: "cron"`, so a typo reaches croner — which throws only when the
    // expression is evaluated. The CLI used to print that stack at whoever
    // typed the command.
    const garbage = "whenever i feel like it";
    const parsed = parseCreatableSchedule(garbage);
    expect(parsed.kind).toBe("unparseable");
    const line = cronAddRefusal(garbage, parsed as Exclude<typeof parsed, { kind: "ok" }>);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/^Cannot schedule "whenever i feel like it": not a schedule expression — /);
    expect(line).not.toMatch(/\bat Object\b|\bat Module\b/); // no stack frames
  });

  it("accepts a live schedule and hands back the parsed value", () => {
    const parsed = parseCreatableSchedule("every 2h");
    expect(parsed).toEqual({ kind: "ok", schedule: { kind: "every", everyMs: 7_200_000 } });
  });
});
