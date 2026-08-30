import { describe, it, expect, vi, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { performStop, type StopDeps } from "../src/cli/daemon.js";
import { isRunning, waitForExit } from "../src/cli/status-info.js";

/** Deps for a plain manual daemon that dies on SIGTERM, unless overridden. */
function deps(over: Partial<StopDeps> = {}): Partial<StopDeps> {
  return {
    autostartEnabled: () => false,
    stopLaunchd: async () => {},
    runningPid: () => 4242,
    alive: () => true,
    kill: () => {},
    wait: async () => true,
    timeoutMs: 200,
    ...over,
  };
}

describe("performStop", () => {
  it("reports not running when there is no pid", async () => {
    const kill = vi.fn();
    const out = await performStop(deps({ runningPid: () => null, kill }));
    expect(out.code).toBe(0);
    expect(out.message).toMatch(/not running/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("SIGTERMs the pid and reports success once it is gone", async () => {
    const kill = vi.fn();
    const out = await performStop(deps({ kill }));
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(out).toEqual({ code: 0, message: "Stopped Tomo (PID 4242)." });
  });

  it("fails non-zero with a kill -9 hint when the daemon outlives the timeout", async () => {
    // This is the regression: main sent SIGTERM and printed "Stopped Tomo"
    // unconditionally, so a wedged daemon was reported as stopped.
    const out = await performStop(deps({ wait: async () => false }));
    expect(out.code).toBe(1);
    expect(out.message).toMatch(/still running/);
    expect(out.message).toContain("kill -9 4242");
  });

  it("still checks the pid file when autostart is enabled", async () => {
    // The plist exists but the running daemon was started by hand, so the
    // launchd bootout reaches nothing. main returned right after the bootout
    // and printed success, leaving the manual daemon polling Telegram.
    const kill = vi.fn();
    const stopLaunchd = vi.fn(async () => {});
    const out = await performStop(deps({ autostartEnabled: () => true, stopLaunchd, kill }));
    expect(stopLaunchd).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(out.code).toBe(0);
    expect(out.message).toMatch(/restart at next login/);
  });

  it("reports failure when a wedged daemon survives an autostart stop", async () => {
    const out = await performStop(deps({ autostartEnabled: () => true, wait: async () => false }));
    expect(out.code).toBe(1);
    expect(out.message).toContain("kill -9 4242");
  });

  it("propagates a launchd bootout failure as a non-zero exit", async () => {
    const out = await performStop(deps({
      autostartEnabled: () => true,
      stopLaunchd: async () => { throw new Error("boom"); },
    }));
    expect(out).toEqual({ code: 1, message: "Failed to stop LaunchAgent: boom" });
  });

  it("does not signal a pid that already exited, but still confirms the exit", async () => {
    const kill = vi.fn();
    const out = await performStop(deps({ alive: () => false, kill }));
    expect(kill).not.toHaveBeenCalled();
    expect(out.code).toBe(0);
  });
});

/**
 * The interesting half of this fix is process semantics — a signal is
 * asynchronous, and "did it exit?" cannot be mocked into existence. These run
 * against real children with the real `isRunning`/`waitForExit`.
 */
describe("performStop against real child processes", () => {
  const children: ChildProcess[] = [];
  const realDeps = (pid: number): Partial<StopDeps> => ({
    autostartEnabled: () => false,
    stopLaunchd: async () => {},
    runningPid: () => pid,
    alive: isRunning,
    kill: (p, s) => { process.kill(p, s); },
    wait: (p, t) => waitForExit(p, t, 50),
    timeoutMs: 3_000,
  });

  function child(script: string): Promise<ChildProcess> {
    const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(c);
    // Wait for "ready" so the SIGTERM handler is installed before we signal.
    return new Promise((resolve) => c.stdout!.on("data", () => resolve(c)));
  }

  afterAll(() => {
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  });

  it("waits for a slow but cooperative daemon and reports success", async () => {
    // Exits ~700ms after SIGTERM, like a daemon finishing agent.stop().
    const c = await child(
      `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 700));`
      + `setInterval(() => {}, 1000); console.log("ready");`,
    );
    const out = await performStop(realDeps(c.pid!));
    expect(out).toEqual({ code: 0, message: `Stopped Tomo (PID ${c.pid}).` });
    expect(isRunning(c.pid!)).toBe(false);
  }, 20_000);

  it("reports failure for a daemon that ignores SIGTERM", async () => {
    // main printed "Stopped Tomo (PID n)" here and exited 0 while the daemon
    // kept running.
    const c = await child(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");`,
    );
    const out = await performStop(realDeps(c.pid!));
    expect(out.code).toBe(1);
    expect(out.message).toContain(`kill -9 ${c.pid}`);
    expect(isRunning(c.pid!)).toBe(true);
  }, 20_000);
});
