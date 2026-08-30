import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePidFile, releasePidFile, isPidAlive } from "../src/cli/pidfile.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-pidfile-"));
  pidFile = join(dir, "tomo.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a process that exits immediately. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

describe("acquirePidFile", () => {
  it("creates the pid file and records our pid", () => {
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: null });
    expect(readFileSync(pidFile, "utf-8")).toBe("4242");
  });

  it("creates the containing directory", () => {
    const nested = join(dir, "a", "b", "tomo.pid");
    expect(acquirePidFile(nested, 7).ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("refuses when a LIVE process already holds the file", () => {
    // Our own pid is the most reliably-live pid available.
    writeFileSync(pidFile, String(process.pid));
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: false, holder: process.pid });
    // …and the incumbent's claim is left intact.
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
  });

  it("takes over a stale pid file, reporting the dead pid", () => {
    const dead = deadPid();
    expect(isPidAlive(dead)).toBe(false);
    writeFileSync(pidFile, String(dead));

    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: dead });
    expect(readFileSync(pidFile, "utf-8")).toBe("4242");
  });

  it("takes over an unparseable pid file", () => {
    writeFileSync(pidFile, "not-a-pid\n");
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: null });
    expect(readFileSync(pidFile, "utf-8")).toBe("4242");
  });

  it("takes over a file that already names us (re-entry, recycled pid)", () => {
    writeFileSync(pidFile, String(process.pid));
    expect(acquirePidFile(pidFile, process.pid)).toEqual({ ok: true, tookOverStale: process.pid });
  });
});

describe("releasePidFile", () => {
  it("removes the file when it names us", () => {
    acquirePidFile(pidFile, 4242);
    releasePidFile(pidFile, 4242);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("leaves a successor's claim alone", () => {
    // A slow-exiting daemon must not delete the pid file its replacement has
    // already acquired — that would re-open the double-start hole.
    writeFileSync(pidFile, "999");
    releasePidFile(pidFile, 4242);
    expect(readFileSync(pidFile, "utf-8")).toBe("999");
  });

  it("is a no-op when the file is gone", () => {
    expect(() => releasePidFile(pidFile, 4242)).not.toThrow();
  });
});

const FIXTURE = fileURLToPath(new URL("./fixtures/pidfile-race.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface RacerLine { pid: number; ok: boolean; holder?: number; tookOverStale?: number | null }

/** Run one racer child; resolve with the JSON line it printed. */
function race(startAt: number): Promise<RacerLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [FIXTURE, pidFile, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", reject);
    // Let every child exit on its own: the winner deliberately holds the file
    // (see the fixture), and killing it early would hand a stale file to any
    // racer still starting up.
    child.on("exit", () => {
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line));
      else reject(new Error(`racer produced no result: ${err}`));
    });
  });
}

describe("acquirePidFile across real processes", () => {
  // The property under test is cross-process, so it cannot be observed in a
  // single process: `acquirePidFile` is synchronous, so an in-process "race"
  // is always serialised. Six real children hitting a shared time barrier
  // exercise the actual create/EEXIST boundary in the kernel.
  it("lets exactly one of six concurrent processes win", { timeout: 60_000 }, async () => {
    const startAt = Date.now() + 5_000; // leave room for tsx startup on a loaded machine
    const results = await Promise.all(Array.from({ length: 6 }, () => race(startAt)));

    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    // Every loser must name the winner — not 0, not each other. A loser that
    // reported a different holder would mean two daemons believed they were
    // alone.
    const winnerPid = winners[0].pid;
    for (const loser of results.filter((r) => !r.ok)) {
      expect(loser.holder).toBe(winnerPid);
    }
  });
});
