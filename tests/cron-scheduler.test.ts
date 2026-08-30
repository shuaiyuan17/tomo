import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronScheduler } from "../src/cron/scheduler.js";
import { CronStore, isInterrupted } from "../src/cron/store.js";
import { parseTomoEvent } from "../src/tomo-event.js";
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

  // --- restart / interrupted-run recovery -------------------------------
  //
  // A cron run can outlive the daemon: `tomo restart` during a run, a crash,
  // a kill. nextRunAt only advances on completion and the in-flight guard is
  // memory-only, so the fresh process finds a job that is still "due".

  /** An agent whose cron turns never settle — stands in for a killed daemon. */
  function hangingAgent(): { agent: Agent; calls: string[] } {
    const calls: string[] = [];
    const agent = {
      handleCronMessage: vi.fn((msg: string) => {
        calls.push(msg);
        return new Promise<boolean>(() => {});
      }),
    } as unknown as Agent;
    return { agent, calls };
  }

  /** Bodies delivered to a recording agent, envelope stripped. */
  function bodies(calls: string[]): string[] {
    return calls.map((msg) => parseTomoEvent(msg)!.body);
  }

  it("does not silently re-fire a recurring job interrupted by a restart", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({
      name: "quiet-hours",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "Do the upgrade.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    // Daemon 1: fires, then dies mid-turn (the turn never resolves).
    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // The dispatch is on disk BEFORE completion — that record is the only
    // thing the next process can use to tell "was running" from "never ran".
    const onDisk = new CronStore(TEST_PATH).list()[0];
    expect(onDisk.lastStartedAt).toBeGreaterThan(0);
    expect(onDisk.lastRunAt).toBeNull();

    // Daemon 2: fresh process, fresh store instance, same file.
    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.calls).toHaveLength(1));
    schedulerB.stop();

    // Exactly one fire, and it announces itself as a resume so the model
    // checks state instead of blindly redoing non-idempotent work.
    expect(second.calls).toHaveLength(1);
    const [body] = bodies(second.calls);
    expect(body).toContain("[resumed]");
    expect(body).toContain("never reported completion");
    expect(body).toContain("Do the upgrade.");
  });

  it("marks the resumed fire only once — a later normal fire is unmarked", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({
      name: "quiet-hours",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "Do the upgrade.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // Daemon 2 delivers the resumed fire and completes it normally.
    const calls: string[] = [];
    const agentB = {
      handleCronMessage: vi.fn((msg: string) => {
        calls.push(msg);
        return Promise.resolve(true);
      }),
    } as unknown as Agent;
    const storeB = new CronStore(TEST_PATH);
    const schedulerB = new CronScheduler(agentB, storeB);
    schedulerB.start();
    await waitFor(() => expect(calls).toHaveLength(1));
    schedulerB.stop();
    await waitFor(() => expect(storeB.list()[0].lastStatus).toBe("ok"));
    expect(bodies(calls)[0]).toContain("[resumed]");

    // Next cadence tick: an ordinary run again.
    makeJobsDue();
    await tick(schedulerB);
    expect(calls).toHaveLength(2);
    expect(bodies(calls)[1]).not.toContain("[resumed]");
    expect(storeB.list()[0].lastStatus).toBe("ok");
  });

  it("never fires a once job twice across a restart", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({
      name: "send-the-order",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "Place the order.",
      sessionKey: "dm:alice",
    });
    expect(storeA.list()[0].deleteAfterRun).toBe(true);
    makeJobsDue();

    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // Daemon 2 must not place the order a second time: the one fire this job
    // was entitled to already happened, and it may well have succeeded.
    const second = hangingAgent();
    const storeB = new CronStore(TEST_PATH);
    const schedulerB = new CronScheduler(second.agent, storeB);
    schedulerB.start();
    await new Promise((r) => setTimeout(r, 50));
    await tick(schedulerB);
    schedulerB.stop();

    expect(second.calls).toHaveLength(0);
    const job = storeB.list()[0];
    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeNull();
    expect(job.lastStatus).toBe("interrupted");
  });

  it("leaves the normal cadence alone across a restart with no interrupted run", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "hourly",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const calls: string[] = [];
    const agent = {
      handleCronMessage: vi.fn((msg: string) => {
        calls.push(msg);
        return Promise.resolve(true);
      }),
    } as unknown as Agent;

    // A complete run, then a restart before the next slot is due.
    await tick(new CronScheduler(agent, store));
    expect(calls).toHaveLength(1);
    expect(bodies(calls)[0]).toBe('Scheduled task "hourly" triggered. tick');

    const storeB = new CronStore(TEST_PATH);
    const schedulerB = new CronScheduler(agent, storeB);
    schedulerB.start();
    await new Promise((r) => setTimeout(r, 50));
    schedulerB.stop();

    // Not due yet, nothing interrupted: no extra fire, cadence untouched.
    expect(calls).toHaveLength(1);
    const job = storeB.list()[0];
    expect(job.lastStatus).toBe("ok");
    expect(job.nextRunAt).toBeGreaterThan(Date.now());

    // And the next due slot fires normally, unmarked.
    makeJobsDue();
    await tick(schedulerB);
    expect(calls).toHaveLength(2);
    expect(bodies(calls)[1]).toBe('Scheduled task "hourly" triggered. tick');
  });

  // --- failure handling around the store -------------------------------

  it("does not scan for due jobs until the store could actually be read", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({
      name: "quiet-hours",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "Do the upgrade.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));
    const goodFile = readFileSync(TEST_PATH, "utf-8");

    // Daemon 2 comes up while the store is unreadable. A read error must not
    // be read as "no jobs": that would let recovery report success with
    // nothing to recover, latch, and then fire the interrupted job unmarked
    // as soon as the file came back.
    writeFileSync(TEST_PATH, "{ this is not json");
    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));

    // Not awaited: if the scan runs anyway it dispatches the hanging turn and
    // the tick never settles — the assertion below should be what fails.
    void tick(schedulerB);
    await new Promise((r) => setTimeout(r, 20));
    expect(second.calls).toHaveLength(0);
    // ...and nothing overwrote the file we could not read.
    expect(readFileSync(TEST_PATH, "utf-8")).toBe("{ this is not json");

    // The file is readable again: recovery lands and the job fires exactly
    // once, with its marker.
    writeFileSync(TEST_PATH, goodFile);
    void tick(schedulerB);
    await waitFor(() => expect(second.calls).toHaveLength(1));
    expect(bodies(second.calls)[0]).toContain("[resumed]");
  });

  it("does not record an error when the turn succeeded and only the write failed", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "send-the-order",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "Place the order.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const agent = {
      handleCronMessage: vi.fn(() => Promise.resolve(true)),
    } as unknown as Agent;

    const markRun = vi.spyOn(store, "markRun");
    markRun.mockImplementationOnce(() => { throw new Error("ENOSPC"); });

    const scheduler = new CronScheduler(agent, store);
    await tick(scheduler);

    // The one-shot's turn ran and succeeded. Recording "error" here would put
    // it back on the failure-retry path (nextRunAt = now + 5min) and place the
    // order a second time.
    expect(markRun.mock.calls.map((c) => c[1])).not.toContain("error");
    // ...and it is held out of the scan while the write is retried.
    await tick(scheduler);
    expect(agent.handleCronMessage).toHaveBeenCalledTimes(1);

    // Once the store recovers, the outcome lands: the one-shot is deleted.
    expect(store.list()).toHaveLength(0);
  });

  it("parks a finished one-shot whose outcome can never be written, instead of retrying it", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "send-the-order",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "Place the order.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const agent = {
      handleCronMessage: vi.fn(() => Promise.resolve(true)),
    } as unknown as Agent;

    vi.spyOn(store, "markRun").mockImplementation(() => { throw new Error("ENOSPC"); });
    const scheduler = new CronScheduler(agent, store);

    // Dispatch, then several more polls' worth of failed outcome writes.
    for (let i = 0; i < 5; i++) await tick(scheduler);

    expect(agent.handleCronMessage).toHaveBeenCalledTimes(1);
    const job = new CronStore(TEST_PATH).list()[0];
    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeNull();
    expect(job.lastStatus).toBe("ok");
    expect(job.retryCount ?? 0).toBe(0);
  });

  it("retries a job whose dispatch record could not be written, instead of wedging it", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "hourly",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const agent = {
      handleCronMessage: vi.fn(() => Promise.resolve(true)),
    } as unknown as Agent;

    const markStarted = vi.spyOn(store, "markStarted");
    markStarted.mockImplementationOnce(() => { throw new Error("EIO"); });

    const scheduler = new CronScheduler(agent, store);
    await tick(scheduler);
    // Nothing was dispatched — and the job must not be stranded in the
    // in-flight set, which would hide it from every later scan this process
    // makes.
    expect(agent.handleCronMessage).not.toHaveBeenCalled();

    await tick(scheduler);
    expect(agent.handleCronMessage).toHaveBeenCalledTimes(1);
    expect(store.list()[0].lastStatus).toBe("ok");
  });

  it("a disable/enable round-trip during a live run does not erase the interruption", async () => {
    const storeA = new CronStore(TEST_PATH);
    const job = storeA.add({
      name: "send-the-order",
      // Past due-time: re-enabling recomputes it to "now", so the job really
      // is due when the next daemon scans — the assertion that it does not
      // fire is about recovery, not about the schedule.
      schedule: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
      message: "Place the order.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // While that turn is still running, someone toggles the job in `tomo
    // config` / `tomo cron`. Enabling must not acknowledge the in-flight run:
    // that would erase the only evidence the one-shot was ever dispatched.
    const admin = new CronStore(TEST_PATH);
    admin.setEnabled(job.id, false);
    admin.setEnabled(job.id, true);
    expect(isInterrupted(new CronStore(TEST_PATH).list()[0])).toBe(true);

    // Restart: the one-shot must still be recognised as interrupted, and must
    // not be placed a second time.
    const second = hangingAgent();
    const storeB = new CronStore(TEST_PATH);
    const schedulerB = new CronScheduler(second.agent, storeB);
    schedulerB.start();
    await new Promise((r) => setTimeout(r, 30));
    await tick(schedulerB);
    schedulerB.stop();

    expect(second.calls).toHaveLength(0);
    const after = storeB.list()[0];
    expect(after.enabled).toBe(false);
    expect(after.lastStatus).toBe("interrupted");
  });

  it("a disable/enable during a RESUMED recurring run does not erase the interruption", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "quiet-hours",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "Do the upgrade.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    // Run 1 dies mid-turn.
    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, store));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // Daemon 2 settles it and delivers the resumed fire — which also hangs.
    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.calls).toHaveLength(1));
    schedulerB.stop();
    expect(bodies(second.calls)[0]).toContain("[resumed]");

    // The toggle lands while that RESUMED run is still in flight. recovery
    // leaves `lastStatus: "interrupted"` on a resumed recurring job, so a
    // status-only gate would treat this live run as settled, acknowledge its
    // token, and lose the interruption entirely.
    const admin = new CronStore(TEST_PATH);
    admin.setEnabled(job.id, false);
    admin.setEnabled(job.id, true);
    expect(isInterrupted(new CronStore(TEST_PATH).list()[0])).toBe(true);

    // Daemon 3 must still see an interrupted run, and its fire must carry the
    // marker. (Re-enabling pushed nextRunAt forward, so make it due again —
    // the marker is persisted and waits for whenever the job next runs.)
    const third = hangingAgent();
    const storeC = new CronStore(TEST_PATH);
    const schedulerC = new CronScheduler(third.agent, storeC);
    schedulerC.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(storeC.list()[0].resumeAttempts).toBe(2);
    makeJobsDue();
    void tick(schedulerC);
    await waitFor(() => expect(third.calls).toHaveLength(1));
    schedulerC.stop();
    expect(bodies(third.calls)[0]).toContain("[resumed]");
  });

  it("re-enabling a settled interrupted job clears it for good", async () => {
    const storeA = new CronStore(TEST_PATH);
    const job = storeA.add({
      name: "send-the-order",
      schedule: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
      message: "Place the order.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // Recovery settles and disables it; the operator then decides it should
    // run after all. That decision must stick across the next restart.
    new CronStore(TEST_PATH).recoverInterrupted();
    new CronStore(TEST_PATH).setEnabled(job.id, true);

    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.calls).toHaveLength(1));
    schedulerB.stop();
    // A deliberate re-run, not a resume: the operator already adjudicated it.
    expect(bodies(second.calls)[0]).not.toContain("[resumed]");
  });

  it("delivers the trigger as a cron tomo-event envelope (round-trip)", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "daily-backup",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "Run the backup.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();

    const fakeAgent = {
      handleCronMessage: vi.fn(() => Promise.resolve(true)),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    await tick(scheduler);

    const [msg] = (fakeAgent.handleCronMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    const parsed = parseTomoEvent(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("cron");
    expect(parsed!.name).toBe("daily-backup");
    expect(parsed!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(parsed!.body).toBe('Scheduled task "daily-backup" triggered. Run the backup.');
  });
});
