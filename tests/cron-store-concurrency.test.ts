import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A one-shot hook that fires inside the store's atomic write — after the
 * merge it computed from its read of the file, before the rename that
 * publishes it. That is the window an optimistic save has to defend: another
 * process publishing here would otherwise be silently overwritten.
 */
const hook = { beforeWrite: null as null | (() => void) };

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

const { CronStore, isInterrupted } = await import("../src/cron/store.js");

const TEST_DIR = join(tmpdir(), "tomo-test-cron-concurrency");
const TEST_PATH = join(TEST_DIR, "jobs.json");

function revision(): number {
  return JSON.parse(readFileSync(TEST_PATH, "utf-8")).revision;
}

describe("CronStore optimistic saves", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    hook.beforeWrite = null;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    hook.beforeWrite = null;
  });

  function seed() {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "quiet-hours",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    return { store, job };
  }

  it("bumps a monotonic revision on every write", () => {
    const { store, job } = seed();
    expect(revision()).toBe(1);
    store.markStarted(job.id);
    expect(revision()).toBe(2);
    store.markRun(job.id, "ok");
    expect(revision()).toBe(3);
  });

  it("re-merges when another process publishes between the read and the rename", () => {
    const { store: daemon, job } = seed();
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
    const { store: daemon, job } = seed();
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
});
