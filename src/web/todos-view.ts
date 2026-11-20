import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { canSeeTodo } from "../todos/format.js";
import { DEFAULT_TODOS, type TodoConfig } from "../todos/limits.js";
import { parseResolutions, parseTodoFile, TodoStoreError, type TodoItem, type TodoResolution } from "../todos/store.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { MAX_WEB_TODO_RESOLUTIONS, WebError, type WebTodoItem, type WebTodoResolution, type WebTodos } from "./protocol.js";
import { isEnoent } from "../fs-utils.js";

/** `todos.json` holds a few dozen one-line items; anything larger is not read. */
export const MAX_TODO_FILE_BYTES = 1024 * 1024;
/** How much of the end of `done.ndjson` is read: a few hundred records, far more than the 20 shown. */
export const TODO_DONE_TAIL_BYTES = 256 * 1024;

export interface WebTodosOptions {
  /** The todo store directory (`<tomoHome>/data/todos`). */
  dir: string;
  /** The limits in force; absent: the defaults. */
  limits?: Pick<TodoConfig, "maxOpen" | "maxSnoozes">;
  /** The owner's canonical session key; absent (no owner configured): nothing is shown. */
  ownerKey?: string;
  /** The title to show for a group session key. */
  groupTitle(sessionKey: string): string;
  /** Bytes of the done log's end to read (default TODO_DONE_TAIL_BYTES). */
  doneTailBytes?: number;
}

/** The last `max` bytes of a file (all of it when smaller). `null`: no such file. Never follows a link. */
async function readTail(path: string, max: number, limit?: number): Promise<{ text: string; cut: boolean } | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isEnoent(error)) return null;
    throw new WebError(503, "todos_unavailable");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (limit !== undefined && stat.size > limit)) throw new WebError(503, "todos_unavailable");
    const start = Math.max(0, stat.size - max);
    const bytes = Buffer.alloc(stat.size - start);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { text: bytes.toString("utf8", 0, read), cut: start > 0 };
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError(503, "todos_unavailable");
  } finally { await file.close(); }
}

/**
 * The Study's view of the todo store. Read-only and off the store's own
 * synchronous path: each file is read once, asynchronously and bounded
 * (`todos.json` whole, up to MAX_TODO_FILE_BYTES; only the end of the
 * append-only `done.ndjson`), then parsed with the store's parsers. It takes
 * no lock and creates no file. Writing stays with the todo tools and `/todo`.
 *
 * An open item whose id is in the done log's tail is closed (a close
 * interrupted between its two writes leaves it in both; the store heals that
 * on its next write, and the interrupted record is the log's last line).
 *
 * Visibility is the store's own rule (`canSeeTodo`) asked as the owner's
 * conversation: the browser shows what `/todo all` shows in the owner's DM —
 * the owner's items and every group's — and nothing when no owner is
 * configured. The raw session key is not sent; a group item carries its
 * chat title instead.
 *
 * A store that cannot be read is `todos_unavailable`, never an empty list,
 * and the error carries no path or file text.
 */
export async function readWebTodos(options: WebTodosOptions): Promise<WebTodos> {
  const { ownerKey } = options;
  const limits = { ...DEFAULT_TODOS, ...options.limits };
  const visible = (item: Pick<TodoItem, "session">) => ownerKey !== undefined && canSeeTodo(item, ownerKey);
  const path = join(options.dir, "todos.json");
  const [file, done] = await Promise.all([
    readTail(path, MAX_TODO_FILE_BYTES, MAX_TODO_FILE_BYTES),
    readTail(join(options.dir, "done.ndjson"), options.doneTailBytes ?? TODO_DONE_TAIL_BYTES),
  ]);
  let open: TodoItem[] = [];
  let closed: TodoResolution[] = [];
  try {
    if (file) open = parseTodoFile(file.text, path).items;
    // A tail that starts mid-file starts mid-line: that first fragment is not a record.
    if (done) closed = parseResolutions(done.cut ? done.text.slice(done.text.indexOf("\n") + 1) : done.text);
  } catch (error) {
    if (error instanceof TodoStoreError) throw new WebError(503, "todos_unavailable");
    throw error;
  }
  const closedIds = new Set(closed.map((record) => record.id));
  open = open.filter((item) => !closedIds.has(item.id));
  const item = (todo: TodoItem): WebTodoItem => ({
    id: todo.id, title: todo.title, next: todo.next, waitingOn: todo.waiting_on,
    reviewAt: Date.parse(todo.review_at),
    ...(todo.ref ? { ref: todo.ref } : {}),
    createdAt: Date.parse(todo.created_at) || 0, updatedAt: Date.parse(todo.updated_at) || 0,
    source: todo.source, snoozes: todo.snoozes,
    ...(todo.snooze_reason ? { snoozeReason: todo.snooze_reason } : {}),
    ...(todo.session !== ownerKey && isGroupSessionKey(todo.session) ? { group: options.groupTitle(todo.session) } : {}),
  });
  const resolution = (todo: TodoResolution): WebTodoResolution => ({
    ...item(todo), resolution: todo.resolution, resolvedAt: Date.parse(todo.resolved_at), resolvedBy: todo.resolved_by,
    ...(todo.reason ? { reason: todo.reason } : {}),
    ...(todo.evidence ? { evidence: todo.evidence } : {}),
  });
  const finished = closed.filter(visible).map(resolution).sort((a, b) => b.resolvedAt - a.resolvedAt);
  return {
    items: open.filter(visible).map(item),
    openTotal: open.length,
    recent: finished.slice(0, MAX_WEB_TODO_RESOLUTIONS),
    moreResolved: finished.length > MAX_WEB_TODO_RESOLUTIONS || (done?.cut ?? false),
    limits: { maxOpen: limits.maxOpen, maxSnoozes: limits.maxSnoozes },
  };
}
