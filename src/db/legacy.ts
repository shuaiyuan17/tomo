import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomicSync, writeJsonAtomicSync } from "../fs-utils.js";
import { fileTimestamp } from "../sessions/transcript-names.js";
import type { TomoDb } from "./index.js";

/**
 * What the stores that moved from a JSON file into the database share for
 * the one-time import of that file and the rollback export back to it: the
 * `meta` rows that record where an import or an export stands, the digest a
 * file is recognised by, the copy of an imported file kept aside, and the
 * placeholder left at its path. The import and export rules themselves stay
 * with each store (they differ: see src/cron/store.ts, src/sessions/pending-notes-store.ts).
 */

export function metaValue(db: TomoDb, key: string): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
}

export function setMeta(db: TomoDb, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

/** Returns how many rows went (0 or 1). */
export function deleteMeta(db: TomoDb, key: string): number {
  return db.run("DELETE FROM meta WHERE key = ?", key);
}

/** sha256, hex: how an imported file is recognised when it is met again. */
export function digestOf(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Copy an imported file's content to `<path>.migrated-<ts>` (fsynced), unless
 * a copy with the same content is already there (a start that imported it and
 * stopped before replacing it). Returns the copy's path. The original is left
 * as it is.
 */
export function keepAside(path: string, raw: string): string {
  const dir = dirname(path);
  const prefix = `${basename(path)}.migrated-`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (readFileSync(join(dir, name), "utf-8") === raw) return join(dir, name);
    } catch { /* not ours to judge; pick a new name */ }
  }
  const ts = fileTimestamp();
  for (let n = 0; n < 100; n++) {
    const to = n === 0 ? `${path}.migrated-${ts}` : `${path}.migrated-${ts}-${n}`;
    if (existsSync(to)) continue;
    writeFileAtomicSync(to, raw, { fsync: true });
    return to;
  }
  throw new Error("no free name to copy it to");
}

/**
 * Replace the file at `path` with `body` (fsynced, atomically: the path is
 * never empty in between). A placeholder is valid JSON an older Tomo refuses
 * as its store, so it stops instead of reading a missing file as a fresh
 * install; `movedToDatabase` is how this version recognises one.
 */
export function writePlaceholder(path: string, body: { movedToDatabase: string } & Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicSync(path, body, { fsync: true });
}

/** Is `data` (parsed JSON) a placeholder {@link writePlaceholder} wrote, with none of `storeKeys` in it? */
export function isPlaceholder(data: unknown, storeKeys: readonly string[]): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return typeof record.movedToDatabase === "string" && !storeKeys.some((k) => k in record);
}
