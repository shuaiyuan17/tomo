import { vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openTomoDb } from "../../src/db/index.js";
import { legacyCronJobsPath } from "../../src/cron/store.js";
import type { Agent } from "../../src/agent.js";
import type { CronScheduler } from "../../src/cron/scheduler.js";
import { parseTomoEvent } from "../../src/tomo-event.js";

/**
 * Shared fixtures for the cron tests: raw edits of the `cron_jobs` rows (as
 * another process, or a daemon that has been down a while, would leave them),
 * the scheduler's private tick, and an agent that stands in for a killed daemon.
 */

/** A job record as it sits in a `cron_jobs` row — loose on purpose: tests write what they need. */
export type RawJob = Record<string, unknown> & { id: string; name: string };

/**
 * Edit the jobs in the database at `dbPath` directly, bypassing the store —
 * what another process or an older version would leave. `fn` mutates the
 * parsed records in place (jobs it adds or removes are ignored).
 */
export function editJobs(dbPath: string, fn: (jobs: RawJob[]) => void): void {
  const db = openTomoDb(dbPath);
  try {
    db.transaction(() => {
      const jobs = db.all<{ job: string }>("SELECT job FROM cron_jobs ORDER BY seq").map((r) => JSON.parse(r.job) as RawJob);
      fn(jobs);
      for (const job of jobs) db.run("UPDATE cron_jobs SET job = ? WHERE id = ?", JSON.stringify(job), job.id);
    });
  } finally {
    db.close();
  }
}

/** Make the named jobs (every job when no name is given) due a second ago. */
export function makeJobsDue(path: string, ...names: string[]): void {
  editJobs(path, (jobs) => {
    for (const job of jobs) {
      if (names.length === 0 || names.includes(job.name)) job.nextRunAt = Date.now() - 1_000;
    }
  });
}

/** One scheduler poll, awaited (recovery, staleness, owner report, due-scan). */
export function tick(scheduler: CronScheduler): Promise<void> {
  return (scheduler as unknown as { tick(): Promise<void> }).tick();
}

/**
 * One poll that must SETTLE within `ms`. For a test whose point is that the
 * scan was gated: a scan that ran anyway dispatches a hanging turn, and a
 * plain `await tick()` would then sit until vitest's 5s timeout instead of
 * failing with a message that says what happened.
 */
export async function tickSettles(scheduler: CronScheduler, ms = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tick did not settle within ${ms}ms: the due-scan ran and dispatched a turn`)), ms);
  });
  try {
    await Promise.race([tick(scheduler), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An agent whose cron turns never settle — stands in for a daemon killed
 * mid-turn. Records every cron message it was handed and every owner DM.
 */
export function hangingAgent(): { agent: Agent; calls: string[]; notices: string[] } {
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

/** The bodies of recorded cron messages, envelope stripped. */
export function cronBodies(calls: string[]): string[] {
  return calls.map((msg) => parseTomoEvent(msg)!.body);
}

/**
 * Poll an assertion until it passes — vi.waitFor at a 1ms interval, since the
 * scheduler settles within a few event-loop turns and the default 50ms
 * interval would dominate these tests' run time.
 */
export function waitFor(assertion: () => void, timeout = 500): Promise<void> {
  return vi.waitFor(assertion, { timeout, interval: 1 });
}

/**
 * Make the store at `dbPath` unreadable the way it can be in production: an
 * old jobs file that will not parse, in the way of the database (every store
 * call refuses until it is gone). `repairStore` takes it away again.
 */
export function breakStore(dbPath: string, contents = "{ this is not json"): string {
  const file = legacyCronJobsPath(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

export function repairStore(dbPath: string): void {
  rmSync(legacyCronJobsPath(dbPath), { force: true });
}
