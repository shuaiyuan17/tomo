import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Lets a test make the reclaim's unlink of an abandoned owner entry fail with
// a code that will not fix itself (EACCES on the lock directory), without
// chmod, which root ignores.
const failUnlink = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    unlinkSync: ((path: Parameters<typeof orig.unlinkSync>[0]) => {
      if (failUnlink.code !== null && String(path).endsWith("owner.planted")) {
        throw Object.assign(new Error(failUnlink.code), { code: failUnlink.code });
      }
      return orig.unlinkSync(path);
    }) as typeof orig.unlinkSync,
  };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLockTimeoutError, isFileLockHeldSync, isPidAlive, withFileLockSync } from "../src/file-lock.js";
import { deadPid, plantFileLock, type PlantedOwner } from "./helpers/lock-fixtures.js";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-file-lock-"));
  lockPath = join(dir, "store.json.lock");
});

afterEach(() => {
  failUnlink.code = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Another process's lock at `lockPath` (see plantFileLock). */
function plantLock(owner: PlantedOwner): void {
  plantFileLock(lockPath, owner);
}

/** Backdate the lock DIRECTORY, which is the age a lock with no readable owner record is judged by. */
function ageLockDir(ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockPath, when, when);
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

  it("excludes another process holding the lock, and gives up loudly, naming the holder", () => {
    plantLock({ pid: process.pid }); // a live owner: this very process
    let ran = false;
    let thrown: unknown;
    try {
      withFileLockSync(lockPath, () => { ran = true; }, { timeoutMs: 60, pollMs: 5 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FileLockTimeoutError);
    expect((thrown as FileLockTimeoutError).holderPid).toBe(process.pid);
    expect((thrown as FileLockTimeoutError).path).toBe(lockPath);
    expect(ran).toBe(false);
    // The holder's lock is untouched, and no half-prepared directory is left.
    expect(readdirSync(lockPath)).toEqual(["owner.planted"]);
    expect(residue()).toEqual(["store.json.lock"]);
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

  it("takes over an empty lock directory at once (a crash between mkdir and write)", () => {
    // Not a reclaim at all: `rename` onto an EMPTY directory replaces it, so
    // the default staleMs never comes into it.
    mkdirSync(lockPath);
    let ran = false;
    withFileLockSync(lockPath, () => { ran = true; }, { timeoutMs: 500, pollMs: 5 });
    expect(ran).toBe(true);
  });

  it("does not trust a dead-looking pid from another host: waits until the lock is stale", () => {
    // A pid from another machine means nothing here, however dead it looks.
    const dead = deadPid();
    plantLock({ pid: dead, host: "elsewhere.invalid" });
    expect(() => withFileLockSync(lockPath, () => "ran", { staleMs: 30_000, timeoutMs: 60, pollMs: 5 }))
      .toThrow(FileLockTimeoutError);
    expect(readdirSync(lockPath)).toEqual(["owner.planted"]);

    plantLock({ pid: dead, host: "elsewhere.invalid", ts: Date.now() - 60_000 });
    expect(withFileLockSync(lockPath, () => "ran", { staleMs: 30_000, timeoutMs: 500, pollMs: 5 })).toBe("ran");
  });

  it("never reclaims a lock with two owner entries, however old: it times out", () => {
    // Garbage this module did not write is not its to adjudicate.
    const old = Date.now() - 60_000;
    plantFileLock(lockPath, { pid: deadPid(), ts: old }, "owner.one");
    plantFileLock(lockPath, { pid: deadPid(), ts: old }, "owner.two");
    ageLockDir(60_000);
    expect(() => withFileLockSync(lockPath, () => "ran", { staleMs: 10, timeoutMs: 60, pollMs: 5 }))
      .toThrow(FileLockTimeoutError);
    expect(readdirSync(lockPath).sort()).toEqual(["owner.one", "owner.two"]);
  });

  it("judges an unreadable owner record by the lock directory's age", () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.planted"), "{ not json");
    // Fresh: nothing proves the owner gone, so it is waited on.
    expect(() => withFileLockSync(lockPath, () => "ran", { staleMs: 30_000, timeoutMs: 60, pollMs: 5 }))
      .toThrow(FileLockTimeoutError);
    // Old: reclaimed.
    ageLockDir(60_000);
    expect(withFileLockSync(lockPath, () => "ran", { staleMs: 30_000, timeoutMs: 500, pollMs: 5 })).toBe("ran");
  });

  it("falls through to the deadline when an abandoned owner cannot be unlinked", () => {
    // EACCES on the lock directory is not going to fix itself: no spinning on
    // the reclaim, a plain timeout, and the lock left as found.
    plantLock({ pid: deadPid() });
    failUnlink.code = "EACCES";
    expect(() => withFileLockSync(lockPath, () => "ran", { timeoutMs: 60, pollMs: 5 }))
      .toThrow(FileLockTimeoutError);
    expect(readdirSync(lockPath)).toEqual(["owner.planted"]);
    expect(residue()).toEqual(["store.json.lock"]);
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

describe("neverReclaimLiveOwner (opt-in)", () => {
  const old = () => Date.now() - 60_000;

  // Without the option, a live owner past staleMs loses the lock: "reclaims a
  // lock older than staleMs even when its pid is alive" above.

  it("with it set, a live holder past staleMs is waited on, not robbed", () => {
    plantLock({ pid: process.pid, ts: old() });
    let ran = false;
    expect(() => withFileLockSync(lockPath, () => { ran = true; }, { staleMs: 10, timeoutMs: 200, neverReclaimLiveOwner: true }))
      .toThrow(FileLockTimeoutError);
    expect(ran).toBe(false);
    expect(readdirSync(lockPath)).toEqual(["owner.planted"]);
  });

  it("still reclaims a dead owner at once, and a foreign host's by age", () => {
    plantLock({ pid: deadPid() });
    expect(withFileLockSync(lockPath, () => "ran", { timeoutMs: 200, neverReclaimLiveOwner: true })).toBe("ran");
    plantLock({ pid: process.pid, ts: old(), host: "elsewhere.invalid" });
    expect(withFileLockSync(lockPath, () => "ran", { staleMs: 10, timeoutMs: 200, neverReclaimLiveOwner: true })).toBe("ran");
  });
});
