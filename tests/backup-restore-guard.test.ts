import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake home. Computed from literals so it is available inside the hoisted
// mock factories, which run before this file's imports: BACKUPS_DIR is
// `join(homedir(), "Backups", "tomo")`, resolved at module load, and without
// this it would resolve into the reviewer's real home.
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-backup-guard-${process.pid}`;
  return { home, backups: `${home}/Backups/tomo`, tomoHome: `${home}/.tomo` };
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

/** Somewhere outside the backups root for a link to point at. */
let outside: string;

beforeAll(() => {
  mkdirSync(paths.backups, { recursive: true });
  mkdirSync(paths.tomoHome, { recursive: true });

  // A genuine backup.
  mkdirSync(join(paths.backups, "2026-08-30_0142", "data"), { recursive: true });

  // A correctly-named SYMLINK to a directory outside the root. Shape check
  // passes, existsSync passes (it follows the link), and restore would then
  // read from there while deleting the live destinations.
  outside = mkdtempSync(join(tmpdir(), "tomo-backup-outside-"));
  mkdirSync(join(outside, "data"), { recursive: true });
  try { symlinkSync(outside, join(paths.backups, "2026-08-30_0200"), "dir"); } catch { /* exists */ }

  // A correctly-named regular file, which is not restorable either.
  writeFileSync(join(paths.backups, "2026-08-30_0300"), "not a directory");
});

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface RunResult { logs: string[]; errors: string[]; exitCodes: number[] }

let restoreStdin: (() => void) | undefined;

beforeEach(() => {
  const original = process.stdin;
  // `confirm()` opens a readline on stdin. Feed it a decline so a command that
  // wrongly REACHES the prompt aborts cleanly instead of hanging the suite —
  // the assertion is that the prompt is never reached at all.
  const fake = Readable.from(["n\n"]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  restoreStdin = () => Object.defineProperty(process, "stdin", { value: original, configurable: true });
});

afterEach(() => { restoreStdin?.(); vi.restoreAllMocks(); });

async function runRestore(arg: string): Promise<RunResult> {
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
    const { logs, exitCodes } = await runRestore("../../../2026-08-30_0142");
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
    // Declines at the prompt, so nothing is actually restored — reaching the
    // prompt is the assertion.
    const { logs, exitCodes } = await runRestore("2026-08-30_0142");
    expect(logs.join("\n")).toContain(ACCEPTED);
    expect(exitCodes).not.toContain(1);
  });
});
