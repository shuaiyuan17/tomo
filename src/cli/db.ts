import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { DbSchemaTooNewError, openTomoDb, quarantinedDbs, type TomoDb } from "../db/index.js";
import { DUMPABLE_TABLES, TOMO_DB_MIGRATIONS } from "../db/schema.js";
import { canManageJob } from "../cron/scope.js";
import { TOMO_SESSION_KEY_ENV } from "../restart-reason.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { LEGACY_PENDING_NOTES_FILENAME, exportPendingNotesToFile } from "../sessions/pending-notes-store.js";
import { isRecordedProcessLive, readPidFileRecord } from "./pidfile.js";

/**
 * `tomo db`: look at Tomo's database (`~/.tomo/data/tomo.db`) without
 * writing to it, and export a store back to its pre-SQLite file for a
 * rollback. `check` and `dump` open it read-only; `export` to the default file
 * moves the store's rows out of the database (see below).
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
    const asides = opts.from ? undefined : quarantinedDbs(path);
    if (asides && asides.length > 0) console.log(`Moved aside, owner not yet told: ${asides.join(", ")}`);
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
const EXPORTS: Record<string, { file: () => string; write: (db: TomoDb, out: string, clear: boolean) => number }> = {
  "pending-notes": {
    file: () => join(config.sessionsDir, LEGACY_PENDING_NOTES_FILENAME),
    write: (db, out, clear) => exportPendingNotesToFile(db, out, { clear }),
  },
};

dbCommand
  .command("export <store>")
  .description(`Write a store back to its pre-SQLite file, for a rollback (${Object.keys(EXPORTS).join(", ")})`)
  .option("--out <path>", "Write here instead of the file the older Tomo reads")
  .option("--from <path>", "Read this database file instead (e.g. a moved-aside copy)")
  .option("--force", "Overwrite an existing file, and run while the daemon is up")
  .action((store: string, opts: { out?: string; from?: string; force?: boolean }) => {
    const target = EXPORTS[store];
    if (!target) fail(`Unknown store "${store}". Stores: ${Object.keys(EXPORTS).join(", ")}`);
    if (process.env[TOMO_SESSION_KEY_ENV]?.trim()) fail("`tomo db export` is an operator command; run it from a terminal, not an agent's shell.");
    const out = opts.out ?? target.file();
    if (!opts.force) {
      // A running daemon keeps changing the table after the export, and an
      // older Tomo started on the file would miss those changes.
      const record = existsSync(defaultRuntimePaths.pidFile) ? readPidFileRecord(defaultRuntimePaths.pidFile) : null;
      if (record && isRecordedProcessLive(record)) fail("Tomo is running. Stop it first (`tomo stop`), or pass --force.");
      if (existsSync(out)) fail(`${out} already exists; pass --force to overwrite it.`);
    }
    // To the file the older Tomo reads, from the live database: the notes are
    // MOVED (the table is emptied once the file is on disk), so an older Tomo
    // that delivers them and deletes the file leaves nothing in the database
    // to deliver a second time after an upgrade. Anywhere else, or from
    // another file, it is a copy and the database is not written.
    const move = !opts.out && !opts.from;
    const path = opts.from ?? config.dbPath;
    if (!existsSync(path)) fail(`No database at ${path}.`);
    let count: number;
    try {
      const db = openTomoDb(path, move ? {} : { readOnly: true, allowNewerSchema: true });
      try {
        count = target.write(db, out, move);
      } finally {
        db.close();
      }
    } catch (err) {
      fail(`Could not export from ${path}: ${(err as Error).message}`);
    }
    if (move) {
      console.log(`Moved ${count} note(s) out of the database into ${out}.`);
      console.log("To roll back: install the older Tomo and start it; it reads this file.");
      console.log("Starting this version again imports the file back (it replaces the table).");
    } else {
      console.log(`Wrote ${count} note(s) to ${out} (the database is unchanged).`);
    }
  });
