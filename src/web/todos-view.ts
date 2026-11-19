import { canSeeTodo } from "../todos/format.js";
import { DEFAULT_TODOS, type TodoConfig } from "../todos/limits.js";
import { TodoStore, TodoStoreError, type TodoItem, type TodoResolution } from "../todos/store.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { MAX_WEB_TODO_RESOLUTIONS, WebError, type WebTodoItem, type WebTodoResolution, type WebTodos } from "./protocol.js";

export interface WebTodosOptions {
  /** The todo store directory (`<tomoHome>/data/todos`). */
  dir: string;
  /** The limits in force; absent: the defaults. */
  limits?: Pick<TodoConfig, "maxOpen" | "maxSnoozes">;
  /** The owner's canonical session key; absent (no owner configured): nothing is shown. */
  ownerKey?: string;
  /** The title to show for a group session key. */
  groupTitle(sessionKey: string): string;
}

/**
 * The Study's view of the todo store. Read-only: it calls the store's two
 * readers and nothing else, so it takes no lock and creates no file. Writing
 * stays with the todo tools and `/todo`.
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
export function readWebTodos(options: WebTodosOptions): WebTodos {
  const { ownerKey } = options;
  const limits = { ...DEFAULT_TODOS, ...options.limits };
  const visible = (item: Pick<TodoItem, "session">) => ownerKey !== undefined && canSeeTodo(item, ownerKey);
  let open: TodoItem[];
  let closed: TodoResolution[];
  try {
    const store = new TodoStore(options.dir, limits);
    open = store.list();
    closed = store.resolved();
  } catch (error) {
    if (error instanceof TodoStoreError) throw new WebError(503, "todos_unavailable");
    throw error;
  }
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
    resolvedTotal: finished.length,
    limits: { maxOpen: limits.maxOpen, maxSnoozes: limits.maxSnoozes },
  };
}
