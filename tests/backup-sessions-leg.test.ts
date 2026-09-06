import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { join } from "node:path";

/**
 * `SESSIONS_DIR` moves the session registry and every transcript out of
 * `~/.tomo/data` (runtime-paths.ts). `tomo backup create` copied `data/` and
 * nothing else, so on an overridden install it printed "Backup complete" over
 * an archive with no conversation history in it at all — and the restore that
 * came back empty was the first anyone heard about it.
 *
 * HERMETIC. `HOME` is redirected in a hoisted block, before any module under
 * test is imported and therefore before `BACKUPS_DIR` (computed at module
 * load from `homedir()`) exists; `node:os`, `src/config.js` and the daemon PID
 * path are mocked to the same temp tree. Nothing here can touch the real
 * `~/Backups/tomo`, `~/.tomo`, or a running daemon.
 */
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-backup-sessions-${process.pid}`;
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    originalHome,
    backups: `${home}/Backups/tomo`,
    tomoHome: `${home}/.tomo`,
    // The whole point: OUTSIDE `~/.tomo/data`, as SESSIONS_DIR allows.
    sessionsDir: `${home}/elsewhere/sessions`,
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

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
const { backupCommand, setPromptOutput } = await import("../src/cli/backup.js");

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

/** A live install whose transcripts sit outside `~/.tomo/data`. */
function liveFixture(): void {
  mkdirSync(join(paths.tomoHome, "data", "cron"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "data", "cron", "jobs.json"), '{"jobs":[]}');
  writeFileSync(join(paths.tomoHome, "config.json"), '{"channels":{}}');
  mkdirSync(join(paths.tomoHome, "workspace", "memory"), { recursive: true });
  writeFileSync(join(paths.tomoHome, "workspace", "memory", "MEMORY.md"), "# memory");
  mkdirSync(paths.sessionsDir, { recursive: true });
  writeFileSync(join(paths.sessionsDir, "registry.json"), '{"version":1,"sessions":[]}');
  writeFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), '{"text":"the only copy"}\n');
}

function silenceConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  return { logs, errors };
}

function onlyBackup(): string {
  const names = readdirSync(paths.backups);
  expect(names).toHaveLength(1);
  return join(paths.backups, names[0]);
}

describe("tomo backup create — SESSIONS_DIR outside data/", () => {
  it("copies the sessions dir instead of reporting a complete backup without it", async () => {
    liveFixture();
    const { logs } = silenceConsole();

    await backupCommand.parseAsync(["create"], { from: "user" });

    const backup = onlyBackup();
    // The claim the command makes...
    expect(logs.join("\n")).toContain("Backup complete");
    // ...and the transcripts it used to be making it without.
    expect(existsSync(join(backup, "sessions"))).toBe(true);
    expect(readFileSync(join(backup, "sessions", "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(readFileSync(join(backup, "sessions", "registry.json"), "utf-8")).toContain("sessions");
    expect(logs.join("\n")).toContain("[ok] sessions/");
  });
});

describe("tomo backup restore — SESSIONS_DIR outside data/", () => {
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

  it("puts the transcripts back where this install keeps them", async () => {
    liveFixture();
    {
      const restore = silenceConsole();
      await backupCommand.parseAsync(["create"], { from: "user" });
      expect(restore.errors).toEqual([]);
      vi.restoreAllMocks();
    }
    const name = readdirSync(paths.backups)[0];

    // Lose the live transcripts, exactly as a disk failure or a bad
    // SESSIONS_DIR edit would.
    rmSync(paths.sessionsDir, { recursive: true, force: true });

    const { logs } = await runRestore(name);

    expect(logs.join("\n")).toContain("Restore complete.");
    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(logs.join("\n")).toContain("[ok] sessions/");
  });
});
