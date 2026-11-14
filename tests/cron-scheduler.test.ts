import { afterAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronScheduler } from "../src/cron/scheduler.js";
import { CronStore, ONE_SHOT_STALE_AFTER_MS, isInterrupted } from "../src/cron/store.js";
import { log } from "../src/logger.js";
import { parseTomoEvent } from "../src/tomo-event.js";
import type { Agent } from "../src/agent.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-cron-scheduler-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
const TEST_PATH = join(TEST_DIR, "jobs.json");

/** Make the interrupted run on disk look like it started `agoMs` ago. */
function ageInterruptedRun(agoMs: number): void {
  const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
  for (const job of raw.jobs) job.lastStartedAt = Date.now() - agoMs;
  writeFileSync(TEST_PATH, JSON.stringify(raw));
}

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
  function hangingAgent(): { agent: Agent; calls: string[]; notices: string[] } {
    const calls: string[] = [];
    const notices: string[] = [];
    const agent = {
      handleCronMessage: vi.fn((msg: string) => {
        calls.push(msg);
        return new Promise<boolean>(() => {});
      }),
      notifyOwner: vi.fn(async (text: string) => { notices.push(text); return true; }),
    } as unknown as Agent;
    return { agent, calls, notices };
  }

  /** Bodies delivered to a recording agent, envelope stripped. */
  function bodies(calls: string[]): string[] {
    return calls.map((msg) => parseTomoEvent(msg)!.body);
  }

  // POLICY (2026-11-14): an interrupted run is never re-run automatically —
  // after a crash or kill exactly as after a graceful restart.
  it("never re-fires a recurring job a crash interrupted; tells the owner once and waits for the next slot", async () => {
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
    await waitFor(() => expect(second.notices).toHaveLength(1));
    await tick(schedulerB);
    schedulerB.stop();

    expect(second.calls).toHaveLength(0);
    expect(second.notices[0]).toContain('"quiet-hours"');
    expect(second.notices[0]).toContain("did NOT finish");
    expect(second.notices[0]).toContain("time unknown");
    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.lastStatus).toBe("interrupted");
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(after.interruptNotice ?? null).toBeNull();

    // Told once.
    const third = hangingAgent();
    const schedulerC = new CronScheduler(third.agent, new CronStore(TEST_PATH));
    schedulerC.start();
    await new Promise((r) => setTimeout(r, 30));
    schedulerC.stop();
    expect(third.notices).toHaveLength(0);
    expect(third.calls).toHaveLength(0);
  });

  it("parks a one-shot a crash interrupted, however fresh, and asks the owner — never retried", async () => {
    const storeA = new CronStore(TEST_PATH);
    const job = storeA.add({
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

    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.notices).toHaveLength(1));
    await tick(schedulerB);
    schedulerB.stop();

    expect(second.calls).toHaveLength(0);
    expect(second.notices[0]).toContain(`"send-the-order" [${job.id}]`);
    expect(second.notices[0]).toContain("Should I run it again?");
    expect(second.notices[0]).toContain("tomo cron remove <id>");
    const after = new CronStore(TEST_PATH).list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastStatus).toBe("interrupted");
    expect(after.interruptNotifiedAt).toBeGreaterThan(0);

    // Told once, not on every restart.
    const third = hangingAgent();
    const schedulerC = new CronScheduler(third.agent, new CronStore(TEST_PATH));
    schedulerC.start();
    await new Promise((r) => setTimeout(r, 30));
    schedulerC.stop();
    expect(third.notices).toHaveLength(0);
  });

  it("reports every unreported interruption of a recurring job, with its count, in the one DM", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({ name: "rec", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    // Two crashes before any report went out.
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    new CronStore(TEST_PATH).markStarted(job.id);

    const next = hangingAgent();
    const scheduler = new CronScheduler(next.agent, new CronStore(TEST_PATH));
    scheduler.start();
    await waitFor(() => expect(next.notices).toHaveLength(1));
    await tick(scheduler);
    scheduler.stop();
    expect(next.notices[0]).toContain('"rec"');
    expect(next.notices[0]).toContain("interrupted 2 times");
    expect(next.notices[0].match(/started /g)).toHaveLength(2);
    expect(next.calls).toHaveLength(0);
  });

  it("after a crash, the owner report also covers the slots missed during the downtime", async () => {
    const store = new CronStore(TEST_PATH);
    const hour = 3_600_000;
    const job = store.add({ name: "hourly", schedule: { kind: "every", everyMs: hour }, message: "x", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = Date.now() - 4.5 * hour;
    writeFileSync(TEST_PATH, JSON.stringify(raw));
    new CronStore(TEST_PATH).markStarted(job.id); // ...and the daemon died

    const next = hangingAgent();
    const scheduler = new CronScheduler(next.agent, new CronStore(TEST_PATH));
    scheduler.start();
    await waitFor(() => expect(next.notices).toHaveLength(1));
    await tick(scheduler);
    scheduler.stop();
    expect(next.notices[0]).toContain('"hourly"');
    expect(next.notices[0]).toContain("4 later scheduled runs missed while Tomo was down");
    expect(next.notices[0]).toMatch(/missed while Tomo was down \(.+ to .+\), not run/);
    expect(next.calls).toHaveLength(0);
  });

  it("an unexpected owner-report rejection is caught at the call site, not left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      new CronStore(TEST_PATH).add({ name: "rec", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
      const next = hangingAgent();
      const scheduler = new CronScheduler(next.agent, new CronStore(TEST_PATH));
      (scheduler as unknown as { reportToOwner(): Promise<void> }).reportToOwner = () => Promise.reject(new Error("report blew up"));
      await tick(scheduler);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Cron owner report failed unexpectedly; will retry",
      );
      // The guard was released, so a later tick can try again.
      expect((scheduler as unknown as { reportingToOwner: boolean }).reportingToOwner).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports parked one-shots and interrupted recurring runs in ONE owner DM", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({ name: "rec", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    storeA.add({ name: "once", schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() }, message: "y", sessionKey: "dm:bob" });
    makeJobsDue();
    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(2));

    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.notices).toHaveLength(1));
    await tick(schedulerB);
    schedulerB.stop();
    expect(second.notices[0]).toContain('"rec"');
    expect(second.notices[0]).toContain('"once"');
    expect(second.calls).toHaveLength(0);
  });

  it("does not retry a stale interrupted once job, and tells the owner", async () => {
    const storeA = new CronStore(TEST_PATH);
    storeA.add({
      name: "water-plants",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "Remind me to water the plants.",
      sessionKey: "dm:alice",
    });
    makeJobsDue();
    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));
    // The daemon stayed down well past the job's staleness window.
    ageInterruptedRun(ONE_SHOT_STALE_AFTER_MS + 60_000);

    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, new CronStore(TEST_PATH));
    schedulerB.start();
    await waitFor(() => expect(second.notices).toHaveLength(1));
    schedulerB.stop();
    expect(second.calls).toHaveLength(0);
    expect(second.notices[0]).toContain("Remind me to water the plants.");
  });

  it("keeps a parked one-shot unreported when there was no owner DM to tell", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({ name: "nowhere", schedule: { kind: "at", at: new Date(Date.now() - 86_400_000).toISOString() },
      message: "x", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    Object.assign(raw.jobs[0], { enabled: false, nextRunAt: null, lastStatus: "interrupted" });
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const notifyOwner = vi.fn(async () => false);
    const agent = { handleCronMessage: vi.fn(), notifyOwner } as unknown as Agent;
    const scheduler = new CronScheduler(agent, new CronStore(TEST_PATH));
    scheduler.start();
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    scheduler.stop();
    expect(new CronStore(TEST_PATH).list()[0].interruptNotifiedAt ?? null).toBeNull();

    // Retried later in the same process, not only on the next start.
    notifyOwner.mockResolvedValue(true);
    (scheduler as unknown as { nextOwnerReportAt: number }).nextOwnerReportAt = 0;
    await tick(scheduler);
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(new CronStore(TEST_PATH).list()[0].interruptNotifiedAt).toBeGreaterThan(0));
  });

  it("tells the owner about a one-shot an older version parked silently", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "legacy",
      schedule: { kind: "at", at: new Date(Date.now() - 86_400_000).toISOString() },
      message: "x",
      sessionKey: "dm:alice",
    });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    Object.assign(raw.jobs[0], { enabled: false, nextRunAt: null, lastStatus: "interrupted" });
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const agent = hangingAgent();
    const scheduler = new CronScheduler(agent.agent, new CronStore(TEST_PATH));
    scheduler.start();
    await waitFor(() => expect(agent.notices).toHaveLength(1));
    scheduler.stop();
    expect(agent.notices[0]).toContain('"legacy"');
  });

  it("after an outage: daily jobs catch up within 12h, longer periods always catch up, the rest skip, one owner DM", async () => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const store = new CronStore(TEST_PATH);
    const every = (name: string, everyMs: number, extra: { staleAfterMs?: number } = {}) =>
      store.add({ name, schedule: { kind: "every", everyMs }, message: name, sessionKey: "dm:alice", ...extra });
    every("backup", DAY);                        // missed by 9h  -> window 12h: catches up
    every("brief", DAY);                         // missed by 14h -> skipped
    every("hourly", HOUR);                       // missed by 3h  -> window 30m: skipped
    every("fortnightly", 14 * DAY);              // missed by 10d -> period > 1 day: catches up
    store.add({ name: "monthly", schedule: { kind: "cron", expr: "0 9 1 * *" }, message: "monthly", sessionKey: "dm:alice" });
    every("always", DAY, { staleAfterMs: 0 });   // missed by 14h -> explicitly always catches up
    const lateBy: Record<string, number> = {
      backup: 9 * HOUR, brief: 14 * HOUR, hourly: 3 * HOUR, fortnightly: 10 * DAY, monthly: 20 * DAY, always: 14 * HOUR,
    };
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    const now = Date.now();
    for (const job of raw.jobs) job.nextRunAt = now - lateBy[job.name];
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const notifyOwner = vi.fn(async () => true);
    const agent = { handleCronMessage: vi.fn(() => Promise.resolve(true)), notifyOwner } as unknown as Agent;
    const scheduler = new CronScheduler(agent, store);
    await tick(scheduler);

    const fired = (agent.handleCronMessage as ReturnType<typeof vi.fn>).mock.calls.map(([msg]) => parseTomoEvent(msg as string)!.name);
    expect(fired.sort()).toEqual(["always", "backup", "fortnightly", "monthly"]);
    const brief = new CronStore(TEST_PATH).list().find((j) => j.name === "brief")!;
    expect(brief.enabled).toBe(true);
    expect(brief.nextRunAt).toBeGreaterThan(now);
    expect(brief.lastSkippedAt).toBeGreaterThanOrEqual(now);
    expect(brief.lastStatus).toBeNull();
    expect(vi.mocked(log.warn).mock.calls.some(([, msg]) => typeof msg === "string" && msg.startsWith("Cron run skipped: missed its slot by 14h"))).toBe(true);

    // The owner hears about the skips — once, in one message, not per job.
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    const text = (notifyOwner.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("2 scheduled runs were missed");
    expect(text).toContain('"brief"');
    expect(text).toContain('"hourly"');
    expect(text).not.toContain('"backup"');
    expect(text).toContain("--stale-after 0");
    await tick(scheduler);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a skip notice survives a restart before it could be delivered", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({ name: "hourly", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = Date.now() - 5 * 3_600_000;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    // Daemon 1 skips the run but has nowhere to send the DM, then goes away.
    const unreachable = vi.fn(async () => false);
    await tick(new CronScheduler({ handleCronMessage: vi.fn(), notifyOwner: unreachable } as unknown as Agent, store));
    await waitFor(() => expect(unreachable).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    // Daemon 2 has nothing new to skip, but still owes the owner the notice.
    const notifyOwner = vi.fn(async () => true);
    await tick(new CronScheduler({ handleCronMessage: vi.fn(() => Promise.resolve(true)), notifyOwner } as unknown as Agent, new CronStore(TEST_PATH)));
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    expect((notifyOwner.mock.calls[0] as unknown as [string])[0]).toContain('"hourly"');
    await waitFor(() => expect(new CronStore(TEST_PATH).list()[0].skipNotice ?? null).toBeNull());
  });

  it("puts an outage's stale skips and parked one-shots in the same DM", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({ name: "hourly", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    store.add({ name: "legacy", schedule: { kind: "at", at: new Date(Date.now() - 86_400_000).toISOString() }, message: "y", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = Date.now() - 5 * 3_600_000;
    Object.assign(raw.jobs[1], { enabled: false, nextRunAt: null, lastStatus: "interrupted" });
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const notifyOwner = vi.fn(async () => true);
    const agent = { handleCronMessage: vi.fn(() => Promise.resolve(true)), notifyOwner } as unknown as Agent;
    await tick(new CronScheduler(agent, store));
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    const text = (notifyOwner.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('"hourly"');
    expect(text).toContain('"legacy"');
  });

  it("keeps unreported skips when the DM could not be delivered, and sends them later", async () => {
    const store = new CronStore(TEST_PATH);
    store.add({ name: "hourly", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
    raw.jobs[0].nextRunAt = Date.now() - 5 * 3_600_000;
    writeFileSync(TEST_PATH, JSON.stringify(raw));

    const notifyOwner = vi.fn(async () => false);
    const agent = { handleCronMessage: vi.fn(() => Promise.resolve(true)), notifyOwner } as unknown as Agent;
    const scheduler = new CronScheduler(agent, store);
    await tick(scheduler);
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    notifyOwner.mockResolvedValue(true);
    (scheduler as unknown as { nextOwnerReportAt: number }).nextOwnerReportAt = 0;
    await tick(scheduler);
    await waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(2));
    expect((notifyOwner.mock.calls[1] as unknown as [string])[0]).toContain('"hourly"');
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

    // The file is readable again: recovery lands, settles the interrupted
    // run, and the job is NOT re-fired.
    writeFileSync(TEST_PATH, goodFile);
    await tick(schedulerB);
    expect(second.calls).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].lastStatus).toBe("interrupted");
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

    // Restart: the one-shot must still be recognised as interrupted — parked
    // and reported, not fired as if it had never run.
    const second = hangingAgent();
    const storeB = new CronStore(TEST_PATH);
    const schedulerB = new CronScheduler(second.agent, storeB);
    schedulerB.start();
    await waitFor(() => expect(second.notices).toHaveLength(1));
    await tick(schedulerB);
    schedulerB.stop();
    expect(second.calls).toHaveLength(0);
    expect(storeB.list()[0].lastStatus).toBe("interrupted");
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

    // Recovery settles and disables it (too old to retry); the operator then
    // decides it should run after all. That decision must stick across the
    // next restart.
    ageInterruptedRun(ONE_SHOT_STALE_AFTER_MS + 60_000);
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
