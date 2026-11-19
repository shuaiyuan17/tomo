import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config, TOMO_HOME } from "../config.js";
import { DEFAULT_TODOS, type TodoConfig } from "./limits.js";
import { withFileLockSync, type FileLockOptions } from "../file-lock.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

/**
 * The todo primitive's store: commitments that outlive a conversation.
 *
 * Not the SDK's TodoWrite / Task* tools, which are one turn's plan. These are
 * kept in `<tomoHome>/data/todos/`:
 *
 * - `todos.json`: the open items, rewritten whole (atomic rename) under an
 *   advisory lock for every mutation;
 * - `done.ndjson`: one line per finished item (done or dropped), append-only.
 *
 * There is no Markdown mirror. Every write goes through this class (the MCP
 * tools, `/todo`, the CLI), and the rules live here, so an item that breaks
 * them is refused when it is written rather than reported later. Direct file
 * writes by the agent are denied by a PreToolUse guard (`./guard.ts`).
 *
 * An unreadable or corrupt `todos.json` is an error, never an empty list:
 * every read and write refuses until the file is fixed, so a bad read can
 * never be saved back as "no todos".
 */

export type WaitingOn = "me" | "owner" | "external";
export type TodoSource = "owner" | "self";
export type TodoAction = "done" | "drop" | "snooze" | "handoff";

export const WAITING_ON: readonly WaitingOn[] = ["me", "owner", "external"];
export const TODO_ACTIONS: readonly TodoAction[] = ["done", "drop", "snooze", "handoff"];

export interface TodoItem {
  /** `t-<n>`: short, stable, never reused. */
  id: string;
  title: string;
  /** The next step, verb first. */
  next: string;
  waiting_on: WaitingOn;
  /** ISO timestamp of the next review. The item is due once it has passed. */
  review_at: string;
  /** Where the details live: a project file, a PR, an issue. */
  ref?: string;
  /** The session key that created it; scopes who may see and resolve it. */
  session: string;
  created_at: string;
  /** Last time it was created, snoozed or handed off ("least recently touched"). */
  updated_at: string;
  source: TodoSource;
  snoozes: number;
  /** Why it was last snoozed. Replaced on every snooze, never accumulated. */
  snooze_reason?: string;
}

/** A line of `done.ndjson`. */
export interface TodoResolution extends TodoItem {
  resolution: "done" | "drop";
  resolved_at: string;
  resolved_by: TodoSource;
  reason?: string;
  evidence?: string;
}

/** The store directory under a given runtime home: `<home>/data/todos`. */
export function todosDirIn(home: string): string {
  return join(home, "data", "todos");
}

/** The default store directory: `<tomoHome>/data/todos`. */
export function todosDir(): string {
  return todosDirIn(config.tomoHome || TOMO_HOME);
}

/** The limits in force (config, falling back to the defaults field by field). */
export function todoLimits(): TodoConfig {
  return { ...DEFAULT_TODOS, ...(config.todos ?? {}) };
}

/** Base of the store's own failures (as opposed to rule refusals). */
export class TodoStoreError extends Error {}

/** The store file could not be read or parsed. Never treated as empty. */
export class TodoStoreReadError extends TodoStoreError {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`todo store could not be read: ${path} (${detail}). Nothing was changed; fix or restore the file.`, { cause });
    this.name = "TodoStoreReadError";
    this.path = path;
  }
}

/**
 * Someone else published `todos.json` between our read and our rename, even
 * though we held the lock — `withFileLockSync` reclaims a lock held past its
 * stale window from a live holder. Retried from a fresh read; reported only
 * if it keeps happening.
 */
export class TodoStoreConflictError extends TodoStoreError {
  constructor(path: string) {
    super(`todo store changed while it was being written: ${path}. Nothing was overwritten; try again.`);
    this.name = "TodoStoreConflictError";
  }
}

/** A write the rules refuse. The message is meant for the model or the owner. */
export class TodoRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoRuleError";
  }
}

const itemSchema = z.looseObject({
  id: z.string().regex(/^t-\d+$/),
  title: z.string(),
  next: z.string(),
  waiting_on: z.enum(["me", "owner", "external"]),
  review_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "expected an ISO timestamp"),
  ref: z.string().optional(),
  session: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.enum(["owner", "self"]),
  snoozes: z.number().int().min(0),
  snooze_reason: z.string().optional(),
});

/** A `done.ndjson` line a reader can show: an item plus how it was closed. */
const resolutionSchema = itemSchema.extend({
  resolution: z.enum(["done", "drop"]),
  resolved_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "expected an ISO timestamp"),
  resolved_by: z.enum(["owner", "self"]),
  reason: z.string().optional(),
  evidence: z.string().optional(),
});

const fileSchema = z.looseObject({
  version: z.literal(1),
  next_id: z.number().int().min(1),
  items: z.array(itemSchema),
});

interface StoreFile {
  version: 1;
  next_id: number;
  items: TodoItem[];
}

interface StoreState {
  file: StoreFile;
  /** The exact bytes read (null: no file), compared again just before the rename. */
  raw: string | null;
  /** Finished items by id, from done.ndjson. */
  closed: Map<string, TodoResolution>;
}

/** Fresh reads before a conflicting write is reported instead of retried. */
const WRITE_ATTEMPTS = 3;

const DAY_MS = 86_400_000;
const REF_MAX_CHARS = 300;
const REASON_MAX_CHARS = 200;

/**
 * When the next review is: `3d`, `2w`, or a date `YYYY-MM-DD` (local
 * midnight). Must be in the future and no further than `maxReviewDays`.
 */
export function parseReviewWhen(input: string, now: number, limits: TodoConfig = todoLimits()): number {
  const text = input.trim().toLowerCase();
  let at: number;
  const rel = /^(\d{1,4})\s*([dw])$/.exec(text);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (rel) {
    at = now + Number(rel[1]) * (rel[2] === "w" ? 7 : 1) * DAY_MS;
  } else if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (d.getMonth() !== Number(date[2]) - 1 || d.getDate() !== Number(date[3])) {
      throw new TodoRuleError(`"${input}" is not a real date.`);
    }
    at = d.getTime();
  } else {
    throw new TodoRuleError(`"${input}" is not a review time. Use a number of days or weeks ("3d", "2w") or a date ("2026-12-01").`);
  }
  if (at <= now) throw new TodoRuleError(`"${input}" is not in the future.`);
  if (at > now + limits.maxReviewDays * DAY_MS) {
    throw new TodoRuleError(`"${input}" is more than ${limits.maxReviewDays} days away; pick a nearer review date.`);
  }
  return at;
}

/** One line, trimmed, non-empty, within `max` characters. */
function line(field: string, value: string | undefined, max: number, required: true): string;
function line(field: string, value: string | undefined, max: number, required: false): string | undefined;
function line(field: string, value: string | undefined, max: number, required: boolean): string | undefined {
  const text = value?.trim() ?? "";
  if (!text) {
    if (required) throw new TodoRuleError(`${field} is required.`);
    return undefined;
  }
  if (/[\r\n]/.test(text)) throw new TodoRuleError(`${field} must be one line. Details belong in the file or issue \`ref\` points to.`);
  const length = [...text].length;
  if (length > max) {
    throw new TodoRuleError(`${field} is ${length} characters; the limit is ${max}. Details belong in the file or issue \`ref\` points to.`);
  }
  return text;
}

export interface AddInput {
  title: string;
  next?: string;
  waiting_on: WaitingOn;
  /** `3d` / `2w` / `YYYY-MM-DD`; defaults by `waiting_on`. */
  review_in?: string;
  ref?: string;
  session: string;
  source: TodoSource;
}

export interface ResolveInput {
  action: TodoAction;
  /** snooze: required. `3d` / `2w` / `YYYY-MM-DD`. */
  until?: string;
  /** drop and snooze: required, one sentence. */
  reason?: string;
  /** done: optional (a PR, a commit). */
  evidence?: string;
  /** snooze / handoff: replace the next step. */
  next?: string;
  by: TodoSource;
}

export interface ResolveResult {
  action: TodoAction;
  /** The item after the action (for done/drop, as it was when it closed). */
  item: TodoItem;
}

/** Visibility predicate supplied by the caller (session scope). */
export type TodoVisible = (item: TodoItem) => boolean;

export class TodoStore {
  readonly dir: string;
  readonly path: string;
  readonly donePath: string;
  private readonly lockPath: string;
  private readonly limitsOverride?: TodoConfig;

  private readonly lockOptions: FileLockOptions;

  /** `lockOptions` is for tests (a shorter wait); a live holder is never robbed of the lock. */
  constructor(dir: string = todosDir(), limits?: TodoConfig, lockOptions: FileLockOptions = {}) {
    this.lockOptions = { ...lockOptions, neverReclaimLiveOwner: true };
    this.dir = dir;
    this.path = join(dir, "todos.json");
    this.donePath = join(dir, "done.ndjson");
    this.lockPath = `${this.path}.lock`;
    this.limitsOverride = limits;
  }

  get limits(): TodoConfig {
    return this.limitsOverride ?? todoLimits();
  }

  /** Every open item, oldest id first. Throws TodoStoreReadError. */
  list(): TodoItem[] {
    return this.read().items;
  }

  /**
   * Finished items (done or dropped), oldest first, as `done.ndjson` logged
   * them. Read-only, for views of the history: a line that is torn or not a
   * whole record is left out. Throws TodoStoreReadError.
   */
  resolved(): TodoResolution[] {
    const records: TodoResolution[] = [];
    for (const record of this.readClosed().values()) {
      if (resolutionSchema.safeParse(record).success) records.push(record);
    }
    return records;
  }

  /** Items whose review time has passed, longest overdue first. */
  due(now: number = Date.now(), visible: TodoVisible = () => true): TodoItem[] {
    return this.list()
      .filter((item) => visible(item) && Date.parse(item.review_at) <= now)
      .sort(byReview);
  }

  add(input: AddInput, now: number = Date.now(), visible: TodoVisible = () => true): TodoItem {
    const limits = this.limits;
    const title = line("title", input.title, limits.titleMaxChars, true);
    // The owner's quick add may leave the next step to be filled in; it starts as the title.
    const next = input.source === "owner"
      ? line("next", input.next ?? title, Math.max(limits.nextMaxChars, limits.titleMaxChars), true)
      : line("next", input.next, limits.nextMaxChars, true);
    if (!WAITING_ON.includes(input.waiting_on)) throw new TodoRuleError(`waiting_on must be one of ${WAITING_ON.join(", ")}.`);
    const ref = line("ref", input.ref, REF_MAX_CHARS, false);
    const session = input.session.trim();
    if (!session) throw new TodoRuleError("a todo needs the session it belongs to.");
    const reviewAt = input.review_in !== undefined
      ? parseReviewWhen(input.review_in, now, limits)
      : now + (input.waiting_on === "me" ? limits.reviewDaysSelf : limits.reviewDaysWaiting) * DAY_MS;

    return this.mutate((file) => {
      // The owner is never refused (their items still count toward the cap).
      if (input.source === "self" && file.items.length >= limits.maxOpen) {
        const stale = file.items.filter(visible).sort(byUpdated).slice(0, 5);
        const list = stale.length ? ` Least recently touched:\n${stale.map((item) => `- ${item.id} ${item.title}`).join("\n")}` : "";
        throw new TodoRuleError(`${file.items.length} todos are open; the limit is ${limits.maxOpen}. Resolve one first (todo_resolve: done, drop, snooze or handoff).${list}`);
      }
      const stamp = new Date(now).toISOString();
      const item: TodoItem = {
        id: `t-${file.next_id}`,
        title,
        next,
        waiting_on: input.waiting_on,
        review_at: new Date(reviewAt).toISOString(),
        ...(ref ? { ref } : {}),
        session,
        created_at: stamp,
        updated_at: stamp,
        source: input.source,
        snoozes: 0,
      };
      file.next_id += 1;
      file.items.push(item);
      return item;
    });
  }

  /**
   * Apply one of the four actions. `visible` is checked against the item as it
   * is on disk, inside the lock; an item the caller may not see is reported
   * exactly like one that does not exist.
   */
  resolve(id: string, input: ResolveInput, now: number = Date.now(), visible: TodoVisible = () => true): ResolveResult {
    const limits = this.limits;
    const key = id.trim().toLowerCase();
    if (!TODO_ACTIONS.includes(input.action)) {
      throw new TodoRuleError(`action must be one of ${TODO_ACTIONS.join(", ")}.`);
    }
    // Validate the arguments before taking the lock.
    const reason = line("reason", input.reason, REASON_MAX_CHARS, false);
    const evidence = line("evidence", input.evidence, REF_MAX_CHARS, false);
    const next = line("next", input.next, limits.nextMaxChars, false);
    if (input.action === "drop" && !reason) throw new TodoRuleError("drop needs a reason (one sentence).");
    if (input.action === "snooze") {
      if (!input.until) throw new TodoRuleError("snooze needs `until` (\"3d\", \"2w\" or a date).");
      if (!reason) throw new TodoRuleError("snooze needs a reason (one sentence).");
    }
    if ((input.action === "done" || input.action === "drop") && next) {
      throw new TodoRuleError(`${input.action} closes the item; \`next\` only goes with snooze or handoff.`);
    }
    const until = input.action === "snooze" ? parseReviewWhen(input.until!, now, limits) : undefined;

    return this.mutate((file, closed) => {
      const index = file.items.findIndex((item) => item.id === key);
      const found = index === -1 ? undefined : file.items[index];
      if (!found || !visible(found)) {
        // Closing an item that is already closed is a no-op, not a second record.
        const done = closed.get(key);
        if (done && visible(done) && (input.action === "done" || input.action === "drop")) {
          return { action: done.resolution, item: stripResolution(done) };
        }
        throw new TodoRuleError(`No open todo ${id.trim()} in this conversation.`);
      }
      const stamp = new Date(now).toISOString();

      if (input.action === "done" || input.action === "drop") {
        const record: TodoResolution = {
          ...found,
          resolution: input.action,
          resolved_at: stamp,
          resolved_by: input.by,
          ...(reason ? { reason } : {}),
          ...(evidence ? { evidence } : {}),
        };
        // Append (and fsync) first. A crash before todos.json is rewritten
        // leaves the item in both files; every read treats an id that is in
        // done.ndjson as closed, so it is never shown again or closed twice.
        appendDurably(this.donePath, `${JSON.stringify(record)}\n`);
        closed.set(record.id, record);
        file.items.splice(index, 1);
        return { action: input.action, item: found };
      }

      if (input.action === "snooze") {
        if (found.snoozes >= limits.maxSnoozes) {
          throw new TodoRuleError(`${found.id} has been snoozed ${found.snoozes} times, the limit. Decide: done, drop, or handoff to the owner.`);
        }
        const updated: TodoItem = {
          ...found,
          ...(next ? { next } : {}),
          review_at: new Date(until!).toISOString(),
          snoozes: found.snoozes + 1,
          snooze_reason: reason!,
          updated_at: stamp,
        };
        file.items[index] = updated;
        return { action: "snooze", item: updated };
      }

      // handoff
      if (found.waiting_on === "owner") throw new TodoRuleError(`${found.id} is already waiting on the owner.`);
      const updated: TodoItem = {
        ...found,
        ...(next ? { next } : {}),
        waiting_on: "owner",
        review_at: new Date(now + limits.reviewDaysWaiting * DAY_MS).toISOString(),
        updated_at: stamp,
      };
      file.items[index] = updated;
      return { action: "handoff", item: updated };
    });
  }

  /**
   * Lock, read fresh, change, publish atomically. A read error aborts before
   * anything is written. Just before the rename the file is read again and
   * compared with what this attempt read: if another writer got in (the lock
   * can be reclaimed from a holder that is slow but alive), nothing is
   * published and the change is redone from a fresh read.
   */
  private mutate<T>(fn: (file: StoreFile, closed: Map<string, TodoResolution>) => T): T {
    mkdirSync(this.dir, { recursive: true });
    // The lock is never reclaimed from a live holder on this host, so a slow
    // writer makes others wait (or time out) rather than write over it. The
    // re-read before the rename stays as a second line of defence (another
    // host, a hand edit, an older build that ignores the lock).
    return withFileLockSync(this.lockPath, () => {
      for (let attempt = 1; ; attempt++) {
        const state = this.readState();
        const result = fn(state.file, state.closed);
        try {
          writeJsonAtomicSync(this.path, state.file, {
            fsync: true,
            beforeRename: () => {
              if (this.rawNow() !== state.raw) throw new TodoStoreConflictError(this.path);
            },
          });
          return result;
        } catch (err) {
          if (err instanceof TodoStoreConflictError && attempt < WRITE_ATTEMPTS) continue;
          throw err;
        }
      }
    }, this.lockOptions);
  }

  private read(): StoreFile {
    return this.readState().file;
  }

  private rawNow(): string | null {
    try {
      return readFileSync(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new TodoStoreReadError(this.path, err);
    }
  }

  private readState(): StoreState {
    const raw = this.rawNow();
    const closed = this.readClosed();
    if (raw === null) return { file: { version: 1, next_id: 1, items: [] }, raw, closed };
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new TodoStoreReadError(this.path, err);
    }
    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) throw new TodoStoreReadError(this.path, new Error(parsed.error.issues[0]?.message ?? "invalid shape"));
    const file = parsed.data as unknown as StoreFile;
    const ids = new Set<string>();
    for (const item of file.items) {
      if (ids.has(item.id)) throw new TodoStoreReadError(this.path, new Error(`duplicate id ${item.id}`));
      ids.add(item.id);
      if (Number(item.id.slice(2)) >= file.next_id) {
        throw new TodoStoreReadError(this.path, new Error(`${item.id} is not below next_id ${file.next_id}`));
      }
    }
    // Self-heal a close interrupted between its two writes: logged means closed.
    file.items = file.items.filter((item) => !closed.has(item.id));
    return { file, raw, closed };
  }

  /**
   * done.ndjson by id. A line that does not parse is skipped — the torn tail
   * of an append cut short — rather than failing every read over history.
   */
  private readClosed(): Map<string, TodoResolution> {
    const closed = new Map<string, TodoResolution>();
    let raw: string;
    try {
      raw = readFileSync(this.donePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return closed;
      throw new TodoStoreReadError(this.donePath, err);
    }
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      try {
        const record = JSON.parse(text) as TodoResolution;
        if (typeof record?.id === "string" && typeof record.session === "string" && !closed.has(record.id)) closed.set(record.id, record);
      } catch { /* torn line */ }
    }
    return closed;
  }
}

/**
 * Append one record and fsync. If the file ends in a torn line (an append cut
 * short), a newline goes first, so the new record starts a line of its own
 * instead of being glued onto the fragment.
 */
function appendDurably(path: string, text: string): void {
  const fd = openSync(path, "a+");
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) text = `\n${text}`;
    }
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stripResolution(record: TodoResolution): TodoItem {
  const item: Partial<TodoResolution> = { ...record };
  delete item.resolution;
  delete item.resolved_at;
  delete item.resolved_by;
  delete item.reason;
  delete item.evidence;
  return item as TodoItem;
}

function byReview(a: TodoItem, b: TodoItem): number {
  return Date.parse(a.review_at) - Date.parse(b.review_at) || idNumber(a) - idNumber(b);
}

function byUpdated(a: TodoItem, b: TodoItem): number {
  return Date.parse(a.updated_at) - Date.parse(b.updated_at) || idNumber(a) - idNumber(b);
}

function idNumber(item: TodoItem): number {
  return Number(item.id.slice(2));
}

export { byReview as compareByReview };
