/**
 * P0-6 (audit 2026-11-13): a graceful restart in the middle of a cron run.
 *
 * `agent.stop()` closes the live sessions; LiveSessionManager converts the
 * in-flight turn's "Session is closed" rejection into a bare NO_REPLY, which
 * TurnRunner reads as a successful silent turn. The scheduler then acked the
 * run "ok" — a one-shot was DELETED with nothing delivered, a recurring job's
 * half-done run was recorded as complete, and no [resumed] marker ever came.
 * A run still queued behind another turn was refused by shutdown and recorded
 * as an error (burning a one-shot's retry) although it never started.
 *
 * Decided: an interrupted run may have partly happened, so it is NEVER re-run
 * automatically. A one-shot is parked and the owner is asked after the
 * restart; a recurring job records "interrupted" and waits for its next slot.
 *
 * Drives the real Agent, CronStore and CronScheduler over the repo's mock SDK.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockSdk, waitFor } from "./helpers/agent-harness.js";
import { CronStore } from "../src/cron/store.js";
import { CronScheduler } from "../src/cron/scheduler.js";

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
  const dir = mkdtempSync(join(tmpdir(), "cron-shutdown-"));
  tmpDirs.push(dir);
  const path = join(dir, "jobs.json");
  return { agent, tg, path, store: new CronStore(path) };
}

/** An `at` time just ahead; callers wait it out so the job is due on the first tick. */
const soon = () => new Date(Date.now() + 30).toISOString();
const elapse = () => new Promise((r) => setTimeout(r, 60));

/** Force a job due now by editing the store file, as another process would. */
function makeDue(path: string, id: string): void {
  const data = JSON.parse(readFileSync(path, "utf-8")) as { jobs: Array<{ id: string; nextRunAt: number }> };
  data.jobs.find((j) => j.id === id)!.nextRunAt = Date.now() - 1_000;
  writeFileSync(path, JSON.stringify(data));
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

async function restartWith(path: string) {
  const next = nextDaemon();
  const scheduler = new CronScheduler(next.agent, new CronStore(path));
  scheduler.start();
  await new Promise((r) => setTimeout(r, 30));
  scheduler.stop();
  return next;
}

describe("a cron run cut short by graceful shutdown is not recorded as finished", () => {
  it("parks an interrupted one-shot (kept, not deleted) and asks the owner after restart, without re-running it", async () => {
    const { agent, tg, path, store } = await setup();
    const job = store.add({ name: "reminder", schedule: { kind: "at", at: soon() }, message: "send the email", sessionKey: "telegram:12345" });

    await elapse();
    let started = 0;
    mockSdk.responseFn = () => { started++; return new Promise(() => {}); }; // hangs mid-turn
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await new Promise((r) => setTimeout(r, 20));

    // Before the fix: gone from disk, nothing delivered.
    const kept = new CronStore(path).get(job.id);
    expect(kept).toBeDefined();
    expect(kept!.lastStatus).toBe("interrupted");
    expect(kept!.enabled).toBe(false);
    expect(kept!.nextRunAt).toBeNull();
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
    const { agent, path, store } = await setup();
    const job = store.add({ name: "rec", schedule: { kind: "every", everyMs: 60 * 60_000 }, message: "x", sessionKey: "telegram:12345" });
    makeDue(path, job.id);

    await elapse();
    let started = 0;
    mockSdk.responseFn = () => { started++; return new Promise(() => {}); };
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await new Promise((r) => setTimeout(r, 20));

    const after = new CronStore(path).get(job.id)!;
    expect(after.lastStatus).toBe("interrupted");
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
    const { agent, path, store } = await setup();
    const once = store.add({ name: "reminder", schedule: { kind: "at", at: soon() }, message: "send the email", sessionKey: "telegram:12345" });

    await elapse();
    let started = 0;
    mockSdk.responseFn = () => { started++; return new Promise(() => {}); };
    const scheduler = new CronScheduler(agent, store);
    // The disk write of the interrupted status fails: the run token is left
    // unacknowledged, exactly as after a crash or a hard kill.
    vi.spyOn(store, "markInterruptedByShutdown").mockImplementation(() => { throw new Error("EIO: disk write failed"); });
    scheduler.start();
    await waitFor(() => expect(started).toBe(1));

    scheduler.stop();
    await agent.stop();
    await new Promise((r) => setTimeout(r, 20));
    const left = new CronStore(path).get(once.id)!;
    expect(left.lastRunId).not.toBe(left.lastCompletedRunId);

    // The next daemon's recovery: parked and the owner asked — no [resumed] fire.
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
    const { agent, path, store } = await setup();
    const job = store.add({ name: "deps", schedule: { kind: "at", at: soon() }, message: "upgrade and restart", sessionKey: "telegram:12345" });

    await elapse();
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
    await new Promise((r) => setTimeout(r, 20));

    const kept = new CronStore(path).get(job.id)!;
    expect(kept.lastStatus).toBe("interrupted");
    expect(kept.enabled).toBe(false);
    const next = await restartWith(path);
    expect(next.turns).toEqual([]);
    expect(next.notices[0]).toContain('"deps"');
  });

  it("rolls back a run shutdown refused before it started: still due, not an error, not interrupted", async () => {
    const { agent, path, store } = await setup();
    // Two jobs on the SAME session: the second queues behind the first.
    const first = store.add({ name: "first", schedule: { kind: "at", at: soon() }, message: "one", sessionKey: "telegram:12345" });
    const second = store.add({ name: "second", schedule: { kind: "at", at: soon() }, message: "two", sessionKey: "telegram:12345" });

    await elapse();
    let started = 0;
    mockSdk.responseFn = () => { started++; return new Promise(() => {}); };
    const scheduler = new CronScheduler(agent, store);
    scheduler.start();
    await waitFor(() => expect(started).toBe(1));
    // Both dispatched (markStarted written), only one reached the model.
    await waitFor(() => {
      const s = new CronStore(path);
      expect(s.get(first.id)!.lastRunId).toBeTruthy();
      expect(s.get(second.id)!.lastRunId).toBeTruthy();
    });

    scheduler.stop();
    await agent.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1);

    const after = new CronStore(path);
    const queuedId = [first.id, second.id].find((id) => after.get(id)!.lastStatus !== "interrupted");
    const runningId = [first.id, second.id].find((id) => id !== queuedId)!;
    expect(queuedId).toBeDefined();
    const queued = after.get(queuedId!)!;
    // Never ran: no outcome recorded, still enabled and due.
    expect(queued.lastStatus).toBeNull();
    expect(queued.enabled).toBe(true);
    expect(queued.nextRunAt).not.toBeNull();
    expect(after.getDueJobs().map((j) => j.id)).toContain(queuedId);

    // The one that was mid-turn is parked as interrupted; nothing is left
    // for restart recovery to re-run automatically.
    expect(after.get(runningId)!.lastStatus).toBe("interrupted");
    expect(after.get(runningId)!.enabled).toBe(false);
    const outcome = after.recoverInterrupted();
    expect(outcome.parked).toEqual([]);
    expect(outcome.recurring).toEqual([]);
    expect(after.get(queuedId!)!.lastStatus).toBeNull();
  });
});
