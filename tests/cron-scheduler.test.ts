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

/** Force every job in the store file to be due now. */
function makeAllJobsDue(): void {
  const raw = JSON.parse(readFileSync(TEST_PATH, "utf-8"));
  for (const job of raw.jobs) job.nextRunAt = Date.now() - 1000;
  writeFileSync(TEST_PATH, JSON.stringify(raw));
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
    makeAllJobsDue();

    // Fake agent whose cron turns only finish when the test releases them —
    // simulates a slow agent turn (these can take minutes for real).
    const inFlight: Array<{ key: string; resolve: () => void }> = [];
    const fakeAgent = {
      handleCronMessage: vi.fn(
        (_msg: string, key: string) =>
          new Promise<void>((resolve) => inFlight.push({ key, resolve })),
      ),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    const tick = (scheduler as unknown as { tick(): Promise<void> }).tick();

    // Both jobs must be dispatched while NEITHER has completed. The old
    // serial loop would hold job-b hostage until job-a's turn resolved.
    await waitFor(() => expect(inFlight).toHaveLength(2));
    expect(inFlight.map((c) => c.key).sort()).toEqual(["dm:alice", "dm:bob"]);

    for (const c of inFlight) c.resolve();
    await tick;

    // Both runs were recorded and rescheduled.
    for (const job of store.list()) {
      expect(job.lastStatus).toBe("ok");
      expect(job.nextRunAt).toBeGreaterThan(Date.now());
    }
  });

  it("records a failed run without disturbing the other job", async () => {
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
    makeAllJobsDue();

    const fakeAgent = {
      handleCronMessage: vi.fn((msg: string) =>
        msg.includes("fail") ? Promise.reject(new Error("turn failed")) : Promise.resolve(),
      ),
    } as unknown as Agent;

    const scheduler = new CronScheduler(fakeAgent, store);
    await (scheduler as unknown as { tick(): Promise<void> }).tick();

    const jobs = store.list();
    expect(jobs.find((j) => j.name === "job-ok")?.lastStatus).toBe("ok");
    expect(jobs.find((j) => j.name === "job-fail")?.lastStatus).toBe("error");
  });
});
