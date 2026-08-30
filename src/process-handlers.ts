import { inspect } from "node:util";
import { log } from "./logger.js";

/**
 * Stable, greppable tokens. They are in the log MESSAGE (not only a structured
 * field) so `grep TOMO_UNCAUGHT_EXCEPTION ~/.tomo/logs/*` works across the pino
 * JSON file, the pretty-printed console, `tomo logs`, and the raw stderr line
 * the exception handler writes. Do not reword them.
 */
export const UNHANDLED_REJECTION_MARKER = "TOMO_UNHANDLED_REJECTION";
export const UNCAUGHT_EXCEPTION_MARKER = "TOMO_UNCAUGHT_EXCEPTION";

/** Rejections logged in full per window before the handler starts summarising. */
export const REJECTION_LOG_BURST = 5;
/** Rate-limit window, and the interval at which a summary line is emitted. */
export const REJECTION_LOG_WINDOW_MS = 60_000;

/** The two pino levels these handlers use. Structural, so `log` satisfies it. */
export interface ErrorLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  fatal: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ProcessErrorHandlerOptions {
  logger?: ErrorLogger;
  /**
   * Last-ditch salvage before an uncaught exception exits. MUST be
   * synchronous, bounded and local — see the note on the exception path below.
   */
  beforeExit?: () => void;
  /** Injected for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Injected for tests. Defaults to `process.stderr.write`. */
  writeStderr?: (line: string) => void;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  target?: NodeJS.EventEmitter;
}

/**
 * Handlers currently installed by this module, so a second install replaces
 * rather than stacks. The daemon installs twice on purpose: once bare at the
 * very top of startup, then again with pino once the logger exists.
 */
let uninstallCurrent: (() => void) | null = null;

/**
 * A console-only variant for the window before the logger module is loaded.
 * An exception during config parsing or a module-level throw in `agent.ts`
 * happens before pino exists, and dying there with Node's default output and
 * no marker is exactly the gap this module is meant to close.
 */
export function installBootstrapErrorHandlers(): () => void {
  return installProcessErrorHandlers({
    logger: {
      error: (obj, msg) => console.error(msg, obj.err),
      fatal: (obj, msg) => console.error(msg, obj.err),
    },
  });
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
 * `tomo_issues_total{level="error"}` and shows in the watch TUI — the metric,
 * without a new counter to wire through the protocol.
 *
 * That fan-out is also why the rejection path is RATE LIMITED. A rejecting
 * promise inside a hot loop (a channel retry, a per-tick send) fires as fast as
 * the loop runs; unthrottled, each one writes a log line, publishes a watch
 * event to every connected `tomo watch` client and bumps a counter. The failure
 * mode being survived would then be replaced by a log-and-socket storm. First
 * {@link REJECTION_LOG_BURST} per {@link REJECTION_LOG_WINDOW_MS} are logged in
 * full; after that one summary line per window reports how many were
 * suppressed, so the count is never silently lost.
 *
 * **`uncaughtException` -> log, then exit non-zero.** Here the process state
 * genuinely is undefined: the throw unwound an arbitrary stack, so a registry
 * write may be half-applied, a channel half-handshaked, a lock held by nobody.
 * Continuing risks corrupting durable state, which is strictly worse than
 * downtime. Exiting non-zero is also the only way launchd `KeepAlive` sees a
 * failure and restarts us into a clean process.
 *
 * Note that a DETERMINISTIC uncaught exception therefore becomes a restart
 * loop. That is intended — the alternative is a wedged daemon nobody notices —
 * but it is bounded by `ThrottleInterval` in the LaunchAgent plist (30s; see
 * service.ts, added on the `review/pidfile-early` branch), not by launchd's
 * 10s default.
 *
 * Returns an uninstall function (used by tests; the daemon never uninstalls).
 */
export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions = {}): () => void {
  // Idempotent by replacement: installing twice must not stack two handlers on
  // the same event, which would double-log and, worse, call `exit` twice.
  uninstallCurrent?.();

  const logger = options.logger ?? log;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeStderr = options.writeStderr ?? ((line: string) => { process.stderr.write(line); });
  const now = options.now ?? Date.now;
  const target = options.target ?? process;

  let windowStart = now();
  let windowCount = 0;

  const onRejection = (reason: unknown) => {
    const elapsed = now() - windowStart;
    if (elapsed >= REJECTION_LOG_WINDOW_MS) {
      const suppressed = windowCount - REJECTION_LOG_BURST;
      if (suppressed > 0) {
        logger.error(
          { marker: UNHANDLED_REJECTION_MARKER, suppressed, windowMs: REJECTION_LOG_WINDOW_MS },
          `${UNHANDLED_REJECTION_MARKER}: ${suppressed} further unhandled rejections suppressed in the last ${REJECTION_LOG_WINDOW_MS / 1000}s`,
        );
      }
      windowStart = now();
      windowCount = 0;
    }

    windowCount++;
    if (windowCount > REJECTION_LOG_BURST) return;

    // A rejection reason is NOT necessarily an Error. `String(reason)` renders
    // the common object case as "[object Object]", discarding the only
    // diagnostic there is; `inspect` keeps the shape, and the raw value is kept
    // in the structured field for anything reading the JSON.
    const err = reason instanceof Error ? reason : new Error(describeReason(reason));
    logger.error(
      { err, reason, marker: UNHANDLED_REJECTION_MARKER },
      `${UNHANDLED_REJECTION_MARKER}: unhandled promise rejection; daemon continuing`,
    );
  };

  // Latch: a throw inside the handler (or a second exception raised while we
  // are on our way out) must not re-enter and loop.
  let exiting = false;
  const onException = (err: unknown, origin?: string) => {
    if (exiting) return;
    exiting = true;
    const error = err instanceof Error ? err : new Error(describeReason(err));
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

    // ONE salvage step before we go: record the inbound messages this daemon
    // accepted and will now never answer. It is a synchronous append to the
    // local transcript, and it is the property #294 exists to protect — a
    // crash must not turn a received message into a silent non-answer. It is
    // emphatically not a shutdown: nothing here awaits, touches the network,
    // or trusts a channel handshake, because the state that produced the throw
    // is untrustworthy by definition.
    if (options.beforeExit) {
      const startedAt = now();
      try {
        options.beforeExit();
      } catch (salvageErr) {
        try {
          writeStderr(`${UNCAUGHT_EXCEPTION_MARKER} salvage failed: ${String(salvageErr)}\n`);
        } catch { /* stderr closed */ }
      }
      // Synchronous work cannot be preempted, so this is a report, not a cap:
      // if it ever trips, the salvage hook has grown something it should not
      // have and belongs back in the ordinary shutdown path.
      const elapsed = now() - startedAt;
      if (elapsed > 1_000) {
        try {
          writeStderr(`${UNCAUGHT_EXCEPTION_MARKER} salvage took ${elapsed}ms (expected <1000ms)\n`);
        } catch { /* stderr closed */ }
      }
    }

    exit(1);
  };

  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);

  const uninstall = () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}

/** Render any rejection reason usefully — objects included. */
function describeReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  return inspect(reason, { depth: 3, breakLength: Infinity });
}
