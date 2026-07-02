import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronScheduler } from "../src/cron/scheduler.js";
import { CronStore } from "../src/cron/store.js";
import type { Agent } from "../src/agent.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/logger.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const TEST_DIR = join(tmpdir(), "tomo-test-cron-scheduler");
const TEST_PATH = join(TEST_DIR, "jobs.json");

/** Force the named jobs (all jobs when omitted) to be due now. */
function makeJobsDue(...names: string[]): void {
  const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
  for (const job of raw.jobs) {
    if (names.length === 0 || names.includes(job.name)) {
      job.nextRunAt = Date.now() - 1000;
    }
  }
  writeFileSync(TEST_PATH, JSON.stringify(raw));
}

function tick(scheduler: CronScheduler): Promise<void> {
  return (scheduler as unknown as { tick(): Promise<void> }).tick();
}

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

describe("CronScheduler", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("dispatches due jobs concurrently instead of serially", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "job-a",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "a",
      sessionKey: "dm:alice",
    });
    store.add({
      name: "job-b",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "b",
      sessionKey: "dm:bob",
    });
    makeJobsDue();

    // Fake agent whose cron turns only finish when the test releases them —
    // simulates a slow agent turn (these can take minutes for real).
    const inFlight: Array<{ key: string; resolve: (ok: boolean) => void }> = [];
    const fakeAgent = {
      handleCronMessage: vi.fn(
        (_msg: string, key: string) =>
          new Promise<boolean>((resolve) => inFlight.push({ key, resolve })),
      ),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    const tickDone = tick(scheduler);

    // Both jobs must be dispatched while NEITHER has completed. The old
    // serial loop would hold job-b hostage until job-a's turn resolved.
    await waitFor(() => expect(inFlight).toHaveLength(2));
    expect(inFlight.map((c) => c.key).sort()).toEqual(["dm:alice", "dm:bob"]);

    for (const c of inFlight) c.resolve(true);
    await tickDone;

    // Both runs were recorded and rescheduled.
    for (const job of store.list()) {
      expect(job.lastStatus).toBe("ok");
      expect(job.nextRunAt).toBeGreaterThan(Date.now());
    }
  });

  it("dispatches newly due jobs while an earlier job is still in flight", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "slow",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "slow",
      sessionKey: "dm:alice",
    });
    store.add({
      name: "later",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "later",
      sessionKey: "dm:bob",
    });
    makeJobsDue("slow");

    const inFlight: Array<{ key: string; resolve: (ok: boolean) => void }> = [];
    const fakeAgent = {
      handleCronMessage: vi.fn(
        (_msg: string, key: string) =>
          new Promise<boolean>((resolve) => inFlight.push({ key, resolve })),
      ),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    const tick1 = tick(scheduler);
    await waitFor(() => expect(inFlight).toHaveLength(1));

    // "later" comes due while "slow" is still running. The next poll must
    // dispatch it (the old whole-tick guard skipped every poll until the
    // slow job finished) — and must NOT re-fire the in-flight "slow" job,
    // which is still due on disk because markRun hasn't advanced it yet.
    makeJobsDue("later");
    const tick2 = tick(scheduler);
    await waitFor(() => expect(inFlight).toHaveLength(2));
    expect(inFlight.map((c) => c.key)).toEqual(["dm:alice", "dm:bob"]);

    inFlight[1].resolve(true);
    await tick2;
    inFlight[0].resolve(true);
    await tick1;

    expect(fakeAgent.handleCronMessage).toHaveBeenCalledTimes(2);
    for (const job of store.list()) {
      expect(job.lastStatus).toBe("ok");
      expect(job.nextRunAt).toBeGreaterThan(Date.now());
    }
  });

  it("records a turn that completed with errors without disturbing the other job", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "job-ok",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "ok",
      sessionKey: "dm:alice",
    });
    store.add({
      name: "job-fail",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "fail",
      sessionKey: "dm:bob",
    });
    makeJobsDue();

    // Matches the real contract: handleCronMessage never rejects — it
    // resolves false when the turn errored (the agent handles delivery of
    // the error itself).
    const fakeAgent = {
      handleCronMessage: vi.fn((msg: string) => Promise.resolve(!msg.includes("fail"))),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    await tick(scheduler);

    const jobs = store.list();
    expect(jobs.find((j) => j.name === "job-ok")?.lastStatus).toBe("ok");
    expect(jobs.find((j) => j.name === "job-fail")?.lastStatus).toBe("error");
    // A failed run still reschedules — transient agent errors shouldn't
    // silently kill a recurring job.
    expect(jobs.find((j) => j.name === "job-fail")?.nextRunAt).toBeGreaterThan(Date.now());
  });
});
