/**
 * Child-process half of the maintenance-lock tests: take the lock at <path>
 * (waiting up to <waitMs>), print "held" or "busy", then hold it for <holdMs>
 * (or until killed, with "forever") and exit without releasing it by hand.
 *
 *   node --expose-gc --import tsx tests/fixtures/hold-maintenance-lock.ts <path> <waitMs> <holdMs|forever>
 */
import { acquireMaintenanceLock } from "../../src/db/lock.js";

const [path, waitMs, holdMs] = process.argv.slice(2);
// The lock is deliberately not kept in a variable anything reads: holding it
// must not depend on the caller keeping a reference (run with --expose-gc,
// the timer below collects garbage while it holds).
process.stdout.write(`${acquireMaintenanceLock(path, { waitMs: Number(waitMs) }) ? "held" : "busy"}\n`);
const gc = (globalThis as { gc?: () => void }).gc;
if (gc) setInterval(gc, 50);
{
  if (holdMs === "forever") setInterval(() => {}, 60_000);
  else setTimeout(() => process.exit(0), Number(holdMs));
}
