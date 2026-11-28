import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sharedTomoDb, type TomoDb } from "../../src/db/index.js";

/**
 * The sub-session table as tests used to see it, a JSON file, now that it is
 * rows in tomo.db (src/agent/subsessions/store.ts). `path` is the store's
 * path (the old file, beside the database). Rows are read and written raw,
 * bypassing the store's parser, so a test can still plant a record in the
 * shape an older Tomo left it.
 */

function dbOf(path: string): TomoDb {
  return sharedTomoDb(join(dirname(path), "tomo.db"));
}

/** The table, as the old file's JSON (records exactly as stored). */
export function readTableFile(path: string): any {
  const db = dbOf(path);
  const state = db.get<{ next_id: number; untrusted: string | null }>("SELECT next_id, untrusted FROM subsessions_state WHERE one = 1");
  const tasks = db.all<{ record: string }>("SELECT record FROM subsessions ORDER BY seq").map((r) => JSON.parse(r.record) as unknown);
  return { version: 1, nextId: state?.next_id ?? 1, tasks, ...(state?.untrusted ? { untrusted: JSON.parse(state.untrusted) as unknown } : {}) };
}

/** Replace the table's rows with `table` (the old file's JSON), as stored, unparsed. */
export function writeTableFile(path: string, table: any): void {
  const db = dbOf(path);
  db.transaction(() => {
    db.run("DELETE FROM subsessions");
    for (const task of table.tasks as Array<{ id: string }>) db.run("INSERT INTO subsessions (id, record) VALUES (?, ?)", task.id, JSON.stringify(task));
    db.run("INSERT INTO subsessions_state (one, next_id, untrusted) VALUES (1, ?, ?) ON CONFLICT (one) DO UPDATE SET next_id = excluded.next_id, untrusted = excluded.untrusted",
      table.nextId, table.untrusted ? JSON.stringify(table.untrusted) : null);
  });
}

/** The database forgets its table, and that it ever imported one: as before this version's first start. */
export function forgetTable(path: string): void {
  const db = dbOf(path);
  db.transaction(() => {
    db.run("DELETE FROM subsessions");
    db.run("DELETE FROM subsessions_state");
    db.run("DELETE FROM meta WHERE key LIKE 'legacy_subsessions_%'");
  });
}

/**
 * Put the table back into the old files the way the old store lost one: its
 * content becomes `.bak`, the file itself holds `primary` ("" or broken
 * JSON), and the database has no table yet. The next store imports the
 * backup, untrusted (state "recovered"), as the old store recovered it.
 */
export function loseTableToBackup(path: string, primary: string): void {
  const table = readTableFile(path) as unknown;
  forgetTable(path);
  writeFileSync(`${path}.bak`, JSON.stringify(table));
  writeFileSync(path, primary);
}
