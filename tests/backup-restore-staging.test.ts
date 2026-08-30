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
  };
});

const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = await import("node:fs");
const { backupCommand } = await import("../src/cli/backup.js");
const { restoreLegsStaged } = await import("../src/cli/backup-restore.js");

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  if (paths.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = paths.originalHome;
});

beforeEach(() => {
  paths.failCopyWhenSrcEndsWith = null;
  rmSync(paths.home, { recursive: true, force: true });
});

afterEach(() => {
  paths.failCopyWhenSrcEndsWith = null;
  vi.restoreAllMocks();
});

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
