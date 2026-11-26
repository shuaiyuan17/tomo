import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import { DbSchemaTooNewError, openTomoDb, repairDb, type TomoDb } from "../db/index.js";
import { DUMPABLE_TABLES, TOMO_DB_MIGRATIONS } from "../db/schema.js";
import { canManageJob } from "../cron/scope.js";
import { TOMO_SESSION_KEY_ENV } from "../restart-reason.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { withFileLockSync } from "../file-lock.js";
import { LEGACY_PENDING_NOTES_FILENAME, exportPendingNotesToFile } from "../sessions/pending-notes-store.js";
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

/**
 * The pid check `tomo backup restore` makes too: a daemon started after it
 * passes is not stopped by it (the operator is the one starting it).
 */
function refuseWhileRunning(): void {
  const record = existsSync(defaultRuntimePaths.pidFile) ? readPidFileRecord(defaultRuntimePaths.pidFile) : null;
  if (record && isRecordedProcessLive(record)) fail("Tomo is running. Stop it first (`tomo stop`).");
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
const EXPORTS: Record<string, { file: () => string; write: (db: TomoDb, out: string, mark: boolean) => number }> = {
  "pending-notes": {
    file: () => join(config.sessionsDir, LEGACY_PENDING_NOTES_FILENAME),
    write: (db, out, mark) => exportPendingNotesToFile(db, out, { mark }),
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
    // the live queue. Everything else is a copy to a file of your choosing.
    if (opts.from && !opts.out) fail("--from needs --out: a copy from another database never goes to the file Tomo imports.");
    if (opts.out && resolve(opts.out) === resolve(rollbackFile)) fail(`--out may not be ${rollbackFile}; run the export without --out to write it.`);
    const rollback = !opts.out;
    const out = opts.out ?? rollbackFile;
    if (rollback) refuseWhileRunning();
    if (existsSync(out) && !(opts.overwrite && !rollback)) {
      fail(rollback
        ? `${out} already exists (an export already ran, or an older Tomo wrote it). Start this Tomo once to import it, or move it away first.`
        : `${out} already exists; pass --overwrite to replace it.`);
    }
    const path = opts.from ?? config.dbPath;
    if (!existsSync(path)) fail(`No database at ${path}.`);
    let count: number;
    try {
      withFileLockSync(`${config.dbPath}.maintenance.lock`, () => {
        const db = openTomoDb(path, rollback ? {} : { readOnly: true, allowNewerSchema: true });
        try {
          count = target.write(db, out, rollback);
        } finally {
          db.close();
        }
      });
    } catch (err) {
      fail(`Could not export from ${path}: ${(err as Error).message}`);
    }
    if (rollback) {
      console.log(`Wrote ${count!} note(s) to ${out}; the database is marked exported.`);
      console.log("To roll back: install the older Tomo and start it; it reads this file.");
      console.log("If you start this version again instead, it imports the file (it replaces the table). Do not delete the file:");
      console.log("this version then takes it that an older Tomo delivered every note, and empties the table.");
    } else {
      console.log(`Wrote ${count!} note(s) to ${out} (the database is unchanged).`);
    }
  });

dbCommand
  .command("repair")
  .description("Copy a damaged database aside (tomo.db.corrupt-<ts>, with its -wal) and start a fresh one. Tomo must be stopped.")
  .action(() => {
    if (process.env[TOMO_SESSION_KEY_ENV]?.trim()) fail("`tomo db repair` is an operator command; run it from a terminal, not an agent's shell.");
    refuseWhileRunning();
    let aside: string | null;
    try {
      aside = withFileLockSync(`${config.dbPath}.maintenance.lock`, () => repairDb(config.dbPath));
    } catch (err) {
      fail(`Repair failed: ${(err as Error).message}`);
    }
    if (aside === null) {
      console.log(`${config.dbPath} passes its check (or does not exist); nothing to repair.`);
      return;
    }
    console.log(`Copied the damaged database to ${aside} and started a fresh one.`);
    console.log(`Its pending notes may still be readable: tomo db export pending-notes --from ${aside} --out <file>`);
    console.log(`Last resort: sqlite3 ${aside} .recover`);
  });
