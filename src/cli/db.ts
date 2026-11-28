import { Command } from "commander";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { config } from "../config.js";
import { DbSchemaTooNewError, openTomoDb, repairDb, type TomoDb } from "../db/index.js";
import { DUMPABLE_TABLES, TOMO_DB_MIGRATIONS } from "../db/schema.js";
import { canManageJob } from "../cron/scope.js";
import { TOMO_SESSION_KEY_ENV } from "../restart-reason.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { acquireMaintenanceLock, maintenanceLockBusyMessage, maintenanceLockPath, type MaintenanceLock } from "../db/lock.js";
import { exportCronJobsToFile, legacyCronFileReplaceable, legacyCronJobsPath } from "../cron/store.js";
import { LEGACY_PENDING_NOTES_FILENAME, exportPendingNotesToFile } from "../sessions/pending-notes-store.js";
import { exportSubsessionsToFile, legacySubsessionsFileReplaceable, legacySubsessionsPath } from "../agent/subsessions/store.js";
import { isRecordedProcessLive, readPidFileRecord } from "./pidfile.js";

/**
 * `tomo db`: look at Tomo's database (`~/.tomo/data/tomo.db`) without
 * writing to it, and export a store back to its pre-SQLite file for a
 * rollback. `check` and `dump` open it read-only; `export` (Tomo stopped)
 * writes the file the older Tomo reads and marks the table exported; `repair`
 * (Tomo stopped) copies a damaged database aside.
 */
export const dbCommand = new Command("db")
  .description("Inspect Tomo's database (check, dump) and export a store to its old file format");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function withDb<T>(path: string, fn: (db: TomoDb) => T, opts: { allowNewerSchema?: boolean } = {}): T {
  if (!existsSync(path)) fail(`No database at ${path} (Tomo creates it on first use).`);
  let db: TomoDb;
  try {
    db = openTomoDb(path, { readOnly: true, allowNewerSchema: opts.allowNewerSchema });
  } catch (err) {
    if (err instanceof DbSchemaTooNewError) fail(err.message);
    fail(`Could not open ${path}: ${(err as Error).message}`);
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `path` with its directory's symlinks resolved (the file itself need not exist). */
function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/**
 * The pid check `tomo backup restore` makes too: a daemon started after it
 * passes is not stopped by it (the operator is the one starting it).
 */
function refuseWhileRunning(): void {
  const record = existsSync(defaultRuntimePaths.pidFile) ? readPidFileRecord(defaultRuntimePaths.pidFile) : null;
  if (record && isRecordedProcessLive(record)) fail("Tomo is running. Stop it first (`tomo stop`).");
}

/**
 * Take the lock the daemon holds for its whole
 * life (src/db/lock.ts), so a daemon launchd respawns meanwhile waits for it.
 * Refuses, without waiting, when the daemon or another maintenance command
 * holds it.
 */
function takeMaintenanceLock(): MaintenanceLock {
  const path = maintenanceLockPath(config.tomoHome);
  const lock = acquireMaintenanceLock(path);
  if (!lock) fail(maintenanceLockBusyMessage(path));
  return lock;
}

function tableNames(db: TomoDb): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}

dbCommand
  .command("check")
  .description("Run integrity_check and print the schema version and row counts. Exits 1 when the database is damaged.")
  .option("--from <path>", "Check this database file instead (e.g. a moved-aside tomo.db.corrupt-<ts>)")
  .action((opts: { from?: string }) => {
    const path = opts.from ?? config.dbPath;
    const ok = withDb(path, (db) => {
      const latest = TOMO_DB_MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
      const version = db.schemaVersion();
      console.log(`Database: ${path} (${statSync(path).size} bytes)`);
      console.log(`Schema version: ${version}${version > latest ? ` (newer than this Tomo, ${latest})` : version < latest ? ` (this Tomo migrates it to ${latest} on next start)` : ""}`);
      for (const name of tableNames(db)) {
        const n = db.get<{ n: number }>(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`)?.n ?? 0;
        console.log(`  ${name}: ${n} row(s)`);
      }
      const result = db.check(true);
      const sound = result.length === 1 && result[0] === "ok";
      console.log(`integrity_check: ${sound ? "ok" : result.slice(0, 20).join("\n  ")}`);
      return sound;
    }, { allowNewerSchema: true });
    if (!ok) process.exit(1);
  });

dbCommand
  .command("dump [table]")
  .description(`Print a table's rows (${Object.keys(DUMPABLE_TABLES).join(", ")}); with no table, list the tables`)
  .option("--json", "Print rows as JSON")
  .option("--from <path>", "Read this database file instead")
  .action((table: string | undefined, opts: { json?: boolean; from?: string }) => {
    const path = opts.from ?? config.dbPath;
    withDb(path, (db) => {
      if (!table) {
        for (const name of tableNames(db)) console.log(name);
        return;
      }
      const order = DUMPABLE_TABLES[table];
      if (!order) fail(`Unknown table "${table}". Tables: ${Object.keys(DUMPABLE_TABLES).join(", ")}`);
      let rows = db.all(`SELECT * FROM ${table} ORDER BY ${order}`);
      // Run from an agent's shell, a session sees only its own notes (the same
      // rule as `tomo todo` and `tomo cron`): a group's shell must not read the owner's.
      const caller = process.env[TOMO_SESSION_KEY_ENV]?.trim() || undefined;
      if (table === "pending_notes") rows = rows.filter((r) => canManageJob({ sessionKey: String(r.session_key) }, caller));
      // And sub-session tasks: a session sees only the tasks it owns.
      if (table === "subsessions") rows = rows.filter((r) => canManageJob({ sessionKey: (typeof r.parent_key === "string" ? r.parent_key : undefined) as string }, caller));
      // Same for cron jobs (`tomo cron list` shows a session only its own).
      if (table === "cron_jobs") rows = rows.filter((r) => canManageJob({ sessionKey: (typeof r.session_key === "string" ? r.session_key : undefined) as string }, caller));
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(`(${table} is empty)`);
        return;
      }
      for (const row of rows) console.log(Object.entries(row).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  "));
    }, { allowNewerSchema: true });
  });

/** Stores `tomo db export` can write back to their pre-SQLite file. */
const EXPORTS: Record<string, {
  file: () => string;
  /** Write the file; with `mark` (the rollback file) record that in the database. Returns the count. */
  write: (db: TomoDb, out: string, mark: boolean) => number;
  noun: string;
  /** Does a rollback export record itself in the database? */
  marks?: boolean;
  /** May a rollback export replace what is at the rollback path? (Default: only when nothing is there.) */
  replaceable?: (path: string) => boolean;
  /** What to tell the operator after a rollback export. */
  rollbackNotes: string[];
}> = {
  "pending-notes": {
    file: () => join(config.sessionsDir, LEGACY_PENDING_NOTES_FILENAME),
    write: (db, out, mark) => exportPendingNotesToFile(db, out, { mark }),
    noun: "note(s)",
    marks: true,
    rollbackNotes: [
      "If you start this version again instead, it imports the file (it replaces the table). Do not delete the file:",
      "this version then takes it that an older Tomo delivered every note, and empties the table.",
    ],
  },
  subsessions: {
    file: () => legacySubsessionsPath(config.dbPath),
    // While a real table file is there every sub-session call refuses, and
    // this version's daemon imports it at its next start, over the rows (the
    // older Tomo continued from the export).
    write: (db, out, mark) => exportSubsessionsToFile(db, out, { mark }),
    noun: "task(s)",
    marks: true,
    replaceable: legacySubsessionsFileReplaceable,
    rollbackNotes: [
      "If you start this version again instead, it imports the file (it replaces the tasks in the database), so changes the older Tomo made are kept.",
      "Export pending notes and cron jobs too (`tomo db export pending-notes`, `tomo db export cron`).",
    ],
  },
  cron: {
    file: () => legacyCronJobsPath(config.dbPath),
    // While a real jobs file is there every cron call refuses, and this
    // version's daemon imports it at its next start; the mark makes that
    // import replace the table (the older Tomo continued from the export).
    write: (db, out, mark) => exportCronJobsToFile(db, out, { mark }),
    noun: "job(s)",
    marks: true,
    // The placeholder the daemon leaves there is not a jobs file.
    replaceable: legacyCronFileReplaceable,
    rollbackNotes: [
      "Until then `tomo cron` refuses (the file is the truth now). If you start this version again instead, it imports the file",
      "(it replaces the table), so changes the older Tomo made are kept.",
      "Export pending notes too (`tomo db export pending-notes`). A Tomo from before the database (0.15 and older) needs nothing",
      "more; one whose database is an older schema refuses this one: move data/tomo.db, -wal and -shm aside before starting it.",
    ],
  },
};

dbCommand
  .command("export <store>")
  .description(`Write a store back to its pre-SQLite file, for a rollback (${Object.keys(EXPORTS).join(", ")}). Tomo must be stopped.`)
  .option("--out <path>", "Write a copy here instead (never the file the older Tomo reads)")
  .option("--from <path>", "Read this database file instead (e.g. a moved-aside copy); needs --out")
  .option("--overwrite", "Overwrite an existing --out file")
  .action((store: string, opts: { out?: string; from?: string; overwrite?: boolean }) => {
    const target = EXPORTS[store];
    if (!target) fail(`Unknown store "${store}". Stores: ${Object.keys(EXPORTS).join(", ")}`);
    if (process.env[TOMO_SESSION_KEY_ENV]?.trim()) fail("`tomo db export` is an operator command; run it from a terminal, not an agent's shell.");
    const rollbackFile = target.file();
    // THE ROLLBACK FILE is written only by a plain export, from the live
    // database, with Tomo stopped: Tomo imports that file at its next start
    // (it replaces the table), so anything else written there would replace
    // the live store. Everything else is a copy to a file of your choosing.
    if (opts.from && !opts.out) fail("--from needs --out: a copy from another database never goes to the file Tomo imports.");
    if (opts.out && canonical(opts.out) === canonical(rollbackFile)) fail(`--out may not be ${rollbackFile}; run the export without --out to write it.`);
    const rollback = !opts.out;
    const out = opts.out ?? rollbackFile;
    if (rollback) refuseWhileRunning();
    // Held from here to the end (exiting releases it too), so the checks
    // below cannot go stale before the write: a respawned daemon waits.
    const lock = rollback ? takeMaintenanceLock() : null;
    try {
      const taken = existsSync(out) && !(rollback && (target.replaceable?.(out) ?? false));
      if (taken && !(opts.overwrite && !rollback)) {
        fail(rollback
          ? `${out} already exists (an export already ran, or an older Tomo wrote it). Start this Tomo once to import it, or move it away first.`
          : `${out} already exists; pass --overwrite to replace it.`);
      }
      const path = opts.from ?? config.dbPath;
      if (!existsSync(path)) fail(`No database at ${path}.`);
      let count: number;
      try {
        const db = openTomoDb(path, rollback ? {} : { readOnly: true, allowNewerSchema: true });
        try {
          count = target.write(db, out, rollback);
        } finally {
          db.close();
        }
      } catch (err) {
        fail(`Could not export from ${path}: ${(err as Error).message}`);
      }
      if (rollback) {
        console.log(`Wrote ${count} ${target.noun} to ${out}${target.marks ? "; the database is marked exported" : ""}.`);
        console.log("To roll back: install the older Tomo and start it; it reads this file.");
        for (const line of target.rollbackNotes) console.log(line);
      } else {
        console.log(`Wrote ${count} ${target.noun} to ${out} (the database is unchanged).`);
      }
    } finally {
      lock?.release();
    }
  });

dbCommand
  .command("repair")
  .description("Copy a damaged database aside (tomo.db.corrupt-<ts>, with its -wal) and start a fresh one. Tomo must be stopped.")
  .action(() => {
    if (process.env[TOMO_SESSION_KEY_ENV]?.trim()) fail("`tomo db repair` is an operator command; run it from a terminal, not an agent's shell.");
    refuseWhileRunning();
    const lock = takeMaintenanceLock();
    let aside: string | null;
    try {
      aside = repairDb(config.dbPath);
    } catch (err) {
      fail(`Repair failed: ${(err as Error).message}`);
    } finally {
      lock.release();
    }
    if (aside === null) {
      console.log(`${config.dbPath} passes its check (or does not exist); nothing to repair.`);
      return;
    }
    console.log(`Copied the damaged database to ${aside} and started a fresh one.`);
    console.log(`Its pending notes and cron jobs may still be readable: tomo db export pending-notes|cron --from ${aside} --out <file>`);
    console.log(`Last resort: sqlite3 ${aside} .recover`);
  });
