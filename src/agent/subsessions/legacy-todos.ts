import { log } from "../../logger.js";
import type { TodoItem, TodoStore } from "../../todos/store.js";
import type { SubsessionRecord } from "./types.js";

/**
 * Sub-sessions once kept a todo each on the owner's list (the removed todo
 * link). The record is the card now, so a todo that link made would never
 * be updated or closed again, and it still counts toward the list's open
 * cap. Each start drops the ones still open, from the table as read before
 * recovery or the sweep can forget a task (`recoverAtStartup`'s
 * `onTableRead`).
 *
 * An item is the link's own only when it carries the task's key as `ref`,
 * sits in the task's owning scope, came from the harness (`source:
 * "self"`), has the title the link gave it (or that title clipped, at any
 * limit), and is still as the link left it: never snoozed, and a
 * `waiting_on` / `next` pair the link wrote ("Answer sN: <reason>" only with
 * the task's own waiting reason). One the owner snoozed or handed off (a new next step, or a move to
 * them) is theirs now and is left alone.
 *
 * A finished task's item (normally "Read s3's result, then close this") is
 * the owner's unread result: before its todo is dropped, that ask moves onto
 * the task (`keepAsk`, which writes `ownerAction` on the record), so the
 * task shows as "Needs you" instead. The record is written first; a crash
 * in between leaves the todo open and the next start finds the ask already
 * on the task and drops it. A todo whose ask could not be moved is kept, and
 * so is that todo of an archived task (nothing else would show its unread
 * result). `keepAsk` moves an ask once per task.
 *
 * Idempotent (once dropped, nothing matches). It never throws; it returns
 * whether every item it should drop was dropped, so the caller can keep the
 * records it matches against until then.
 */
export function dropLegacyTaskTodos(
  store: TodoStore,
  records: readonly SubsessionRecord[],
  keepAsk: (id: string, action: string) => boolean,
): { dropped: number; complete: boolean } {
  try {
    const byKey = new Map(records.map((r) => [r.sessionKey, r]));
    // The link's words, or those words clipped (at whatever limit was set
    // when it wrote them: the limits may have changed since).
    const wrote = (stored: string, text: string) => {
      const full = text.replace(/[\r\n]+/g, " ").trim();
      return stored === full || (stored.endsWith("…") && stored.length > 1 && full.startsWith(stored.slice(0, -1)));
    };
    // The next steps the link wrote, with the waiting_on it wrote them with.
    const asLinkLeftIt = (item: TodoItem, r: SubsessionRecord) => item.snoozes === 0 && (item.waiting_on === "external"
      ? wrote(item.next, `${r.id} is working on it (/s ${r.id})`) || wrote(item.next, `${r.id} is waiting for its check-back`)
      : item.waiting_on === "owner" && (wrote(item.next, `Read ${r.id}'s result, then close this`)
        || wrote(item.next, `Answer ${r.id}: ${r.waitingReason ?? "it is waiting for you"}`)));
    const stale = store.list().flatMap((item) => {
      const task = item.ref ? byKey.get(item.ref) : undefined;
      return task && item.session === task.parentKey && item.source === "self"
        && wrote(item.title, `${task.title} (${task.id})`) && asLinkLeftIt(item, task) ? [{ item, task }] : [];
    });
    let dropped = 0;
    let complete = true;
    for (const { item, task } of stale) {
      try {
        // A finished task's open todo is the owner's unread result, whatever
        // step it shows (a crash could come between the finish and the
        // link's "Read sN's result"). Only a finished task can carry it as
        // "Needs you"; an archived one (the old sweep archived finished tasks
        // after a week, leaving their todo open) keeps its todo, the owner's
        // to close as before. A move that failed is tried again. Any other
        // task's todo is stale: it is on its card (or ended without a result).
        if (task.status === "archived") continue;
        if (task.status === "finished" && !keepAsk(task.id, `Read ${task.id}'s result`)) { complete = false; continue; }
        store.resolve(item.id, { action: "drop", reason: "sub-sessions no longer keep a todo; the task is its own card", by: "self" });
        dropped++;
      } catch (err) {
        complete = false;
        log.warn({ err, todoId: item.id }, "Could not drop a sub-session's old todo");
      }
    }
    if (dropped > 0) log.info({ dropped }, "Dropped the todos sub-sessions used to keep");
    return { dropped, complete };
  } catch (err) {
    log.warn({ err }, "Could not look for the todos sub-sessions used to keep");
    return { dropped: 0, complete: false };
  }
}
