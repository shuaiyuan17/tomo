import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { RestoreLeg } from "../src/cli/backup-restore.js";

/**
 * Staged restore (issue #312, finding 4).
 *
 * Two layers: unit tests of `restoreLegsStaged`, which owns the staging and
 * the rollback, and an end-to-end run of the real `tomo backup restore` action
 * with a copy that fails part-way — the ENOSPC case the finding describes.
 *
 * HERMETIC UNDER ANY VERSION OF THE CODE. `HOME` is redirected to a temp
 * directory in a hoisted block, i.e. before any module of the system under
 * test is imported and therefore before `BACKUPS_DIR` (`join(homedir(),
 * "Backups", "tomo")`, resolved at module load) can be computed; `node:os`'s
 * `homedir()`, `src/config.js` and the daemon PID path are all mocked to the
 * same temp tree. Isolation therefore does not depend on the code under test
 * honouring any argument — which matters precisely because these tests are
 * also run against the OLD code to prove they fail there. Nothing here can
 * touch the real `~/Backups/tomo`, `~/.tomo`, or a running daemon.
 */
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-restore-staging-${process.pid}`;
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    originalHome,
    backups: `${home}/Backups/tomo`,
    tomoHome: `${home}/.tomo`,
    unit: `${home}/unit`,
    // Set by a test to make the copy of a particular leg fail.
    failCopyWhenSrcEndsWith: null as string | null,
    /** Fail the rename that parks this leg's live tree aside. */
    failParkWhenSrcEndsWith: null as string | null,
    /** Fail every rename that would put a parked copy back. */
    failRestoreFromPreRestore: false,
    /** Make lstat of this path fail with EIO — "unreadable", not "absent". */
    failLstatWhenPathEndsWith: null as string | null,
  };
});

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => paths.home }, homedir: () => paths.home };
});

vi.mock("../src/config.js", () => ({
  config: {
    tomoHome: paths.tomoHome,
    workspaceDir: join(paths.tomoHome, "workspace"),
    sdkSessionsDir: join(paths.tomoHome, "sdk-sessions"),
  },
  CONFIG_PATH: join(paths.tomoHome, "config.json"),
}));

vi.mock("../src/runtime-paths.js", () => ({
  defaultRuntimePaths: {
    tomoHome: paths.tomoHome,
    pidFile: join(paths.tomoHome, "nonexistent.pid"),
    watchSocketPath: join(paths.tomoHome, "watch.sock"),
  },
}));

// The only way to provoke a mid-copy failure deterministically. Matches on the
// SOURCE path, which is the same on both the old code (which copies straight
// onto the live destination) and the new one (which copies into a sibling), so
// the end-to-end test is a fair comparison between them.
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    cpSync: ((src: unknown, dest: unknown, opts?: unknown) => {
      if (
        paths.failCopyWhenSrcEndsWith
        && typeof src === "string"
        && src.endsWith(paths.failCopyWhenSrcEndsWith)
      ) {
        const err = new Error(`ENOSPC: no space left on device, copyfile '${src}'`);
        (err as NodeJS.ErrnoException).code = "ENOSPC";
        throw err;
      }
      return (actual.cpSync as (...a: unknown[]) => unknown)(src, dest, opts);
    }) as typeof actual.cpSync,
    lstatSync: ((path: unknown, opts?: unknown) => {
      if (
        paths.failLstatWhenPathEndsWith
        && typeof path === "string"
        && path.endsWith(paths.failLstatWhenPathEndsWith)
      ) {
        throw errno("EIO", `EIO: i/o error, lstat '${path}'`);
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, opts);
    }) as typeof actual.lstatSync,
    renameSync: ((from: unknown, to: unknown) => {
      const f = String(from);
      const t = String(to);
      if (paths.failParkWhenSrcEndsWith && t.includes(".pre-restore-") && f.endsWith(paths.failParkWhenSrcEndsWith)) {
        throw errno("EPERM", `EPERM: operation not permitted, rename '${f}'`);
      }
      if (paths.failRestoreFromPreRestore && f.includes(".pre-restore-")) {
        throw errno("EROFS", `EROFS: read-only file system, rename '${f}'`);
      }
      return (actual.renameSync as (...a: unknown[]) => unknown)(from, to);
    }) as typeof actual.renameSync,
  };
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } =
  await import("node:fs");
const actualCopy = (from: string, to: string): void => cpSync(from, to, { recursive: true, dereference: false });
const { backupCommand } = await import("../src/cli/backup.js");
const { acquireRestoreLock, RestoreLockHeldError, restoreLegsStaged, StagedRestoreError, sweepRestoreLeftovers } =
  await import("../src/cli/backup-restore.js");

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  if (paths.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = paths.originalHome;
});

beforeEach(() => {
  resetInjections();
  rmSync(paths.home, { recursive: true, force: true });
});

afterEach(() => {
  resetInjections();
  vi.restoreAllMocks();
});

function resetInjections(): void {
  paths.failCopyWhenSrcEndsWith = null;
  paths.failParkWhenSrcEndsWith = null;
  paths.failRestoreFromPreRestore = false;
  paths.failLstatWhenPathEndsWith = null;
}

// --------------------------------------------------------------------------
// restoreLegsStaged
// --------------------------------------------------------------------------

/** Two source trees and two live trees, each with a distinguishable marker. */
function unitFixture(): { legs: RestoreLeg[]; live: string[] } {
  const src = join(paths.unit, "backup");
  const live = join(paths.unit, "live");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(src, name), { recursive: true });
    writeFileSync(join(src, name, "file.txt"), `restored ${name}`);
    mkdirSync(join(live, name), { recursive: true });
    writeFileSync(join(live, name, "file.txt"), `live ${name}`);
    writeFileSync(join(live, name, "only-live.txt"), "irreplaceable");
  }
  return {
    legs: [
      { label: "alpha/", src: join(src, "alpha"), dest: join(live, "alpha") },
      { label: "beta/", src: join(src, "beta"), dest: join(live, "beta") },
    ],
    live: [join(live, "alpha"), join(live, "beta")],
  };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes(".restoring-") || n.includes(".pre-restore-"));
}

describe("restoreLegsStaged", () => {
  it("restores every leg and leaves no staging or pre-restore directories", () => {
    const { legs, live } = unitFixture();
    const done: string[] = [];

    restoreLegsStaged(legs, { onLegRestored: (leg) => done.push(leg.label) });

    expect(done).toEqual(["alpha/", "beta/"]);
    for (const [i, dir] of live.entries()) {
      const name = ["alpha", "beta"][i];
      expect(readFileSync(join(dir, "file.txt"), "utf-8")).toBe(`restored ${name}`);
      expect(existsSync(join(dir, "only-live.txt"))).toBe(false);
    }
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("leaves the live data intact when the SECOND leg fails to copy", () => {
    // The finding's scenario: a 2.8 GB backup onto a disk with 1 GB free. The
    // old code had already deleted the live tree by this point.
    const { legs, live } = unitFixture();
    const copied: string[] = [];

    expect(() => restoreLegsStaged(legs, {
      copy: (src, dest) => {
        if (src.endsWith("beta")) throw new Error("ENOSPC: no space left on device");
        copied.push(src);
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "file.txt"), readFileSync(join(src, "file.txt")));
      },
    })).toThrow(/ENOSPC/);

    expect(copied).toHaveLength(1); // it really did get as far as the second leg
    for (const [i, dir] of live.entries()) {
      const name = ["alpha", "beta"][i];
      expect(readFileSync(join(dir, "file.txt"), "utf-8")).toBe(`live ${name}`);
      expect(existsSync(join(dir, "only-live.txt"))).toBe(true);
    }
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("refuses to swap in a copy that stopped part-way", () => {
    // A copy that neither throws nor finishes — a killed process, a truncated
    // write. Without verification this swaps silently and the missing files
    // are only discovered later, by which point the original is gone.
    const { legs, live } = unitFixture();
    writeFileSync(join(legs[0].src, "second.txt"), "also in the backup");

    expect(() => restoreLegsStaged(legs, {
      copy: (src, dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "file.txt"), readFileSync(join(src, "file.txt")));
      },
    })).toThrow(/does not match the backup/);

    expect(readFileSync(join(live[0], "file.txt"), "utf-8")).toBe("live alpha");
    expect(existsSync(join(live[0], "only-live.txt"))).toBe(true);
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("rolls back the legs it already swapped when a later swap fails", () => {
    const { legs, live } = unitFixture();
    let renames = 0;

    expect(() => restoreLegsStaged(legs, {
      rename: (from, to) => {
        renames += 1;
        // Fail on the second leg's move-the-live-tree-aside step, i.e. after
        // the first leg is fully swapped in.
        if (renames === 3) throw new Error("EPERM: operation not permitted");
        renameSync(from, to);
      },
    })).toThrow(/EPERM/);

    // Both legs are exactly as they were — including the first, which HAD
    // been swapped and was rolled back.
    for (const [i, dir] of live.entries()) {
      const name = ["alpha", "beta"][i];
      expect(readFileSync(join(dir, "file.txt"), "utf-8")).toBe(`live ${name}`);
      expect(existsSync(join(dir, "only-live.txt"))).toBe(true);
    }
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("never leaves a destination absent when the rollback itself fails", () => {
    // The correlated failure: whatever broke the swap (a volume remounted
    // read-only, EIO) also breaks putting the original back. The earlier
    // version stopped after moving the restored tree aside, leaving the live
    // path ABSENT while the caller printed "nothing was replaced".
    const { legs, live } = unitFixture();
    let renames = 0;

    let caught: unknown;
    try {
      restoreLegsStaged(legs, {
        stamp: "TESTSTAMP",
        rename: (from, to) => {
          renames += 1;
          // 3rd rename = parking beta's live tree, i.e. after alpha swapped.
          if (renames === 3) throw new Error("EIO: i/o error");
          // ...and the rollback's put-the-original-back also fails.
          if (from.includes(".pre-restore-")) throw new Error("EROFS: read-only file system");
          renameSync(from, to);
        },
      });
    } catch (err) {
      caught = err;
    }

    // SOMETHING valid occupies the path — the backup's copy, which is wrong
    // but complete. An absent directory is neither.
    expect(existsSync(live[0])).toBe(true);
    expect(readFileSync(join(live[0], "file.txt"), "utf-8")).toBe("restored alpha");
    // The original is still on disk, and the error says where.
    expect(existsSync(join(paths.unit, "live", "alpha.pre-restore-TESTSTAMP"))).toBe(true);

    expect(caught).toBeInstanceOf(StagedRestoreError);
    const err = caught as InstanceType<typeof StagedRestoreError>;
    expect(err.rollbackClean).toBe(false);
    expect(err.recovery).toHaveLength(1);
    expect(err.recovery[0]).toMatchObject({
      label: "alpha/",
      dest: live[0],
      occupiedBy: "the backup's copy",
      preRestore: join(paths.unit, "live", "alpha.pre-restore-TESTSTAMP"),
    });
  });

  it("reports a clean rollback as clean", () => {
    const { legs } = unitFixture();
    let renames = 0;

    let caught: unknown;
    try {
      restoreLegsStaged(legs, {
        rename: (from, to) => {
          renames += 1;
          if (renames === 3) throw new Error("EIO: i/o error");
          renameSync(from, to);
        },
      });
    } catch (err) { caught = err; }

    expect((caught as InstanceType<typeof StagedRestoreError>).rollbackClean).toBe(true);
    expect((caught as InstanceType<typeof StagedRestoreError>).recovery).toEqual([]);
  });

  it("refuses up front when the volume cannot hold the staged copy", () => {
    // Staging needs room for the copy ALONGSIDE the live tree. Asking first
    // turns "ENOSPC half-way through 2.8 GB" into a refusal naming both
    // numbers, with nothing written.
    const { legs, live } = unitFixture();

    expect(() => restoreLegsStaged(legs, { freeSpace: () => 8 }))
      .toThrow(/not enough free space[\s\S]*available/);

    expect(readFileSync(join(live[0], "file.txt"), "utf-8")).toBe("live alpha");
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("proceeds when free space cannot be determined", () => {
    const { legs, live } = unitFixture();
    restoreLegsStaged(legs, { freeSpace: () => null });
    expect(readFileSync(join(live[0], "file.txt"), "utf-8")).toBe("restored alpha");
  });

  it("keeps the pre-restore copies until every leg has swapped", () => {
    const { legs } = unitFixture();
    const seen: string[][] = [];

    restoreLegsStaged(legs, {
      stamp: "TESTSTAMP",
      onLegRestored: () => seen.push(leftovers(join(paths.unit, "live")).sort()),
    });

    // After the first leg: its own live tree is parked as .pre-restore, and
    // the second leg's staged copy is still waiting.
    expect(seen[0]).toEqual(["alpha.pre-restore-TESTSTAMP", "beta.restoring-TESTSTAMP"]);
    expect(seen[1]).toEqual(["alpha.pre-restore-TESTSTAMP", "beta.pre-restore-TESTSTAMP"]);
    // ...and only then are they deleted.
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// tomo backup restore, end to end
// --------------------------------------------------------------------------

const VALID = "2026-08-30_0142";
const validDir = join(paths.backups, VALID);
const liveMarker = join(paths.tomoHome, "data", "live.txt");

function cliFixture(): void {
  mkdirSync(join(validDir, "data"), { recursive: true });
  writeFileSync(join(validDir, "data", "restored.txt"), "from backup");
  mkdirSync(join(validDir, "workspace"), { recursive: true });
  writeFileSync(join(validDir, "workspace", "SOUL.md"), "backup soul");
  mkdirSync(join(validDir, "sdk-sessions"), { recursive: true });
  writeFileSync(join(validDir, "sdk-sessions", "s.jsonl"), "backup session");
  writeFileSync(join(validDir, "config.json"), '{"from":"backup"}');

  mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
  writeFileSync(liveMarker, "live");
  mkdirSync(join(paths.tomoHome, "workspace"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "workspace", "SOUL.md"), "live soul");
  mkdirSync(join(paths.tomoHome, "sdk-sessions"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "sdk-sessions", "live.jsonl"), "live session");
  writeFileSync(join(paths.tomoHome, "config.json"), '{"from":"live"}');
}

interface RunResult { logs: string[]; errors: string[]; exitCodes: number[]; threw: Error | null }

let restoreStdin: (() => void) | undefined;
afterEach(() => { restoreStdin?.(); restoreStdin = undefined; });

async function runRestore(arg: string, answer: string[] = ["y\n"]): Promise<RunResult> {
  const original = process.stdin;
  const fake = Readable.from(answer) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  restoreStdin = () => Object.defineProperty(process, "stdin", { value: original, configurable: true });

  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error("__exit__");
  }) as never);

  let threw: Error | null = null;
  try {
    await backupCommand.parseAsync(["restore", arg], { from: "user" });
  } catch (err) {
    if ((err as Error).message !== "__exit__") threw = err as Error;
  }
  return { logs, errors, exitCodes, threw };
}

describe("tomo backup restore — a leg fails to copy", () => {
  beforeEach(() => { cliFixture(); });

  it("leaves every live tree intact when the data/ copy runs out of space", async () => {
    // data/ is the second leg. On the old code the first leg (config.json)
    // had already been written over the live file and `rmSync(dataDest)` had
    // already deleted the live data by the time this throws.
    paths.failCopyWhenSrcEndsWith = join(VALID, "data");

    const { errors, exitCodes, threw } = await runRestore(VALID);

    // THE DATA FIRST — this is the whole point. On the old code the live
    // `data/` tree has been deleted by now and is in no backup.
    expect(existsSync(liveMarker)).toBe(true);
    expect(readFileSync(liveMarker, "utf-8")).toBe("live");
    expect(existsSync(join(paths.tomoHome, "data", "restored.txt"))).toBe(false);
    // Nor was the leg that HAD staged successfully applied — all or nothing.
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("live");
    expect(readFileSync(join(paths.tomoHome, "sdk-sessions", "live.jsonl"), "utf-8")).toBe("live session");
    // The workspace leg runs after the staged ones, so it is untouched too.
    expect(readFileSync(join(paths.tomoHome, "workspace", "SOUL.md"), "utf-8")).toBe("live soul");
    expect(leftovers(paths.tomoHome)).toEqual([]);

    // And the failure is reported rather than thrown out of the command.
    expect(threw).toBeNull();
    expect(errors.join("\n")).toContain("Restore failed");
    expect(errors.join("\n")).toContain("ENOSPC");
    expect(exitCodes).toContain(1);
  });

  it("still restores every leg when nothing fails", async () => {
    const { logs, exitCodes } = await runRestore(VALID);

    expect(logs.join("\n")).toContain("Restore complete.");
    expect(exitCodes).not.toContain(1);
    expect(readFileSync(join(paths.tomoHome, "data", "restored.txt"), "utf-8")).toBe("from backup");
    expect(existsSync(liveMarker)).toBe(false);
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("backup");
    expect(readFileSync(join(paths.tomoHome, "sdk-sessions", "s.jsonl"), "utf-8")).toBe("backup session");
    expect(readFileSync(join(paths.tomoHome, "workspace", "SOUL.md"), "utf-8")).toBe("backup soul");
    expect(leftovers(paths.tomoHome)).toEqual([]);
  });
});

describe("restoreLegsStaged — what it refuses to guess", () => {
  it("does not treat an unreadable live path as absent", () => {
    // A file leg, because that is where a wrong answer is silent: `rename`
    // onto an existing FILE overwrites it. If "EIO on lstat" read as "nothing
    // live here", the swap would skip parking, rename the staged copy over the
    // original, and a later rollback would have nothing to put back while
    // calling itself clean.
    const src = join(paths.unit, "backup", "config.json");
    const dest = join(paths.unit, "live", "config.json");
    mkdirSync(join(paths.unit, "backup"), { recursive: true });
    mkdirSync(join(paths.unit, "live"), { recursive: true });
    writeFileSync(src, "from backup");
    writeFileSync(dest, "the only live copy");
    paths.failLstatWhenPathEndsWith = join("live", "config.json");

    let thrown: unknown;
    try {
      restoreLegsStaged([{ label: "config.json", src, dest }], { freeSpace: () => null });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StagedRestoreError);
    expect((thrown as Error).message).toMatch(/EIO/);
    paths.failLstatWhenPathEndsWith = null;
    expect(readFileSync(dest, "utf-8")).toBe("the only live copy");
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("names the entry on which the staged copy differs, not just a total", () => {
    // Same entry count, same total bytes, different tree: a copy that dropped
    // one file and gained another of the same size. Count-plus-size cannot see
    // it; a per-entry manifest names the first entry that differs.
    const { legs } = unitFixture();
    let thrown: unknown;
    try {
      restoreLegsStaged(legs, {
        freeSpace: () => null,
        copy: (from, to) => {
          actualCopy(from, to);
          if (from.endsWith("alpha")) renameSync(join(to, "file.txt"), join(to, "eile.txt"));
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error).message).toMatch(/alpha\/: staged copy does not match the backup/);
    expect((thrown as Error).message).toContain("eile.txt");
    expect(leftovers(join(paths.unit, "live"))).toEqual([]);
  });

  it("checks free space on the volume each leg is going to, not just the first", () => {
    // sdkSessionsDir is configurable and can live on another disk. A roomy
    // first volume must not vouch for a full second one.
    const src = join(paths.unit, "backup");
    mkdirSync(join(src, "alpha"), { recursive: true });
    writeFileSync(join(src, "alpha", "file.txt"), "x".repeat(100));
    mkdirSync(join(src, "beta"), { recursive: true });
    writeFileSync(join(src, "beta", "file.txt"), "y".repeat(100));
    const legs: RestoreLeg[] = [
      { label: "alpha/", src: join(src, "alpha"), dest: join(paths.unit, "diskA", "alpha") },
      { label: "beta/", src: join(src, "beta"), dest: join(paths.unit, "diskB", "beta") },
    ];

    expect(() => restoreLegsStaged(legs, {
      volumeOf: (path) => (path.endsWith("diskB") ? "B" : "A"),
      freeSpace: (path) => (path.endsWith("diskB") ? 10 : 10 ** 12),
    })).toThrow(/not enough free space[\s\S]*volume holding .*diskB/);
    expect(existsSync(join(paths.unit, "diskA", "alpha"))).toBe(false);
  });
});

describe("acquireRestoreLock", () => {
  it("refuses while another restore holds the lock", () => {
    const dir = join(paths.unit, "tomo");
    const release = acquireRestoreLock(dir, { pid: 1111, isAlive: () => true });

    expect(() => acquireRestoreLock(dir, { pid: 2222, isAlive: () => true })).toThrow(RestoreLockHeldError);
    expect(readFileSync(join(dir, "restore.lock"), "utf-8").trim()).toBe("1111");

    release();
    expect(existsSync(join(dir, "restore.lock"))).toBe(false);
  });

  it("takes over a lock whose holder is gone", () => {
    const dir = join(paths.unit, "tomo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "restore.lock"), "1111\n");
    // Old enough that an unreadable pid would not be read as "still writing".
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "restore.lock"), old, old);

    const release = acquireRestoreLock(dir, { pid: 2222, isAlive: (pid) => pid !== 1111 });

    expect(readFileSync(join(dir, "restore.lock"), "utf-8").trim()).toBe("2222");
    release();
    expect(existsSync(join(dir, "restore.lock"))).toBe(false);
  });

  it("releases only its own lock", () => {
    // The lock was taken over by a later restore after this one was judged
    // dead; releasing must not remove the newer holder's lock.
    const dir = join(paths.unit, "tomo");
    const release = acquireRestoreLock(dir, { pid: 1111, isAlive: () => true });
    writeFileSync(join(dir, "restore.lock"), "3333\n");

    release();

    expect(readFileSync(join(dir, "restore.lock"), "utf-8").trim()).toBe("3333");
  });
});

describe("sweepRestoreLeftovers", () => {
  it("ignores names that merely start with the leg's prefix", () => {
    // Anything moved onto the live path BECOMES the live data, so only a name
    // this module could have written qualifies. A user's own directory that
    // happens to share the prefix is neither moved nor reported.
    const dest = join(paths.unit, "live", "data");
    mkdirSync(join(paths.unit, "live"), { recursive: true });
    const impostor = `${dest}.pre-restore-z`;
    mkdirSync(impostor, { recursive: true });
    writeFileSync(join(impostor, "registry.json"), "not a backup of anything");

    const found = sweepRestoreLeftovers([{ label: "data/", dest }]);

    expect(found).toEqual([]);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(impostor)).toBe(true);
  });

  it("leaves two parked copies alone even when the live path is missing", () => {
    // Two interrupted restores. Which parked copy is "the" original is not
    // knowable here — stamps from the same second cannot even be ordered.
    const dest = join(paths.unit, "live", "data");
    mkdirSync(join(paths.unit, "live"), { recursive: true });
    const older = `${dest}.pre-restore-20260101-000000-11`;
    const newer = `${dest}.pre-restore-20260101-000000-99`;
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });

    const found = sweepRestoreLeftovers([{ label: "data/", dest }]);

    expect(existsSync(dest)).toBe(false);
    expect(found.map((f) => [f.path, f.recovered])).toEqual([[older, false], [newer, false]]);
  });

  it("puts back a leg whose live path is missing", () => {
    const dest = join(paths.unit, "live", "data");
    mkdirSync(join(paths.unit, "live"), { recursive: true });
    const parked = `${dest}.pre-restore-20260101-000000-99`;
    mkdirSync(parked, { recursive: true });
    writeFileSync(join(parked, "registry.json"), "the only copy");

    const found = sweepRestoreLeftovers([{ label: "data/", dest }]);

    expect(readFileSync(join(dest, "registry.json"), "utf-8")).toBe("the only copy");
    expect(found).toEqual([{ label: "data/", path: parked, kind: "pre-restore", recovered: true }]);
  });

  it("reports but does not touch a parked copy when the live path exists", () => {
    // Which of the two is wanted is not knowable from here.
    const dest = join(paths.unit, "live", "data");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "registry.json"), "current");
    const parked = `${dest}.pre-restore-20260101-000000-99`;
    mkdirSync(parked, { recursive: true });
    const staging = `${dest}.restoring-20260101-000000-99`;
    mkdirSync(staging, { recursive: true });

    const found = sweepRestoreLeftovers([{ label: "data/", dest }]);

    expect(readFileSync(join(dest, "registry.json"), "utf-8")).toBe("current");
    expect(found.map((f) => [f.kind, f.recovered])).toEqual([["staging", false], ["pre-restore", false]]);
    expect(existsSync(parked)).toBe(true);
    expect(existsSync(staging)).toBe(true);
  });
});

describe("tomo backup restore — rollback and leftovers, end to end", () => {
  beforeEach(() => { cliFixture(); });

  it("prints recovery paths instead of a false reassurance when a rollback fails", async () => {
    // config.json swaps, data/ cannot be parked, and putting config.json back
    // fails too. Something WAS replaced, so "nothing was replaced" would be a
    // lie — and the one thing the operator needs is where their data is.
    paths.failParkWhenSrcEndsWith = join(paths.tomoHome, "data");
    paths.failRestoreFromPreRestore = true;

    const { errors, exitCodes } = await runRestore(VALID);
    const text = errors.join("\n");

    expect(exitCodes).toContain(1);
    expect(text).toContain("Some components could NOT be rolled back");
    expect(text).toContain("config.json.pre-restore-");
    expect(text).not.toContain("Nothing was replaced");
    // The live path is occupied, and the original is still on disk.
    expect(existsSync(join(paths.tomoHome, "config.json"))).toBe(true);
    const parked = readdirSync(paths.tomoHome).filter((n) => n.startsWith("config.json.pre-restore-"));
    expect(parked).toHaveLength(1);
    expect(readFileSync(join(paths.tomoHome, parked[0]), "utf-8")).toContain("live");
  });

  it("recovers a leg parked by an interrupted restore before doing anything else", async () => {
    // A previous run was killed inside the swap: `data/` is absent and the
    // only copy is parked beside it. Nothing sweeps for that on its own.
    const parked = join(paths.tomoHome, "data.pre-restore-20260101-000000-4242");
    mkdirSync(parked, { recursive: true });
    writeFileSync(join(parked, "irreplaceable.txt"), "months of transcripts");
    rmSync(join(paths.tomoHome, "data"), { recursive: true, force: true });

    // Declined at the prompt: the repair still stands.
    const { logs } = await runRestore(VALID, ["n\n"]);

    expect(logs.join("\n")).toContain("Found leftovers from an interrupted restore");
    expect(logs.join("\n")).toContain("[recovered]");
    expect(readFileSync(join(paths.tomoHome, "data", "irreplaceable.txt"), "utf-8"))
      .toBe("months of transcripts");
    expect(existsSync(parked)).toBe(false);
  });

  it("refuses to run beside another restore, before it sweeps", async () => {
    // The sweep would un-park a running restore's original at the exact
    // moment its live path is renamed aside. So: a live lock refuses the
    // command, and the parked copy — which here belongs to the "other" run —
    // is not touched.
    mkdirSync(paths.tomoHome, { recursive: true });
    writeFileSync(join(paths.tomoHome, "restore.lock"), `${process.pid}\n`);
    const parked = join(paths.tomoHome, "data.pre-restore-20260101-000000-4242");
    mkdirSync(parked, { recursive: true });
    rmSync(join(paths.tomoHome, "data"), { recursive: true, force: true });

    const { logs, errors, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(errors.join("\n")).toContain("another restore is in progress");
    expect(exitCodes).toContain(1);
    expect(logs.join("\n")).not.toContain("Found leftovers");
    expect(existsSync(parked)).toBe(true);
    expect(existsSync(join(paths.tomoHome, "data"))).toBe(false);
    // Refusing must not remove the other restore's lock either.
    expect(readFileSync(join(paths.tomoHome, "restore.lock"), "utf-8").trim()).toBe(String(process.pid));
  });

  it("does not claim success when the workspace leg fails", async () => {
    // The workspace is restored OUTSIDE the staged transaction, so its
    // failure leaves the other three restored. Saying "Restore complete."
    // there would be false.
    paths.failCopyWhenSrcEndsWith = join(VALID, "workspace");

    const { logs, errors, exitCodes } = await runRestore(VALID);

    expect(logs.join("\n")).not.toContain("Restore complete.");
    expect(errors.join("\n")).toContain("Restore INCOMPLETE");
    expect(errors.join("\n")).toContain("has not been rolled back");
    expect(exitCodes).toContain(1);
    // ...and the staged legs really are in place, which is why it is incomplete
    // rather than failed.
    expect(readFileSync(join(paths.tomoHome, "data", "restored.txt"), "utf-8")).toBe("from backup");
  });
});
