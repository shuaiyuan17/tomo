import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { getRunningPid, getDaemonStatus, isRunning } from "../src/cli/status-info.js";

const TEST_DIR = join(tmpdir(), "tomo-test-status-info");
const PID_FILE = join(TEST_DIR, "tomo.pid");

describe("status-info", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns null when the pid file is missing", () => {
    expect(getRunningPid(PID_FILE)).toBeNull();
    expect(getDaemonStatus(PID_FILE)).toEqual({ pid: null, uptimeMs: null });
  });

  it("returns the pid for a live process", () => {
    writeFileSync(PID_FILE, String(process.pid));
    expect(getRunningPid(PID_FILE)).toBe(process.pid);

    // uptimeMs must never go negative, even when the freshly written pid
    // file's mtime is a fraction ahead of Date.now().
    const status = getDaemonStatus(PID_FILE);
    expect(status.pid).toBe(process.pid);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("cleans up a stale pid file for a dead process", () => {
    // Spawn a process that exits immediately; its pid is guaranteed dead.
    const child = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(PID_FILE, String(child.pid));
    expect(isRunning(child.pid!)).toBe(false);
    expect(getRunningPid(PID_FILE)).toBeNull();
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it("cleans up a garbage pid file", () => {
    writeFileSync(PID_FILE, "not-a-pid");
    expect(getRunningPid(PID_FILE)).toBeNull();
    expect(existsSync(PID_FILE)).toBe(false);
  });
});
