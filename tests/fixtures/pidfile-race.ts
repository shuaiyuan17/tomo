/**
 * Child-process half of the pid-file race test. Prints one JSON line
 * describing whether this process won the pid file. Run via tsx.
 *
 *   tsx tests/fixtures/pidfile-race.ts <pidFile> <startAtEpochMs>
 *
 * The start time is a shared barrier so every racer hits `acquirePidFile` in
 * the same millisecond — the whole point is to exercise the create/EEXIST
 * boundary concurrently, which cannot happen inside a single process because
 * the call is synchronous.
 */
import { acquirePidFile } from "../../src/cli/pidfile.js";

const [pidFile, startAt] = process.argv.slice(2);

// Spin (not sleep) up to the barrier: setTimeout granularity is worse than the
// window we are trying to hit.
const target = Number(startAt);
while (Date.now() < target) { /* busy-wait */ }

const result = acquirePidFile(pidFile);
process.stdout.write(JSON.stringify({ pid: process.pid, ...result }) + "\n");

// The winner must stay alive long enough for EVERY other racer to observe it
// as a live holder. A winner that exited first would leave a stale pid file,
// which a late-starting racer is then entitled to take over — a correct
// outcome for the code, but not the one this test is measuring.
if (result.ok) setTimeout(() => process.exit(0), 6_000);
