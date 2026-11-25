import { log } from "../../logger.js";
import type { TodoStore } from "../../todos/store.js";
import type { SubsessionRecord } from "./types.js";

/**
 * Sub-sessions once kept a todo each on the owner's list (the removed todo
 * link). The record is the card now, so a todo that link made would never
 * be updated or closed again, and it still counts toward the list's open
 * cap. Each start drops the ones still open: an item is the link's own only
 * when it carries the task's key as `ref`, sits in the task's owning scope,
 * came from the harness (`source: "self"`), and has exactly the title the
 * link gave it. Idempotent (once dropped, nothing matches), and it never
 * throws: a todo list it cannot read or write is left as it is.
 */
export function dropLegacyTaskTodos(store: TodoStore, records: readonly SubsessionRecord[]): number {
  try {
    const max = store.limits.titleMaxChars;
    const titleOf = (r: SubsessionRecord) => {
      const chars = [...`${r.title} (${r.id})`.replace(/[\r\n]+/g, " ").trim()];
      return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
    };
    const byKey = new Map(records.map((r) => [r.sessionKey, r]));
    const stale = store.list().filter((item) => {
      const task = item.ref ? byKey.get(item.ref) : undefined;
      return task !== undefined && item.session === task.parentKey && item.source === "self" && item.title === titleOf(task);
    });
    let dropped = 0;
    for (const item of stale) {
      try {
        store.resolve(item.id, { action: "drop", reason: "sub-sessions no longer keep a todo; the task is its own card", by: "self" });
        dropped++;
      } catch (err) {
        log.warn({ err, todoId: item.id }, "Could not drop a sub-session's old todo");
      }
    }
    if (dropped > 0) log.info({ dropped }, "Dropped the todos sub-sessions used to keep");
    return dropped;
  } catch (err) {
    log.warn({ err }, "Could not look for the todos sub-sessions used to keep");
    return 0;
  }
}
