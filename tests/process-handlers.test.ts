import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  installProcessErrorHandlers,
  UNHANDLED_REJECTION_MARKER,
  UNCAUGHT_EXCEPTION_MARKER,
  REJECTION_LOG_BURST,
  REJECTION_LOG_WINDOW_MS,
  raiseFatal,
} from "../src/process-handlers.js";

describe("installProcessErrorHandlers", () => {
  let target: EventEmitter;
  let logger: { error: ReturnType<typeof vi.fn>; fatal: ReturnType<typeof vi.fn> };
  let exit: ReturnType<typeof vi.fn>;
  let stderr: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    target = new EventEmitter();
    logger = { error: vi.fn(), fatal: vi.fn() };
    exit = vi.fn();
    stderr = vi.fn();
    uninstall = installProcessErrorHandlers({ target, logger, exit, writeStderr: stderr });
  });

  afterEach(() => uninstall());

  it("logs an unhandled rejection with the stable marker and does NOT exit", () => {
    const err = new Error("boom");
    target.emit("unhandledRejection", err, Promise.resolve());

    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.error.mock.calls[0];
    expect(obj.err).toBe(err);                       // full error, not a string
    expect(obj.marker).toBe(UNHANDLED_REJECTION_MARKER);
    expect(msg).toContain(UNHANDLED_REJECTION_MARKER); // greppable in the message too
  });

  it("wraps a non-Error rejection reason so the log still carries a stack", () => {
    target.emit("unhandledRejection", "just a string", Promise.resolve());
    const [obj] = logger.error.mock.calls[0];
    expect(obj.err).toBeInstanceOf(Error);
    expect((obj.err as Error).message).toBe("just a string");
  });

  it("survives repeated rejections", () => {
    for (let i = 0; i < REJECTION_LOG_BURST; i++) {
      target.emit("unhandledRejection", new Error(`r${i}`), Promise.resolve());
    }
    expect(logger.error).toHaveBeenCalledTimes(REJECTION_LOG_BURST);
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps a non-Error reason inspectable instead of \"[object Object]\"", () => {
    const reason = { code: "ECONNRESET", detail: { host: "api.telegram.org", attempt: 3 } };
    target.emit("unhandledRejection", reason, Promise.resolve());

    const [obj, ] = logger.error.mock.calls[0];
    // The raw value survives for anything reading the structured JSON…
    expect(obj.reason).toBe(reason);
    // …and the rendered message is diagnostic, not "[object Object]".
    const message = (obj.err as Error).message;
    expect(message).not.toContain("[object Object]");
    expect(message).toContain("ECONNRESET");
    expect(message).toContain("api.telegram.org");
  });

  it("logs an uncaught exception and exits non-zero", () => {
    const err = new Error("fatal boom");
    target.emit("uncaughtException", err, "uncaughtException");

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.fatal.mock.calls[0];
    expect(obj.err).toBe(err);
    expect(obj.marker).toBe(UNCAUGHT_EXCEPTION_MARKER);
    expect(msg).toContain(UNCAUGHT_EXCEPTION_MARKER);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("writes the exception to stderr synchronously, before the async logger", () => {
    // pino's transport is a worker thread and process.exit does not wait for
    // it; stderr is launchd.err.log, so the crash is legible either way.
    target.emit("uncaughtException", new Error("fatal boom"), "uncaughtException");
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain(UNCAUGHT_EXCEPTION_MARKER);
    expect(line).toContain("fatal boom");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("does not re-enter when a second exception lands during the exit", () => {
    target.emit("uncaughtException", new Error("first"), "uncaughtException");
    target.emit("uncaughtException", new Error("second"), "uncaughtException");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
  });

  it("still exits when the logger itself throws", () => {
    logger.fatal.mockImplementation(() => { throw new Error("pino is gone"); });
    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("installing twice replaces rather than stacks", () => {
    // The daemon installs bare handlers at the top of startup and upgrades
    // them to pino a few lines later. Stacking would double-log and, worse,
    // call `exit` twice.
    const second = { error: vi.fn(), fatal: vi.fn() };
    const secondUninstall = installProcessErrorHandlers({ target, logger: second, exit, writeStderr: stderr });
    try {
      expect(target.listenerCount("unhandledRejection")).toBe(1);
      expect(target.listenerCount("uncaughtException")).toBe(1);

      target.emit("unhandledRejection", new Error("boom"), Promise.resolve());
      expect(logger.error).not.toHaveBeenCalled();
      expect(second.error).toHaveBeenCalledTimes(1);
    } finally {
      secondUninstall();
    }
  });

  it("uninstall removes both listeners", () => {
    uninstall();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });
});

describe("rejection log rate limiting", () => {
  // A rejecting promise inside a hot loop fires as fast as the loop runs, and
  // every log.error fans out to a watch event for every connected `tomo watch`
  // client plus a metric increment. Surviving the rejection must not mean
  // replacing it with a log-and-socket storm.
  let target: EventEmitter;
  let logger: { error: ReturnType<typeof vi.fn>; fatal: ReturnType<typeof vi.fn> };
  let clock: number;
  let uninstall: () => void;

  beforeEach(() => {
    target = new EventEmitter();
    logger = { error: vi.fn(), fatal: vi.fn() };
    clock = 1_000_000;
    uninstall = installProcessErrorHandlers({
      target, logger, exit: vi.fn(), writeStderr: vi.fn(), now: () => clock,
    });
  });
  afterEach(() => uninstall());

  const reject = (n: number) => {
    for (let i = 0; i < n; i++) target.emit("unhandledRejection", new Error(`r${i}`), Promise.resolve());
  };

  it("logs the first burst in full and then stops", () => {
    reject(500);
    expect(logger.error).toHaveBeenCalledTimes(REJECTION_LOG_BURST);
  });

  it("reports how many it suppressed, once the window rolls over", () => {
    reject(500);
    logger.error.mockClear();

    clock += REJECTION_LOG_WINDOW_MS;
    reject(1);

    // One summary line naming the exact count, then the new window's first
    // full line. Nothing is silently lost.
    expect(logger.error).toHaveBeenCalledTimes(2);
    const [summary, summaryMsg] = logger.error.mock.calls[0];
    expect(summary.suppressed).toBe(500 - REJECTION_LOG_BURST);
    expect(summaryMsg).toContain(UNHANDLED_REJECTION_MARKER);
    expect(summaryMsg).toContain(String(500 - REJECTION_LOG_BURST));
  });

  it("reports the suppressed count when the window ends QUIETLY, via the timer", () => {
    // A burst that then stops: no later rejection ever arrives to trigger
    // the rollover summary, so the count would be lost without the timer.
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    uninstall();
    uninstall = installProcessErrorHandlers({
      target, logger, exit: vi.fn(), writeStderr: vi.fn(), now: () => clock,
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
    });
    reject(500);
    logger.error.mockClear();
    expect(scheduled).toHaveLength(1);              // armed once, on the first suppressed one
    expect(scheduled[0].ms).toBe(REJECTION_LOG_WINDOW_MS);

    clock += REJECTION_LOG_WINDOW_MS;
    scheduled[0].fn();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0].suppressed).toBe(500 - REJECTION_LOG_BURST);

    // The window was closed by the timer; the next rejection must not report
    // the same 495 again, and the next burst arms a fresh timer.
    logger.error.mockClear();
    reject(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0].suppressed).toBeUndefined();
    reject(REJECTION_LOG_BURST);
    expect(scheduled).toHaveLength(2);
  });

  it("a timer that fires early, or after uninstall, reports nothing", () => {
    const scheduled: Array<() => void> = [];
    uninstall();
    uninstall = installProcessErrorHandlers({
      target, logger, exit: vi.fn(), writeStderr: vi.fn(), now: () => clock,
      schedule: (fn) => scheduled.push(fn),
    });
    reject(500);
    logger.error.mockClear();
    scheduled[0]();                                  // clock has not advanced
    expect(logger.error).not.toHaveBeenCalled();
    uninstall();
    clock += REJECTION_LOG_WINDOW_MS;
    scheduled[0]();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("emits no summary when the window was never exceeded", () => {
    reject(REJECTION_LOG_BURST);
    logger.error.mockClear();
    clock += REJECTION_LOG_WINDOW_MS;
    reject(1);
    expect(logger.error).toHaveBeenCalledTimes(1);      // just the new one
    expect(logger.error.mock.calls[0][0].suppressed).toBeUndefined();
  });

  it("never rate-limits the exception path", () => {
    // One exception is all there can be; the latch handles the rest.
    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    expect(logger.fatal).toHaveBeenCalledTimes(1);
  });
});

describe("crash-path inbound salvage", () => {
  let target: EventEmitter;
  let exit: ReturnType<typeof vi.fn>;
  let stderr: ReturnType<typeof vi.fn>;
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    target = new EventEmitter();
    exit = vi.fn();
    stderr = vi.fn();
  });
  afterEach(() => uninstall?.());

  const install = (beforeExit: () => void, now?: () => number) => {
    uninstall = installProcessErrorHandlers({
      target, exit, writeStderr: stderr, now,
      logger: { error: vi.fn(), fatal: vi.fn() },
      beforeExit,
    });
  };

  it("runs the salvage hook before exiting", () => {
    const order: string[] = [];
    install(() => order.push("salvage"));
    exit.mockImplementation(() => order.push("exit"));

    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    // #294: a crash must not turn an already-received message into a silent
    // non-answer, so the transcript append happens before we go.
    expect(order).toEqual(["salvage", "exit"]);
  });

  it("exits anyway when the salvage hook throws", () => {
    install(() => { throw new Error("registry is unwritable"); });
    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.some(([l]) => String(l).includes("salvage failed"))).toBe(true);
  });

  it("reports a salvage hook that overruns its 1s expectation", () => {
    let clock = 0;
    install(() => { clock += 2_500; }, () => clock);
    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    // Synchronous work cannot be preempted, so this is a report rather than a
    // cap — it exists to catch the hook growing something that belongs in the
    // ordinary shutdown path.
    expect(stderr.mock.calls.some(([l]) => String(l).includes("salvage took 2500ms"))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is optional — no hook, still exits", () => {
    uninstall = installProcessErrorHandlers({
      target, exit, writeStderr: stderr, logger: { error: vi.fn(), fatal: vi.fn() },
    });
    target.emit("uncaughtException", new Error("boom"), "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("hostile values and caught-but-fatal errors", () => {
  let target: EventEmitter;
  let uninstall: (() => void) | null = null;
  afterEach(() => uninstall?.());

  const hostile = { [inspect.custom]() { throw new Error("inspect is a trap"); } };

  it("a reason whose util.inspect.custom throws is logged, and the daemon continues", () => {
    target = new EventEmitter();
    const logger = { error: vi.fn(), fatal: vi.fn() };
    const exit = vi.fn();
    uninstall = installProcessErrorHandlers({ target, logger, exit, writeStderr: vi.fn() });
    expect(() => target.emit("unhandledRejection", hostile, Promise.resolve())).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0].err.message).toContain("unrenderable");
    expect(exit).not.toHaveBeenCalled();
  });

  it("the same value as an uncaught exception still salvages and exits (the exit hook must run)", () => {
    target = new EventEmitter();
    const exit = vi.fn();
    const stderr = vi.fn();
    const salvage = vi.fn(() => { throw hostile; });
    uninstall = installProcessErrorHandlers({ target, logger: { error: vi.fn(), fatal: vi.fn() }, exit, writeStderr: stderr, beforeExit: salvage });
    expect(() => target.emit("uncaughtException", hostile, "uncaughtException")).not.toThrow();
    expect(salvage).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.map((c) => c[0]).join("")).toContain("salvage failed");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("raiseFatal goes through the installed exception path: marker, salvage, exit 1", () => {
    target = new EventEmitter();
    const exit = vi.fn();
    const stderr = vi.fn();
    const salvage = vi.fn();
    const logger = { error: vi.fn(), fatal: vi.fn() };
    uninstall = installProcessErrorHandlers({ target, logger, exit, writeStderr: stderr, beforeExit: salvage });
    raiseFatal(new Error("agent.start() failed"), "startup");
    expect(stderr.mock.calls[0][0]).toContain(`${UNCAUGHT_EXCEPTION_MARKER} origin=startup`);
    expect(stderr.mock.calls[0][0]).toContain("agent.start() failed");
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(salvage).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // Not the rejection path: nothing was "survived".
    expect(logger.error).not.toHaveBeenCalled();
  });
});

const FIXTURE = fileURLToPath(new URL("./fixtures/process-handlers-child.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function runChild(mode: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(TSX, [FIXTURE, mode], (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number"
        ? (err as unknown as { code: number }).code
        : (err ? 1 : 0);
      if (err && !stdout && !stderr) return reject(err);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * The behaviour under test is "does the process die?", which no in-process
 * test can answer — Node's default action for an unhandled rejection is to
 * terminate the very process running the assertions. So: real children, one
 * with the handlers installed and one without (i.e. main).
 */
describe("synthetic rejection and exception in a real process", () => {
  it("kills a daemon WITHOUT the handlers (the bug)", { timeout: 60_000 }, async () => {
    const { code, stdout } = await runChild("rejection-bare");
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("ALIVE");
  });

  it("survives a synthetic unhandled rejection WITH the handlers", { timeout: 60_000 }, async () => {
    const { code, stdout } = await runChild("rejection");
    expect(stdout).toContain(`marker=${UNHANDLED_REJECTION_MARKER}`);
    expect(stdout).toContain("ALIVE");   // the daemon is still serving
    expect(code).toBe(0);
  });

  it("survives a non-Error rejection reason and still says something useful", async () => {
    const { code, stdout } = await runChild("rejection-object");
    expect(code).toBe(0);
    expect(stdout).toContain("ALIVE");
    expect(stdout).toContain("ECONNRESET");
    expect(stdout).not.toContain("[object Object]");
  }, 60_000);

  it("a startup rejection nobody awaits is SURVIVED by the handlers — the half-started daemon", { timeout: 60_000 }, async () => {
    // This is what `cli.ts`'s sync parse() + an async start action produce
    // if the command does not catch: the failure is logged as a stray
    // rejection and the process lives on.
    const { code, stdout } = await runChild("startup-swallowed");
    expect(stdout).toContain(`marker=${UNHANDLED_REJECTION_MARKER}`);
    expect(stdout).toContain("ALIVE");
    expect(code).toBe(0);
  });

  it("the start command routes its failure through raiseFatal: exit 1, origin=startup", { timeout: 60_000 }, async () => {
    const { code, stdout, stderr } = await runChild("startup-fatal");
    expect(code).toBe(1);
    expect(stdout).not.toContain("ALIVE");
    expect(stderr).toContain(`${UNCAUGHT_EXCEPTION_MARKER} origin=startup`);
    expect(stderr).toContain("Full Disk Access");
  });

  it("exits non-zero on a synthetic uncaught exception, with the marker on stderr", { timeout: 60_000 }, async () => {
    const { code, stdout, stderr } = await runChild("exception");
    expect(code).toBe(1);                // launchd KeepAlive sees a failure
    expect(stdout).not.toContain("ALIVE");
    expect(stdout).toContain(`marker=${UNCAUGHT_EXCEPTION_MARKER}`);
    expect(stderr).toContain(UNCAUGHT_EXCEPTION_MARKER);
    expect(stderr).toContain("synthetic uncaught exception");
  });

  it("exits non-zero without the handlers too, but says nothing greppable", { timeout: 60_000 }, async () => {
    const { code, stderr } = await runChild("exception-bare");
    expect(code).not.toBe(0);
    expect(stderr).not.toContain(UNCAUGHT_EXCEPTION_MARKER);
  });
});
