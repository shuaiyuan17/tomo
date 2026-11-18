import { canSeeTodo, formatTodoLine, formatTodoList } from "../todos/format.js";
import { TodoRuleError, TodoStoreError, type TodoStore } from "../todos/store.js";

export const TODO_USAGE = "Usage: /todo, /todo all, /todo add <text>, /todo done <id>, /todo drop <id> [reason]";

/** What a `/todo` invocation asks for. */
export type TodoCommand =
  | { kind: "list"; all: boolean }
  | { kind: "add"; text: string }
  | { kind: "done"; id: string }
  | { kind: "drop"; id: string; reason?: string };

/** Parse the text after `/todo`; undefined when it is not a valid form. */
export function parseTodoArgs(args: string | undefined): TodoCommand | undefined {
  const text = args?.trim() ?? "";
  if (text === "") return { kind: "list", all: false };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const sub = match[1].toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (sub === "all" && !rest) return { kind: "list", all: true };
  if (sub === "add" && rest) return { kind: "add", text: rest };
  if (sub === "done" || sub === "drop") {
    const idMatch = /^(t-\d+)(?:\s+([\s\S]*))?$/i.exec(rest);
    if (!idMatch) return undefined;
    if (sub === "done") return idMatch[2]?.trim() ? undefined : { kind: "done", id: idMatch[1] };
    const reason = idMatch[2]?.trim();
    return { kind: "drop", id: idMatch[1], ...(reason ? { reason } : {}) };
  }
  return undefined;
}

/**
 * Run one `/todo` for `scopeKey` (the conversation whose items it sees) and
 * return the plain-text reply. Owner commands: items added here are
 * `source: owner`, waiting on Tomo, and never refused by the open cap.
 */
export function runTodoCommand(command: TodoCommand, deps: { store: TodoStore; scopeKey: string; now: number }): string {
  const { store, scopeKey, now } = deps;
  const visible = (item: { session: string }) => canSeeTodo(item, scopeKey);
  const maxSnoozes = store.limits.maxSnoozes;
  try {
    switch (command.kind) {
      case "list":
        return formatTodoList(store.list().filter(visible), { now, all: command.all, maxSnoozes });
      case "add": {
        const item = store.add({ title: command.text, waiting_on: "me", session: scopeKey, source: "owner" }, now, visible);
        return `Added ${formatTodoLine(item, now, maxSnoozes)}`;
      }
      case "done": {
        const { item } = store.resolve(command.id, { action: "done", by: "owner" }, now, visible);
        return `Done: ${item.id} ${item.title}`;
      }
      case "drop": {
        const { item } = store.resolve(command.id, { action: "drop", reason: command.reason ?? "Dropped by the owner.", by: "owner" }, now, visible);
        return `Dropped: ${item.id} ${item.title}`;
      }
    }
  } catch (err) {
    if (err instanceof TodoStoreError) return `Todos are unavailable: ${err.message}`;
    if (err instanceof TodoRuleError) return err.message;
    throw err;
  }
}
