import { existsSync, rmSync } from "node:fs";
import { dbFamily, openTomoDb } from "./index.js";

/**
 * Is `path` the live database or one of its sidecars? A file copy of those
 * can catch `tomo.db` and `tomo.db-wal` at different moments, so the backup
 * skips them and writes {@link snapshotDb} instead.
 */
export function isLiveDbFile(path: string, dbPath: string): boolean {
  return dbFamily(dbPath).includes(path);
}

/**
 * Write a consistent copy of the database at `dbPath` to `dest` with
 * `VACUUM INTO` (safe while the daemon is writing), and check the copy.
 * Returns false when there is no database to copy. Throws when the copy
 * cannot be made or does not pass `integrity_check`; a failed copy is removed.
 */
export function snapshotDb(dbPath: string, dest: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = openTomoDb(dbPath, { readOnly: true, allowNewerSchema: true });
  try {
    db.vacuumInto(dest);
  } finally {
    db.close();
  }
  try {
    verifyDbFile(dest);
  } catch (err) {
    for (const p of dbFamily(dest)) rmSync(p, { force: true });
    throw err;
  }
  return true;
}

/** Throws unless the database file at `path` passes `PRAGMA integrity_check`. */
export function verifyDbFile(path: string): void {
  const db = openTomoDb(path, { readOnly: true, allowNewerSchema: true });
  try {
    const result = db.check(true);
    if (result.length !== 1 || result[0] !== "ok") {
      throw new Error(`${path} failed integrity_check: ${result.slice(0, 5).join("; ")}`);
    }
  } finally {
    db.close();
  }
}
