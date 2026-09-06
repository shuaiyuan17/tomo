import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { join } from "node:path";

/**
 * Restoring a backup taken on a `SESSIONS_DIR` install onto one WITHOUT the
 * override.
 *
 * The restore's `sessions/` leg used to be gated on `externalSessionsDir()`,
 * which answers null when this install keeps its transcripts inside
 * `~/.tomo/data`. A null dest dropped the leg silently: the command printed
 * "Restore complete." over a `sessions/` directory in the backup that nobody
 * read, and the operator's conversation history was gone. Nothing in the output
 * mentioned it — the same failure shape, in the same command, that the backup
 * half of this bug had.
 *
 * HERMETIC, the same way `backup-sessions-leg.test.ts` is: `HOME` is redirected
 * in a hoisted block before any module under test is imported, and `node:os`,
 * `src/config.js` and the daemon PID path are mocked to the same temp tree.
 * The difference is the one the test is about — `sessionsDir` here is the
 * DEFAULT, inside `data/`.
 */
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-backup-default-sessions-${process.pid}`;
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const tomoHome = `${home}/.tomo`;
  return {
    home,
    originalHome,
    backups: `${home}/Backups/tomo`,
    tomoHome,
    // No SESSIONS_DIR override: runtime-paths' default, inside data/.
    sessionsDir: `${tomoHome}/data/sessions`,
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
    sessionsDir: paths.sessionsDir,
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

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { backupCommand, setPromptOutput } = await import("../src/cli/backup.js");

const BACKUP_NAME = "2026-01-01_1200";

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  if (paths.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = paths.originalHome;
});

beforeEach(() => {
  rmSync(paths.home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A backup written by an install whose `SESSIONS_DIR` pointed outside `data/`:
 * `data/` carries no transcripts, and the separate `sessions/` leg carries all
 * of them.
 */
function backupFromOverriddenInstall(): string {
  const backup = join(paths.backups, BACKUP_NAME);
  mkdirSync(join(backup, "data", "cron"), { recursive: true });
  writeFileSync(join(backup, "data", "cron", "jobs.json"), '{"jobs":[]}');
  writeFileSync(join(backup, "config.json"), '{"channels":{}}');
  mkdirSync(join(backup, "sessions"), { recursive: true });
  writeFileSync(join(backup, "sessions", "registry.json"), '{"version":1,"sessions":[]}');
  writeFileSync(join(backup, "sessions", "dm-owner.jsonl"), '{"text":"the only copy"}\n');
  return backup;
}

/** The live install this restores onto: default paths, no transcripts left. */
function liveDefaultInstall(): void {
  mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "config.json"), '{"channels":{}}');
}

function silenceConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  return { logs, errors };
}

async function runRestore(name: string): Promise<{ logs: string[]; errors: string[] }> {
  const original = process.stdin;
  const fake = Readable.from(["y\n"]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const originalPrompt = setPromptOutput(sink);
  const captured = silenceConsole();
  try {
    await backupCommand.parseAsync(["restore", name], { from: "user" });
  } finally {
    Object.defineProperty(process, "stdin", { value: original, configurable: true });
    setPromptOutput(originalPrompt);
  }
  return captured;
}

describe("tomo backup restore — backup has sessions/, this install has no SESSIONS_DIR", () => {
  it("restores the transcripts into the default sessions dir instead of dropping the leg", async () => {
    backupFromOverriddenInstall();
    liveDefaultInstall();

    const { logs, errors } = await runRestore(BACKUP_NAME);

    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Restore complete.");
    // The claim the command was making with nothing behind it.
    expect(existsSync(join(paths.sessionsDir, "dm-owner.jsonl"))).toBe(true);
    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(readFileSync(join(paths.sessionsDir, "registry.json"), "utf-8")).toContain("sessions");
    expect(logs.join("\n")).toContain("[ok] sessions/");
  });

  it("keeps the rest of the restore intact alongside it", async () => {
    backupFromOverriddenInstall();
    liveDefaultInstall();

    const { logs } = await runRestore(BACKUP_NAME);

    expect(logs.join("\n")).toContain("[ok] data/");
    expect(readFileSync(join(paths.tomoHome, "data", "cron", "jobs.json"), "utf-8")).toBe('{"jobs":[]}');
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toBe('{"channels":{}}');
  });

  it("replaces transcripts already sitting in the default location", async () => {
    backupFromOverriddenInstall();
    liveDefaultInstall();
    mkdirSync(paths.sessionsDir, { recursive: true });
    writeFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), '{"text":"stale"}\n');

    await runRestore(BACKUP_NAME);

    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
  });
});
