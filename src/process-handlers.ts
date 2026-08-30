import { log } from "./logger.js";

/**
 * Stable, greppable tokens. They are in the log MESSAGE (not only a structured
 * field) so `grep TOMO_UNCAUGHT_EXCEPTION ~/.tomo/logs/*` works across the pino
 * JSON file, the pretty-printed console, `tomo logs`, and the raw stderr line
 * the exception handler writes. Do not reword them.
 */
export const UNHANDLED_REJECTION_MARKER = "TOMO_UNHANDLED_REJECTION";
export const UNCAUGHT_EXCEPTION_MARKER = "TOMO_UNCAUGHT_EXCEPTION";

/** The two pino levels these handlers use. Structural, so `log` satisfies it. */
export interface ErrorLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  fatal: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ProcessErrorHandlerOptions {
  logger?: ErrorLogger;
  /** Injected for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Injected for tests. Defaults to `process.stderr.write`. */
  writeStderr?: (line: string) => void;
  target?: NodeJS.EventEmitter;
}

/**
 * Install the daemon's last-resort error handlers.
 *
 * Before this, `grep -rn "unhandledRejection\|uncaughtException" src/` returned
 * nothing: the only `process.on` calls were the two signal handlers. Node >= 15
 * terminates the process on an unhandled rejection, and because `shutdown()` is
 * wired only to SIGINT/SIGTERM, none of the cleanup ran — stale pid file,
 * orphaned `imsg rpc` child, metrics port and watch socket held until the OS
 * reaped them.
 *
 * The two events get deliberately different treatment:
 *
 * **`unhandledRejection` -> log, do not exit.** Almost every rejection that
 * reaches here is one orphaned promise — a fire-and-forget send, a background
 * runner, a channel retry — and the rest of the daemon is intact. Killing it
 * costs every live session, both channels and the in-flight turn to salvage a
 * promise nobody was awaiting. The `log.error` also lands on the watch bus as
 * an `issue` event (see the `logMethod` hook in logger.ts), so it increments
 * `tomo_issues_total{level="error"}` and shows in the watch TUI — the metric
 * asked for, without a new counter to wire through the protocol.
 *
 * **`uncaughtException` -> log, then exit non-zero.** Here the process state
 * genuinely is undefined: the throw unwound an arbitrary stack, so a registry
 * write may be half-applied, a channel half-handshaked, a lock held by nobody.
 * Continuing risks corrupting durable state, which is strictly worse than
 * downtime. Exiting non-zero is also the only way launchd `KeepAlive` sees a
 * failure and restarts us into a clean process — which is exactly the recovery
 * we want and cannot get by soldiering on.
 *
 * Returns an uninstall function (used by tests; the daemon never uninstalls).
 */
export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions = {}): () => void {
  const logger = options.logger ?? log;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeStderr = options.writeStderr ?? ((line: string) => { process.stderr.write(line); });
  const target = options.target ?? process;

  const onRejection = (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(
      { err, marker: UNHANDLED_REJECTION_MARKER },
      `${UNHANDLED_REJECTION_MARKER}: unhandled promise rejection; daemon continuing`,
    );
  };

  // Latch: a throw inside the handler (or a second exception raised while we
  // are on our way out) must not re-enter and loop.
  let exiting = false;
  const onException = (err: unknown, origin?: string) => {
    if (exiting) return;
    exiting = true;
    const error = err instanceof Error ? err : new Error(String(err));
    // Synchronous and unbuffered, FIRST. pino's transport is a worker thread
    // and `process.exit` does not wait for it, so the structured line can be
    // lost — while stderr is `~/.tomo/logs/launchd.err.log` under launchd,
    // which is exactly where a crash should be legible.
    try {
      writeStderr(`${UNCAUGHT_EXCEPTION_MARKER} origin=${origin ?? "uncaughtException"} ${error.stack ?? error.message}\n`);
    } catch { /* stderr closed; nothing better to do */ }
    try {
      logger.fatal(
        { err: error, origin, marker: UNCAUGHT_EXCEPTION_MARKER },
        `${UNCAUGHT_EXCEPTION_MARKER}: uncaught exception; exiting non-zero so the supervisor restarts a clean process`,
      );
    } catch { /* logging must never be the reason we fail to exit */ }
    exit(1);
  };

  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);

  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}
