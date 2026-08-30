import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installProcessErrorHandlers,
  UNHANDLED_REJECTION_MARKER,
  UNCAUGHT_EXCEPTION_MARKER,
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
    for (let i = 0; i < 5; i++) target.emit("unhandledRejection", new Error(`r${i}`), Promise.resolve());
    expect(logger.error).toHaveBeenCalledTimes(5);
    expect(exit).not.toHaveBeenCalled();
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

  it("uninstall removes both listeners", () => {
    uninstall();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
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
