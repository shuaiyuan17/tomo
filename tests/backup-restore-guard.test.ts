import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";

// A fake home. Computed from literals so it is available inside the hoisted
// mock factories, which run before this file's imports: BACKUPS_DIR is
// `join(homedir(), "Backups", "tomo")`, resolved at module load, and without
// this it would resolve into the reviewer's real home.
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-backup-guard-${process.pid}`;
  return {
    home,
    backups: `${home}/Backups/tomo`,
    tomoHome: `${home}/.tomo`,
    outside: `/tmp/tomo-backup-outside-${process.pid}`,
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

// Point the daemon PID file at something that does not exist, so the "Tomo is
// running" guard never fires off the reviewer's own live daemon.
vi.mock("../src/runtime-paths.js", () => ({
  defaultRuntimePaths: {
    tomoHome: paths.tomoHome,
    pidFile: join(paths.tomoHome, "nonexistent.pid"),
    watchSocketPath: join(paths.tomoHome, "watch.sock"),
  },
}));

const { backupCommand } = await import("../src/cli/backup.js");

const VALID = "2026-08-30_0142";
const validDir = join(paths.backups, VALID);
/** A live file that a restore would delete, and an abort must not. */
const liveMarker = join(paths.tomoHome, "data", "live.txt");
/** A file only present in the backup, so a real restore is observable. */
const restoredMarker = join(paths.tomoHome, "data", "restored.txt");

/**
 * Where `../../<VALID>` lands from the backups root: two levels up is the fake
 * home, which is outside the root but inside our own temp tree.
 */
const traversalTarget = join(paths.home, VALID);

/** Rebuilt per test: several cases mutate the tree on purpose. */
function buildFixture(): void {
  rmSync(paths.home, { recursive: true, force: true });
  rmSync(paths.outside, { recursive: true, force: true });

  // A genuine backup with ALL FOUR legs, so the positive control proves every
  // one of them is restored rather than just `data`.
  mkdirSync(join(validDir, "data"), { recursive: true });
  writeFileSync(join(validDir, "data", "restored.txt"), "from backup");
  mkdirSync(join(validDir, "workspace"), { recursive: true });
  writeFileSync(join(validDir, "workspace", "SOUL.md"), "backup soul");
  mkdirSync(join(validDir, "sdk-sessions"), { recursive: true });
  writeFileSync(join(validDir, "sdk-sessions", "s.jsonl"), "backup session");
  writeFileSync(join(validDir, "config.json"), '{"from":"backup"}');

  // Somewhere outside the backups root for a link to point at.
  mkdirSync(join(paths.outside, "data"), { recursive: true });
  writeFileSync(join(paths.outside, "data", "loot.txt"), "attacker payload");

  // A correctly-named SYMLINK to a directory outside the root. Shape check
  // passes, existsSync passes (it follows the link), and restore would then
  // read from there while deleting the live destinations.
  symlinkSync(paths.outside, join(paths.backups, "2026-08-30_0200"), "dir");
  // A correctly-named regular file, which is not restorable either.
  writeFileSync(join(paths.backups, "2026-08-30_0300"), "not a directory");

  // DECOYS so the rejection tests discriminate. Without these, `../../../X`
  // and `/etc` are refused on main merely because nothing is there — the test
  // would pass without the validation it claims to exercise. With them, only
  // shape/containment can do the rejecting.
  mkdirSync(join(traversalTarget, "data"), { recursive: true });
  writeFileSync(join(traversalTarget, "data", "loot.txt"), "attacker payload");
  mkdirSync(join(paths.backups, "etc", "data"), { recursive: true });
  writeFileSync(join(paths.backups, "etc", "data", "loot.txt"), "attacker payload");

  // Live data the restore would overwrite.
  mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
  writeFileSync(liveMarker, "live");
  mkdirSync(join(paths.tomoHome, "workspace"), { recursive: true });
  mkdirSync(join(paths.tomoHome, "sdk-sessions"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "config.json"), '{"from":"live"}');
}

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  rmSync(paths.outside, { recursive: true, force: true });
});

let restoreStdin: (() => void) | undefined;

beforeEach(() => {
  buildFixture();
  restoreStdin = undefined;
});

afterEach(() => { restoreStdin?.(); vi.restoreAllMocks(); });

interface RunResult { logs: string[]; errors: string[]; exitCodes: number[] }

/**
 * Run the real `restore` action.
 *
 * `answer` becomes stdin for `confirm()`. It may be an async generator, which
 * is how the swap-during-prompt case runs its mutation at the one moment that
 * matters: `Readable.from` pulls lazily, so the generator body does not run
 * until readline actually reads — i.e. after the prompt is pending.
 */
async function runRestore(
  arg: string,
  answer: Iterable<string> | AsyncIterable<string> = ["n\n"],
): Promise<RunResult> {
  const original = process.stdin;
  const fake = Readable.from(answer) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  restoreStdin = () => Object.defineProperty(process, "stdin", { value: original, configurable: true });

  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  // Real process.exit would take the test runner with it. Throwing reproduces
  // its control flow: nothing after the call runs.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error("__exit__");
  }) as never);

  try {
    await backupCommand.parseAsync(["restore", arg], { from: "user" });
  } catch (err) {
    if ((err as Error).message !== "__exit__") throw err;
  }
  return { logs, errors, exitCodes };
}

/** The line restore prints once it has accepted the argument. */
const ACCEPTED = "Restore from:";

describe("tomo backup restore — argument guard", () => {
  it("rejects traversal instead of resolving it against the backups root", async () => {
    const { logs, exitCodes } = await runRestore("../../..");
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("rejects a traversal that still ends in a valid-looking name", async () => {
    // The decoy at `traversalTarget` exists and holds a `data/` leg, so this
    // is rejected by containment rather than by nothing being there.
    expect(existsSync(join(traversalTarget, "data"))).toBe(true);
    const { logs, exitCodes } = await runRestore(`../../${VALID}`);
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("rejects an absolute path", async () => {
    // `join(BACKUPS_DIR, "/etc")` is `<backups>/etc`, which the decoy makes
    // real — so only the shape check can reject this.
    expect(existsSync(join(paths.backups, "etc", "data"))).toBe(true);
    const { logs, exitCodes } = await runRestore("/etc");
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("rejects a correctly-named symlink pointing outside the backups root", async () => {
    // The shape check and existsSync both pass — the link is named exactly like
    // a backup and resolves to a real directory. Only lstat + realpath catch it.
    const { logs, exitCodes } = await runRestore("2026-08-30_0200");
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("rejects a correctly-named entry that is not a directory", async () => {
    const { logs, exitCodes } = await runRestore("2026-08-30_0300");
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  // Regression guard, not a discriminator: non-existence rejects this on every
  // version, including main. Kept so the plain missing-backup path stays covered.
  it("rejects a well-formed name that does not exist", async () => {
    const { logs, exitCodes } = await runRestore("2020-01-01_0000");
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("still accepts a genuine backup directory", async () => {
    // Declines at the prompt, so nothing is restored — reaching the prompt is
    // the assertion.
    const { logs, exitCodes } = await runRestore(VALID);
    expect(logs.join("\n")).toContain(ACCEPTED);
    expect(exitCodes).not.toContain(1);
  });
});

describe("tomo backup restore — swapped between validation and copy", () => {
  /** Replace the validated directory with a symlink pointing outside. */
  const swapForSymlink = (): void => {
    rmSync(validDir, { recursive: true, force: true });
    symlinkSync(paths.outside, validDir, "dir");
  };

  it("aborts when the validated directory is swapped while the prompt is pending", async () => {
    const { errors, exitCodes } = await runRestore(VALID, (async function* () {
      // The prompt is up and the command is parked on it. This is the window
      // the string-based check could not see: the name still resolves, but no
      // longer to what was validated.
      swapForSymlink();
      yield "y\n";
    })());

    expect(errors.join("\n")).toContain("changed while waiting for confirmation");
    expect(exitCodes).toContain(1);
  });

  it("leaves the live destinations untouched when it aborts", async () => {
    await runRestore(VALID, (async function* () {
      swapForSymlink();
      yield "y\n";
    })());

    // The rmSync that would have deleted this never ran...
    expect(existsSync(liveMarker)).toBe(true);
    // ...and nothing from the attacker's tree was copied in.
    expect(existsSync(join(paths.tomoHome, "data", "loot.txt"))).toBe(false);
  });

  /**
   * Replace the validated directory with a DIFFERENT ordinary directory at the
   * same pathname. Both resolutions return the identical canonical string, so
   * only filesystem identity separates them.
   *
   * Order matters: the replacement is created while the original still
   * exists (renamed aside), so the filesystem cannot hand it the inode it just
   * freed. ext4 reuses freed inodes eagerly, and an rm-then-mkdir swap on
   * Linux CI produced a "new" directory with the OLD dev+ino — indistinguishable
   * from no swap at all, which is precisely what the guard keys on.
   */
  const swapForAnotherDirectory = (): void => {
    const aside = `${validDir}.aside`;
    renameSync(validDir, aside);
    mkdirSync(join(validDir, "data"), { recursive: true });
    writeFileSync(join(validDir, "data", "loot.txt"), "attacker payload");
    rmSync(aside, { recursive: true, force: true });
  };

  it("aborts when the directory is replaced by another directory at the same path", async () => {
    const before = statSync(validDir);

    const { errors, exitCodes } = await runRestore(VALID, (async function* () {
      swapForAnotherDirectory();
      yield "y\n";
    })());

    // Guard the guard: the swap is built so the replacement cannot reuse the
    // inode (see swapForAnotherDirectory). If it ever did, there would be
    // nothing to detect and the test would pass for the wrong reason.
    const after = statSync(validDir);
    expect([after.dev, after.ino]).not.toEqual([before.dev, before.ino]);

    expect(errors.join("\n")).toContain("changed while waiting for confirmation");
    expect(exitCodes).toContain(1);
  });

  it("leaves the live destinations untouched when a same-path directory is swapped in", async () => {
    await runRestore(VALID, (async function* () {
      swapForAnotherDirectory();
      yield "y\n";
    })());

    expect(existsSync(liveMarker)).toBe(true);
    expect(existsSync(join(paths.tomoHome, "data", "loot.txt"))).toBe(false);
  });

  it("still restores normally when nothing is swapped", async () => {
    // Positive control across ALL FOUR legs: the guards must not break the
    // path they exist to protect, and a control that only checked `data`
    // would not notice if they had broken the other three.
    const { logs, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(logs.join("\n")).toContain("Restore complete.");
    expect(exitCodes).not.toContain(1);
    expect(existsSync(restoredMarker)).toBe(true);
    expect(existsSync(liveMarker)).toBe(false);
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("backup");
    expect(existsSync(join(paths.tomoHome, "workspace", "SOUL.md"))).toBe(true);
    expect(existsSync(join(paths.tomoHome, "sdk-sessions", "s.jsonl"))).toBe(true);
  });
});

describe("tomo backup restore — a leg of the backup is a symlink", () => {
  it("refuses a backup whose data/ leg redirects outside the tree", async () => {
    // dev+ino identifies the backup DIRECTORY; its children are not covered by
    // it, and this needs no race at all — the link can predate the command.
    // `existsSync` follows it, so the leg would be read from the link target
    // while the matching rmSync still deleted the live one.
    rmSync(join(validDir, "data"), { recursive: true, force: true });
    symlinkSync(join(paths.outside, "data"), join(validDir, "data"), "dir");

    const { errors, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(errors.join("\n")).toContain("symlink at data");
    expect(exitCodes).toContain(1);
  });

  it("leaves the live destinations untouched when it refuses a symlinked leg", async () => {
    rmSync(join(validDir, "data"), { recursive: true, force: true });
    symlinkSync(join(paths.outside, "data"), join(validDir, "data"), "dir");

    await runRestore(VALID, ["y\n"]);

    // Refused before ANY leg was acted on, so config.json is untouched too.
    expect(existsSync(liveMarker)).toBe(true);
    expect(existsSync(join(paths.tomoHome, "data", "loot.txt"))).toBe(false);
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("live");
  });
});

describe("tomo backup restore — a leg of the backup is the wrong kind", () => {
  it("refuses a backup whose workspace/ leg is a regular file", async () => {
    // No redirection needed: `existsSync` is true for a file, the live
    // workspace would be deleted, and the file copied into its place.
    rmSync(join(validDir, "workspace"), { recursive: true, force: true });
    writeFileSync(join(validDir, "workspace"), "not a directory");

    const { errors, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(errors.join("\n")).toContain("non-directory at workspace");
    expect(exitCodes).toContain(1);
    // Refused before ANY leg was acted on: config.json comes first and is intact.
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("live");
    expect(existsSync(join(paths.tomoHome, "workspace"))).toBe(true);
    expect(statSync(join(paths.tomoHome, "workspace")).isDirectory()).toBe(true);
    expect(existsSync(liveMarker)).toBe(true);
  });

  it("refuses a backup whose config.json leg is a directory", async () => {
    rmSync(join(validDir, "config.json"), { force: true });
    mkdirSync(join(validDir, "config.json"));

    const { errors, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(errors.join("\n")).toContain("non-file at config.json");
    expect(exitCodes).toContain(1);
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("live");
    expect(existsSync(liveMarker)).toBe(true);
  });
});
