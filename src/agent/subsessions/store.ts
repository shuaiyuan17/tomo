import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLockSync } from "../../file-lock.js";
import { writeJsonAtomicSync } from "../../fs-utils.js";
import { log } from "../../logger.js";
import { taskSessionKey } from "../../sessions/keys.js";
import { IllegalTransitionError, nextStatus, type SubsessionEvent } from "./state-machine.js";
import {
  OWNER_MESSAGE_IDS_KEEP,
  OWNER_MESSAGE_MARKER,
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

export class SubsessionStore {
  private readonly lockPath: string;
  private readonly backupPath: string;
  private cached: SubsessionTable | null = null;
  private lastState: SubsessionStoreState | null = null;
  private readonly now: () => number;
  /** Tests: an illegal transition throws instead of being logged and refused. */
  private readonly strict: boolean;
  /** Called after every successful write (the web UI's live sub-session list); never throws into a write. */
  private readonly onChange: (() => void) | undefined;

  constructor(readonly path: string, opts: { now?: () => number; strictTransitions?: boolean; onChange?: () => void } = {}) {
    this.lockPath = `${path}.lock`;
    this.backupPath = `${path}.bak`;
    this.now = opts.now ?? Date.now;
    this.strict = opts.strictTransitions ?? false;
    this.onChange = opts.onChange;
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

  /** `changed`, when given, may skip the write: only for a table read cleanly from the primary. */
  private mutate<T>(fn: (table: SubsessionTable) => T, changed?: () => boolean): T {
    return withFileLockSync(this.lockPath, () => {
      const table = clone(this.readLocked());
      const result = fn(table);
      if (changed && !changed() && this.lastState === "ok") return result;
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
        return this.remember(this.untrust(backup.table), "recovered");
      }
      if (backup.kind === "missing") return this.remember(EMPTY(), "missing");
      // No primary, and a backup that exists but cannot be read: there WAS a
      // table. Empty would reuse s1 over a live task:s1 conversation.
      this.lastState = "unreadable";
      throw new SubsessionStoreError(`Sub-session table ${this.path} is missing and its backup is unreadable`, backup.cause);
    }
    const backup = readTable(this.backupPath);
    if (backup.kind === "ok") {
      // Keep the bad file for a human to look at, under a second name. The
      // primary is replaced by the next write.
      const corrupt = `${this.path}.corrupt-${this.now()}`;
      try { copyFileSync(this.path, corrupt); } catch (err) { log.warn({ err, corrupt }, "Could not keep a copy of the unreadable sub-session table"); }
      log.error({ path: this.path, cause: primary.cause, corrupt }, "Sub-session table unreadable; recovered from its backup");
      return this.remember(this.untrust(backup.table), "recovered");
    }
    this.lastState = "unreadable";
    throw new SubsessionStoreError(`Sub-session table ${this.path} is unreadable and has no usable backup`, primary.cause);
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
    // Inside the lock, so a listener must only schedule work, never read back synchronously.
    try { this.onChange?.(); } catch (err) { log.warn({ err }, "Sub-session change listener failed"); }
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
    // An entry not shaped like a transition (or with a time no Date can show) is dropped.
    transitions: Array.isArray(r.transitions)
      ? (r.transitions as unknown[]).filter((t): t is SubsessionRecord["transitions"][number] => !!t && typeof t === "object"
        && isTimestamp((t as Record<string, unknown>).at) && typeof (t as Record<string, unknown>).event === "string"
        && typeof (t as Record<string, unknown>).to === "string")
      : [],
  };
}

/** A well-formed question handed to the main session, kept only on a task waiting for the owner. */
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
    return entry ? [{ at: entry.at, text: entry.text, ...(entry.rest.kind === "plan" ? { kind: "plan" as const } : {}) }] : [];
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
