/**
 * Child-process half of the process-handler tests. Run via tsx:
 *
 *   tsx tests/fixtures/process-handlers-child.ts <mode>
 *
 * Modes:
 *   rejection             handlers installed, then a synthetic unhandled rejection
 *   rejection-bare        NO handlers (i.e. main), same synthetic rejection
 *   exception             handlers installed, then a synthetic uncaught throw
 *   exception-bare        NO handlers, same synthetic throw
 *
 * Every mode prints `ALIVE` and exits 0 after 400ms IF it survives. Whether
 * that line appears is the entire test: it cannot be observed in-process,
 * because Node's default unhandled-rejection behaviour is to terminate.
 */
import { installProcessErrorHandlers } from "../../src/process-handlers.js";

const mode = process.argv[2];

if (!mode.endsWith("-bare")) {
  installProcessErrorHandlers({
    // A synchronous stdout logger: pino's real transport is a worker thread
    // whose output can be lost when the process exits, and this test is about
    // process semantics, not pino.
    logger: {
      error: (obj, msg) => process.stdout.write(`ERROR ${msg} marker=${String(obj.marker)}\n`),
      fatal: (obj, msg) => process.stdout.write(`FATAL ${msg} marker=${String(obj.marker)}\n`),
    },
  });
}

if (mode.startsWith("exception")) {
  // Outside any try/catch and off the main tick — the shape a real daemon
  // crash takes (a throw inside a setInterval callback, e.g. PetScheduler).
  setTimeout(() => { throw new Error("synthetic uncaught exception"); }, 20);
} else {
  // A floating rejected promise: nobody awaits it, nobody attaches a catch.
  void Promise.reject(new Error("synthetic unhandled rejection"));
}

setTimeout(() => {
  process.stdout.write("ALIVE\n");
  process.exit(0);
}, 400);
