/**
 * Stop (web UI → the SDK's interrupt) ends whichever turn is running in a
 * session, and that can be a cron job's. The stopped turn settles cleanly so
 * the owner gets no error notice, which the scheduler used to read as "ok":
 * a one-shot was deleted half-done and a recurring run recorded as complete.
 *
 * Decided, as for a shutdown mid-run: it may have partly run, so it is never
 * re-run automatically. A one-shot is parked and the owner asked; a recurring
 * job records "interrupted" and waits for its next normal slot.
 *
 * Drives the real Agent, CronStore and CronScheduler over the repo's mock SDK;
 * Stop goes through Agent.stopTurn, exactly as the web channel calls it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

installAgentTestHooks();

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  mockSdk.responseFn = () => "seeded";
  await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
  await drainQueue(agent);
  tg.delivered.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "cron-stop-"));
  tmpDirs.push(dir);
  const path = join(dir, "jobs.json");
  return { agent, tg, path, store: new CronStore(path) };
}
const soon = () => new Date(Date.now() + 30).toISOString();
const elapse = () => new Promise((r) => setTimeout(r, 60));
function makeDue(path: string, id: string): void {
  const data = JSON.parse(readFileSync(path, "utf-8")) as { jobs: Array<{ id: string; nextRunAt: number }> };
  data.jobs.find((j) => j.id === id)!.nextRunAt = Date.now() - 1_000;
  writeFileSync(path, JSON.stringify(data));
}
/** A cron turn that hangs mid-run until released; `started` counts the runs. */
function hangingRuns() {
  const state = { started: 0, release: (_text: string) => {} };
  mockSdk.responseFn = () => { state.started++; return new Promise<string>((resolve) => { state.release = resolve; }); };
  return state;
}
/** The session the cron turn is running on, as the mock SDK saw it. */
const runningKey = () => mockSdk.promptsBySession.at(-1)!.sessionKey;

describe("a cron run the owner stopped is not recorded as finished", () => {
  it("parks a stopped one-shot (kept, not deleted), tells the owner, and never re-runs it", async () => {
    const { agent, tg, path, store } = await setup();
    const job = store.add({ name: "reminder", schedule: { kind: "at", at: soon() }, message: "send the email", sessionKey: "telegram:12345" });
    await elapse();
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
      await waitFor(() => expect(new CronStore(path).get(job.id)?.lastStatus).toBe("interrupted"));
      const kept = new CronStore(path).get(job.id)!;
      expect(kept.enabled).toBe(false);
      expect(kept.nextRunAt).toBeNull();
      // The owner is asked, by the running scheduler, without a restart.
      await waitFor(() => expect(notices).toHaveLength(1));
      expect(notices[0]).toContain('"reminder"');
      expect(notices[0]).toContain("did NOT finish");
      expect(notices[0]).toContain("stopped from the web UI");
      expect(notices[0]).toContain("Should I run it again?");
      // A stopped turn is not an error: nothing else was sent, and it is not run again.
      expect(tg.delivered.filter((m) => m.text.includes("[error]"))).toEqual([]);
      await new Promise((r) => setTimeout(r, 80));
      expect(runs.started).toBe(1);
    } finally { scheduler.stop(); await agent.stop(); }
  });

  it("records a stopped recurring run as interrupted and waits for its next slot; the next run is its own outcome", async () => {
    const { agent, path, store } = await setup();
    const job = store.add({ name: "digest", schedule: { kind: "every", everyMs: 60 * 60_000 }, message: "summarise", sessionKey: "telegram:12345" });
    makeDue(path, job.id);
    const runs = hangingRuns();
    const scheduler = new CronScheduler(agent, new CronStore(path));
    scheduler.start();
    try {
      await waitFor(() => expect(runs.started).toBe(1));
      await agent.stopTurn(runningKey());
      runs.release("too late");
      await waitFor(() => expect(new CronStore(path).get(job.id)?.lastStatus).toBe("interrupted"));
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
    const { agent, path, store } = await setup();
    const job = store.add({ name: "tidy", schedule: { kind: "at", at: soon() }, message: "compact and tidy up", sessionKey: "telegram:12345" });
    await elapse();
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
      await waitFor(() => expect(new CronStore(path).get(job.id)?.lastStatus).toBe("interrupted"));
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
