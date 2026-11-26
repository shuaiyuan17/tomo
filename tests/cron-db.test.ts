import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Cron jobs in tomo.db: the one-time import of data/cron/jobs.json (daemon
// only), the placeholder an older Tomo cannot read as "no jobs", the rollback
// export, and real processes (the `tomo cron` CLI) writing while the daemon
// does.
// ---------------------------------------------------------------------------

/**
 * The rename that lands a file at data/cron/jobs.json (the placeholder after
 * an import, the rollback export): `failLegacyRename` makes it fail, as a
 * crash just before it would leave things; `onLegacyRename` runs just before it.
 */
const fsHook = vi.hoisted(() => ({ failLegacyRename: false, failLegacyChmod: false, onLegacyRename: null as null | (() => void) }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (String(to).endsWith(`cron/jobs.json`)) {
        fsHook.onLegacyRename?.();
        if (fsHook.failLegacyRename) throw Object.assign(new Error("EIO: crash"), { code: "EIO" });
      }
      return actual.renameSync(from, to);
    },
    chmodSync: (path: string, mode: number) => {
      if (fsHook.failLegacyChmod && String(path).endsWith("cron/jobs.json")) throw Object.assign(new Error("EPERM: chmod"), { code: "EPERM" });
      return actual.chmodSync(path, mode);
    },
  };
});

const { CronStore, CronStoreReadError, CRON_EXPORTED_KEY, CRON_IMPORTED_KEY, exportCronJobsToFile, importLegacyCronJobs, legacyCronJobsPath, parseCronStore } = await import("../src/cron/store.js");
const { openTomoDb } = await import("../src/db/index.js");
/** The TomoDb a store writes through (any open one has the same prototype). */
const sharedConnection = (_store: unknown) => { const db = openTomoDb(dbPath); db.close(); return db; };

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let home: string;
let dbPath: string;
let legacy: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tomo-cron-db-"));
  dbPath = join(home, ".tomo", "data", "tomo.db");
  legacy = legacyCronJobsPath(dbPath);
  fsHook.failLegacyRename = false;
  fsHook.failLegacyChmod = false;
  fsHook.onLegacyRename = null;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `job ${id}`, enabled: true, schedule: { kind: "every", everyMs: 3_600_000 }, message: "m", sessionKey: "dm:alice",
  deleteAfterRun: false, createdAt: 1, nextRunAt: Date.now() + 3_600_000, lastRunAt: null, lastStatus: null, ...extra,
});

function writeLegacy(jobs: unknown[]): string {
  mkdirSync(join(home, ".tomo", "data", "cron"), { recursive: true });
  const text = JSON.stringify({ version: 1, revision: 4, jobs });
  writeFileSync(legacy, text);
  return text;
}

const migrated = () => readdirSync(join(home, ".tomo", "data", "cron")).filter((n) => n.startsWith("jobs.json.migrated-"));
const meta = (key: string) => {
  const db = openTomoDb(dbPath);
  try { return db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value; } finally { db.close(); }
};

/** `tomo <args>` as its own process, HOME in the scratch directory. */
function tomo(...args: string[]) {
  return spawnSync(TSX, [CLI, ...args], { env: { ...process.env, HOME: home, TOMO_SESSION_KEY: "" }, encoding: "utf-8", timeout: 60_000 });
}
function tomoAsync(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(TSX, [CLI, ...args], { env: { ...process.env, HOME: home, TOMO_SESSION_KEY: "" } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (c) => { stdout += String(c); });
  child.stderr.on("data", (c) => { stderr += String(c); });
  return new Promise((resolve) => child.on("exit", (status) => resolve({ status, stdout, stderr })));
}

describe("importing data/cron/jobs.json", () => {
  it("imports once, keeps the file as .migrated-<ts>, and leaves a placeholder an older Tomo refuses", () => {
    const jobs = [job("aaaa0001", { lastRunId: "r1", lastCompletedRunId: "r0", lastStartedAt: 5 }), job("aaaa0002")];
    const text = writeLegacy(jobs);
    expect(importLegacyCronJobs(dbPath)).toMatchObject({ kind: "imported", jobs: 2 });

    // Every field as it was, in file order: the run token says "interrupted".
    expect(new CronStore(dbPath).list()).toEqual(jobs);
    expect(migrated()).toHaveLength(1);
    expect(readFileSync(join(home, ".tomo", "data", "cron", migrated()[0]), "utf-8")).toBe(text);
    // The placeholder is not a jobs file: the old parser (the same function) refuses it.
    expect(() => parseCronStore(legacy, readFileSync(legacy, "utf-8"))).toThrow(CronStoreReadError);
    expect(meta(CRON_IMPORTED_KEY)).toBeTruthy();

    // A second start changes nothing.
    new CronStore(dbPath).remove("aaaa0002");
    expect(importLegacyCronJobs(dbPath)).toEqual({ kind: "none" });
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual(["aaaa0001"]);
  });

  it("a fresh install gets the placeholder too", () => {
    expect(importLegacyCronJobs(dbPath)).toEqual({ kind: "none" });
    expect(JSON.parse(readFileSync(legacy, "utf-8"))).toMatchObject({ movedToDatabase: dbPath });
    expect(new CronStore(dbPath).list()).toEqual([]);
  });

  it("a crash between the commit and the placeholder leaves the file in place (never a missing file), and does not import it again over newer rows", () => {
    const text = writeLegacy([job("aaaa0001")]);
    fsHook.failLegacyRename = true;
    importLegacyCronJobs(dbPath);
    // An older Tomo started now still finds its jobs: a missing file would read as a fresh install.
    expect(readFileSync(legacy, "utf-8")).toBe(text);
    expect(meta(CRON_IMPORTED_KEY)).toBeTruthy();

    // The daemon runs on: a dispatch is recorded. Other processes do not
    // refuse over a file that is already in the table.
    const runId = new CronStore(dbPath).markStarted("aaaa0001");
    expect(runId).toBeTruthy();

    // Next start: the file is replaced, not imported again (that would erase the run token).
    fsHook.failLegacyRename = false;
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).get("aaaa0001")?.lastRunId).toBe(runId);
    expect(migrated()).toHaveLength(1);
    expect(JSON.parse(readFileSync(legacy, "utf-8"))).toHaveProperty("movedToDatabase");
  });

  it("a backup that copied data/ before the first import (its database snapshot after) restores without bringing back deleted jobs", () => {
    // `tomo backup create` copies data/ (the old jobs file), the daemon's
    // first start imports it, jobs change, then the backup snapshots the database.
    const text = writeLegacy([job("aaaa0001"), job("aaaa0002")]);
    importLegacyCronJobs(dbPath);
    const store = new CronStore(dbPath);
    store.remove("aaaa0002");
    const runId = store.markStarted("aaaa0001");
    // Restored: the old file is back beside that database.
    writeFileSync(legacy, text);
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual(["aaaa0001"]);
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual(["aaaa0001"]);
    expect(new CronStore(dbPath).get("aaaa0001")?.lastRunId).toBe(runId);
    expect(JSON.parse(readFileSync(legacy, "utf-8"))).toHaveProperty("movedToDatabase");
  });

  it("after a rollback export, the file an older Tomo kept replaces the table (its deletions stand)", () => {
    importLegacyCronJobs(dbPath);
    const store = new CronStore(dbPath);
    const kept = store.add({ name: "kept", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    store.add({ name: "deleted by the older Tomo", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    const db = openTomoDb(dbPath);
    try { exportCronJobsToFile(db, legacy, { mark: true }); } finally { db.close(); }
    // The older Tomo removes one job and adds another.
    const file = JSON.parse(readFileSync(legacy, "utf-8"));
    file.jobs = [file.jobs[0], job("bbbb0001")];
    writeFileSync(legacy, JSON.stringify(file));
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual([kept.id, "bbbb0001"]);
    expect(meta(CRON_EXPORTED_KEY)).toBeUndefined();
  });

  it("without an export, a file an older Tomo started anew is merged in: no job in the table is lost", () => {
    // Downgraded without exporting: the older Tomo refuses the placeholder and
    // says "fix or remove the file ... the daemon recreates it empty". Removed,
    // it starts a new jobs file with only what was added since.
    importLegacyCronJobs(dbPath);
    const kept = new CronStore(dbPath).add({ name: "in the table", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    rmSync(legacy);
    writeLegacy([job("bbbb0001")]);
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual([kept.id, "bbbb0001"]);
  });

  it("leaves a file that will not read where it is; every cron call refuses until it is fixed", () => {
    mkdirSync(join(home, ".tomo", "data", "cron"), { recursive: true });
    writeFileSync(legacy, "{ not json");
    expect(importLegacyCronJobs(dbPath)).toMatchObject({ kind: "unreadable" });
    expect(readFileSync(legacy, "utf-8")).toBe("{ not json");
    expect(() => new CronStore(dbPath).list()).toThrow(CronStoreReadError);
  });

  // root reads through any permission.
  it.skipIf(process.getuid?.() === 0)("a jobs file it cannot reach (no search permission on data/cron) refuses, not reads as absent", () => {
    writeLegacy([job("aaaa0001")]);
    const dir = join(home, ".tomo", "data", "cron");
    chmodSync(dir, 0o000);
    try {
      expect(importLegacyCronJobs(dbPath)).toMatchObject({ kind: "unreadable" });
      expect(() => new CronStore(dbPath).list()).toThrow(CronStoreReadError);
      expect(() => new CronStore(dbPath).add({ name: "x", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" })).toThrow(CronStoreReadError);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("only the daemon imports: `tomo cron` refuses while the file waits, and works once it is in", { timeout: 60_000 }, () => {
    writeLegacy([job("aaaa0001")]);
    const refused = tomo("cron", "add", "--name", "x", "--schedule", "every 1h", "--message", "x", "--session", "dm:alice");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("has not been imported into the database yet");
    expect(tomo("cron", "list").status).toBe(1);

    importLegacyCronJobs(dbPath);
    expect(tomo("cron", "add", "--name", "x", "--schedule", "every 1h", "--message", "x", "--session", "dm:alice").status).toBe(0);
    expect(new CronStore(dbPath).list().map((j) => j.name)).toEqual(["job aaaa0001", "x"]);
  });
});

describe("tomo db export cron (rollback)", () => {
  it("writes the old jobs file over the placeholder; cron then refuses until this Tomo imports it again", { timeout: 60_000 }, () => {
    importLegacyCronJobs(dbPath);
    const store = new CronStore(dbPath);
    const a = store.add({ name: "a", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    store.markStarted(a.id);
    const before = store.list();

    const run = tomo("db", "export", "cron");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Wrote 1 job(s)");
    const file = JSON.parse(readFileSync(legacy, "utf-8"));
    // The old format, every field kept: what the older Tomo reads.
    expect(file).toEqual({ version: 1, revision: 1, exportedAt: expect.any(String), jobs: before });
    expect(parseCronStore(legacy, readFileSync(legacy, "utf-8")).jobs).toEqual(before);

    // The file is the truth now: nothing may write the table behind its back.
    expect(tomo("cron", "list").status).toBe(1);
    // A second export would overwrite what an older Tomo may have written since.
    expect(tomo("db", "export", "cron").status).toBe(1);

    // Upgrading again (or calling the rollback off): the start imports it.
    expect(importLegacyCronJobs(dbPath)).toMatchObject({ kind: "imported", jobs: 1 });
    expect(new CronStore(dbPath).list()).toEqual(before);
    expect(tomo("cron", "list").status).toBe(0);
  });

  it("a backup spanning the first import and a later rollback export restores the newer table, not the old file", () => {
    // The backup copied data/ (the original jobs file); then the import, a
    // change, a stop and an export's mark, all before its database snapshot.
    const text = writeLegacy([job("aaaa0001"), job("aaaa0002")]);
    importLegacyCronJobs(dbPath);
    new CronStore(dbPath).remove("aaaa0002");
    const added = new CronStore(dbPath).add({ name: "new", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    const db = openTomoDb(dbPath);
    try { exportCronJobsToFile(db, legacy, { mark: true }); } finally { db.close(); }
    // Restored: the original file beside that database (mark and all).
    writeFileSync(legacy, text);
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual(["aaaa0001", added.id]);
    expect(meta(CRON_EXPORTED_KEY)).toBeUndefined();
  });

  it("the mark is committed before the file lands: a file on disk always carries it", () => {
    importLegacyCronJobs(dbPath);
    new CronStore(dbPath).add({ name: "a", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    let markAtRename: string | undefined = "not called";
    fsHook.onLegacyRename = () => { markAtRename = meta(CRON_EXPORTED_KEY); };
    const db = openTomoDb(dbPath);
    try { exportCronJobsToFile(db, legacy, { mark: true }); } finally { db.close(); }
    // Seen from another connection, as a crash right after the rename would leave it.
    expect(markAtRename).toBeTruthy();
  });

  it("an export whose file never lands leaves the jobs in the database, usable", () => {
    importLegacyCronJobs(dbPath);
    const a = new CronStore(dbPath).add({ name: "a", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    fsHook.failLegacyRename = true;
    const db = openTomoDb(dbPath);
    try { expect(() => exportCronJobsToFile(db, legacy, { mark: true })).toThrow(/EIO/); } finally { db.close(); }
    fsHook.failLegacyRename = false;
    expect(meta(CRON_EXPORTED_KEY)).toBeUndefined();
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual([a.id]);

    // Killed before it could undo the mark: the next start does.
    const db2 = openTomoDb(dbPath);
    try { db2.run("INSERT INTO meta (key, value) VALUES (?, 'x')", CRON_EXPORTED_KEY); } finally { db2.close(); }
    expect(() => new CronStore(dbPath).list()).toThrow(CronStoreReadError);
    expect(importLegacyCronJobs(dbPath)).toEqual({ kind: "none" });
    expect(new CronStore(dbPath).list().map((j) => j.id)).toEqual([a.id]);
  });

  it("an export that fails after its file landed keeps the mark: the file still replaces the table", () => {
    importLegacyCronJobs(dbPath);
    new CronStore(dbPath).add({ name: "a", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    fsHook.failLegacyChmod = true;
    const db = openTomoDb(dbPath);
    try { expect(() => exportCronJobsToFile(db, legacy, { mark: true })).toThrow(/EPERM/); } finally { db.close(); }
    fsHook.failLegacyChmod = false;
    expect(JSON.parse(readFileSync(legacy, "utf-8")).jobs).toHaveLength(1);
    expect(meta(CRON_EXPORTED_KEY)).toBeTruthy();
    // The older Tomo removes the job; upgrading again must not bring it back.
    const file = JSON.parse(readFileSync(legacy, "utf-8"));
    file.jobs = [];
    writeFileSync(legacy, JSON.stringify(file));
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list()).toEqual([]);
  });

  it("a change that passed its check just before the export's snapshot is refused under the write lock, not lost", () => {
    importLegacyCronJobs(dbPath);
    const store = new CronStore(dbPath);
    store.list(); // connection open, check passed
    // The export commits between this store's check and its BEGIN.
    const proto = Object.getPrototypeOf(sharedConnection(store)) as { transaction: (fn: () => unknown) => unknown };
    const original = proto.transaction;
    let exported = false;
    proto.transaction = function (this: unknown, fn: () => unknown) {
      if (!exported) {
        exported = true;
        const db = openTomoDb(dbPath);
        try { exportCronJobsToFile(db, legacy, { mark: true }); } finally { db.close(); }
      }
      return original.call(this, fn);
    };
    try {
      expect(() => store.add({ name: "late", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" })).toThrow(CronStoreReadError);
    } finally {
      proto.transaction = original;
    }
    expect(exported).toBe(true);
    expect(JSON.parse(readFileSync(legacy, "utf-8")).jobs).toEqual([]);
    importLegacyCronJobs(dbPath);
    expect(new CronStore(dbPath).list()).toEqual([]);
  });

  it("a copy (--out) leaves the placeholder alone", { timeout: 60_000 }, () => {
    importLegacyCronJobs(dbPath);
    new CronStore(dbPath).add({ name: "a", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:alice" });
    const out = join(home, "copy.json");
    expect(tomo("db", "export", "cron", "--out", out).status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf-8")).jobs).toHaveLength(1);
    expect(JSON.parse(readFileSync(legacy, "utf-8"))).toHaveProperty("movedToDatabase");
  });
});

describe("the CLI and the daemon writing at once", () => {
  it("a CLI change waits for the daemon's write and keeps the dispatch record it made (#356)", { timeout: 60_000 }, async () => {
    importLegacyCronJobs(dbPath);
    const job0 = new CronStore(dbPath).add({ name: "hourly", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });

    // The daemon is inside a write: the dispatch record is written, not yet committed.
    const daemon = openTomoDb(dbPath);
    daemon.exec("BEGIN IMMEDIATE");
    const row = daemon.get<{ job: string }>("SELECT job FROM cron_jobs WHERE id = ?", job0.id)!;
    daemon.run("UPDATE cron_jobs SET job = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.job), lastRunId: "daemon-run", lastStartedAt: 42 }), job0.id);

    // Meanwhile `tomo cron disable` starts. Reading before the daemon commits
    // and writing after it would put the old record back.
    const cli = tomoAsync("cron", "disable", job0.id);
    await new Promise((r) => setTimeout(r, 2_000));
    daemon.exec("COMMIT");
    daemon.close();
    const result = await cli;
    expect(result.status, result.stderr).toBe(0);

    const after = new CronStore(dbPath).get(job0.id)!;
    expect(after.enabled).toBe(false);
    expect(after.lastRunId).toBe("daemon-run");
    expect(after.lastStartedAt).toBe(42);
  });

  it("CLI processes adding jobs while the daemon records runs lose nothing", { timeout: 120_000 }, async () => {
    importLegacyCronJobs(dbPath);
    const daemon = new CronStore(dbPath);
    const job0 = daemon.add({ name: "busy", schedule: { kind: "every", everyMs: 3_600_000 }, message: "x", sessionKey: "dm:alice" });
    const clis = Promise.all([0, 1, 2, 3].map((i) =>
      tomoAsync("cron", "add", "--name", `cli-${i}`, "--schedule", "every 1h", "--message", "x", "--session", "dm:alice")));
    let done = false;
    void clis.then(() => { done = true; });
    let runs = 0;
    while (!done) {
      const runId = daemon.markStarted(job0.id)!;
      daemon.markRun(job0.id, "ok");
      expect(daemon.get(job0.id)?.lastCompletedRunId).toBe(runId);
      runs++;
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const r of await clis) expect(r.status, r.stderr).toBe(0);
    expect(runs).toBeGreaterThan(0);
    const names = daemon.list().map((j) => j.name).sort();
    expect(names).toEqual(["busy", "cli-0", "cli-1", "cli-2", "cli-3"]);
    const busy = daemon.get(job0.id)!;
    expect(busy.lastCompletedRunId).toBe(busy.lastRunId);
  });
});
