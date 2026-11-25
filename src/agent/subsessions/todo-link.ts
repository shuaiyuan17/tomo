import { log } from "../../logger.js";
import { TodoRuleError, type TodoStore } from "../../todos/store.js";
import type { SubsessionTodoLink } from "./service.js";
import type { SubsessionRecord } from "./types.js";

/**
 * A sub-session's line on the owner's todo list (#558; config
 * `subsessions.todos`). Opened at spawn, in the owning session's scope, so
 * `/todo` and the morning brief show it where the owner already looks; it
 * then waits on "external" while the task works and on "owner" while the
 * task waits for them or has a result to read. A task that ends without a
 * result drops it. The owner closes a finished one, as with any todo.
 *
 * Nothing here throws to the service: a todo that cannot be written (the
 * store unreadable, the open cap) costs the task nothing but its line.
 */
export function createTodoLink(store: TodoStore): SubsessionTodoLink {
  const clip = (text: string, max: number) => {
    const chars = [...text.replace(/[\r\n]+/g, " ").trim()];
    return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
  };
  return {
    open(record: SubsessionRecord): string | undefined {
      try {
        // One made already (a crash came before its id reached the task record): that one.
        const existing = store.list().find((item) => item.ref === record.sessionKey);
        if (existing) return existing.id;
        const limits = store.limits;
        const item = store.add({
          title: clip(`${record.title} (${record.id})`, limits.titleMaxChars),
          next: clip(`${record.id} is working on it (/s ${record.id})`, limits.nextMaxChars),
          waiting_on: "external",
          ref: record.sessionKey,
          session: record.parentKey,
          source: "self",
        });
        return item.id;
      } catch (err) {
        if (err instanceof TodoRuleError) log.info({ id: record.id, rule: err.rule.kind }, "No todo for the sub-session: the todo list refused it");
        else log.warn({ err, id: record.id }, "No todo for the sub-session: the todo list could not be written");
        return undefined;
      }
    },
    set(todoId: string, waitingOn: "owner" | "external", next: string): void {
      try {
        store.relink(todoId, waitingOn, clip(next, store.limits.nextMaxChars));
      } catch (err) {
        log.warn({ err, todoId }, "Could not update a sub-session's todo");
      }
    },
    close(todoId: string, reason: string): void {
      try {
        // Already closed (by the owner, or a close before a restart): nothing to write.
        if (!store.list().some((item) => item.id === todoId)) return;
        store.resolve(todoId, { action: "drop", reason: clip(reason, 200), by: "self" });
      } catch (err) {
        if (err instanceof TodoRuleError && err.rule.kind === "not_found") return;
        log.warn({ err, todoId }, "Could not close a sub-session's todo");
      }
    },
  };
}
