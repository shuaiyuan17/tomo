import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openTomoDb, sharedTomoDb, type TomoDb } from "../../db/index.js";
import { deleteMeta, digestOf, isPlaceholder, keepAside, metaValue, setMeta, writePlaceholder } from "../../db/legacy.js";
import { isEnoent, writeJsonAtomicSync } from "../../fs-utils.js";
import { fileTimestamp } from "../../sessions/transcript-names.js";
import { log } from "../../logger.js";
import { taskSessionKey } from "../../sessions/keys.js";
import { IllegalTransitionError, nextStatus, type SubsessionEvent } from "./state-machine.js";
import {
  OWNER_MESSAGE_IDS_KEEP,
  OWNER_MESSAGE_MARKER,
  PAUSE_KINDS,
  type PauseKind,
  type QuotaPass,
  CONVERSATION_KEEP,
  DONE_STEPS_KEEP,
  UPDATES_KEEP,
  PLAN_MAX_STEPS,
  PLAN_STEP_MAX,
  PROGRESS_TEXT_MAX,
  STEP_RESULT_MAX,
  isTimestamp,
  oneLine,
  REPLY_MAP_KEEP,
  SENT_KEEP,
  SUBSESSION_STATUSES,
  TERMINAL_STATUSES,
  TRANSITION_LOG_KEEP,
  type SubsessionInput,
  type SubsessionPlanStep,
  type SubsessionDoneStep,
  type SubsessionUpdate,
  type SubsessionRecord,
  type SubsessionStatus,
  type SubsessionTable,
  type InputOrigin,
} from "./types.js";

/**
 * The task table: rows of Tomo's database (`subsessions`, one per task, and
 * `subsessions_state`, the table-wide fields), until 0.16 the file
 * `~/.tomo/data/subsessions.json`.
 *
 * It is the reconcile source for everything else a task touches (registry,
 * cron, pending notes). Every read-modify-write is one database transaction
 * (`BEGIN IMMEDIATE`, see src/db), so what was read is what is judged and
 * written, and a write changes only the rows that changed: a heartbeat is one
 * row, not the whole table twice. AN UNREADABLE TABLE IS NOT AN EMPTY ONE: a
 * table never written reads as empty (`missing`); a database that cannot be
 * opened, or a row that does not parse, refuses every read and write
 * (`unreadable`) rather than letting the startup reconcile see "no tasks" and
 * unlink every task's registry entry. `recovered`: this process imported the
 * old file's `.bak` (the file itself was missing or unreadable), and the
 * table is marked untrusted.
 *
 * THE OLD FILE (see importLegacy). On first use the file is imported in one
 * transaction (its `.bak` when the file cannot be read), then a copy kept
 * aside (`.migrated-<ts>`), the `.bak` moved aside too, and a placeholder left
 * at the path: an older Tomo started without `tomo db export subsessions`
 * then finds an unreadable table with no backup and keeps sub-sessions off,
 * instead of starting from an empty one. A real table file found there later
 * is imported only after a rollback export (it replaces the rows: the older
 * Tomo continued from the export) or into a database that has no table yet;
 * any other one is refused, and the file left as it is for the owner.
 */
export type SubsessionStoreState = "ok" | "missing" | "recovered" | "unreadable";

export class SubsessionStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SubsessionStoreError";
  }
}

export interface CreateTaskInput {
  parentKey: string;
  title: string;
  brief: string;
  quote?: string[];
  model?: string;
  effort?: string;
}

export interface TransitionOptions {
  reason?: string;
  /** Refuse unless the status read under the lock is one of these. */
  expectFrom?: readonly SubsessionStatus[];
  /** Field changes written in the same write as the status change. */
  patch?: (record: SubsessionRecord) => void;
  /**
   * Judged under the lock after the state machine allowed the event: a
   * non-empty answer refuses the transition (nothing is written) and comes
   * back as `refused`.
   */
  guard?: (record: SubsessionRecord) => string | undefined;
}

export type TransitionOutcome =
  | { ok: true; changed: boolean; from: SubsessionStatus; record: SubsessionRecord }
  | { ok: false; from: SubsessionStatus | null; record?: SubsessionRecord; refused?: string };

const EMPTY: () => SubsessionTable = () => ({ version: 1, nextId: 1, tasks: [] });

/**
 * `meta` row: the digest of the last old table file imported. A file at the
 * old path with that digest is already in the database (a crash between the
 * import's commit and the placeholder, a backup restored from before the
 * first start) and is never imported again.
 */
export const SUBSESSIONS_IMPORTED_KEY = "legacy_subsessions_imported";
/**
 * `meta` row set by `tomo db export subsessions` (the rollback), from its
 * snapshot on: the file at the old path continues from the database, so every
 * store call refuses, and the next start imports the file over the rows.
 * Cleared by that import, or by a start that finds only the placeholder (an
 * export whose file never landed).
 */
export const SUBSESSIONS_EXPORTED_KEY = "legacy_subsessions_exported";

/** The old file's path for a database (`data/subsessions.json` beside `data/tomo.db`). */
export function legacySubsessionsPath(dbPath: string): string {
  return join(dirname(dbPath), "subsessions.json");
}

export function subsessionsPlaceholder(dbPath: string): { movedToDatabase: string; note: string } {
  return {
    movedToDatabase: dbPath,
    note: "Tomo keeps its sub-session tasks in its database now (tables subsessions, subsessions_state). This file is deliberately not a task table, "
      + "so an older Tomo keeps sub-sessions off instead of starting from an empty list. To go back to an older Tomo: "
      + "`tomo stop && tomo db export subsessions`, then install it.",
  };
}

export class SubsessionStore {
  /** The database the table lives in. */
  readonly dbPath: string;
  private readonly backupPath: string;
  private cached: SubsessionTable | null = null;
  private lastState: SubsessionStoreState | null = null;
  /** This process imported the old `.bak` (until its first write): reads say "recovered". */
  private recoveredByImport = false;
  private importChecked = false;
  private readonly now: () => number;
  /** Tests: an illegal transition throws instead of being logged and refused. */
  private readonly strict: boolean;
  /** Called after every successful write (the web UI's live sub-session list); never throws into a write. */
  private readonly onChange: (() => void) | undefined;

  /**
   * `path` is the old table file (`data/subsessions.json`), imported on first
   * use; the database defaults to `tomo.db` beside it.
   */
  constructor(readonly path: string, opts: { dbPath?: string; now?: () => number; strictTransitions?: boolean; onChange?: () => void } = {}) {
    this.dbPath = opts.dbPath ?? join(dirname(path), "tomo.db");
    this.backupPath = `${path}.bak`;
    this.now = opts.now ?? Date.now;
    this.strict = opts.strictTransitions ?? false;
    this.onChange = opts.onChange;
  }

  /** How the last read went. `null` before the first read. */
  state(): SubsessionStoreState | null {
    return this.lastState;
  }

  /** A fresh read (one consistent snapshot). Throws SubsessionStoreError when unreadable. */
  read(): SubsessionTable {
    const db = this.ready();
    return clone(this.readRows(db).table);
  }

  list(): SubsessionRecord[] {
    return this.read().tasks;
  }

  get(id: string): SubsessionRecord | undefined {
    return this.list().find((t) => t.id === id);
  }

  byKey(sessionKey: string): SubsessionRecord | undefined {
    return this.list().find((t) => t.sessionKey === sessionKey);
  }

  /** The last table read or written by this process, without touching disk (null before the first). */
  peek(): SubsessionTable | null {
    return this.cached ? clone(this.cached) : null;
  }
  create(input: CreateTaskInput): SubsessionRecord {
    return this.mutate((table) => {
      const id = `s${table.nextId}`;
      table.nextId += 1;
      const now = this.now();
      const record: SubsessionRecord = {
        id,
        sessionKey: taskSessionKey(id),
        parentKey: input.parentKey,
        title: input.title,
        brief: input.brief,
        ...(input.quote && input.quote.length > 0 ? { quote: input.quote } : {}),
        status: "queued",
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        createdAt: now,
        lastActivityAt: now,
        activeMs: 0,
        resumeNeeded: false,
        startDelivered: false,
        interruptStreak: 0,
        failStreak: 0,
        turnsWithoutProgress: 0,
        restartRequested: false,
        reportDelivered: false,
        compactPending: false,
        postCompactReminder: false,
        pendingInput: [],
        replyMap: [],
        ownerMessageIds: [],
        conversation: [],
        conversationSeq: 0,
        mirrorSeenSeq: 0,
        nextInputSeq: 1,
        seenThrough: 0,
        sent: [],
        transitions: [{ at: now, from: null, to: "queued", event: "spawn" }],
      };
      table.tasks.push(record);
      log.info({ id, parentKey: input.parentKey, title: input.title }, "Sub-session created");
      return clone(record);
    });
  }

  /**
   * Change fields other than the lifecycle. `fn` must not touch `status`,
   * `waitingOn` or the transition log: those change only through
   * {@link transition}. Returns the updated record, or undefined when there is
   * no such task. A call that changes nothing writes nothing (and so fires no
   * onChange), unless the table it read needs writing back anyway (it came
   * from the backup).
   */
  update(id: string, fn: (record: SubsessionRecord) => void): SubsessionRecord | undefined {
    let changed = true;
    return this.mutate((table) => {
      const record = table.tasks.find((t) => t.id === id);
      if (!record) { changed = false; return undefined; }
      const before = JSON.stringify(record);
      const { status, waitingOn } = record;
      const logLength = record.transitions.length;
      fn(record);
      if (record.status !== status || record.waitingOn !== waitingOn || record.transitions.length !== logLength) {
        throw new Error(`Sub-session ${id}: update() may not change the lifecycle; use transition()`);
      }
      trimLists(record);
      changed = JSON.stringify(record) !== before;
      return clone(record);
    }, () => changed);
  }

  /**
   * THE one place a task's status changes. Under the lock, reads the current
   * status, asks the state machine, and writes the result with `patch` in the
   * same write (compare-and-set: what was read is what is judged). An illegal
   * event is refused and logged (thrown when strict); a legal no-op ("same")
   * still applies `patch` and is not logged as a transition.
   */
  transition(id: string, event: SubsessionEvent, opts: TransitionOptions = {}): TransitionOutcome {
    return this.mutate((table): TransitionOutcome => {
      const record = table.tasks.find((t) => t.id === id);
      if (!record) {
        log.warn({ id, event }, "Sub-session transition refused: no such task");
        return { ok: false, from: null };
      }
      const from = record.status;
      if (opts.expectFrom && !opts.expectFrom.includes(from)) {
        log.info({ id, event, from, expected: opts.expectFrom }, "Sub-session transition skipped: status changed meanwhile");
        return { ok: false, from, record: clone(record) };
      }
      const target = nextStatus(from, record.waitingOn, event);
      if (target === null) {
        if (this.strict) throw new IllegalTransitionError(id, from, event);
        log.warn({ id, event, from, waitingOn: record.waitingOn, reason: opts.reason }, "Sub-session transition refused: not allowed from this status");
        return { ok: false, from, record: clone(record) };
      }
      const refused = opts.guard?.(record);
      if (refused) {
        log.info({ id, event, from, refused }, "Sub-session transition refused by its guard");
        return { ok: false, from, record: clone(record), refused };
      }
      const now = this.now();
      if (target !== "same") {
        if (from === "active" && record.activeSince !== undefined) {
          record.activeMs += Math.max(0, now - record.activeSince);
          delete record.activeSince;
          delete record.activeSeenAt;
        }
        record.status = target.status;
        if (target.status === "waiting") {
          record.waitingOn = target.waitingOn;
          if (opts.reason) record.waitingReason = opts.reason;
          else delete record.waitingReason;
        } else {
          delete record.waitingOn;
          delete record.waitingReason;
        }
        if (target.status === "active") { record.activeSince = now; record.activeSeenAt = now; }
        if (target.status === "finished" || target.status === "cancelled" || target.status === "failed" || target.status === "archived") {
          record.endedAt = now;
        } else {
          delete record.endedAt;
        }
        // An ended task never changes again, so nothing a backup held about it can be newer.
        if (TERMINAL_STATUSES.has(target.status)) delete record.restored;
        record.transitions.push({ at: now, from, to: target.status, event, ...(opts.reason ? { reason: opts.reason } : {}) });
        log.info({ id, event, from, to: target.status, waitingOn: record.waitingOn, reason: opts.reason }, "Sub-session transition");
      }
      record.lastActivityAt = now;
      opts.patch?.(record);
      // A question handed to the main session stands only while the task
      // waits for the owner's answer (the patch still sees it: a relay that
      // ends the wait is marked as that answer).
      if (record.status !== "waiting" || record.waitingOn !== "owner") delete record.askViaMain;
      // Why a pause was made stands only while that pause does: not once the
      // task moved on, nor once it waits on a question instead.
      if (record.status !== "waiting" || record.waitingOn !== "owner" || record.askViaMain) delete record.pausedBy;
      // A quota go-ahead is for the work in hand, not for whatever a finished task is woken to do later.
      if (record.status === "finished" || TERMINAL_STATUSES.has(record.status)) delete record.quotaPass;
      if (record.status !== (target === "same" ? from : target.status)) {
        throw new Error(`Sub-session ${id}: a transition patch may not change the status`);
      }
      trimLists(record);
      return { ok: true, changed: target !== "same", from, record: clone(record) };
    });
  }

  /**
   * Make sure no new task gets an id at or below `n` (`s<n>`). For ids the
   * registry still holds while the table lost them: reusing one would put a
   * new task on an old task's conversation.
   */
  reserveIdsThrough(n: number): void {
    this.mutate((table) => { if (table.nextId <= n) table.nextId = n + 1; });
  }

  /** Drop records for good (terminal ones past retention). */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.mutate((table) => { table.tasks = table.tasks.filter((t) => !drop.has(t.id)); });
  }

  /** `changed`, when given, may skip the write: only for a table read cleanly ("ok"). */
  private mutate<T>(fn: (table: SubsessionTable) => T, changed?: () => boolean): T {
    const db = this.ready();
    let written: SubsessionTable | null = null;
    const result = db.transaction(() => {
      const before = this.readRows(db);
      const table = clone(before.table);
      const out = fn(table);
      if (changed && !changed() && this.lastState === "ok") return out;
      writeRows(db, before, table);
      written = table;
      return out;
    });
    if (written) {
      this.cached = clone(written);
      this.lastState = "ok";
      this.recoveredByImport = false;
      try { this.onChange?.(); } catch (err) { log.warn({ err }, "Sub-session change listener failed"); }
    }
    return result;
  }

  /** The database, opened and the old file imported. Throws SubsessionStoreError when it cannot be used. */
  private ready(): TomoDb {
    let db: TomoDb;
    try {
      db = sharedTomoDb(this.dbPath);
    } catch (err) {
      this.lastState = "unreadable";
      throw new SubsessionStoreError(`Sub-session table: Tomo's database ${this.dbPath} could not be opened`, err);
    }
    try {
      if (!this.importChecked) {
        this.importLegacy(db);
        this.importChecked = true;
      } else if (metaValue(db, SUBSESSIONS_EXPORTED_KEY) !== undefined) {
        throw new SubsessionStoreError(`The sub-session tasks were exported for a rollback (\`tomo db export subsessions\`); Tomo imports ${this.path} when it starts`);
      }
    } catch (err) {
      this.lastState = "unreadable";
      throw err instanceof SubsessionStoreError ? err : new SubsessionStoreError(`Sub-session table: ${(err as Error).message}`, err);
    }
    return db;
  }

  /** The table as stored, parsed. Throws SubsessionStoreError (and the state says unreadable) when a row does not parse. */
  private readRows(db: TomoDb): StoredTable {
    let stored: StoredTable;
    try {
      stored = readStored(db);
    } catch (err) {
      this.lastState = "unreadable";
      throw new SubsessionStoreError(`Sub-session table in ${this.dbPath} is unreadable`, err);
    }
    this.cached = stored.table;
    this.lastState = !stored.written ? "missing" : this.recoveredByImport ? "recovered" : "ok";
    return stored;
  }

  // --- The old file -------------------------------------------------------

  /**
   * Import `subsessions.json` (or its `.bak`) into the database, in one
   * transaction, then keep copies aside and leave the placeholder (see the
   * class comment). What is imported:
   *
   * - The file, when it holds a table not imported before, and either the
   *   database has no table yet (the first start of this version) or a
   *   rollback export marked it (an older Tomo continued from the export:
   *   the file replaces the rows). Otherwise the database already has a table
   *   that did not come from this file: it is refused, nothing changed.
   * - The `.bak`, untrusted (`recovered`), when the file is missing or will not
   *   read and the database has no table yet (or a rollback export marked
   *   it): the old store's own recovery, done once.
   * - Nothing, when the file is missing and there is no `.bak` (a fresh
   *   install: `missing`), or only the placeholder is there. A rollback mark
   *   beside the placeholder is an export that never landed: cleared.
   *
   * A file and a `.bak` that both will not read, with no table in the
   * database, refuse every call: there was a table.
   */
  private importLegacy(db: TomoDb): void {
    const primary = readLegacyTable(this.path);
    const backup = readLegacyTable(this.backupPath);
    const outcome = db.transaction((): { from: "file" | "backup"; tasks: number; replaced: boolean } | null => {
      const exported = metaValue(db, SUBSESSIONS_EXPORTED_KEY) !== undefined;
      const stored = readStored(db);
      const empty = !stored.written && stored.table.tasks.length === 0;
      if (primary.kind === "table") {
        // After a rollback export the file is the truth, whatever its bytes
        // (an older Tomo, or a restored copy, can write the very file imported
        // before): the mark wins over the digest.
        if (!exported && metaValue(db, SUBSESSIONS_IMPORTED_KEY) === primary.digest) return null;
        if (!empty && !exported) {
          throw new SubsessionStoreError(`${this.path} holds a sub-session table the database has not imported, and the database already has one. `
            + "Nothing was changed. Move the file aside to keep the database's table, or export with `tomo db export subsessions` first to go back to it.");
        }
        replaceRows(db, stored, primary.table);
        setMeta(db, SUBSESSIONS_IMPORTED_KEY, primary.digest);
        deleteMeta(db, SUBSESSIONS_EXPORTED_KEY);
        return { from: "file", tasks: primary.table.tasks.length, replaced: !empty };
      }
      if (primary.kind === "placeholder" || (!empty && !exported)) {
        // The database has the table (or this is the placeholder): a broken
        // or missing file beside it is not a newer one.
        if (deleteMeta(db, SUBSESSIONS_EXPORTED_KEY) > 0) log.warn({ file: this.path }, "A sub-session rollback export never wrote its file; the tasks stay in the database");
        return null;
      }
      if (backup.kind === "table") {
        if (!exported && metaValue(db, SUBSESSIONS_IMPORTED_KEY) === backup.digest) return null;
        replaceRows(db, stored, this.untrust(backup.table));
        setMeta(db, SUBSESSIONS_IMPORTED_KEY, backup.digest);
        deleteMeta(db, SUBSESSIONS_EXPORTED_KEY);
        return { from: "backup", tasks: backup.table.tasks.length, replaced: !empty };
      }
      if (primary.kind === "absent" && backup.kind === "absent") {
        if (deleteMeta(db, SUBSESSIONS_EXPORTED_KEY) > 0) log.warn({ file: this.path }, "A sub-session rollback export never wrote its file; the tasks stay in the database");
        return null;
      }
      const cause = primary.kind === "bad" ? primary.cause : backup.kind === "bad" ? backup.cause : undefined;
      throw new SubsessionStoreError(primary.kind === "absent"
        ? `Sub-session table ${this.path} is missing and its backup is unreadable`
        : `Sub-session table ${this.path} is unreadable and has no usable backup`, cause);
    });
    if (outcome) {
      if (outcome.from === "backup") {
        this.recoveredByImport = true;
        log.warn({ file: this.path, tasks: outcome.tasks }, primary.kind === "absent"
          ? "Sub-session table missing; imported its backup into the database (untrusted until /s trust)"
          : "Sub-session table unreadable; imported its backup into the database (untrusted until /s trust)");
      } else {
        log.info({ file: this.path, tasks: outcome.tasks, replaced: outcome.replaced }, outcome.replaced
          ? "Imported the sub-session table file (an older Tomo continued from the rollback export) over the database's"
          : "Imported the sub-session table file into the database");
      }
    }
    this.finishImport(primary, backup);
  }

  /**
   * After the import committed (or found nothing to do): the old files are
   * kept aside and the placeholder left at the path. Each step is safe to
   * repeat, and a failure is retried by the next start. Not after a refusal
   * (that throws before here): the files stay as they are for the owner.
   */
  private finishImport(primary: LegacyTable, backup: LegacyTable): void {
    // Every step must land before this process writes anything: until the
    // old files are out of the way, an older Tomo started in between must see
    // exactly what was imported (the file, or the .bak it would recover from
    // itself), never an empty table nor one this process has moved on from.
    // A failure keeps sub-sessions off this start; the next start finishes it
    // (each step is safe to repeat).
    try {
      if (primary.kind === "table") {
        // The file holds what was imported: the .bak can go first.
        keepAside(this.path, primary.raw);
        this.moveBackupAside(backup);
        writePlaceholder(this.path, subsessionsPlaceholder(this.dbPath));
      } else {
        // No usable file: an older Tomo would recover from the .bak, so it
        // goes only once the placeholder (which still sends it there) is in.
        if (primary.kind === "bad" && primary.raw) keepCorruptCopy(this.path);
        if (primary.kind !== "placeholder") writePlaceholder(this.path, subsessionsPlaceholder(this.dbPath));
        this.moveBackupAside(backup);
      }
    } catch (err) {
      throw new SubsessionStoreError(`Imported the sub-session table, but could not put the old files at ${this.path} aside; sub-sessions stay off until that works (the next start retries)`, err);
    }
  }

  private moveBackupAside(backup: LegacyTable): void {
    if (backup.kind === "absent") return;
    if (backup.kind === "table") keepAside(this.backupPath, backup.raw);
    else keepCorruptCopy(this.backupPath);
    unlinkSync(this.backupPath);
  }

  /** A table read from `.bak` may be missing tasks, and its records may be stale: it says so from here on, in every write. */
  private untrust(table: SubsessionTable): SubsessionTable {
    // A fresh recovery: the owner is told again (no `notified`).
    table.untrusted = { since: this.now(), reason: table.untrusted?.reason ?? "recovered" };
    // Every open status in it may be older than what happened since. An
    // ended one cannot be: cancelled, failed and archived never change.
    for (const task of table.tasks) if (!TERMINAL_STATUSES.has(task.status)) task.restored = true;
    return table;
  }

  /** Mark the table as possibly missing tasks (see `SubsessionTable.untrusted`). */
  markUntrusted(reason: "recovered" | "lost"): void {
    this.mutate((table) => { if (!table.untrusted) table.untrusted = { since: this.now(), reason }; });
  }

  /** The owner was told about the mark (see `SubsessionTable.untrusted`): called once the notice went out. */
  markNotified(): void {
    this.mutate((table) => { if (table.untrusted) table.untrusted.notified = true; });
  }

  /**
   * The owner checked the recovered table and says it is right (`/s trust`):
   * the `untrusted` mark and every `restored` mark go. The only way either
   * ends besides a live report or cancel of that one record: nothing clears
   * them on its own. Returns whether there was a mark to clear.
   */
  trust(): boolean {
    return this.mutate((table) => {
      const had = !!table.untrusted || table.tasks.some((t) => t.restored);
      for (const task of table.tasks) delete task.restored;
      delete table.untrusted;
      return had;
    });
  }

}

// --- Rows -----------------------------------------------------------------

interface StoredTable {
  table: SubsessionTable;
  /** Has the table been written (or imported) at least once? (The state row exists.) */
  written: boolean;
  /** Each stored task's record as parsed, serialized: what a write compares against. */
  rows: Map<string, string>;
}

/** Copy a file that will not read aside, byte for byte, as `<path>.corrupt-<ts>`, once per content. */
function keepCorruptCopy(path: string): void {
  const raw = readFileSync(path);
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) && readFileSync(join(dir, name)).equals(raw)) return;
  }
  copyFileSync(path, `${path}.corrupt-${fileTimestamp()}`);
}

/** The table as stored, from one snapshot (the state row and the task rows never from two moments). */
function readStored(db: TomoDb): StoredTable {
  return db.snapshot(() => readStoredNow(db));
}

function readStoredNow(db: TomoDb): StoredTable {
  const state = db.get<{ next_id: number; untrusted: string | null }>("SELECT next_id, untrusted FROM subsessions_state WHERE one = 1");
  const records = db.all<{ record: string }>("SELECT record FROM subsessions ORDER BY seq").map((r) => JSON.parse(r.record) as unknown);
  const table = parseTable({
    version: 1,
    nextId: state ? Number(state.next_id) : 1,
    tasks: records,
    ...(state?.untrusted ? { untrusted: JSON.parse(state.untrusted) as unknown } : {}),
  });
  const rows = new Map(table.tasks.map((t) => [t.id, JSON.stringify(t)]));
  return { table, written: state !== undefined, rows };
}

/** Write what changed between `before` and `after`: changed and new rows, removed rows, the state row. */
function writeRows(db: TomoDb, before: StoredTable, after: SubsessionTable): void {
  const keep = new Set<string>();
  for (const task of after.tasks) {
    if (keep.has(task.id)) throw new Error(`Sub-session table: two tasks with id ${task.id}`);
    keep.add(task.id);
    const json = JSON.stringify(task);
    const prev = before.rows.get(task.id);
    if (prev === json) continue;
    if (prev === undefined) db.run("INSERT INTO subsessions (id, record) VALUES (?, ?)", task.id, json);
    else db.run("UPDATE subsessions SET record = ? WHERE id = ?", json, task.id);
  }
  for (const id of before.rows.keys()) if (!keep.has(id)) db.run("DELETE FROM subsessions WHERE id = ?", id);
  const untrusted = after.untrusted ? JSON.stringify(after.untrusted) : null;
  const prevUntrusted = before.table.untrusted ? JSON.stringify(before.table.untrusted) : null;
  if (!before.written || after.nextId !== before.table.nextId || untrusted !== prevUntrusted) {
    db.run("INSERT INTO subsessions_state (one, next_id, untrusted) VALUES (1, ?, ?) ON CONFLICT (one) DO UPDATE SET next_id = excluded.next_id, untrusted = excluded.untrusted",
      after.nextId, untrusted);
  }
}

/** Replace every row with `table`'s (an import). Never lowers nextId: an id once handed out is not reused. */
function replaceRows(db: TomoDb, before: StoredTable, table: SubsessionTable): void {
  db.run("DELETE FROM subsessions");
  const next = { ...table, nextId: Math.max(table.nextId, before.written ? before.table.nextId : 1) };
  writeRows(db, { table: EMPTY(), written: false, rows: new Map() }, next);
}

// --- The old file ---------------------------------------------------------

type LegacyTable =
  | { kind: "absent" }
  | { kind: "placeholder" }
  | { kind: "table"; table: SubsessionTable; raw: string; digest: string }
  | { kind: "bad"; cause: unknown; raw: boolean };

function readLegacyTable(path: string): LegacyTable {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    return { kind: "bad", cause: err, raw: false };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (err) {
    return { kind: "bad", cause: err, raw: true };
  }
  if (text.trim() === "") return { kind: "bad", cause: new Error("empty file"), raw: true };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { kind: "bad", cause: err, raw: true };
  }
  if (isPlaceholder(data, ["tasks", "nextId", "version"])) return { kind: "placeholder" };
  try {
    return { kind: "table", table: parseTable(data), raw: text, digest: digestOf(buf) };
  } catch (err) {
    return { kind: "bad", cause: err, raw: true };
  }
}

/**
 * `tomo db export subsessions`: write the table to `out` in the old file's
 * format, fsynced. With `mark` (the rollback, to the old path) the snapshot
 * and the mark commit together BEFORE the file is written (the cron export's
 * order): from the mark on every store call refuses, so nothing changes the
 * rows behind the snapshot, and the file is never there without the mark (a
 * table file without it would be refused at the next start). A file that does
 * not land takes the mark back; one left behind is cleared by the next start,
 * which finds only the placeholder. Returns how many tasks were written.
 */
export function exportSubsessionsToFile(db: TomoDb, out: string, opts: { mark: boolean }): number {
  const write = (table: SubsessionTable): number => {
    mkdirSync(dirname(out), { recursive: true });
    // `exportedAt` is ignored by an older Tomo; it keeps this file's digest
    // from ever matching a file imported before.
    writeJsonAtomicSync(out, { ...table, exportedAt: new Date().toISOString() }, { fsync: true });
    return table.tasks.length;
  };
  if (!opts.mark) return write(readStored(db).table);
  const table = db.transaction(() => {
    setMeta(db, SUBSESSIONS_EXPORTED_KEY, new Date().toISOString());
    return readStored(db).table;
  });
  try {
    return write(table);
  } catch (err) {
    if (legacySubsessionsFileReplaceable(out)) {
      try { deleteMeta(db, SUBSESSIONS_EXPORTED_KEY); } catch { /* the next start undoes it */ }
    }
    throw err;
  }
}

/** Is the file at `path` absent, or only the placeholder (safe for a rollback export to replace)? */
export function legacySubsessionsFileReplaceable(path: string): boolean {
  const state = readLegacyTable(path);
  return state.kind === "absent" || state.kind === "placeholder";
}

/**
 * Task titles by id, read-only, for the web process's cost page: never
 * imports, never writes, and best-effort (an empty map when the database or
 * the table is not there yet).
 */
export function readSubsessionTitles(dbPath: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(dbPath)) return titles;
  let db: TomoDb | null = null;
  try {
    db = openTomoDb(dbPath, { readOnly: true, allowNewerSchema: true });
    for (const row of db.all<{ id: string; title: unknown }>("SELECT id, title FROM subsessions")) {
      if (typeof row.title === "string") titles.set(row.id, row.title);
    }
  } catch { /* no titles */ } finally {
    db?.close();
  }
  return titles;
}

/**
 * Shape-check a table read from disk. Core fields must be right or the whole
 * read fails (and the backup is tried); fields added later are defaulted.
 * Exported for tests.
 */
export function parseTable(raw: unknown): SubsessionTable {
  if (!raw || typeof raw !== "object") throw new Error("not an object");
  const t = raw as Record<string, unknown>;
  if (t.version !== 1) throw new Error(`unknown version ${String(t.version)}`);
  if (typeof t.nextId !== "number" || !Number.isInteger(t.nextId) || t.nextId < 1) throw new Error("bad nextId");
  if (!Array.isArray(t.tasks)) throw new Error("tasks is not an array");
  const tasks = t.tasks.map((entry, i) => parseRecord(entry, i));
  const untrusted = parseUntrusted(t.untrusted);
  return { version: 1, nextId: t.nextId, tasks, ...(untrusted ? { untrusted } : {}) };
}

function parseUntrusted(raw: unknown): SubsessionTable["untrusted"] {
  if (raw === undefined) return undefined;
  const u = raw as Record<string, unknown> | null;
  // Present but malformed still means "do not trust": never dropped silently.
  const since = u && typeof u.since === "number" && Number.isFinite(u.since) ? u.since : 0;
  const reason = u && u.reason === "lost" ? "lost" : "recovered";
  return { since, reason, ...(u && u.notified === true ? { notified: true as const } : {}) };
}

function parseRecord(raw: unknown, index: number): SubsessionRecord {
  if (!raw || typeof raw !== "object") throw new Error(`task ${index} is not an object`);
  const r = raw as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof r[k] !== "string") throw new Error(`task ${index}: ${k} is not a string`);
    return r[k] as string;
  };
  const num = (k: string, fallback: number) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? r[k] as number : fallback);
  const status = str("status") as SubsessionStatus;
  if (!(SUBSESSION_STATUSES as readonly string[]).includes(status)) throw new Error(`task ${index}: unknown status ${status}`);
  const id = str("id");
  const createdAt = num("createdAt", 0);
  const pendingInput = parseInputs(r.pendingInput);
  const lastSeq = pendingInput.at(-1)?.seq ?? 0;
  // `progress` (the old task_progress line) is no longer kept: a record
  // written before is read without it. `todoId` (the todo sub-sessions once
  // kept on the owner's list) is read as `legacyTodoId`, for the startup
  // pass that drops those todos.
  const kept = { ...r };
  delete kept.progress;
  delete kept.todoId;
  const legacyTodoId = typeof r.todoId === "string" && r.todoId ? r.todoId : typeof r.legacyTodoId === "string" && r.legacyTodoId ? r.legacyTodoId : undefined;
  delete kept.legacyTodoId;
  delete kept.restored;
  return {
    ...(kept as unknown as SubsessionRecord),
    ...(legacyTodoId ? { legacyTodoId } : {}),
    id,
    sessionKey: str("sessionKey"),
    parentKey: str("parentKey"),
    title: str("title"),
    brief: str("brief"),
    status,
    createdAt,
    lastActivityAt: num("lastActivityAt", createdAt),
    activeMs: num("activeMs", 0),
    resumeNeeded: r.resumeNeeded === true,
    startDelivered: r.startDelivered === true,
    interruptStreak: num("interruptStreak", 0),
    failStreak: num("failStreak", 0),
    ...parseLastFailure(r.lastFailure),
    turnsWithoutProgress: num("turnsWithoutProgress", 0),
    restartRequested: r.restartRequested === true,
    reportDelivered: r.reportDelivered === true,
    compactPending: r.compactPending === true,
    postCompactReminder: r.postCompactReminder === true,
    pendingInput,
    nextInputSeq: Math.max(lastSeq + 1, Math.floor(num("nextInputSeq", 1))),
    seenThrough: Math.max(0, Math.floor(num("seenThrough", 0))),
    ...(typeof r.heldThrough === "number" && Number.isFinite(r.heldThrough) ? { heldThrough: Math.max(0, Math.floor(r.heldThrough)) } : { heldThrough: undefined }),
    replyMap: Array.isArray(r.replyMap)
      ? r.replyMap.filter((m): m is SubsessionRecord["replyMap"][number] => typeof m === "object" && m !== null
        && typeof (m as Record<string, unknown>).channel === "string" && typeof (m as Record<string, unknown>).messageId === "string")
      : [],
    ownerMessageIds: Array.isArray(r.ownerMessageIds) ? r.ownerMessageIds.filter((p): p is string => typeof p === "string") : [],
    conversation: Array.isArray(r.conversation)
      ? r.conversation.filter((e): e is SubsessionRecord["conversation"][number] => typeof e === "object" && e !== null
        && typeof (e as Record<string, unknown>).seq === "number" && typeof (e as Record<string, unknown>).text === "string")
      : [],
    conversationSeq: num("conversationSeq", 0),
    mirrorSeenSeq: num("mirrorSeenSeq", 0),
    // Never on an ended task (an older table could have marked one, which kept it from ever being cleaned up).
    ...(r.restored === true && !TERMINAL_STATUSES.has(status) ? { restored: true } : {}),
    ...(typeof r.activeAtOwnerInputMs === "number" && Number.isFinite(r.activeAtOwnerInputMs) ? { activeAtOwnerInputMs: r.activeAtOwnerInputMs } : { activeAtOwnerInputMs: undefined }),
    ...(Array.isArray(r.earlierReports)
      ? { earlierReports: (r.earlierReports as unknown[]).filter((e): e is { seq: number; text: string } =>
        !!e && typeof e === "object" && typeof (e as { seq?: unknown }).seq === "number" && typeof (e as { text?: unknown }).text === "string") }
      : { earlierReports: undefined }),
    ...(r.handedBack === true ? { handedBack: true } : { handedBack: undefined }),
    ...(typeof r.ownerAction === "string" && r.ownerAction.trim() ? { ownerAction: r.ownerAction } : { ownerAction: undefined }),
    ...(Array.isArray(r.plan) ? { plan: parsePlan(r.plan) } : { plan: undefined }),
    ...(Array.isArray(r.doneSteps) ? { doneSteps: parseDoneSteps(r.doneSteps) } : { doneSteps: undefined }),
    ...(Array.isArray(r.updates) ? { updates: parseUpdates(r.updates) } : { updates: undefined }),
    sent: Array.isArray(r.sent) ? r.sent as SubsessionRecord["sent"] : [],
    ...parseAskViaMain(r.askViaMain, status, r.waitingOn),
    ...parsePausedBy(r.pausedBy, status, r.waitingOn),
    ...(status !== "finished" && !TERMINAL_STATUSES.has(status) && parseQuotaPass(r.quotaPass) ? { quotaPass: parseQuotaPass(r.quotaPass) } : { quotaPass: undefined }),
    // An entry not shaped like a transition (or with a time no Date can show) is dropped.
    transitions: Array.isArray(r.transitions)
      ? (r.transitions as unknown[]).filter((t): t is SubsessionRecord["transitions"][number] => !!t && typeof t === "object"
        && isTimestamp((t as Record<string, unknown>).at) && typeof (t as Record<string, unknown>).event === "string"
        && typeof (t as Record<string, unknown>).to === "string")
      : [],
  };
}

/** A well-formed last-failure cause, or none. */
function parseLastFailure(value: unknown): { lastFailure?: SubsessionRecord["lastFailure"] } {
  if (!value || typeof value !== "object") return { lastFailure: undefined };
  const v = value as Record<string, unknown>;
  if (!isTimestamp(v.at)) return { lastFailure: undefined };
  return { lastFailure: {
    at: v.at,
    ...(typeof v.category === "string" && v.category ? { category: v.category } : {}),
    ...(v.refused === true ? { refused: true } : {}),
    ...(typeof v.detail === "string" && v.detail ? { detail: v.detail } : {}),
  } };
}

/** A well-formed question handed to the main session, kept only on a task waiting for the owner. */
function parsePausedBy(value: unknown, status: SubsessionStatus, waitingOn: unknown): { pausedBy?: SubsessionRecord["pausedBy"] } {
  if (status !== "waiting" || waitingOn !== "owner" || !value || typeof value !== "object") return { pausedBy: undefined };
  const kind = (value as Record<string, unknown>).kind;
  // An unknown kind is read as none: only the owner's own words end that wait (fail closed).
  if (!(PAUSE_KINDS as readonly unknown[]).includes(kind)) return { pausedBy: undefined };
  const resetsAt = (value as Record<string, unknown>).resetsAt;
  return { pausedBy: { kind: kind as PauseKind, ...(kind === "quota" && isTimestamp(resetsAt) ? { resetsAt: resetsAt as number } : {}) } };
}

function parseQuotaPass(value: unknown): QuotaPass | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return isTimestamp(v.until) ? { until: v.until as number } : undefined;
}

function parseAskViaMain(value: unknown, status: SubsessionStatus, waitingOn: unknown): { askViaMain?: SubsessionRecord["askViaMain"] } {
  if (status !== "waiting" || waitingOn !== "owner" || !value || typeof value !== "object") return { askViaMain: undefined };
  const v = value as Record<string, unknown>;
  if (!isTimestamp(v.at) || typeof v.text !== "string" || !v.text.trim()) return { askViaMain: undefined };
  return { askViaMain: { at: v.at, text: v.text, ...(typeof v.note === "string" && v.note ? { note: v.note } : {}), ...(v.direct === true ? { direct: true as const } : {}) } };
}

/**
 * Inputs, in seq order. Malformed entries are dropped; a plain string (no
 * seq) gets the next seq after the ones before it, so order is kept.
 */
function parseInputs(raw: unknown): SubsessionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: SubsessionInput[] = [];
  let last = 0;
  for (const entry of raw) {
    let seq: number | undefined;
    let text: string | undefined;
    // No origin (written before inputs carried one, or malformed): the
    // harness's own, never the owner's word.
    let origin: InputOrigin = { from: "harness" };
    if (typeof entry === "string") text = entry;
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.text === "string") text = e.text;
      if (typeof e.seq === "number" && Number.isInteger(e.seq) && e.seq > last) seq = e.seq;
      if (e.from === "owner" && (e.checked === true || (text ?? "").startsWith(OWNER_MESSAGE_MARKER))) {
        origin = { from: "owner", words: typeof e.words === "string" ? e.words : (text ?? ""), ...(e.source === "panel" ? { source: "panel" as const } : {}) };
      } else if (e.from === "owner" || e.from === "main") {
        // A relay stored as the owner's with no `checked` was stored before
        // origins were checked, when every relay was stored as the owner's:
        // the main session may have written it, so it is read as its note.
        origin = { from: "main", words: typeof e.words === "string" ? e.words : (text ?? "") };
      }
    }
    if (text === undefined) continue;
    last = seq ?? last + 1;
    out.push({ seq: last, text, ...origin, ...(origin.from === "owner" ? { checked: true as const } : {}) });
  }
  return out;
}

/** A timed one-line entry, or nothing when it is malformed (no finite time, no text) or blank. */
function timedLine(e: unknown, max: number): { at: number; text: string; rest: Record<string, unknown> } | undefined {
  if (!e || typeof e !== "object") return undefined;
  const rest = e as Record<string, unknown>;
  const { at, text } = rest;
  if (!isTimestamp(at) || typeof text !== "string") return undefined;
  const line = oneLine(text, max);
  return line ? { at, text: line, rest } : undefined;
}

/** Well-formed steps only, each within its limits, the newest DONE_STEPS_KEEP. */
function parseDoneSteps(raw: unknown[]): SubsessionDoneStep[] {
  return raw.flatMap((e): SubsessionDoneStep[] => {
    const entry = timedLine(e, PLAN_STEP_MAX);
    if (!entry) return [];
    const result = typeof entry.rest.result === "string" ? oneLine(entry.rest.result, STEP_RESULT_MAX) : "";
    return [{ at: entry.at, text: entry.text, ...(result ? { result } : {}) }];
  }).slice(-DONE_STEPS_KEEP);
}

/** Well-formed updates only, each one line within PROGRESS_TEXT_MAX, the newest UPDATES_KEEP. */
function parseUpdates(raw: unknown[]): SubsessionUpdate[] {
  return raw.flatMap((e): SubsessionUpdate[] => {
    const entry = timedLine(e, PROGRESS_TEXT_MAX);
    return entry ? [{ at: entry.at, text: entry.text, ...(entry.rest.kind === "plan" || entry.rest.kind === "release" ? { kind: entry.rest.kind } : {}) }] : [];
  }).slice(-UPDATES_KEEP);
}

/**
 * Well-formed steps only, each one line within PLAN_STEP_MAX, the first
 * PLAN_MAX_STEPS, no two alike (task_plan refuses them): a second copy is
 * dropped, and the first takes its in_progress if it had it.
 */
function parsePlan(raw: unknown[]): SubsessionPlanStep[] {
  const byText = new Map<string, SubsessionPlanStep>();
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const { text, status } = e as { text?: unknown; status?: unknown };
    const line = typeof text === "string" ? oneLine(text, PLAN_STEP_MAX) : "";
    if (!line) continue;
    const step = byText.get(line) ?? { text: line, status: "pending" as const };
    if (status === "in_progress") step.status = "in_progress";
    byText.set(line, step);
  }
  return [...byText.values()].slice(0, PLAN_MAX_STEPS);
}

/** The capped logs. pendingInput is NOT one of them: accepted input is never dropped. */
function trimLists(record: SubsessionRecord): void {
  if (record.sent.length > SENT_KEEP) record.sent = record.sent.slice(-SENT_KEEP);
  if (record.transitions.length > TRANSITION_LOG_KEEP) record.transitions = record.transitions.slice(-TRANSITION_LOG_KEEP);
  if (record.replyMap.length > REPLY_MAP_KEEP) record.replyMap = record.replyMap.slice(-REPLY_MAP_KEEP);
  if (record.conversation.length > CONVERSATION_KEEP) record.conversation = record.conversation.slice(-CONVERSATION_KEEP);
  if (record.plan && record.plan.length > PLAN_MAX_STEPS) record.plan = record.plan.slice(0, PLAN_MAX_STEPS);
  if (record.doneSteps && record.doneSteps.length > DONE_STEPS_KEEP) record.doneSteps = record.doneSteps.slice(-DONE_STEPS_KEEP);
  if (record.updates && record.updates.length > UPDATES_KEEP) record.updates = record.updates.slice(-UPDATES_KEEP);
  if (record.ownerMessageIds.length > OWNER_MESSAGE_IDS_KEEP) record.ownerMessageIds = record.ownerMessageIds.slice(-OWNER_MESSAGE_IDS_KEEP);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
