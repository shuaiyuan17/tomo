import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireMaintenanceLock, maintenanceLockPath, type MaintenanceLock } from "../src/db/lock.js";

// ---------------------------------------------------------------------------
// The lock the daemon and the maintenance commands share (src/db/lock.ts):
// one holder at a time, across processes, and a holder that dies however it
// dies lets go of it.
// ---------------------------------------------------------------------------

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const HOLDER = fileURLToPath(new URL("./fixtures/hold-maintenance-lock.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let home: string;
let path: string;
const held: MaintenanceLock[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tomo-lock-"));
  path = maintenanceLockPath(join(home, ".tomo"));
});
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

function take(waitMs = 0): MaintenanceLock | null {
  const lock = acquireMaintenanceLock(path, { waitMs });
  if (lock) held.push(lock);
  return lock;
}

/** A child that takes the lock and holds it; resolves once it says whether it got it. */
function holder(hold: string, waitMs = 0): Promise<{ child: ChildProcess; got: boolean }> {
  // node itself, not the tsx wrapper: a SIGKILL has to reach the process holding the lock.
  const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", HOLDER, path, String(waitMs), hold], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (c) => {
      out += String(c);
      if (out.includes("\n")) resolve({ child, got: out.startsWith("held") });
    });
    child.on("exit", (code) => { if (!out.includes("\n")) reject(new Error(`holder exited ${code} before answering`)); });
  });
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.on("exit", () => resolve());
});

describe("the maintenance lock", () => {
  it("has one holder at a time, in this process and across processes", async () => {
    const first = take();
    expect(first).not.toBeNull();
    expect(take()).toBeNull();
    expect((await holder("0")).got).toBe(false);
    first!.release();
    first!.release(); // idempotent
    expect(take()).not.toBeNull();
  });

  it("stays held while its holder runs, however long and whatever the GC collects", { timeout: 30_000 }, async () => {
    const { got } = await holder("forever");
    expect(got).toBe(true);
    // Longer than it took a holder whose connection could be collected to lose it.
    expect(take(6_000)).toBeNull();
  });

  it("is let go of when its holder is SIGKILLed: no stale lock to clean up", { timeout: 30_000 }, async () => {
    const { child, got } = await holder("forever");
    expect(got).toBe(true);
    expect(take()).toBeNull();
    child.kill("SIGKILL");
    await exited(child);
    expect(take()).not.toBeNull();
  });

  it("waits up to waitMs for a holder that is about to finish", { timeout: 30_000 }, async () => {
    const { got } = await holder("400");
    expect(got).toBe(true);
    const started = Date.now();
    expect(take(10_000)).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(9_000);
  });
});

describe("who takes it", () => {
  /** `tomo <args>` as its own process, HOME in the scratch directory. */
  function tomo(...args: string[]) {
    return spawnSync(TSX, [CLI, ...args], { env: { ...process.env, HOME: home, TOMO_SESSION_KEY: "" }, encoding: "utf-8", timeout: 60_000 });
  }

  it("a starting daemon refuses while a maintenance command holds it", { timeout: 60_000 }, async () => {
    mkdirSync(join(home, ".tomo"), { recursive: true });
    const { got } = await holder("forever");
    expect(got).toBe(true);
    const run = tomo("start", "--foreground");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("A maintenance command");
    expect(run.stderr).toContain("Refusing to start");
  });

  it("tomo db repair and the rollback export refuse while the daemon holds it", { timeout: 60_000 }, async () => {
    mkdirSync(join(home, ".tomo", "data"), { recursive: true });
    const { got } = await holder("forever");
    expect(got).toBe(true);
    for (const args of [["db", "repair"], ["db", "export", "pending-notes"]]) {
      const run = tomo(...args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr, args.join(" ")).toContain("is locked");
    }
  });

  it("tomo backup restore refuses while the daemon holds it", { timeout: 60_000 }, async () => {
    const backup = join(home, "Backups", "tomo", "2026-01-01_0000");
    mkdirSync(join(backup, "data"), { recursive: true });
    mkdirSync(join(home, ".tomo"), { recursive: true });
    const { got } = await holder("forever");
    expect(got).toBe(true);
    const run = tomo("backup", "restore", "2026-01-01_0000");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Cannot restore:");
    expect(run.stderr).toContain("is locked");
  });
});
