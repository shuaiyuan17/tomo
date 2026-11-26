import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { withFileLockSync } from "../file-lock.js";
import { dirname } from "node:path";
import { writeJsonAtomicSync, isEnoent } from "../fs-utils.js";
import { log } from "../logger.js";
import { fileTimestamp } from "../sessions/transcript-names.js";
import { loadNodeSqlite, type SqliteDatabase, type SqliteStatement, type SqliteValue } from "./sqlite.js";
import { TOMO_DB_MIGRATIONS, type Migration } from "./schema.js";

export type { Migration } from "./schema.js";
export type { SqliteValue } from "./sqlite.js";

/**
 * Tomo's own database: one SQLite file (`~/.tomo/data/tomo.db`, see
 * `RuntimePaths.dbPath`) for the runtime state programs read and write.
 * State people and the agent read stays in files.
 *
 * Every connection is opened the same way (see {@link openTomoDb}):
 *
 * - WAL, so a reader never waits for a writer and sees a consistent snapshot.
 * - `synchronous=FULL` plus `fullfsync`/`checkpoint_fullfsync`: on macOS a
 *   plain fsync does not reach the platter, and a commit that returns has to
 *   survive power loss (the same promise the JSON stores made with fsync).
 * - A busy timeout, and every write in `BEGIN IMMEDIATE` (see
 *   {@link TomoDb.transaction}), so two processes writing at once queue up
 *   instead of one failing with SQLITE_BUSY.
 * - A forward-only schema migration keyed on `PRAGMA user_version`, each step
 *   in its own transaction. A database newer than this code is refused.
 * - A `quick_check` on every writable open. A database that fails it, or is
 *   not a database at all, is never repaired in place nor read as empty and
 *   written over. The daemon (the only opener with `quarantine`) copies it
 *   aside unchanged with its log as `tomo.db.corrupt-<ts>` and starts a fresh
 *   one; the marker beside it names the copy until the owner has been told.
 *   Every other opener gets a DbDamagedError and leaves it for the daemon.
 *
 * This is the only module that talks to `node:sqlite`; nothing else should
 * hold a raw handle.
 */
export const DB_BUSY_TIMEOUT_MS = 5_000;

/** SQLite primary result codes that mean the file itself is damaged. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export class DbSchemaTooNewError extends Error {
  constructor(readonly path: string, readonly found: number, readonly supported: number) {
    super(
      `${path} has schema version ${found}, newer than this Tomo understands (${supported}). `
      + "It was written by a newer Tomo: upgrade again, or export its data with that version (`tomo db export`) before downgrading.",
    );
    this.name = "DbSchemaTooNewError";
  }
}

/** The database file is damaged (corrupt, or not a database). */
export function isCorruptionError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
}

export interface OpenOptions {
  /** Open for reading only: no PRAGMA writes, no migration, no quarantine. */
  readOnly?: boolean;
  /** Override the schema (tests). Defaults to Tomo's own migrations. */
  migrations?: readonly Migration[];
  /** Read-only opens only: do not refuse a schema newer than this code (`tomo db check`). */
  allowNewerSchema?: boolean;
  /**
   * Copy a damaged database aside and start a fresh one (see quarantineDb).
   * Only the daemon sets this, when it opens the database at start: with
   * several processes free to do it, one could move the file while another
   * is opening or using it. Anyone else gets a DbDamagedError.
   */
  quarantine?: boolean;
  /** Told after a damaged database was copied aside (the marker already names it). */
  onQuarantined?: (aside: string) => void;
  /** Busy timeout override (tests that hold a lock on purpose). */
  busyTimeoutMs?: number;
}

export class TomoDb {
  private readonly statements = new Map<string, SqliteStatement>();
  private inTransaction = false;

  constructor(readonly path: string, private readonly db: SqliteDatabase, readonly readOnly: boolean) {}

  private statement(sql: string): SqliteStatement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqliteValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqliteValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqliteValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /**
   * Run `fn` as one write transaction: `BEGIN IMMEDIATE` takes the write lock
   * up front (waiting up to the busy timeout for another process), so a read
   * inside `fn` can never be upgraded into a write that fails with BUSY.
   * Anything `fn` throws rolls the whole transaction back and is rethrown.
   * Synchronous only, and not nestable.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error("TomoDb.transaction is not re-entrant");
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("TomoDb.transaction callbacks must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackErr) {
        log.warn({ err: rollbackErr }, "Database rollback failed");
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /** `PRAGMA quick_check` (or the full `integrity_check`): `["ok"]` when sound. */
  check(full = false): string[] {
    const rows = this.db.prepare(full ? "PRAGMA integrity_check" : "PRAGMA quick_check").all();
    return rows.map((row) => String(Object.values(row)[0]));
  }

  schemaVersion(): number {
    return Number(this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
  }

  /**
   * Write a consistent copy of the database to `dest` (which must not exist):
   * one snapshot, WAL content included, as a standalone file. The only safe
   * way to copy a live database: copying `tomo.db` and its `-wal` with `cp`
   * can catch the two at different moments.
   */
  vacuumInto(dest: string): void {
    if (existsSync(dest)) throw new Error(`${dest} already exists`);
    mkdirSync(dirname(dest), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(dest);
  }

  close(): void {
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** The sidecar files SQLite keeps beside a database in WAL (and rollback) mode. */
export const DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Every path that belongs to the database at `path`. */
export function dbFamily(path: string): string[] {
  return [path, ...DB_SIDECAR_SUFFIXES.map((s) => `${path}${s}`)];
}

function connect(path: string, opts: OpenOptions): SqliteDatabase {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path, { readOnly: opts.readOnly === true, timeout: opts.busyTimeoutMs ?? DB_BUSY_TIMEOUT_MS });
  try {
    if (!opts.readOnly) {
      // WAL is a property of the file and survives; the rest are per connection.
      db.exec("PRAGMA journal_mode=WAL");
    }
    db.exec("PRAGMA synchronous=FULL; PRAGMA fullfsync=1; PRAGMA checkpoint_fullfsync=1; PRAGMA foreign_keys=ON");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Throws (a corruption error) when the open file does not pass `quick_check`. */
function assertSound(db: SqliteDatabase, path: string): void {
  const rows = db.prepare("PRAGMA quick_check").all().map((row) => String(Object.values(row)[0]));
  if (rows.length !== 1 || rows[0] !== "ok") {
    throw Object.assign(new Error(`${path} failed quick_check: ${rows.slice(0, 5).join("; ")}`), { errcode: SQLITE_CORRUPT });
  }
}

function migrate(db: TomoDb, migrations: readonly Migration[]): void {
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const current = db.schemaVersion();
  if (current > latest) throw new DbSchemaTooNewError(db.path, current, latest);
  if (current === latest) return;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    db.transaction(() => {
      // Re-read under the write lock: another process may have run it first.
      const now = db.schemaVersion();
      if (now > latest) throw new DbSchemaTooNewError(db.path, now, latest);
      if (now >= migration.version) return;
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

/**
 * Open Tomo's database at `path`, creating it (and its directory) when
 * missing. See {@link TomoDb} for what every connection is set up with.
 *
 * A damaged file is copied aside and a fresh one started only with
 * `quarantine` (the daemon); any other open, or a copy that cannot complete,
 * throws instead — nothing is ever written over a database that might still
 * hold data.
 */
export function openTomoDb(path: string, opts: OpenOptions = {}): TomoDb {
  const migrations = opts.migrations ?? TOMO_DB_MIGRATIONS;
  if (opts.readOnly) {
    const db = new TomoDb(path, connect(path, opts), true);
    try {
      const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
      const found = db.schemaVersion();
      if (!opts.allowNewerSchema && found > latest) throw new DbSchemaTooNewError(path, found, latest);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const damaged = (err: unknown, checked: string | null): void => {
    // Only the process that owns maintenance (the daemon, at start) moves a
    // damaged file; anyone else stops here and leaves it for that one.
    if (!opts.quarantine) throw new DbDamagedError(path, err);
    const aside = quarantineDb(path, err, checked);
    if (aside === null) return; // another process moved it first
    try {
      opts.onQuarantined?.(aside);
    } catch (listenerErr) {
      log.warn({ err: listenerErr }, "Database quarantine listener failed");
    }
  };
  // CHECKED READ-ONLY FIRST. A writable connection to a damaged file is not
  // harmless: it can rewrite or drop a -wal it does not like, and closing it
  // checkpoints the log into the database. A read-only one leaves the -wal and
  // the main file as they are, so what is copied aside is what was there. When
  // the read-only check cannot run at all (no -shm to read, say) the writable
  // open checks instead.
  let checked = false;
  const identity = fileIdentity(path);
  if (identity !== null) {
    let ro: SqliteDatabase | null = null;
    let failure: unknown = null;
    try {
      ro = connect(path, { ...opts, readOnly: true });
      assertSound(ro, path);
      checked = true;
    } catch (err) {
      if (isCorruptionError(err)) failure = err;
    } finally {
      ro?.close();
    }
    if (failure !== null) {
      damaged(failure, identity);
      checked = true;
    }
  }
  const attempt = (check: boolean): TomoDb => {
    const raw = connect(path, opts);
    const db = new TomoDb(path, raw, false);
    try {
      if (check) assertSound(raw, path);
      migrate(db, migrations);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  };
  const before = fileIdentity(path);
  try {
    return attempt(!checked);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    damaged(err, before);
    return attempt(true);
  }
}

/** The database is damaged and this opener does not move it aside (see `OpenOptions.quarantine`). */
export class DbDamagedError extends Error {
  readonly errcode = SQLITE_CORRUPT;
  constructor(readonly path: string, cause: unknown) {
    super(`${path} is damaged (${(cause as Error)?.message ?? cause}); Tomo moves it aside when it next starts. \`tomo db check\` shows the damage.`, { cause });
    this.name = "DbDamagedError";
  }
}

// --- Quarantine -------------------------------------------------------------

/** Beside the database: the copies moved aside that the owner has not been told about. */
export function dbQuarantineMarkerPath(path: string): string {
  return `${path}.quarantined.json`;
}

/** Moved-aside copies not yet announced (undefined: none). A marker that will not read names none. */
export function quarantinedDbs(path: string): string[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(dbQuarantineMarkerPath(path), "utf-8");
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
export function clearQuarantinedDbs(path: string, asides: string[]): void {
  const marker = dbQuarantineMarkerPath(path);
  const before = quarantinedDbs(path);
  if (before === undefined) return;
  const left = before.filter((a) => !asides.includes(a));
  try {
    if (left.length > 0) writeJsonAtomicSync(marker, { asides: left }, { fsync: true });
    else unlinkSync(marker);
  } catch (err) {
    if (!isEnoent(err)) log.warn({ err }, "Could not update the database quarantine marker");
  }
}

/** Identity of the file at `path` (null: none), to tell "the file we checked" from one created since. */
export function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Copy a damaged database and its log aside, as `<path>.corrupt-<ts>`
 * (+ `-wal`/`-journal`, so `sqlite3 <aside>` still sees the log), then remove
 * the originals so a fresh database can start.
 *
 * COPY, FSYNC, MARK, THEN DELETE. A crash at any point leaves a complete copy
 * or the untouched originals, never a database separated from its committed
 * log: the copies are whole and on disk before the marker names them, and the
 * marker is on disk before any original goes. The log is deleted before the
 * main file (a -wal left beside a fresh database would be replayed into it);
 * a crash between the two leaves the damaged main file, which the next start
 * finds and copies aside again. `-shm` is only an index and is not copied.
 *
 * Under a lock, and only while the file is still the one that failed the
 * check (`checked`, its dev:ino): returns null when it is not (someone else
 * already moved it). Throws when it cannot complete; nothing may be created
 * over the originals then. Exported for tests.
 */
export function quarantineDb(path: string, cause: unknown, checked: string | null): string | null {
  return withFileLockSync(`${path}.quarantine.lock`, () => {
    if (fileIdentity(path) !== checked) return null;
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const aside = n === 0 ? `${path}.corrupt-${ts}` : `${path}.corrupt-${ts}-${n}`;
      if (dbFamily(aside).some((p) => existsSync(p))) continue;
      const copied: string[] = [];
      try {
        for (const suffix of ["", "-wal", "-journal"]) {
          if (!existsSync(`${path}${suffix}`)) continue;
          copyFileSync(`${path}${suffix}`, `${aside}${suffix}`, constants.COPYFILE_EXCL);
          copied.push(`${aside}${suffix}`);
          fsyncPath(`${aside}${suffix}`);
        }
        fsyncPath(dirname(path));
      } catch (err) {
        for (const p of copied) rmSync(p, { force: true });
        throw new Error(`Database ${path} is damaged and could not be copied aside`, { cause: err });
      }
      const before = quarantinedDbs(path);
      writeJsonAtomicSync(dbQuarantineMarkerPath(path), { asides: [...(before ?? []), aside] }, { fsync: true });
      for (const suffix of ["-wal", "-journal", "", "-shm"]) {
        try {
          unlinkSync(`${path}${suffix}`);
        } catch (err) {
          if (!isEnoent(err)) throw new Error(`Copied the damaged database ${path} aside to ${aside} but could not remove ${path}${suffix}`, { cause: err });
        }
      }
      log.error({ err: cause, file: path, aside }, "Database failed its check; copied it aside unchanged and started a fresh one");
      return aside;
    }
    throw new Error(`No free name to copy the damaged database ${path} aside`, { cause });
  });
}

function fsyncPath(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* advisory where the filesystem refuses (a directory on some systems) */
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
