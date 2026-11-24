import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLockSync } from "../../file-lock.js";
import { writeJsonAtomicSync } from "../../fs-utils.js";
import { log } from "../../logger.js";
import { taskSessionKey } from "../../sessions/keys.js";
import { IllegalTransitionError, nextStatus, type SubsessionEvent } from "./state-machine.js";
import {
  PENDING_INPUT_KEEP,
  SENT_KEEP,
  SUBSESSION_STATUSES,
  TRANSITION_LOG_KEEP,
  type SubsessionRecord,
  type SubsessionStatus,
  type SubsessionTable,
} from "./types.js";

/**
 * The task table, `~/.tomo/data/subsessions.json`.
 *
 * It is the reconcile source for everything else a task touches (registry,
 * cron, pending notes), so it is written the way the session registry is
 * since #619: under an advisory lock for the whole read-modify-write, fsynced,
 * and copied to `.bak` after every successful write. And AN UNREADABLE TABLE
 * IS NOT AN EMPTY ONE: a missing file reads as empty (`missing`), but a
 * 0-byte or unparseable one falls back to `.bak` (`recovered`) and, failing
 * that, refuses every read and write (`unreadable`) rather than letting the
 * startup reconcile see "no tasks" and unlink every task's registry entry.
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
}

export type TransitionOutcome =
  | { ok: true; changed: boolean; from: SubsessionStatus; record: SubsessionRecord }
  | { ok: false; from: SubsessionStatus | null; record?: SubsessionRecord };

const EMPTY: () => SubsessionTable = () => ({ version: 1, nextId: 1, tasks: [] });

export class SubsessionStore {
  private readonly lockPath: string;
  private readonly backupPath: string;
  private cached: SubsessionTable | null = null;
  private lastState: SubsessionStoreState | null = null;
  private readonly now: () => number;
  /** Tests: an illegal transition throws instead of being logged and refused. */
  private readonly strict: boolean;

  constructor(readonly path: string, opts: { now?: () => number; strictTransitions?: boolean } = {}) {
    this.lockPath = `${path}.lock`;
    this.backupPath = `${path}.bak`;
    this.now = opts.now ?? Date.now;
    this.strict = opts.strictTransitions ?? false;
  }

  /** How the last read went. `null` before the first read. */
  state(): SubsessionStoreState | null {
    return this.lastState;
  }

  /** A fresh read (under the lock). Throws SubsessionStoreError when unreadable. */
  read(): SubsessionTable {
    return withFileLockSync(this.lockPath, () => clone(this.readLocked()));
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
   * no such task.
   */
  update(id: string, fn: (record: SubsessionRecord) => void): SubsessionRecord | undefined {
    return this.mutate((table) => {
      const record = table.tasks.find((t) => t.id === id);
      if (!record) return undefined;
      const { status, waitingOn } = record;
      const logLength = record.transitions.length;
      fn(record);
      if (record.status !== status || record.waitingOn !== waitingOn || record.transitions.length !== logLength) {
        throw new Error(`Sub-session ${id}: update() may not change the lifecycle; use transition()`);
      }
      trimLists(record);
      return clone(record);
    });
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
      const now = this.now();
      if (target !== "same") {
        if (from === "active" && record.activeSince !== undefined) {
          record.activeMs += Math.max(0, now - record.activeSince);
          delete record.activeSince;
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
        if (target.status === "active") record.activeSince = now;
        if (target.status === "finished" || target.status === "cancelled" || target.status === "failed" || target.status === "archived") {
          record.endedAt = now;
        } else {
          delete record.endedAt;
        }
        record.transitions.push({ at: now, from, to: target.status, event, ...(opts.reason ? { reason: opts.reason } : {}) });
        log.info({ id, event, from, to: target.status, waitingOn: record.waitingOn, reason: opts.reason }, "Sub-session transition");
      }
      record.lastActivityAt = now;
      opts.patch?.(record);
      if (record.status !== (target === "same" ? from : target.status)) {
        throw new Error(`Sub-session ${id}: a transition patch may not change the status`);
      }
      trimLists(record);
      return { ok: true, changed: target !== "same", from, record: clone(record) };
    });
  }

  /** Drop records for good (terminal ones past retention). */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.mutate((table) => { table.tasks = table.tasks.filter((t) => !drop.has(t.id)); });
  }

  private mutate<T>(fn: (table: SubsessionTable) => T): T {
    return withFileLockSync(this.lockPath, () => {
      const table = clone(this.readLocked());
      const result = fn(table);
      this.writeLocked(table);
      return result;
    });
  }

  private readLocked(): SubsessionTable {
    const primary = readTable(this.path);
    if (primary.kind === "ok") return this.remember(primary.table, "ok");
    if (primary.kind === "missing") {
      // A missing primary with a good backup is a lost write, not a fresh
      // install: take the backup.
      const backup = readTable(this.backupPath);
      if (backup.kind === "ok") {
        log.warn({ path: this.path }, "Sub-session table missing; recovered from its backup");
        return this.remember(backup.table, "recovered");
      }
      return this.remember(EMPTY(), "missing");
    }
    const backup = readTable(this.backupPath);
    if (backup.kind === "ok") {
      // Keep the bad file for a human to look at, under a second name. The
      // primary is replaced by the next write.
      const corrupt = `${this.path}.corrupt-${this.now()}`;
      try { copyFileSync(this.path, corrupt); } catch (err) { log.warn({ err, corrupt }, "Could not keep a copy of the unreadable sub-session table"); }
      log.error({ path: this.path, cause: primary.cause, corrupt }, "Sub-session table unreadable; recovered from its backup");
      return this.remember(backup.table, "recovered");
    }
    this.lastState = "unreadable";
    throw new SubsessionStoreError(`Sub-session table ${this.path} is unreadable and has no usable backup`, primary.cause);
  }

  private remember(table: SubsessionTable, state: SubsessionStoreState): SubsessionTable {
    this.cached = table;
    this.lastState = state;
    return table;
  }

  private writeLocked(table: SubsessionTable): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeJsonAtomicSync(this.path, table, { fsync: true });
    this.cached = clone(table);
    this.lastState = "ok";
    try {
      writeJsonAtomicSync(this.backupPath, table, { fsync: true });
    } catch (err) {
      // The primary is good; the next successful write refreshes the backup.
      log.warn({ err, path: this.backupPath }, "Could not refresh the sub-session table backup");
    }
  }
}

type ReadResult =
  | { kind: "ok"; table: SubsessionTable }
  | { kind: "missing" }
  | { kind: "bad"; cause: unknown };

function readTable(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "bad", cause: err };
  }
  if (text.trim() === "") return { kind: "bad", cause: new Error("empty file") };
  try {
    return { kind: "ok", table: parseTable(JSON.parse(text)) };
  } catch (err) {
    return { kind: "bad", cause: err };
  }
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
  return { version: 1, nextId: t.nextId, tasks };
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
  return {
    ...(r as unknown as SubsessionRecord),
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
    turnsWithoutProgress: num("turnsWithoutProgress", 0),
    restartRequested: r.restartRequested === true,
    reportDelivered: r.reportDelivered === true,
    compactPending: r.compactPending === true,
    postCompactReminder: r.postCompactReminder === true,
    pendingInput: Array.isArray(r.pendingInput) ? r.pendingInput.filter((p): p is string => typeof p === "string") : [],
    sent: Array.isArray(r.sent) ? r.sent as SubsessionRecord["sent"] : [],
    transitions: Array.isArray(r.transitions) ? r.transitions as SubsessionRecord["transitions"] : [],
  };
}

function trimLists(record: SubsessionRecord): void {
  if (record.sent.length > SENT_KEEP) record.sent = record.sent.slice(-SENT_KEEP);
  if (record.transitions.length > TRANSITION_LOG_KEEP) record.transitions = record.transitions.slice(-TRANSITION_LOG_KEEP);
  if (record.pendingInput.length > PENDING_INPUT_KEEP) record.pendingInput = record.pendingInput.slice(-PENDING_INPUT_KEEP);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
