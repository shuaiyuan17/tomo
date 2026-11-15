import type { HistoryMessage, WebRequest } from "../../src/web/protocol.js";
import { messageKey, pendingKey, type TimelineEntry, type ToolBlock } from "./inline-tools.js";

/**
 * The main chat's scroller rows: pure, so the shapes the Message Scroller
 * depends on are testable without a browser.
 *
 * The scroller (@shadcn/react) reads the transcript's direct children and
 * infers what happened from how their list changed: a new first row is a
 * prepend (keep the reader's place), rows past the old count are appended
 * (it anchors a new turn near the top, under a spacer of nearly a screen),
 * a same-length list that changed is treated as a fresh transcript (it
 * scrolls to the first anchor it has not scrolled to yet).
 * So the list must only ever grow at its ends:
 *
 * - Tool calls are not rows of their own: the calls before a message ride in
 *   that message's row. They load after the messages (and again after "Load
 *   earlier"), and as rows they would be inserted mid-list.
 * - Live content (the running turn's trailing calls, the reply in progress)
 *   rides in the LAST row, so it grows that row instead of adding and later
 *   swapping rows out.
 * - A web message has one id from pending bubble to recorded message
 *   (`sent:<requestId>`), so recording it keeps the row, and its element.
 * - Only the latest user message is a scroll anchor: it is where a reopened
 *   conversation lands, and with no older anchors there is nothing earlier
 *   for the scroller to jump back to. And only while it is one the
 *   conversation opened with (`openingAnchors`): a turn that comes later goes
 *   in at the end and is followed there, with no spacer under it.
 */
export type ChatRow =
  | { kind: "message"; id: string; key: string; anchor: boolean; tools: ToolBlock[]; message: HistoryMessage }
  | { kind: "pending"; id: string; key: string; anchor: boolean; request: WebRequest }
  /** Live content with no row to ride in (an empty conversation). */
  | { kind: "live"; id: string; key: string; anchor: false };

/** A history message's row id; a web message keeps its pending bubble's. */
export function rowId(message: Pick<HistoryMessage, "id" | "role" | "requestId">): string {
  return message.role === "user" && message.requestId ? `sent:${message.requestId}` : message.id;
}

export function chatRows(entries: readonly TimelineEntry[], pending: readonly WebRequest[], live: boolean): ChatRow[] {
  const rows: ChatRow[] = [];
  let tools: ToolBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === "tools") { tools.push(entry.block); continue; }
    const message = entry.message;
    rows.push({ kind: "message", id: rowId(message), key: messageKey(message), anchor: false, tools, message });
    tools = [];
  }
  for (const request of pending) rows.push({ kind: "pending", id: pendingKey(request), key: pendingKey(request), anchor: false, request });
  if (live && !rows.length) rows.push({ kind: "live", id: "live", key: "live", anchor: false });
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "pending" || (row.kind === "message" && row.message.role === "user")) { rows[i] = { ...row, anchor: true }; break; }
  }
  return rows;
}

/**
 * The keys that may be scroll anchors: the rows the conversation opened with
 * (its first non-empty `keys`), less any this tab sent (`claimed`): a first
 * message into an empty conversation is followed like any other.
 */
export function openingAnchors(keys: readonly string[], claimed: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(keys.filter((key) => !claimed.has(key)));
}
