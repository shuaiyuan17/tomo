import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    workspaceDir: "/tmp/tomo-mock-runner",
    sdkSessionsDir: "/tmp/tomo-mock-runner/sessions",
    lcm: { groupCompactStyle: "lcm" },
  },
}));

const { VersionChecker } = await import("../src/version.js");
const { RollupRunner } = await import("../src/lcm/runner.js");

/**
 * Both background runners arm TWO timers in start(): a one-shot initial-delay
 * check and the recurring interval. stop() used to clear only the interval, so
 * the initial check survived teardown — it fired against a runner the daemon
 * had already stopped, and until it fired it held the event loop open.
 *
 * Asserted as a DELTA rather than an absolute count: pino lazily arms its own
 * timer on the first log call, which start() makes, so an absolute
 * `getTimerCount() === 0` would be measuring the logger as much as the runner.
 */
describe("background runners release their timers on stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // RollupRunner.checkAll() short-circuits outside 08:00-22:00 local, so pin
    // the clock into the daytime window or the test passes for the wrong reason.
    vi.setSystemTime(new Date(2026, 7, 30, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("VersionChecker.stop() clears the initial-delay check as well as the interval", () => {
    const checker = new VersionChecker({ sendNotification: vi.fn() } as never);
    checker.start();
    const armed = vi.getTimerCount();
    checker.stop();
    expect(vi.getTimerCount()).toBe(armed - 2);
  });

  it("RollupRunner.stop() clears the initial-delay check as well as the interval", () => {
    const runner = new RollupRunner({ listActiveSessions: vi.fn(() => []) } as never);
    runner.start();
    const armed = vi.getTimerCount();
    runner.stop();
    expect(vi.getTimerCount()).toBe(armed - 2);
  });

  it("a stopped RollupRunner never runs its initial check", async () => {
    const listActiveSessions = vi.fn(() => []);
    const runner = new RollupRunner({ listActiveSessions } as never);
    runner.start();
    runner.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listActiveSessions).not.toHaveBeenCalled();
  });

  it("a RollupRunner tick whose session lookup throws is contained", async () => {
    // checkAll()'s per-session body is guarded, but listActiveSessions() (a
    // disk read) sits outside the try. Unawaited and uncaught, that rejection
    // reaches the process as an unhandled rejection, which Node turns into an
    // exit — the daemon dies because the session registry was briefly
    // unreadable. Captured here at the process level because that is exactly
    // the surface that kills the daemon.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const runner = new RollupRunner({
        listActiveSessions: vi.fn(() => { throw new Error("registry unreadable"); }),
      } as never);
      runner.start();
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      runner.stop();
      // Let Node's rejection bookkeeping run.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
