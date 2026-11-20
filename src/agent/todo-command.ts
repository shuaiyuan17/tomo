import { canSeeTodo, formatTodoLine, formatTodoList } from "../todos/format.js";
import { TodoRuleError, TodoStoreError, type TodoStore } from "../todos/store.js";
import { ownerLocale, ownerT, raw, type Locale, type OwnerText } from "../i18n/index.js";

/** The `/todo` usage line. */
export function todoUsage(locale: Locale = ownerLocale()): OwnerText {
  return ownerT("todo", locale)("usage");
}

/** "Todos are unavailable: …" around a store error. */
export function todoUnavailable(error: string, locale: Locale = ownerLocale()): OwnerText {
  return ownerT("todo", locale)("unavailable", { error });
}

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
export function runTodoCommand(command: TodoCommand, deps: { store: TodoStore; scopeKey: string; now: number; locale?: Locale }): OwnerText {
  const { store, scopeKey, now } = deps;
  const locale = deps.locale ?? ownerLocale();
  const t = ownerT("todo", locale);
  const visible = (item: { session: string }) => canSeeTodo(item, scopeKey);
  const maxSnoozes = store.limits.maxSnoozes;
  try {
    switch (command.kind) {
      case "list":
        return formatTodoList(store.list().filter(visible), { now, all: command.all, maxSnoozes, locale });
      case "add": {
        const item = store.add({ title: command.text, waiting_on: "me", session: scopeKey, source: "owner" }, now, visible);
        return t("added", { line: formatTodoLine(item, now, maxSnoozes, locale) });
      }
      case "done": {
        const { item } = store.resolve(command.id, { action: "done", by: "owner" }, now, visible);
        return t("done", { id: item.id, title: item.title });
      }
      case "drop": {
        const { item } = store.resolve(command.id, { action: "drop", reason: command.reason ?? "Dropped by the owner.", by: "owner" }, now, visible);
        return t("dropped", { id: item.id, title: item.title });
      }
    }
  } catch (err) {
    if (err instanceof TodoStoreError) return todoUnavailable(err.message, locale);
    // The store's rule messages are written for the model's todo tools too, and stay English.
    if (err instanceof TodoRuleError) return raw(err.message);
    throw err;
  }
}
