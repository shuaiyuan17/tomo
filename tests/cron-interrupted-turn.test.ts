/**
 * A cron run whose turn is cut short — by a graceful shutdown or by the
 * owner's Stop — is never recorded as finished.
 *
 * P0-6 (audit 2026-11-13), shutdown: `agent.stop()` closes the live sessions;
 * LiveSessionManager converts the in-flight turn's "Session is closed"
 * rejection into a bare NO_REPLY, which TurnRunner reads as a successful
 * silent turn. The scheduler then acked the run "ok" — a one-shot was DELETED
 * with nothing delivered, a recurring job's half-done run was recorded as
 * complete. A run still queued behind another turn was refused by shutdown and
 * recorded as an error (burning a one-shot's retry) although it never started.
 *
 * Stop (web UI → the SDK's interrupt) ends whichever turn is running in a
 * session, and that can be a cron job's. The stopped turn settles cleanly so
 * the owner gets no error notice, which the scheduler used to read as "ok"
 * the same way.
 *
 * Decided for both: an interrupted run may have partly happened, so it is
 * NEVER re-run automatically. A one-shot is parked and the owner is asked; a
 * recurring job records "interrupted" and waits for its next normal slot.
 *
 * Drives the real Agent, CronStore and CronScheduler over the repo's mock SDK;
 * Stop goes through Agent.stopTurn, exactly as the web channel calls it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, waitFor } from "./helpers/agent-harness.js";
import { getCompactTriggerPath } from "../src/lcm/compact.js";
import { CronStore } from "../src/cron/store.js";
import { CronScheduler } from "../src/cron/scheduler.js";
import { editJobs, tick } from "./helpers/cron.js";

installAgentTestHooks();

/** Every directory setup() created; removed once the file is done. */
const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  // Seed the session so cron has a delivery target.
  mockSdk.responseFn = () => "seeded";
  await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
  await drainQueue(agent);
  tg.delivered.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "cron-interrupted-"));
  tmpDirs.push(dir);
  const path = join(dir, "jobs.json");
  const store = new CronStore(path);
  /**
   * Add a job that is due on the first tick. A one-shot's `at` is a minute
   * ahead, then its slot is moved into the past on disk, as another process
   * would — no waiting for a real clock to pass it.
   */
  const addDue = (name: string, schedule: "once" | "hourly", message = name) => {
    const job = store.add({
      name,
      schedule: schedule === "once"
        ? { kind: "at", at: new Date(Date.now() + 60_000).toISOString() }
        : { kind: "every", everyMs: 60 * 60_000 },
      message,
      sessionKey: "telegram:12345",
    });
    makeDue(path, job.id);
    return job;
  };
  return { agent, tg, path, store, addDue };
}

/** Force a job due now by editing the store file. */
function makeDue(path: string, id: string): void {
  editJobs(path, (jobs) => { jobs.find((j) => j.id === id)!.nextRunAt = Date.now() - 1_000; });
}

/** A cron turn that hangs mid-run until released; `started` counts the runs. */
function hangingRuns() {
  const state = { started: 0, release: (_text: string) => {} };
  mockSdk.responseFn = () => { state.started++; return new Promise<string>((resolve) => { state.release = resolve; }); };
  return state;
}

/** The next daemon, as far as the scheduler can tell: a stub agent that
 *  records owner DMs and any cron turn it is asked to run. */
function nextDaemon() {
  const notices: string[] = [];
  const turns: string[] = [];
  const agent = {
    notifyOwner: vi.fn(async (text: string) => { notices.push(text); return true; }),
    handleCronMessage: vi.fn(async (message: string) => { turns.push(message); return true; }),
  };
  return { agent: agent as never, notices, turns };
}

/**
 * A fresh scheduler on the same file: its first tick (what `start()` runs),
 * awaited, and the owner report that tick kicked off. That report is not part
 * of the tick's promise, but its only await is this agent's already-resolved
 * `notifyOwner` (the store is synchronous), so it has settled once the
 * microtask queue drains, which one macrotask turn guarantees. No sleep,
 * and a "no notice" answer is a real answer rather than "not yet".
 */
async function restartWith(path: string) {
  const next = nextDaemon();
  await tick(new CronScheduler(next.agent, new CronStore(path)));
  await new Promise((r) => setImmediate(r));
  return next;
}

/** Wait until the job on disk reads `lastStatus: "interrupted"`. */
const interruptedOnDisk = (path: string, id: string) =>
  waitFor(() => expect(new CronStore(path).get(id)?.lastStatus).toBe("interrupted"));

describe("a cron run cut short by graceful shutdown is not recorded as finished", () => {
  it("parks an interrupted one-shot (kept, not deleted) and asks the owner after restart, without re-running it", async () => {
    const { agent, tg, path, store, addDue } = await setup();
    const job = addDue("reminder", "once", "send the email");

    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(runs.started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await interruptedOnDisk(path, job.id);

    // Before the fix: gone from disk, nothing delivered.
    const kept = new CronStore(path).get(job.id)!;
    expect(kept.enabled).toBe(false);
    expect(kept.nextRunAt).toBeNull();
    expect(tg.delivered).toEqual([]);

    const next = await restartWith(path);
    expect(next.turns).toEqual([]);
    expect(next.notices).toHaveLength(1);
    expect(next.notices[0]).toContain('"reminder"');
    expect(next.notices[0]).toContain("did NOT finish");
    expect(next.notices[0]).toContain("interrupted");
    expect(next.notices[0]).toContain("Should I run it again?");
    // Reported once.
    const again = await restartWith(path);
    expect(again.notices).toEqual([]);
    expect(again.turns).toEqual([]);
  });

  it("records an interrupted recurring run as interrupted and waits for its next normal slot — no catch-up", async () => {
    const { agent, path, store, addDue } = await setup();
    const job = addDue("rec", "hourly", "x");

    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(runs.started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await interruptedOnDisk(path, job.id);

    const after = new CronStore(path).get(job.id)!;
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(after.interruptedAt ?? null).toBeNull();

    const next = await restartWith(path);
    expect(next.turns).toEqual([]);
    // Reported once, report only.
    expect(next.notices).toHaveLength(1);
    expect(next.notices[0]).toContain('"rec"');
    expect(next.notices[0]).toContain("did NOT finish");
    expect(next.notices[0]).toContain("next normal time");
    expect(next.notices[0]).not.toContain("time unknown");
    const again = await restartWith(path);
    expect(again.notices).toEqual([]);
    expect(again.turns).toEqual([]);
  });

  it("parks + reports after restart when writing the interrupted status failed — never auto-re-run", async () => {
    const { agent, path, store, addDue } = await setup();
    const once = addDue("reminder", "once", "send the email");

    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, store);
    // The disk write of the interrupted status fails: the run token is left
    // unacknowledged, exactly as after a crash or a hard kill.
    const markInterrupted = vi.spyOn(store, "markInterruptedByShutdown").mockImplementation(() => { throw new Error("EIO: disk write failed"); });
    scheduler.start();
    await waitFor(() => expect(runs.started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await waitFor(() => expect(markInterrupted).toHaveBeenCalled());
    const left = new CronStore(path).get(once.id)!;
    expect(left.lastRunId).not.toBe(left.lastCompletedRunId);

    // The next daemon's recovery: parked and the owner asked — not re-run.
    const next = await restartWith(path);
    expect(next.turns).toEqual([]);
    expect(next.notices).toHaveLength(1);
    expect(next.notices[0]).toContain('"reminder"');
    expect(next.notices[0]).toContain("Should I run it again?");
    const after = new CronStore(path).get(once.id)!;
    expect(after.enabled).toBe(false);
    expect(after.lastStatus).toBe("interrupted");
  });

  it("treats a restart the cron turn itself started the same way: parked, owner asked, not re-run", async () => {
    const { agent, path, store, addDue } = await setup();
    const job = addDue("deps", "once", "upgrade and restart");

    const scheduler = new CronScheduler(agent, store);
    let stopped: Promise<void> | undefined;
    // The turn runs `tomo restart`: the daemon is told to stop while this very
    // turn is still in flight.
    mockSdk.responseFn = () => {
      stopped ??= (async () => { await new Promise((r) => setTimeout(r, 5)); scheduler.stop(); await agent.stop(); })();
      return new Promise(() => {});
    };
    scheduler.start();
    await waitFor(() => expect(stopped).toBeDefined());
    await stopped;
    await interruptedOnDisk(path, job.id);

    expect(new CronStore(path).get(job.id)!.enabled).toBe(false);
    const next = await restartWith(path);
    expect(next.turns).toEqual([]);
    expect(next.notices[0]).toContain('"deps"');
  });

  it("rolls back a run shutdown refused before it started: still due, not an error, not interrupted", async () => {
    const { agent, path, store, addDue } = await setup();
    // Two jobs on the SAME session: the second queues behind the first.
    const first = addDue("first", "once", "one");
    const second = addDue("second", "once", "two");

    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(runs.started).toBe(1));
    // Both dispatched (markStarted written), only one reached the model.
    await waitFor(() => {
      const s = new CronStore(path);
      expect(s.get(first.id)!.lastRunId).toBeTruthy();
      expect(s.get(second.id)!.lastRunId).toBeTruthy();
    });

    scheduler.stop();
    await agent.stop();
    // Settled: one job interrupted, the other rolled back (its token acknowledged).
    await waitFor(() => {
      const s = new CronStore(path);
      const jobs = [s.get(first.id)!, s.get(second.id)!];
      expect(jobs.filter((j) => j.lastStatus === "interrupted")).toHaveLength(1);
      expect(jobs.every((j) => j.lastRunId === j.lastCompletedRunId)).toBe(true);
    });
    expect(runs.started).toBe(1);

    const after = new CronStore(path);
    const queuedId = [first.id, second.id].find((id) => after.get(id)!.lastStatus !== "interrupted")!;
    const runningId = [first.id, second.id].find((id) => id !== queuedId)!;
    const queued = after.get(queuedId)!;
    // Never ran: no outcome recorded, still enabled and due.
    expect(queued.lastStatus).toBeNull();
    expect(queued.enabled).toBe(true);
    expect(queued.nextRunAt).not.toBeNull();
    expect(after.getDueJobs().map((j) => j.id)).toContain(queuedId);

    // The one that was mid-turn is parked as interrupted; nothing is left
    // for restart recovery to re-run automatically.
    expect(after.get(runningId)!.enabled).toBe(false);
    const outcome = after.recoverInterrupted();
    expect(outcome.parked).toEqual([]);
    expect(outcome.recurring).toEqual([]);
    expect(after.get(queuedId)!.lastStatus).toBeNull();
  });
});

/** The session the cron turn is running on, as the mock SDK saw it. */
const runningKey = () => mockSdk.promptsBySession.at(-1)!.sessionKey;

describe("a cron run the owner stopped is not recorded as finished", () => {
  it("parks a stopped one-shot (kept, not deleted), tells the owner, and never re-runs it", async () => {
    const { agent, tg, path, store, addDue } = await setup();
    const job = addDue("reminder", "once", "send the email");
    const runs = hangingRuns();
    // The harness has no owner DM to deliver to; the report itself is what is under test.
    const notices: string[] = [];
    vi.spyOn(agent, "notifyOwner").mockImplementation(async (text: string) => { notices.push(text); return true; });
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    try {
      await waitFor(() => expect(runs.started).toBe(1));
      await expect(agent.stopTurn(runningKey())).resolves.toBe(true);
      expect(mockSdk.interrupts).toBe(1);
      runs.release("too late");

      // Before the fix: acked "ok" and deleted.
      await interruptedOnDisk(path, job.id);
      const kept = new CronStore(path).get(job.id)!;
      expect(kept.enabled).toBe(false);
      expect(kept.nextRunAt).toBeNull();
      // The owner is asked, by the running scheduler, without a restart.
      await waitFor(() => expect(notices).toHaveLength(1));
      expect(notices[0]).toContain('"reminder"');
      expect(notices[0]).toContain("did NOT finish");
      expect(notices[0]).toContain("stopped from the web UI");
      expect(notices[0]).toContain("Should I run it again?");
      // A stopped turn is not an error: nothing else was sent, and the next
      // scan does not run it again.
      expect(tg.delivered.filter((m) => m.text.includes("[error]"))).toEqual([]);
      await tick(scheduler);
      expect(runs.started).toBe(1);
    } finally { scheduler.stop(); await agent.stop(); }
  });

  it("records a stopped recurring run as interrupted and waits for its next slot; the next run is its own outcome", async () => {
    const { agent, path, addDue } = await setup();
    const job = addDue("digest", "hourly", "summarise");
    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, new CronStore(path));
    scheduler.start();
    try {
      await waitFor(() => expect(runs.started).toBe(1));
      await agent.stopTurn(runningKey());
      runs.release("too late");
      await interruptedOnDisk(path, job.id);
      const after = new CronStore(path).get(job.id)!;
      expect(after.enabled).toBe(true);
      expect(after.nextRunAt).toBeGreaterThan(Date.now());
      scheduler.stop();

      // The stop does not leak into the next run: it finishes and is recorded "ok".
      mockSdk.responseFn = () => "Here is the digest.";
      makeDue(path, job.id);
      const again = new CronScheduler(agent, new CronStore(path));
      again.start();
      try { await waitFor(() => expect(new CronStore(path).get(job.id)?.lastStatus).toBe("ok")); } finally { again.stop(); }
    } finally { scheduler.stop(); await agent.stop(); }
  });

  it("Stop racing a compact reload: the session is closed and replaced before the outcome is read, and the run is still interrupted", async () => {
    const { agent, path, store, addDue } = await setup();
    const job = addDue("tidy", "once", "compact and tidy up");
    const runs = hangingRuns();
    const closeLiveSession = vi.spyOn((agent as unknown as { liveSessionManager: { closeLiveSession(key: string): void } }).liveSessionManager, "closeLiveSession");
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    try {
      await waitFor(() => expect(runs.started).toBe(1));
      // The run compacted its own context: the manager's completion
      // bookkeeping finds this trigger and closes the session instance
      // before control returns to the turn runner.
      mkdirSync(mockConfig.sdkSessionsDir, { recursive: true });
      const trigger = getCompactTriggerPath("mock-sdk-session-123", mockConfig.sdkSessionsDir);
      writeFileSync(trigger, "");
      const key = runningKey();
      closeLiveSession.mockClear();
      await agent.stopTurn(key);
      runs.release("too late");
      await interruptedOnDisk(path, job.id);
      // The race really happened: the trigger was consumed and the instance closed.
      expect(existsSync(trigger)).toBe(false);
      expect(closeLiveSession).toHaveBeenCalledWith(key);
      const kept = new CronStore(path).get(job.id)!;
      expect(kept.enabled).toBe(false);
      expect(kept.nextRunAt).toBeNull();
    } finally { scheduler.stop(); await agent.stop(); }
  });

  it("a turn that was not stopped reports nothing, and Stop with nothing running stops nothing", async () => {
    const { agent, tg } = await setup();
    await expect(agent.stopTurn("dm:owner")).resolves.toBe(false);
    const onStopped = vi.fn();
    mockSdk.responseFn = () => "done";
    await expect(agent.handleCronMessage("do it", "telegram:12345", { waitForHandoff: true, onStopped })).resolves.toBe(true);
    expect(onStopped).not.toHaveBeenCalled();
    expect(tg.delivered.at(-1)?.text).toBe("done");
    await agent.stop();
  });
});
