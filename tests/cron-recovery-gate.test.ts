import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronScheduler } from "../src/cron/scheduler.js";
import { CronStore } from "../src/cron/store.js";
import type { Agent } from "../src/agent.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// CronScheduler.tick: interrupted-run recovery is a precondition for the
// due-scan. The neighbouring test in cron-scheduler.test.ts makes the whole
// file unreadable, which also makes getDueJobs throw — so it cannot tell
// whether the scan was gated. Here only recovery fails; the store reads fine.

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-cron-recovery-gate-"));
  path = join(dir, "jobs.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tick(scheduler: CronScheduler): Promise<void> {
  return (scheduler as unknown as { tick(): Promise<void> }).tick();
}

function hangingAgent(): { agent: Agent; calls: string[] } {
  const calls: string[] = [];
  const agent = {
    handleCronMessage: vi.fn((msg: string) => { calls.push(msg); return new Promise<boolean>(() => {}); }),
    notifyOwner: vi.fn(async () => true),
  } as unknown as Agent;
  return { agent, calls };
}

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { assertion(); return; } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

describe("CronScheduler recovery gate", () => {
  it("skips the due-scan while recovery cannot persist, and never re-fires the interrupted run", async () => {
    const storeA = new CronStore(path);
    storeA.add({ name: "upgrade", schedule: { kind: "every", everyMs: 60_000 }, message: "Do the upgrade.", sessionKey: "dm:alice" });
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    for (const job of raw.jobs) job.nextRunAt = Date.now() - 1000;
    writeFileSync(path, JSON.stringify(raw));

    // Daemon 1 dispatches the run and dies mid-turn.
    const first = hangingAgent();
    void tick(new CronScheduler(first.agent, storeA));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    // Daemon 2: the file reads fine, but recovery cannot write (EROFS, say).
    const storeB = new CronStore(path);
    const recover = vi.spyOn(storeB, "recoverInterrupted").mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system");
    });
    const second = hangingAgent();
    const schedulerB = new CronScheduler(second.agent, storeB);

    // Not awaited: a scan that ran anyway would dispatch the hanging turn.
    void tick(schedulerB);
    await new Promise((r) => setTimeout(r, 20));
    expect(second.calls).toHaveLength(0);

    // Recovery succeeds on the next tick; the interrupted run is settled, not re-fired.
    await tick(schedulerB);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(second.calls).toHaveLength(0);
    expect(new CronStore(path).list()[0].lastStatus).toBe("interrupted");
  });
});
