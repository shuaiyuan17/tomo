import { canSeeTodo, formatTodoLine, formatTodoList } from "../todos/format.js";
import { TodoRuleError, TodoStoreError, type TodoRule, type TodoStore } from "../todos/store.js";
import { errorDetail } from "../i18n/error-detail.js";
import { joinText, ownerLocale, ownerT, type Locale, type OwnerT, type OwnerText } from "../i18n/index.js";

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
    if (err instanceof TodoStoreError) return todoUnavailable(errorDetail(err, locale), locale);
    // The error's English message is what the model's todo tools return; the owner gets the rule in their language.
    if (err instanceof TodoRuleError) return todoRuleText(t, err.rule);
    throw err;
  }
}

/** A store rule refusal, in the owner's language. */
function todoRuleText(t: OwnerT<"todo">, rule: TodoRule): OwnerText {
  switch (rule.kind) {
    case "not_real_date": return t("rule.notRealDate", { input: rule.input });
    case "not_review_time": return t("rule.notReviewTime", { input: rule.input });
    case "not_future": return t("rule.notFuture", { input: rule.input });
    case "too_far": return t("rule.tooFar", { input: rule.input, maxDays: rule.maxDays });
    case "required": return t("rule.required", { field: rule.field });
    case "one_line": return t("rule.oneLine", { field: rule.field });
    case "too_long": return t("rule.tooLong", { field: rule.field, length: rule.length, max: rule.max });
    case "waiting_on_invalid": return t("rule.waitingOnInvalid", { allowed: rule.allowed });
    case "no_session": return t("rule.noSession");
    case "open_limit": return rule.stale.length
      ? t("rule.openLimitStale", { open: rule.open, max: rule.max, list: joinText(rule.stale.map((item) => t("rule.staleItem", item))) })
      : t("rule.openLimit", { open: rule.open, max: rule.max });
    case "action_invalid": return t("rule.actionInvalid", { allowed: rule.allowed });
    case "drop_needs_reason": return t("rule.dropNeedsReason");
    case "snooze_needs_until": return t("rule.snoozeNeedsUntil");
    case "snooze_needs_reason": return t("rule.snoozeNeedsReason");
    case "next_with_close": return t("rule.nextWithClose", { action: rule.action });
    case "not_found": return t("rule.notFound", { id: rule.id });
    case "snooze_limit": return t("rule.snoozeLimit", { id: rule.id, snoozes: rule.snoozes });
    case "already_owner": return t("rule.alreadyOwner", { id: rule.id });
  }
}
