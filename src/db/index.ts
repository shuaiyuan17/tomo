import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, rmSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isEnoent } from "../fs-utils.js";
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
 * - A `quick_check` on every writable open, read-only first. A database that
 *   fails it, or is not a database at all, is never repaired in place, never
 *   read as empty and written over, and never moved by a running process: the
 *   open throws DbDamagedError (the daemon tells the owner and keeps notes in
 *   memory), and `tomo db repair`, with Tomo stopped, copies it aside as
 *   `tomo.db.corrupt-<ts>` and starts a fresh one (see repairDb). Moving files
 *   under processes that may have them open was the source of every race an
 *   automatic quarantine had.
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
  /** Open for reading only: no PRAGMA writes, no migration. */
  readOnly?: boolean;
  /** Override the schema (tests). Defaults to Tomo's own migrations. */
  migrations?: readonly Migration[];
  /** Read-only opens only: do not refuse a schema newer than this code (`tomo db check`). */
  allowNewerSchema?: boolean;
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
  // CHECKED READ-ONLY FIRST. A writable connection to a damaged file is not
  // harmless: it can rewrite or drop a -wal it does not like, and closing it
  // checkpoints the log into the database. A read-only one leaves the -wal and
  // the main file as they are, for `tomo db repair` to copy. When the
  // read-only check cannot run at all (no -shm to read, say) the writable open
  // checks instead.
  let checked = false;
  if (existsSync(path)) {
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
    if (failure !== null) throw new DbDamagedError(path, failure);
  }
  const raw = connect(path, opts);
  const db = new TomoDb(path, raw, false);
  try {
    if (!checked) assertSound(raw, path);
    migrate(db, migrations);
    return db;
  } catch (err) {
    db.close();
    if (isCorruptionError(err) && !(err instanceof DbDamagedError)) throw new DbDamagedError(path, err);
    throw err;
  }
}

/** The database failed its check. Nothing was changed; `tomo db repair` (Tomo stopped) copies it aside. */
export class DbDamagedError extends Error {
  readonly errcode = SQLITE_CORRUPT;
  constructor(readonly path: string, cause: unknown) {
    super(`${path} is damaged (${(cause as Error)?.message ?? cause}). Stop Tomo and run \`tomo db repair\` to copy it aside and start a fresh one; \`tomo db check\` shows the damage.`, { cause });
    this.name = "DbDamagedError";
  }
}

// --- Repair -----------------------------------------------------------------

/**
 * `tomo db repair`: copy a damaged database and its log aside, as
 * `<path>.corrupt-<ts>` (+ `-wal`/`-journal`, so `sqlite3 <aside>` still sees
 * the log), remove the originals and start a fresh database. The caller makes
 * sure Tomo is not running; nothing else moves these files.
 *
 * COPY, FSYNC, THEN DELETE. A failure (or a crash) before the deletes leaves
 * the originals untouched, and a copy is only trusted once it and its
 * directory are fsynced. The log is deleted before the main file (a -wal left
 * beside a fresh database would be replayed into it); stopping between the
 * two leaves the damaged main file, which the next repair copies again.
 * `-shm` is only an index and is not copied.
 *
 * Returns null, touching nothing, when the database passes its check (or does
 * not exist); otherwise the aside path.
 */
export function repairDb(path: string): string | null {
  if (!existsSync(path)) return null;
  let failure: unknown = null;
  let ro: SqliteDatabase | null = null;
  try {
    ro = connect(path, { readOnly: true });
    assertSound(ro, path);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    failure = err;
  } finally {
    ro?.close();
  }
  if (failure === null) return null;
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
        fsyncFile(`${aside}${suffix}`);
      }
      fsyncDir(dirname(path));
    } catch (err) {
      for (const p of copied) rmSync(p, { force: true });
      throw new Error(`Could not copy the damaged database ${path} aside; nothing was changed`, { cause: err });
    }
    for (const suffix of ["-wal", "-journal", "", "-shm"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch (err) {
        if (!isEnoent(err)) throw new Error(`Copied the damaged database to ${aside} but could not remove ${path}${suffix}; run repair again`, { cause: err });
      }
    }
    fsyncDir(dirname(path));
    log.warn({ err: failure, file: path, aside }, "Damaged database copied aside; a fresh one starts");
    openTomoDb(path).close();
    return aside;
  }
  throw new Error(`No free name to copy the damaged database ${path} aside`);
}

/** fsync a file the copy depends on: an error here aborts the repair. */
function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** fsync a directory: advisory, as some filesystems refuse it. */
function fsyncDir(path: string): void {
  try {
    fsyncFile(path);
  } catch {
    /* see above */
  }
}
