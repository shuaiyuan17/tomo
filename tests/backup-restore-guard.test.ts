import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Rebuilt per test: several cases mutate the tree on purpose. */
function buildFixture(): void {
  rmSync(paths.home, { recursive: true, force: true });
  rmSync(paths.outside, { recursive: true, force: true });

  mkdirSync(join(validDir, "data"), { recursive: true });
  writeFileSync(join(validDir, "data", "restored.txt"), "from backup");

  // Somewhere outside the backups root for a link to point at.
  mkdirSync(join(paths.outside, "data"), { recursive: true });
  writeFileSync(join(paths.outside, "data", "loot.txt"), "attacker payload");

  // A correctly-named SYMLINK to a directory outside the root. Shape check
  // passes, existsSync passes (it follows the link), and restore would then
  // read from there while deleting the live destinations.
  symlinkSync(paths.outside, join(paths.backups, "2026-08-30_0200"), "dir");
  // A correctly-named regular file, which is not restorable either.
  writeFileSync(join(paths.backups, "2026-08-30_0300"), "not a directory");

  // Live data the restore would overwrite.
  mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
  writeFileSync(liveMarker, "live");
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
    const { logs, exitCodes } = await runRestore(`../../../${VALID}`);
    expect(logs.join("\n")).not.toContain(ACCEPTED);
    expect(exitCodes).toContain(1);
  });

  it("rejects an absolute path", async () => {
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

  it("still restores normally when nothing is swapped", async () => {
    // Positive control: the re-check must not break the path it guards.
    const { logs, exitCodes } = await runRestore(VALID, ["y\n"]);

    expect(logs.join("\n")).toContain("Restore complete.");
    expect(exitCodes).not.toContain(1);
    expect(existsSync(restoredMarker)).toBe(true);
    expect(existsSync(liveMarker)).toBe(false);
  });
});
