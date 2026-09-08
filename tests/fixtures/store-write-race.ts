/**
 * Child-process half of the store contention tests. Loads a store, waits on a
 * shared time barrier, makes ONE edit, and prints a JSON line. Run via tsx.
 *
 *   tsx tests/fixtures/store-write-race.ts cron|sessions <path> <index> <startAtEpochMs>
 *
 * The store is constructed BEFORE the barrier on purpose: every racer then
 * holds a snapshot that predates the others' writes, which is exactly the
 * read-modify-write the advisory lock has to serialise. It cannot be staged
 * inside one process — every store API here is synchronous, so an in-process
 * "race" is always serialised by the interpreter.
 */
import { CronStore } from "../../src/cron/store.js";
import { SessionStore } from "../../src/sessions/store.js";
import { join } from "node:path";

const [mode, path, index, startAt] = process.argv.slice(2);
const i = Number(index);

const cron = mode === "cron" ? new CronStore(path) : null;
const sessions = mode === "sessions" ? new SessionStore(path, 20, join(path, "sdk")) : null;
const key = `telegram:${i}`;

// Spin, not sleep: setTimeout granularity is worse than the window under test.
const target = Number(startAt);
while (Date.now() < target) { /* busy-wait */ }

let error: string | null = null;
try {
  if (cron) {
    cron.add({
      name: `job-${i}`,
      schedule: { kind: "every", everyMs: 3_600_000 },
      message: `m-${i}`,
      sessionKey: key,
    });
  } else {
    sessions!.setChatTitle(key, `Title ${i}`);
  }
} catch (err) {
  error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

process.stdout.write(JSON.stringify({ pid: process.pid, index: i, error }) + "\n");
