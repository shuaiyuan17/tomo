import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { FileLockTimeoutError, isFileLockHeldSync, isPidAlive, withFileLockSync } from "../src/file-lock.js";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-file-lock-"));
  lockPath = join(dir, "store.json.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a process that exits immediately. */
function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = spawnSync(process.execPath, ["-e", ""]);
    if (!res.error && typeof res.pid === "number" && res.pid > 0) return res.pid;
  }
  throw new Error("could not spawn a throwaway process to obtain a dead pid");
}

/**
 * Plant a lock exactly as another process would leave one: a directory holding
 * a single `owner.<token>` record. Same-process re-entry is deliberately free
 * (see withFileLockSync), so this is the only honest way to play a contender.
 */
function plantLock(owner: { pid: number; ts?: number; host?: string } | null): void {
  mkdirSync(lockPath, { recursive: true });
  if (owner === null) return;
  writeFileSync(
    join(lockPath, "owner.planted"),
    `${JSON.stringify({ pid: owner.pid, ts: owner.ts ?? Date.now(), host: owner.host ?? hostname() })}\n`,
  );
}

/** Everything left in the lock's directory — a leaked temp dir shows up here. */
function residue(): string[] {
  return readdirSync(dir).sort();
}

describe("withFileLockSync", () => {
  it("runs the body, returns its value, and leaves nothing behind", () => {
    let sawLock = false;
    const value = withFileLockSync(lockPath, () => {
      sawLock = existsSync(lockPath);
      return 42;
    });
    expect(value).toBe(42);
    expect(sawLock).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(residue()).toEqual([]);
  });

  it("creates the containing directory", () => {
    const nested = join(dir, "a", "b", "jobs.json.lock");
    expect(withFileLockSync(nested, () => "ok")).toBe("ok");
    expect(existsSync(join(dir, "a", "b"))).toBe(true);
  });

  it("excludes another process holding the lock, and gives up loudly", () => {
    plantLock({ pid: process.pid }); // a live owner: this very process
    let ran = false;
    expect(() => withFileLockSync(lockPath, () => { ran = true; }, { timeoutMs: 60, pollMs: 5 }))
      .toThrow(FileLockTimeoutError);
    expect(ran).toBe(false);
    // The holder's lock is untouched, and no half-prepared directory is left.
    expect(readdirSync(lockPath)).toEqual(["owner.planted"]);
    expect(residue()).toEqual(["store.json.lock"]);
  });

  it("names the holder in the timeout it throws", () => {
    plantLock({ pid: process.pid });
    try {
      withFileLockSync(lockPath, () => undefined, { timeoutMs: 30, pollMs: 5 });
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(FileLockTimeoutError);
      expect((err as FileLockTimeoutError).holderPid).toBe(process.pid);
      expect((err as FileLockTimeoutError).path).toBe(lockPath);
    }
  });

  it("reclaims a lock whose owner is dead, however fresh it looks", () => {
    const dead = deadPid();
    expect(isPidAlive(dead)).toBe(false);
    plantLock({ pid: dead, ts: Date.now() }); // brand new, but nobody is home

    let ran = false;
    withFileLockSync(lockPath, () => { ran = true; }, { timeoutMs: 500, pollMs: 5 });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock older than staleMs even when its pid is alive", () => {
    // A pid can be recycled, and a holder wedged inside a sub-millisecond
    // critical section for this long is not coming back. Refusing forever
    // would wedge every writer of the file instead.
    plantLock({ pid: process.pid, ts: Date.now() - 60_000 });
    let ran = false;
    withFileLockSync(lockPath, () => { ran = true; }, { staleMs: 30_000, timeoutMs: 500, pollMs: 5 });
    expect(ran).toBe(true);
  });

  it("reclaims a lock left ownerless past staleMs (a crash between mkdir and write)", () => {
    plantLock(null);
    let ran = false;
    withFileLockSync(lockPath, () => { ran = true; }, { staleMs: 0, timeoutMs: 500, pollMs: 5 });
    expect(ran).toBe(true);
  });

  it("releases the lock when the body throws, and propagates the error", () => {
    expect(() => withFileLockSync(lockPath, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
    expect(isFileLockHeldSync(lockPath)).toBe(false);
    // ...and the next acquirer is not blocked by the failed one.
    expect(withFileLockSync(lockPath, () => "next")).toBe("next");
  });

  it("re-enters within one process instead of deadlocking on itself", () => {
    // Synchronous code cannot interleave, so a nested acquire is a nested CALL
    // (setSdkSessionId → clearSdkSessionId), never a race. Blocking it would be
    // a guaranteed self-deadlock.
    const seen: string[] = [];
    withFileLockSync(lockPath, () => {
      expect(isFileLockHeldSync(lockPath)).toBe(true);
      withFileLockSync(lockPath, () => { seen.push("inner"); });
      // The inner frame must not have released the lock on the way out.
      expect(existsSync(lockPath)).toBe(true);
      expect(isFileLockHeldSync(lockPath)).toBe(true);
      seen.push("outer");
    });
    expect(seen).toEqual(["inner", "outer"]);
    expect(existsSync(lockPath)).toBe(false);
    expect(isFileLockHeldSync(lockPath)).toBe(false);
  });

  it("unwinds the re-entry depth when a nested body throws", () => {
    expect(() => withFileLockSync(lockPath, () => {
      withFileLockSync(lockPath, () => { throw new Error("inner boom"); });
    })).toThrow("inner boom");
    expect(isFileLockHeldSync(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
