import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DbDamagedError, openTomoDb, type TomoDb } from "../db/index.js";
import { isEnoent, writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import { fileTimestamp } from "./transcript-names.js";
import type { PendingNotesFile } from "./store-support.js";

/** The pre-SQLite file, in the sessions directory. Imported once, then renamed. */
export const LEGACY_PENDING_NOTES_FILENAME = "_pending_notes.json";
const LEGACY_MARKER_FILENAME = "_pending_notes.quarantined.json";
/**
 * `meta` row, present only between an import's commit and the rename of the
 * file it imported: that file's digest. A crash in between leaves the file
 * and this row, and the next start renames the file without importing it
 * again. Cleared once the file is renamed, so a later file (after a rollback)
 * is always imported, whatever its bytes.
 */
export const IMPORT_PENDING_KEY = "legacy_pending_notes_import_pending";
/**
 * `meta` row set by `tomo db export pending-notes`: from then on the exported
 * file is the truth. The next start imports it if it is there (a rollback
 * that was called off, or an older Tomo that left notes), and if it is gone
 * (an older Tomo delivered every note and deleted it) empties the table, so
 * nothing it already delivered is delivered again.
 */
export const EXPORTED_KEY = "legacy_pending_notes_exported";

export type MoveOutcome = "moved" | "taken" | "gone";

/**
 * The durable half of the pending-notes queue (src/agent/pending-notes-queue.ts):
 * one row per note in Tomo's database, `pending_notes(session_key, position, note)`.
 *
 * A write replaces one session's rows in one transaction, so it can no longer
 * touch another session's notes (#649: one shared JSON file, read as empty
 * when it would not parse, and the next write replaced every session's).
 * A re-key moves the rows in one transaction too.
 *
 * THE OLD FILE. `sessions/_pending_notes.json`, when it is there on first use,
 * is imported in one transaction and renamed to `.migrated-<ts>`: it is then
 * the newest truth (only a pre-SQLite Tomo writes it, e.g. after a rollback),
 * so it replaces the table rather than adding to it. Its digest is recorded in
 * the same transaction until the rename lands (IMPORT_PENDING_KEY), so a crash
 * in between imports nothing twice. `tomo db export pending-notes` writes the
 * file and marks the table exported (EXPORTED_KEY): the next start takes the
 * file as the truth, and when the file is gone (an older Tomo delivered every
 * note and deleted it) empties the table, so nothing is delivered twice. A
 * file that will not read is moved aside unchanged as before (`.corrupt-<ts>`,
 * marker first) and the owner told. No dual writes: the file is never written
 * again; `tomo db export pending-notes` writes it for a rollback.
 *
 * The database opens lazily, on the first note read or write; a store that
 * never touches notes (`tomo status`) never opens it. When it cannot be opened
 * every call throws and the queue keeps the notes in memory (its own fallback).
 *
 * THE IMPORT IS THE DAEMON'S. Only a store built with `maintenance` (the
 * daemon's, opened at start) imports the old file. Another process (a CLI
 * re-key) that finds it not yet imported throws and leaves it for the daemon.
 *
 * A DAMAGED DATABASE is left as it is (see src/db): every call throws, the
 * queue keeps notes in memory, and `damage()` says why so the daemon can tell
 * the owner to stop Tomo and run `tomo db repair`.
 */
export class PendingNotesStore {
  private db: TomoDb | null = null;
  private unreadable: unknown = null;
  /** The last open failed because the database is damaged (cleared by a good open). */
  private damaged: DbDamagedError | null = null;
  /** Told after the unreadable old notes file was moved aside (a marker already names it). */
  onQuarantined?: (aside: string) => void;

  constructor(
    private readonly sessionsDir: string,
    readonly dbPath: string,
    private readonly opts: { readOnly: boolean; maintenance: boolean; move: (from: string, to: string) => MoveOutcome },
  ) {}

  private get legacyPath(): string {
    return join(this.sessionsDir, LEGACY_PENDING_NOTES_FILENAME);
  }

  private get legacyMarkerPath(): string {
    return join(this.sessionsDir, LEGACY_MARKER_FILENAME);
  }

  /** The open database, imported and ready. Throws when it cannot be. */
  private ready(): TomoDb {
    if (this.db) return this.db;
    let db: TomoDb;
    try {
      db = openTomoDb(this.dbPath, { readOnly: this.opts.readOnly });
    } catch (err) {
      if (err instanceof DbDamagedError) this.damaged = err;
      throw err;
    }
    this.damaged = null;
    try {
      if (this.opts.maintenance && !this.opts.readOnly) this.importLegacy(db);
      else if (!this.opts.readOnly && existsSync(this.legacyPath)) {
        throw new Error(`${this.legacyPath} has not been imported into the database yet; Tomo imports it when it starts`);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
    return db;
  }

  /** Why the database could not be opened, when it is damaged (null: it is not, or not known yet). */
  damage(): DbDamagedError | null {
    return this.damaged;
  }

  /** Is the database usable? Throws when not (a re-key checks before it moves anything). */
  assertReady(): void {
    if (this.opts.readOnly && !existsSync(this.dbPath)) return;
    this.ready();
  }

  get(key: string): string[] {
    if (this.opts.readOnly && !this.db && !existsSync(this.dbPath)) return [];
    return this.ready()
      .all<{ note: string }>("SELECT note FROM pending_notes WHERE session_key = ? ORDER BY position", key)
      .map((row) => row.note);
  }

  /** Replace one session's notes (an empty list removes them), in one transaction. */
  set(key: string, notes: string[]): void {
    if (this.opts.readOnly) throw new Error("Read-only session store");
    const db = this.ready();
    db.transaction(() => writeNotes(db, key, notes));
  }

  /** `oldKey`'s notes go after `newKey`'s, under `newKey`, in one transaction. */
  rekey(oldKey: string, newKey: string): void {
    if (this.opts.readOnly) throw new Error("Read-only session store");
    if (oldKey === newKey) return;
    const db = this.ready();
    db.transaction(() => {
      const moved = readNotes(db, oldKey);
      if (moved.length === 0) return;
      writeNotes(db, newKey, [...readNotes(db, newKey), ...moved]);
      writeNotes(db, oldKey, []);
    });
  }

  /** Every session's notes (export, tests). */
  all(): Record<string, string[]> {
    return readAllNotes(this.ready());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // --- Legacy file import ---

  private importLegacy(db: TomoDb): void {
    // Read inside the write transaction: what is imported is what the file
    // held while nobody else could write the table.
    const outcome = db.transaction((): { notes: Record<string, string[]>; displaced: number } | "none" | "consumed" | "unreadable" | "pending" => {
      let raw: Buffer;
      try {
        raw = readFileSync(this.legacyPath);
      } catch (err) {
        if (isEnoent(err)) {
          if (!db.get("SELECT 1 FROM meta WHERE key = ?", EXPORTED_KEY)) return "none";
          db.run("DELETE FROM pending_notes");
          db.run("DELETE FROM meta WHERE key = ?", EXPORTED_KEY);
          return "consumed";
        }
        this.unreadable = err;
        return "unreadable";
      }
      let notes: Record<string, string[]>;
      try {
        notes = parsePendingNotesFile(raw);
      } catch (err) {
        this.unreadable = err;
        return "unreadable";
      }
      const digest = createHash("sha256").update(raw).digest("hex");
      const prev = db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", IMPORT_PENDING_KEY);
      if (prev?.value === digest) return "pending";
      const displaced = Number(db.get<{ n: number }>("SELECT count(*) AS n FROM pending_notes")?.n ?? 0);
      db.run("DELETE FROM pending_notes");
      for (const [key, list] of Object.entries(notes)) writeNotes(db, key, list);
      db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", IMPORT_PENDING_KEY, digest);
      db.run("DELETE FROM meta WHERE key = ?", EXPORTED_KEY);
      return { notes, displaced };
    });
    if (outcome === "none") return;
    if (outcome === "consumed") {
      log.info("The exported pending notes file is gone (an older Tomo delivered its notes): the table was emptied");
      return;
    }
    if (outcome === "unreadable") {
      this.quarantineLegacy(this.unreadable);
      return;
    }
    if (typeof outcome === "object") {
      const { notes } = outcome;
      const count = Object.values(notes).reduce((n, list) => n + list.length, 0);
      log.info({ file: this.legacyPath, sessions: Object.keys(notes).length, notes: count }, "Imported the pending notes file into the database");
      if (outcome.displaced > 0) {
        log.warn({ displaced: outcome.displaced }, "The imported pending notes file replaced notes already in the database (it was written after them, by an older Tomo)");
      }
    }
    // After the commit: a crash before this leaves the file, whose digest now matches.
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const to = n === 0 ? `${this.legacyPath}.migrated-${ts}` : `${this.legacyPath}.migrated-${ts}-${n}`;
      let moved: MoveOutcome;
      try {
        moved = this.opts.move(this.legacyPath, to);
      } catch (err) {
        log.warn({ err, file: this.legacyPath }, "Imported the pending notes file but could not rename it; will retry next start");
        return;
      }
      if (moved === "taken") continue;
      db.run("DELETE FROM meta WHERE key = ?", IMPORT_PENDING_KEY);
      return;
    }
  }

  /**
   * Move the unreadable legacy file aside, byte for byte, as
   * `_pending_notes.json.corrupt-<ts>`, the marker naming it on disk first.
   * Throws when it cannot be moved: it must not be lost behind a database
   * that reads as empty.
   */
  private quarantineLegacy(cause: unknown): void {
    const path = this.legacyPath;
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const aside = n === 0 ? `${path}.corrupt-${ts}` : `${path}.corrupt-${ts}-${n}`;
      const before = this.quarantined();
      let outcome: MoveOutcome | undefined;
      try {
        writeJsonAtomicSync(this.legacyMarkerPath, { asides: [...(before ?? []), aside] }, { fsync: true });
        outcome = this.opts.move(path, aside);
      } finally {
        if (outcome !== "moved") {
          try {
            if (before === undefined) unlinkSync(this.legacyMarkerPath);
            else writeJsonAtomicSync(this.legacyMarkerPath, { asides: before }, { fsync: true });
          } catch (err) {
            if (!isEnoent(err)) log.warn({ err }, "Could not restore the pending notes quarantine marker");
          }
        }
      }
      if (outcome === "taken") continue;
      if (outcome === "gone") return;
      log.error({ err: cause, file: path, aside }, "Pending notes file could not be read; moved it aside unchanged (its notes were not imported)");
      this.tell(aside);
      return;
    }
    throw new Error("No free name to move the pending notes file aside", { cause });
  }

  private tell(aside: string): void {
    try {
      this.onQuarantined?.(aside);
    } catch (err) {
      log.warn({ err }, "Pending notes quarantine listener failed");
    }
  }

  // --- Quarantine marker (the unreadable legacy file's) ---

  /**
   * Old notes files moved aside because they would not read, that the owner
   * has not been told about yet; undefined: none. A marker that will not read
   * counts as one naming no file.
   */
  quarantined(): string[] | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.legacyMarkerPath, "utf-8");
    } catch (err) {
      return isEnoent(err) ? undefined : [];
    }
    try {
      const asides = (JSON.parse(raw) as { asides?: unknown }).asides;
      return Array.isArray(asides) ? asides.filter((a): a is string => typeof a === "string") : [];
    } catch {
      return [];
    }
  }

  /** The owner was told about `asides`: they leave the marker, which goes once empty. */
  clearQuarantined(asides: string[]): void {
    const before = this.quarantined();
    if (before === undefined) return;
    const left = before.filter((a) => !asides.includes(a));
    try {
      if (left.length > 0) writeJsonAtomicSync(this.legacyMarkerPath, { asides: left }, { fsync: true });
      else unlinkSync(this.legacyMarkerPath);
    } catch (err) {
      if (!isEnoent(err)) log.warn({ err }, "Could not update the pending notes quarantine marker");
    }
  }
}

function readNotes(db: TomoDb, key: string): string[] {
  return db.all<{ note: string }>("SELECT note FROM pending_notes WHERE session_key = ? ORDER BY position", key).map((r) => r.note);
}

function writeNotes(db: TomoDb, key: string, notes: string[]): void {
  db.run("DELETE FROM pending_notes WHERE session_key = ?", key);
  notes.forEach((note, i) => {
    db.run("INSERT INTO pending_notes (session_key, position, note) VALUES (?, ?, ?)", key, i, note);
  });
}

export function readAllNotes(db: TomoDb): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of db.all<{ session_key: string; note: string }>("SELECT session_key, note FROM pending_notes ORDER BY session_key, position")) {
    (out[row.session_key] ??= []).push(row.note);
  }
  return out;
}

/** Parse the legacy file; throws for anything but `{ notes: { key: string[] } }` in valid UTF-8. */
export function parsePendingNotesFile(raw: Buffer): Record<string, string[]> {
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Partial<PendingNotesFile> | null;
  const notes = data?.notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)
    || !Object.values(notes).every((v) => Array.isArray(v) && v.every((n) => typeof n === "string"))) {
    throw new Error("not a pending notes file");
  }
  return notes;
}

/**
 * Write every note to the legacy file at `out`. With `mark` (the rollback
 * path, to the file the older Tomo reads) the table is marked exported in the
 * same write transaction, the file written and fsynced inside it: the mark
 * commits only with the file on disk. The table itself is not changed, so an
 * export can be repeated. Returns how many notes were written.
 */
export function exportPendingNotesToFile(db: TomoDb, out: string, opts: { mark: boolean }): number {
  const write = (): number => {
    const notes = readAllNotes(db);
    const file: PendingNotesFile = { version: 1, notes };
    writeJsonAtomicSync(out, file, { fsync: true });
    return Object.values(notes).reduce((n, list) => n + list.length, 0);
  };
  if (!opts.mark) return write();
  return db.transaction(() => {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", EXPORTED_KEY, new Date().toISOString());
    return write();
  });
}
