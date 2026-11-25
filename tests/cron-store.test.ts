import { afterAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CronStore,
  CronStoreReadError,
  InvalidScheduleError,
  isInterrupted,
  MAX_INTERRUPT_NOTICE_RUNS,
  mergeWithDisk,
  ONE_SHOT_MAX_RETRIES,
  ONE_SHOT_RETRY_DELAY_MS,
} from "../src/cron/store.js";
import { MAX_EVERY_MS, MIN_EVERY_MS, parseScheduleString, unschedulableReason } from "../src/cron/schedule.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readCronJobsSafely } from "../src/cli/cron-errors.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A one-shot hook that fires inside the store's atomic write — after the
 * merge it computed from its read of the file, before the rename that
 * publishes it. That is the window an optimistic save has to defend: another
 * process publishing here would otherwise be silently overwritten.
 */
const hook = vi.hoisted(() => ({ beforeWrite: null as null | (() => void) }));

// Passes straight through while no hook is armed, so every other test here
// writes exactly as production does.
vi.mock("../src/fs-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fs-utils.js")>();
  return {
    ...actual,
    writeJsonAtomicSync: (path: string, value: unknown, opts?: { beforeRename?: () => void }) => {
      const fire = hook.beforeWrite;
      hook.beforeWrite = null; // one-shot: the competing writer must not recurse
      fire?.();
      return actual.writeJsonAtomicSync(path, value, opts);
    },
  };
});

type CronJobLike = Record<string, unknown> & { id: string };

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-cron-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
const TEST_PATH = join(TEST_DIR, "jobs.json");

describe("CronStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("rollbackStarted restores what markStarted overwrote and leaves the run un-interrupted", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "r", schedule: { kind: "every", everyMs: 60_000 }, message: "m", sessionKey: "dm:alice" });
    store.markStarted(job.id);
    store.markRun(job.id, "error");
    const before = store.get(job.id)!;
    const prior = { lastStartedAt: before.lastStartedAt ?? null, interruptedAt: null, lastStatus: before.lastStatus };

    const runId = store.markStarted(job.id)!;
    store.rollbackStarted(job.id, runId, prior);

    const after = new CronStore(TEST_PATH).get(job.id)!;
    expect(after.lastStartedAt).toBe(prior.lastStartedAt);
    expect(after.lastStatus).toBe("error");
    expect(after.lastCompletedRunId).toBe(runId);
    expect(isInterrupted(after)).toBe(false);
    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.parked).toEqual([]);
    expect(outcome.recurring).toEqual([]);
  });

  it("rollbackStarted is a no-op once another dispatch holds the token", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "r", schedule: { kind: "every", everyMs: 60_000 }, message: "m", sessionKey: "dm:alice" });
    const stale = store.markStarted(job.id)!;
    const current = store.markStarted(job.id)!;
    store.rollbackStarted(job.id, stale, { lastStartedAt: null, interruptedAt: null, lastStatus: null });
    const after = store.get(job.id)!;
    expect(after.lastRunId).toBe(current);
    expect(after.lastCompletedRunId).not.toBe(current);
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
      schedule: { kind: "every", everyMs: 60_000 },
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

  it("does not make a completed `every` job due again immediately", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "hourly",
      schedule: { kind: "every", everyMs: 3_600_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    store.markRun(job.id, "ok");
    expect(store.getDueJobs()).toHaveLength(0);
    expect(store.get(job.id)!.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("refuses to store an interval the scheduler could never honour", () => {
    const store = new CronStore(TEST_PATH);
    for (const everyMs of [0, MIN_EVERY_MS - 1, Number.NaN, MAX_EVERY_MS + 1, 99999999999999 * 86_400_000]) {
      expect(() => store.add({
        name: "hot loop",
        schedule: { kind: "every", everyMs },
        message: "spin",
        sessionKey: "dm:alice",
      }), String(everyMs)).toThrow(InvalidScheduleError);
    }
    expect(store.list()).toHaveLength(0);
    // The boundary itself is a legitimate schedule.
    expect(() => store.add({
      name: "every 30s",
      schedule: { kind: "every", everyMs: MIN_EVERY_MS },
      message: "ok",
      sessionKey: "dm:alice",
    })).not.toThrow();
  });

  it("holds a hand-edited zero-interval job disabled instead of firing it every poll", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "legacy",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    // What an older CLI or a text editor could leave behind.
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    const onDisk = raw.jobs.find((j: CronJobLike) => j.id === job.id);
    onDisk.schedule = { kind: "every", everyMs: 0 };
    onDisk.nextRunAt = Date.now() - 1000;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const reopened = new CronStore(TEST_PATH);
    expect(reopened.getDueJobs()).toHaveLength(0);
    const held = reopened.get(job.id)!;
    expect(held.enabled).toBe(false);
    expect(held.nextRunAt).toBeNull();
    // Held, not rewritten: the user's file still says what they wrote.
    const still = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    expect(still.jobs.find((j: CronJobLike) => j.id === job.id).enabled).toBe(true);
    // And re-enabling it says why, instead of quietly re-arming a spin.
    expect(unschedulableReason(held.schedule, Date.now())).toMatch(/below the 30s minimum$/);
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

  it("deletes a one-shot job after a successful run", () => {
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

  // A one-shot is deleted once it ran, a recurring job kept; an explicit value
  // wins either way (a cron pattern meant to fire once, an `at` job kept as a
  // record).
  it.each([
    ["at", undefined, true],
    ["cron", undefined, false],
    ["every", undefined, false],
    ["at", false, false],
    ["cron", true, true],
  ] as const)("deleteAfterRun for a %s schedule given %s is %s", (kind, explicit, expected) => {
    const store = new CronStore(TEST_PATH);
    const schedule = kind === "at" ? { kind, at: new Date(Date.now() + 60_000).toISOString() }
      : kind === "cron" ? { kind, expr: "0 9 * * *" }
      : { kind, everyMs: 60_000 };
    const job = store.add({
      name: `${kind}-${explicit}`,
      schedule,
      message: "x",
      sessionKey: "dm:alice",
      ...(explicit === undefined ? {} : { deleteAfterRun: explicit }),
    });
    expect(job.deleteAfterRun).toBe(expected);
    expect(new CronStore(TEST_PATH).get(job.id)!.deleteAfterRun).toBe(expected);
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

  // POLICY (2026-11-14): an interrupted run — crash, kill, or a graceful
  // shutdown that could not write its status — is NEVER re-run
  // automatically. One-shots are parked and the owner asked; recurring jobs
  // record "interrupted", move to their next normal slot and the owner is
  // told once.
  it("settles an interrupted recurring job: interrupted, next normal slot, one owner notice, no resume", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    // Due now, as it is at dispatch.
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = Date.now() - 1_000;
    writeFileSync(TEST_PATH, JSON.stringify(raw));
    new CronStore(TEST_PATH).markStarted(job.id);

    const first = new CronStore(TEST_PATH).recoverInterrupted();
    expect(first.recurring.map((j) => j.id)).toEqual([job.id]);
    expect(first.parked).toHaveLength(0);

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.lastStatus).toBe("interrupted");
    expect(after.lastInterruptedAt).toBeGreaterThan(0);
    expect(after.interruptedAt ?? null).toBeNull();
    expect(after.enabled).toBe(true);
    // Not due: no catch-up fire.
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(new CronStore(TEST_PATH).getDueJobs()).toHaveLength(0);
    expect(new CronStore(TEST_PATH).unreportedInterruptedRecurring().map((j) => j.id)).toEqual([job.id]);
    // Crash: the moment is unknown, not invented.
    expect(after.interruptNotice?.runs[0].interruptedAt).toBeNull();

    // Settled once: a second restart finds nothing new.
    const second = new CronStore(TEST_PATH).recoverInterrupted();
    expect(second.recurring).toHaveLength(0);
  });

  it("keeps the interruption in the history after the next run", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    const at = new CronStore(TEST_PATH).list()[0].lastInterruptedAt;

    const live = new CronStore(TEST_PATH);
    live.markStarted(job.id);
    live.markRun(job.id, "ok");
    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.lastStatus).toBe("ok");
    expect(after.lastInterruptedAt).toBe(at);
  });

  it("accumulates repeated interruptions — count and each start/interrupt time — and clears only what was reported", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    const reported = structuredClone(new CronStore(TEST_PATH).unreportedInterruptedRecurring()[0].interruptNotice!);
    expect(reported.count).toBe(1);
    // Interrupted again (twice) before / while the DM was in flight.
    new CronStore(TEST_PATH).markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    const s2 = new CronStore(TEST_PATH);
    const run3 = s2.markStarted(job.id)!;
    s2.markInterruptedByShutdown(job.id, run3);

    const notice = new CronStore(TEST_PATH).unreportedInterruptedRecurring()[0].interruptNotice!;
    expect(notice.count).toBe(3);
    expect(notice.runs).toHaveLength(3);
    for (const run of notice.runs) expect(run.startedAt).toBeGreaterThan(0);
    // Crashes: time unknown; the graceful one: known.
    expect(notice.runs.map((r) => r.interruptedAt === null)).toEqual([true, true, false]);

    new CronStore(TEST_PATH).markRecurringInterruptNoticesSent([{ id: job.id, notice: reported }]);
    const left = new CronStore(TEST_PATH).unreportedInterruptedRecurring()[0].interruptNotice!;
    expect(left.count).toBe(2);
    expect(left.runs).toEqual(notice.runs.slice(1));
    new CronStore(TEST_PATH).markRecurringInterruptNoticesSent([{ id: job.id, notice: left }]);
    expect(new CronStore(TEST_PATH).unreportedInterruptedRecurring()).toHaveLength(0);
  });

  it("keeps at most MAX_INTERRUPT_NOTICE_RUNS run details but an exact count, and an acknowledgement keeps the two consistent", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    const crash = () => {
      new CronStore(TEST_PATH).markStarted(job.id);
      new CronStore(TEST_PATH).recoverInterrupted();
    };
    const notice = () => new CronStore(TEST_PATH).get(job.id)!.interruptNotice!;

    for (let i = 0; i < 5; i++) crash();
    // The report went out for the first five; seven more crashes land while it is in flight.
    const reported = structuredClone(notice());
    expect(reported).toMatchObject({ seq: 5, count: 5 });
    for (let i = 0; i < 7; i++) crash();
    const full = notice();
    expect(full.count).toBe(12);
    expect(full.runs).toHaveLength(MAX_INTERRUPT_NOTICE_RUNS);

    // Clearing what was reported leaves exactly the seven newer runs, even
    // though some of the reported ones had already been sliced away.
    new CronStore(TEST_PATH).markRecurringInterruptNoticesSent([{ id: job.id, notice: reported }]);
    const left = notice();
    expect(left.count).toBe(7);
    expect(left.runs).toEqual(full.runs.slice(-7));

    // A report that was itself capped ("12 times, 10 shown"), acknowledged
    // after one more crash, leaves just that one.
    for (let i = 0; i < 5; i++) crash();
    const capped = structuredClone(notice());
    expect(capped.count).toBe(12);
    expect(capped.runs).toHaveLength(MAX_INTERRUPT_NOTICE_RUNS);
    crash();
    const newest = notice().runs.at(-1);
    new CronStore(TEST_PATH).markRecurringInterruptNoticesSent([{ id: job.id, notice: capped }]);
    expect(notice()).toMatchObject({ count: 1, runs: [newest] });
  });

  it("after a long downtime, an `every` job advances from its OWN slot by whole periods, not from recovery time", () => {
    const store = new CronStore(TEST_PATH);
    const hour = 3_600_000;
    const job = store.add({ name: "hourly", schedule: { kind: "every", everyMs: hour }, message: "x", sessionKey: "dm:alice" });
    // The interrupted run's slot was 5.5h ago (then the daemon stayed down).
    const slot = Date.now() - 5.5 * hour;
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = slot;
    writeFileSync(TEST_PATH, JSON.stringify(raw));
    new CronStore(TEST_PATH).markStarted(job.id);

    new CronStore(TEST_PATH).recoverInterrupted();
    const next = new CronStore(TEST_PATH).list()[0].nextRunAt!;
    expect(next).toBe(slot + 6 * hour);
    expect(next).toBeGreaterThan(Date.now());
    expect((next - slot) % hour).toBe(0);
    // The five slots the downtime swallowed are recorded for the owner report.
    const run = new CronStore(TEST_PATH).list()[0].interruptNotice!.runs[0];
    expect(run.missed).toEqual({ count: 5, from: slot + hour, to: slot + 5 * hour });
  });

  it("counts the slots a downtime swallowed for a cron-expression job too", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "hourly-cron", schedule: { kind: "cron", expr: "0 * * * *" }, message: "x", sessionKey: "dm:alice" });
    const hour = 3_600_000;
    const top = Math.floor(Date.now() / hour) * hour;
    const slot = top - 3 * hour; // 3 full hours ago, on the hour
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = slot;
    writeFileSync(TEST_PATH, JSON.stringify(raw));
    new CronStore(TEST_PATH).markStarted(job.id);

    new CronStore(TEST_PATH).recoverInterrupted();
    const run = new CronStore(TEST_PATH).list()[0].interruptNotice!.runs[0];
    expect(run.missed).toEqual({ count: 3, from: slot + hour, to: top });
  });

  it("records no missed slots for an interruption within the job's own slot", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    const runId = store.markStarted(job.id)!;
    store.markInterruptedByShutdown(job.id, runId);
    expect(new CronStore(TEST_PATH).list()[0].interruptNotice!.runs[0].missed).toBeUndefined();
  });

  it("parks an interrupted one-shot however fresh — kept, disabled, left for the owner report", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "place the order",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);

    const first = new CronStore(TEST_PATH).recoverInterrupted();
    expect(first.parked.map((s) => [s.job.id, s.reason])).toEqual([[job.id, "once-interrupted"]]);
    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("interrupted");
    expect(after.interruptedAt ?? null).toBeNull();
    expect(new CronStore(TEST_PATH).unreportedParkedOneShots().map((j) => j.id)).toEqual([job.id]);
    expect(new CronStore(TEST_PATH).getDueJobs()).toHaveLength(0);

    // Stays parked across the next restart.
    const second = new CronStore(TEST_PATH).recoverInterrupted();
    expect(second.parked).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(false);
  });

  it("parks an interrupted at-job kept as a record (once: false) too", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "keep-the-record",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "place the order",
      sessionKey: "dm:alice",
      deleteAfterRun: false,
    });
    store.markStarted(job.id);
    const { parked } = new CronStore(TEST_PATH).recoverInterrupted();
    expect(parked.map((s) => s.job.id)).toEqual([job.id]);
    expect(new CronStore(TEST_PATH).list()[0].nextRunAt).toBeNull();
  });

  it("reports, rather than resumes, a one-shot disabled while its run was in flight", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    new CronStore(TEST_PATH).setEnabled(job.id, false);

    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.parked.map((s) => s.reason)).toEqual(["once-disabled"]);
    expect(new CronStore(TEST_PATH).unreportedParkedOneShots().map((j) => j.id)).toEqual([job.id]);
  });

  it("a re-enabled one-shot that is interrupted and parked again is reported again", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    new CronStore(TEST_PATH).markInterruptNotified([job.id]);
    expect(new CronStore(TEST_PATH).unreportedParkedOneShots()).toHaveLength(0);

    new CronStore(TEST_PATH).setEnabled(job.id, true);
    new CronStore(TEST_PATH).markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    expect(new CronStore(TEST_PATH).unreportedParkedOneShots().map((j) => j.id)).toEqual([job.id]);
  });

  it("drops a resume an older version queued: the one-shot is parked, the recurring job moves on", () => {
    const store = new CronStore(TEST_PATH);
    const once = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    const rec = addRecurring(store);
    // What an older daemon's recovery left: token acknowledged, marker set,
    // still enabled and due for its [resumed] fire.
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    for (const job of raw.jobs) {
      Object.assign(job, { lastRunId: "r1", lastCompletedRunId: "r1", lastStartedAt: Date.now() - 5_000, interruptedAt: Date.now() - 5_000, lastStatus: "interrupted", nextRunAt: Date.now() - 1_000, resumeAttempts: 1 });
    }
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.parked.map((s) => s.job.id)).toEqual([once.id]);
    expect(outcome.recurring.map((j) => j.id)).toEqual([rec.id]);
    expect(new CronStore(TEST_PATH).getDueJobs()).toHaveLength(0);
    for (const job of new CronStore(TEST_PATH).list()) {
      expect(job.interruptedAt ?? null).toBeNull();
      expect(job.resumeAttempts).toBeUndefined();
    }
  });

  it("a skipped interval job keeps its phase", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "daily", schedule: { kind: "every", everyMs: 86_400_000 }, message: "x", sessionKey: "dm:alice" });
    const now = Date.now();
    const slot = now - 14 * 3_600_000;
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = slot;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const [skip] = new CronStore(TEST_PATH).skipStaleRuns(new Set(), now);
    expect(skip.job.id).toBe(job.id);
    expect(new CronStore(TEST_PATH).list()[0].nextRunAt).toBe(slot + 86_400_000);
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
    expect(outcome.recurring).toHaveLength(0);
    expect(outcome.parked).toHaveLength(0);
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
    expect(outcome.recurring).toHaveLength(0);
    expect(outcome.parked).toHaveLength(0);
    expect(store.getDueJobs()).toHaveLength(1);
  });
});

describe("CronStore clock independence and unacked outcomes", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
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
    expect(outcome.recurring).toHaveLength(0);
    expect(outcome.parked).toHaveLength(0);
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
    expect(new CronStore(TEST_PATH).recoverInterrupted().recurring).toHaveLength(1);
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
    // Interrupted (a crash), then parked by recovery: every interrupted
    // one-shot is, however fresh.
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(false);

    const reenabled = new CronStore(TEST_PATH).setEnabled(job.id, true);
    expect(reenabled?.enabled).toBe(true);
    expect(reenabled?.lastStatus).toBeNull();

    // Without clearing the token, the next daemon start would settle this as
    // interrupted all over again and disable the job the operator just fixed.
    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.parked).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(true);
  });
});

describe("CronStore concurrent writers", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    hook.beforeWrite = null;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
    hook.beforeWrite = null;
  });

  const revision = (): number => JSON.parse(readFileSync(TEST_PATH, "utf-8")).revision;

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

  it("a CLI write does not erase a dispatch record the daemon made between its read and its merge", () => {
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

  it("a CLI write re-merges when the daemon publishes between its merge and its rename", () => {
    const daemon = new CronStore(TEST_PATH);
    const job = addRecurring(daemon);
    const cli = new CronStore(TEST_PATH);

    // The CLI has read the file and merged. The daemon dispatches a run —
    // publishing lastRunId — in the instant before the CLI's rename. Without
    // the last-moment revision check the CLI's rename erases the dispatch
    // token, and the next daemon start re-fires a job that was already
    // running.
    let runId: string | undefined;
    hook.beforeWrite = () => { runId = daemon.markStarted(job.id); };
    cli.setEnabled(job.id, false);

    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);        // the CLI's own edit still lands
    expect(after.lastRunId).toBe(runId);      // ...and the token survived
    expect(isInterrupted(after)).toBe(true);
    expect(revision()).toBe(3);               // add, markStarted, setEnabled
  });

  it("gives up rather than publishing a merge it could not verify", () => {
    const daemon = new CronStore(TEST_PATH);
    const job = addRecurring(daemon);
    const cli = new CronStore(TEST_PATH);

    // A writer that loses the race on every attempt: the save must report a
    // failure (the scheduler retries the outcome write) instead of silently
    // clobbering.
    const rearm = () => {
      hook.beforeWrite = () => {
        daemon.markStarted(job.id);
        rearm();
      };
    };
    rearm();

    expect(() => cli.setEnabled(job.id, false)).toThrow(/changed during write/);
    hook.beforeWrite = null;
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(true);
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

  it("bumps a monotonic revision on every write", () => {
    const store = new CronStore(TEST_PATH);
    const job = addRecurring(store);
    expect(revision()).toBe(1);
    store.markStarted(job.id);
    expect(revision()).toBe(2);
    store.markRun(job.id, "ok");
    expect(revision()).toBe(3);
  });

  // The ownership check has to run against the state the delete applies to.
  // remove() reloads from disk, so a job written by another process after the
  // caller's snapshot was taken used to skip the check and be deleted.
  it("remove applies its ownership guard to the reloaded store, not a stale snapshot", () => {
    const store = new CronStore(TEST_PATH);
    const otherProcess = new CronStore(TEST_PATH);
    const job = otherProcess.add({
      name: "written-after-the-snapshot",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "private",
      sessionKey: "dm:alice",
    });

    // Not in `store`'s snapshot at all — this is the window.
    expect(store.get(job.id)).toBeUndefined();
    expect(store.remove(job.id, (j) => j.sessionKey === "telegram:-1001234567")).toBe("refused");
    expect(new CronStore(TEST_PATH).get(job.id)).toBeTruthy();
  });

  // Same window as remove(): setEnabled reloads, so a snapshot check misses
  // anything another process wrote in between. enabling is the one
  // operation that makes a DORMANT job run again, so it is the worst place to
  // skip an ownership check.
  it("setEnabled applies its ownership guard to the reloaded store, not a stale snapshot", () => {
    const store = new CronStore(TEST_PATH);
    const otherProcess = new CronStore(TEST_PATH);
    const job = otherProcess.add({
      name: "written-after-the-snapshot",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "private",
      sessionKey: "dm:alice",
    });
    otherProcess.setEnabled(job.id, false);

    expect(store.get(job.id)).toBeUndefined();
    expect(store.setEnabled(job.id, true, (j) => j.sessionKey === "telegram:-1001234567")).toBe("refused");
    expect(new CronStore(TEST_PATH).get(job.id)?.enabled).toBe(false);
  });

  it("mergeWithDisk treats clearing a field as an edit, not as an absence", () => {
    // `interruptedAt = null` (marker consumed) against a baseline that had no
    // such key at all. Reading undefined and null as the same value would let
    // a concurrent writer's stale non-null value survive, and an interruption
    // already acted on would come back. (This once meant a second [resumed]
    // fire; no such marker exists any more, the rule still holds.)
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

describe("CronStore stale-run skips", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skip notices aggregate, and an acknowledgement clears only what was sent", () => {
    const store = new CronStore(TEST_PATH);
    store.add({ name: "j", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    const stale = () => {
      const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
      raw.jobs[0].nextRunAt = Date.now() - 5 * 3_600_000;
      writeFileSync(TEST_PATH, JSON.stringify(raw));
      new CronStore(TEST_PATH).skipStaleRuns();
    };
    stale();
    const sent = new CronStore(TEST_PATH).unreportedSkips().map((j) => ({ id: j.id, notice: { ...j.skipNotice! } }));
    stale(); // skipped again while that report was in flight
    expect(new CronStore(TEST_PATH).list()[0].skipNotice).toMatchObject({ seq: 2, count: 2 });
    new CronStore(TEST_PATH).markSkipNoticesSent(sent);
    expect(new CronStore(TEST_PATH).list()[0].skipNotice).toMatchObject({ seq: 2, count: 1 });
    new CronStore(TEST_PATH).markSkipNoticesSent(new CronStore(TEST_PATH).unreportedSkips().map((j) => ({ id: j.id, notice: j.skipNotice! })));
    expect(new CronStore(TEST_PATH).list()[0].skipNotice ?? null).toBeNull();
  });

  it("setStaleAfter sets, clears and guards a job's window", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "j", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    expect(new CronStore(TEST_PATH).setStaleAfter(job.id, 0)?.staleAfterMs).toBe(0);
    expect(new CronStore(TEST_PATH).list()[0].staleAfterMs).toBe(0);
    expect(new CronStore(TEST_PATH).setStaleAfter(job.id, null, () => false)).toBe("refused");
    expect(new CronStore(TEST_PATH).setStaleAfter(job.id, null)?.staleAfterMs).toBeUndefined();
    expect("staleAfterMs" in new CronStore(TEST_PATH).list()[0]).toBe(false);
    expect(new CronStore(TEST_PATH).setStaleAfter("nope", 0)).toBeUndefined();
    expect(() => new CronStore(TEST_PATH).setStaleAfter(job.id, -5)).toThrow(RangeError);
  });
});
