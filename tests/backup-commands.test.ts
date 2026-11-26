import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runBackupCommand } from "./helpers/backup-cli.js";

/**
 * `tomo backup create` and `restore` end to end, for what the restore suite
 * (backup-restore.test.ts) does not cover: where the sessions leg goes, the
 * retention prune, and the "daemon is running" refusal.
 *
 * HERMETIC. `HOME` is redirected in a hoisted block, before any module under
 * test is imported and therefore before `BACKUPS_DIR` (computed at module
 * load from `homedir()`) exists; `node:os`, `src/config.js` and the daemon PID
 * path are mocked to the same temp tree. Nothing here can touch the real
 * `~/Backups/tomo`, `~/.tomo`, or a running daemon. The retention override is
 * cleared before the module reads it, so the prune runs on the default.
 */
const paths = vi.hoisted(() => {
  const home = `/tmp/tomo-backup-commands-${process.pid}`;
  const originalHome = process.env.HOME;
  const originalRetention = process.env.TOMO_BACKUP_RETENTION_DAYS;
  process.env.HOME = home;
  delete process.env.TOMO_BACKUP_RETENTION_DAYS;
  const tomoHome = `${home}/.tomo`;
  return {
    home,
    originalHome,
    originalRetention,
    backups: `${home}/Backups/tomo`,
    tomoHome,
    // Read lazily by the config mock, so each describe picks its install:
    // a SESSIONS_DIR outside `~/.tomo/data`, or the default inside it.
    sessionsDir: `${tomoHome}/data/sessions`,
    /** Absent unless a test writes it: the restore's daemon guard reads it. */
    pidFile: `${tomoHome}/tomo.pid`,
  };
});
const OVERRIDDEN_SESSIONS = `${paths.home}/elsewhere/sessions`;
const DEFAULT_SESSIONS = `${paths.tomoHome}/data/sessions`;

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => paths.home }, homedir: () => paths.home };
});

vi.mock("../src/config.js", () => ({
  config: {
    tomoHome: paths.tomoHome,
    workspaceDir: join(paths.tomoHome, "workspace"),
    get sessionsDir() { return paths.sessionsDir; },
    sdkSessionsDir: join(paths.tomoHome, "sdk-sessions"),
    dbPath: join(paths.tomoHome, "data", "tomo.db"),
  },
  CONFIG_PATH: join(paths.tomoHome, "config.json"),
}));

vi.mock("../src/runtime-paths.js", () => ({
  defaultRuntimePaths: {
    tomoHome: paths.tomoHome,
    pidFile: paths.pidFile,
    watchSocketPath: join(paths.tomoHome, "watch.sock"),
  },
}));

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
const { backupCommand, setPromptOutput, DEFAULT_RETENTION_DAYS } = await import("../src/cli/backup.js");

const run = (argv: string[], answer?: string[]) => runBackupCommand(backupCommand, setPromptOutput, argv, answer);

afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true });
  if (paths.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = paths.originalHome;
  if (paths.originalRetention !== undefined) process.env.TOMO_BACKUP_RETENTION_DAYS = paths.originalRetention;
});

beforeEach(() => {
  rmSync(paths.home, { recursive: true, force: true });
  paths.sessionsDir = DEFAULT_SESSIONS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A live install whose transcripts sit in `paths.sessionsDir`. */
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

/** The backup directory name `create` would give a backup taken at `date`. */
function backupName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * `SESSIONS_DIR` moves the session registry and every transcript out of
 * `~/.tomo/data` (runtime-paths.ts). `tomo backup create` copied `data/` and
 * nothing else, so on an overridden install it printed "Backup complete" over
 * an archive with no conversation history in it at all — and the restore that
 * came back empty was the first anyone heard about it.
 */
describe("SESSIONS_DIR outside data/", () => {
  beforeEach(() => { paths.sessionsDir = OVERRIDDEN_SESSIONS; });

  it("create copies the sessions dir instead of reporting a complete backup without it", async () => {
    liveFixture();

    const { logs } = await run(["create"]);

    const names = readdirSync(paths.backups);
    expect(names).toHaveLength(1);
    const backup = join(paths.backups, names[0]);
    // The claim the command makes...
    expect(logs.join("\n")).toContain("Backup complete");
    // ...and the transcripts it used to be making it without.
    expect(readFileSync(join(backup, "sessions", "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(readFileSync(join(backup, "sessions", "registry.json"), "utf-8")).toContain("sessions");
    expect(logs.join("\n")).toContain("[ok] sessions/");
  });

  it("restore puts the transcripts back where this install keeps them", async () => {
    liveFixture();
    expect((await run(["create"])).errors).toEqual([]);
    const name = readdirSync(paths.backups)[0];

    // Lose the live transcripts, exactly as a disk failure or a bad
    // SESSIONS_DIR edit would.
    rmSync(paths.sessionsDir, { recursive: true, force: true });

    const { logs } = await run(["restore", name]);

    expect(logs.join("\n")).toContain("Restore complete.");
    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(logs.join("\n")).toContain("[ok] sessions/");
  });
});

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
 */
describe("restore: backup has sessions/, this install has no SESSIONS_DIR", () => {
  const BACKUP_NAME = "2026-01-01_1200";

  /**
   * A backup written by an install whose `SESSIONS_DIR` pointed outside
   * `data/`: `data/` carries no transcripts, and the separate `sessions/` leg
   * carries all of them.
   */
  function backupFromOverriddenInstall(): void {
    const backup = join(paths.backups, BACKUP_NAME);
    mkdirSync(join(backup, "data", "cron"), { recursive: true });
    writeFileSync(join(backup, "data", "cron", "jobs.json"), '{"jobs":[]}');
    writeFileSync(join(backup, "config.json"), '{"channels":{}}');
    mkdirSync(join(backup, "sessions"), { recursive: true });
    writeFileSync(join(backup, "sessions", "registry.json"), '{"version":1,"sessions":[]}');
    writeFileSync(join(backup, "sessions", "dm-owner.jsonl"), '{"text":"the only copy"}\n');
  }

  /** The live install this restores onto: default paths, no transcripts left. */
  function liveDefaultInstall(): void {
    mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
    writeFileSync(join(paths.tomoHome, "config.json"), '{"channels":{}}');
  }

  it("restores the transcripts into the default sessions dir, alongside the rest, instead of dropping the leg", async () => {
    backupFromOverriddenInstall();
    liveDefaultInstall();

    const { logs, errors } = await run(["restore", BACKUP_NAME]);

    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Restore complete.");
    // The claim the command was making with nothing behind it.
    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
    expect(readFileSync(join(paths.sessionsDir, "registry.json"), "utf-8")).toContain("sessions");
    expect(logs.join("\n")).toContain("[ok] sessions/");
    // ...and the rest of the restore is intact beside it.
    expect(logs.join("\n")).toContain("[ok] data/");
    expect(readFileSync(join(paths.tomoHome, "data", "cron", "jobs.json"), "utf-8")).toBe('{"jobs":[]}');
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toBe('{"channels":{}}');
  });

  it("replaces transcripts already sitting in the default location", async () => {
    backupFromOverriddenInstall();
    liveDefaultInstall();
    mkdirSync(paths.sessionsDir, { recursive: true });
    writeFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), '{"text":"stale"}\n');

    await run(["restore", BACKUP_NAME]);

    expect(readFileSync(join(paths.sessionsDir, "dm-owner.jsonl"), "utf-8")).toBe('{"text":"the only copy"}\n');
  });
});

/**
 * `create` deletes every backup older than the retention window. It is the
 * one path in the command that removes data the user did not name, so what it
 * may touch is pinned: only directories with a backup's exact name, only past
 * the window, never the backup it just made.
 */
describe("create: retention prune", () => {
  const DAY = 86_400_000;

  it("removes only backup directories past the window, keeping newer ones, foreign entries and the new backup", async () => {
    liveFixture();
    const expired = backupName(new Date(Date.now() - (DEFAULT_RETENTION_DAYS + 3) * DAY));
    const recent = backupName(new Date(Date.now() - 2 * DAY));
    for (const name of [expired, recent]) {
      mkdirSync(join(paths.backups, name, "data"), { recursive: true });
      writeFileSync(join(paths.backups, name, "config.json"), "{}");
    }
    // Old by date, but not something this command made: never touched.
    mkdirSync(join(paths.backups, "2020-01-01_0000-keep"), { recursive: true });
    mkdirSync(join(paths.backups, "notes"), { recursive: true });
    writeFileSync(join(paths.backups, "2020-01-01_0001"), "a file with a backup's name");

    const { logs } = await run(["create"]);

    const left = readdirSync(paths.backups).sort();
    expect(left).not.toContain(expired);
    expect(left).toContain(recent);
    expect(left).toEqual(expect.arrayContaining(["2020-01-01_0000-keep", "notes", "2020-01-01_0001"]));
    // The backup it just made: the one name that is neither seeded nor foreign.
    const created = left.filter((n) => ![recent, "2020-01-01_0000-keep", "notes", "2020-01-01_0001"].includes(n));
    expect(created).toHaveLength(1);
    expect(existsSync(join(paths.backups, created[0], "config.json"))).toBe(true);
    expect(logs.join("\n")).toContain(`Pruned 1 backup(s) older than ${DEFAULT_RETENTION_DAYS} days.`);
  });

  it("prunes nothing, and says nothing about it, when every backup is inside the window", async () => {
    liveFixture();
    const recent = backupName(new Date(Date.now() - DAY));
    mkdirSync(join(paths.backups, recent), { recursive: true });

    const { logs } = await run(["create"]);

    expect(readdirSync(paths.backups)).toContain(recent);
    expect(logs.join("\n")).not.toContain("Pruned");
  });
});

describe("restore: refuses while the daemon runs", () => {
  const BACKUP_NAME = "2026-01-01_1200";

  function backupAndLive(): void {
    mkdirSync(join(paths.backups, BACKUP_NAME, "data"), { recursive: true });
    writeFileSync(join(paths.backups, BACKUP_NAME, "data", "restored.txt"), "from backup");
    writeFileSync(join(paths.backups, BACKUP_NAME, "config.json"), '{"from":"backup"}');
    mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
    writeFileSync(join(paths.tomoHome, "data", "live.txt"), "live");
    writeFileSync(join(paths.tomoHome, "config.json"), '{"from":"live"}');
  }

  it("refuses, touching nothing, when the pid file names a live process", async () => {
    backupAndLive();
    // A legacy one-line pid file: no identity line, so plain liveness decides,
    // and this test process is certainly alive.
    writeFileSync(paths.pidFile, `${process.pid}\n`);

    const { errors, exitCodes } = await run(["restore", BACKUP_NAME]);

    expect(errors.join("\n")).toContain("Tomo daemon is running");
    expect(exitCodes).toContain(1);
    expect(readFileSync(join(paths.tomoHome, "data", "live.txt"), "utf-8")).toBe("live");
    expect(existsSync(join(paths.tomoHome, "data", "restored.txt"))).toBe(false);
    expect(readFileSync(join(paths.tomoHome, "config.json"), "utf-8")).toContain("live");
  });

  it("goes ahead over a stale pid file whose process is gone", async () => {
    backupAndLive();
    // The pid of a child that has already exited and been reaped.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(paths.pidFile, `${gone}\n`);

    const { logs, exitCodes } = await run(["restore", BACKUP_NAME]);

    expect(exitCodes).not.toContain(1);
    expect(logs.join("\n")).toContain("Restore complete.");
    expect(readFileSync(join(paths.tomoHome, "data", "restored.txt"), "utf-8")).toBe("from backup");
  });
});

/**
 * Tomo's database is never file-copied: a copy of a live tomo.db and its -wal
 * can come from two moments. `create` writes one VACUUM INTO snapshot (WAL
 * content included), and `restore` checks the database before anything moves.
 */
describe("the database (data/tomo.db)", () => {
  const dbPath = () => join(paths.tomoHome, "data", "tomo.db");

  it("create writes a consistent snapshot, rows still in the WAL included, and no -wal/-shm", async () => {
    liveFixture();
    const { openTomoDb } = await import("../src/db/index.js");
    // Held open, like the daemon's connection: the row lives in the -wal.
    const live = openTomoDb(dbPath());
    live.run("INSERT INTO pending_notes (session_key, position, note) VALUES ('dm:owner', 0, 'only in the wal')");
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);
    try {
      const { logs, exitCodes } = await run(["create"]);
      expect(exitCodes).toEqual([]);
      expect(logs.join("\n")).toContain("data/tomo.db (consistent snapshot)");
    } finally {
      live.close();
    }
    const backup = join(paths.backups, readdirSync(paths.backups)[0]);
    expect(readdirSync(join(backup, "data")).filter((f) => f.startsWith("tomo.db"))).toEqual(["tomo.db"]);
    const copy = openTomoDb(join(backup, "data", "tomo.db"), { readOnly: true });
    expect(copy.all("SELECT note FROM pending_notes")).toEqual([{ note: "only in the wal" }]);
    copy.close();
  });

  it("restore refuses a backup whose database fails integrity_check, and replaces nothing", async () => {
    liveFixture();
    const { openTomoDb } = await import("../src/db/index.js");
    openTomoDb(dbPath()).close();
    expect((await run(["create"])).exitCodes).toEqual([]);
    const name = readdirSync(paths.backups)[0];
    writeFileSync(join(paths.backups, name, "data", "tomo.db"), "garbage ".repeat(600));
    writeFileSync(join(paths.tomoHome, "data", "cron", "jobs.json"), '{"jobs":["live"]}');

    const { errors, exitCodes } = await run(["restore", name]);
    expect(exitCodes).toEqual([1]);
    expect(errors.join("\n")).toMatch(/data\/: staged copy failed its check/);
    expect(errors.join("\n")).toContain("Nothing was replaced");
    expect(readFileSync(join(paths.tomoHome, "data", "cron", "jobs.json"), "utf-8")).toBe('{"jobs":["live"]}');
  });
});
