import type { HistoryMessage, SessionTools, SubagentItem } from "../../src/web/protocol.js";
import { groupRows, viewRows, type ViewBlock } from "./subagent.js";
import { appendedIds } from "./motion.js";

/**
 * The main chat's inline tool calls: pure state, kept out of React so it is
 * testable. The rows, grouping and labels are the task view's (subagent.ts);
 * this only reads them from the session's transcript and places them
 * between the chat's own messages by time.
 */

/**
 * `complete: false`: the first scan stopped at its cap before reaching the oldest loaded message (older calls are not shown).
 * `unreadable`: the server met transcript lines it could not read since the last fresh scan (some calls may be missing).
 */
export interface ToolsState { transcript: string; end: number; items: SubagentItem[]; complete: boolean; unreadable: boolean }
export const NO_TOOLS: ToolsState = { transcript: "", end: 0, items: [], complete: true, unreadable: false };
/** Items kept in memory for one conversation; the oldest go first. */
export const MAX_KEPT_TOOL_ITEMS = 2_000;

/** A fresh scan (`from`) replaces; a tail read (`after`) appends what is new, by item id (a byte offset, so stable). */
export function mergeTools(state: ToolsState, page: SessionTools, kind: "full" | "newer"): ToolsState {
  if (kind === "full" || page.transcript !== state.transcript) {
    return { transcript: page.transcript, end: page.end, items: page.items.slice(-MAX_KEPT_TOOL_ITEMS), complete: page.complete, unreadable: !!page.unreadable };
  }
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  const items = fresh.length ? [...state.items, ...fresh].slice(-MAX_KEPT_TOOL_ITEMS) : state.items;
  return { transcript: state.transcript, end: Math.max(state.end, page.end), items, complete: state.complete, unreadable: state.unreadable || !!page.unreadable };
}

/** A tool block in the chat, keyed so its open/closed state survives paging and live updates. */
export type ToolBlock = Extract<ViewBlock, { kind: "tool" | "group" }> & { key: string };
export type TimelineEntry = { kind: "message"; message: HistoryMessage } | { kind: "tools"; block: ToolBlock };

/** A run of calls is keyed by its first call (a run only grows at its end). */
const keyed = (block: ViewBlock): ToolBlock => block.kind === "group" ? { ...block, key: `calls:${block.key}` }
  : { ...(block as Extract<ViewBlock, { kind: "tool" }>), key: `call:${(block as Extract<ViewBlock, { kind: "tool" }>).row.toolUseId}` };

/**
 * Messages in order with the tool calls made before each placed in front of
 * it: the calls of one turn fold into a group (one call stays a row), the
 * text is never folded. Calls after the last message are `trailing` (the
 * turn still running). Calls before `since` (the oldest loaded message, when
 * older history is not loaded yet) and calls without a time are left out.
 */
export function interleave(messages: readonly HistoryMessage[], items: readonly SubagentItem[], since = 0):
  { entries: TimelineEntry[]; trailing: ToolBlock[] } {
  const times = new Map<string, number>();
  for (const item of items) if (item.kind === "tool" && item.ts !== undefined) times.set(item.id, item.ts);
  const rows = viewRows([...items]).filter((row) => row.kind === "tool" && (times.get(row.id) ?? -1) >= since);
  const entries: TimelineEntry[] = [];
  let next = 0;
  for (const message of messages) {
    const run = [];
    while (next < rows.length && times.get(rows[next].id)! < message.timestamp) run.push(rows[next++]);
    for (const block of groupRows(run)) entries.push({ kind: "tools", block: keyed(block) });
    entries.push({ kind: "message", message });
  }
  return { entries, trailing: groupRows(rows.slice(next)).map(keyed) };
}

// ---- "N new messages ↓" ----

/** What counts as one message for the counter: a turn's reply once, whether streamed or recorded. */
export function messageKey(message: Pick<HistoryMessage, "id" | "role" | "requestId" | "turnId">): string {
  if (message.role === "assistant") return `reply:${message.turnId ?? message.requestId ?? message.id}`;
  return message.requestId ? `sent:${message.requestId}` : `msg:${message.id}`;
}
export const blockKey = (block: { requestId: string; turnId?: string }) => `reply:${block.turnId ?? block.requestId}`;
export const pendingKey = (request: { requestId: string }) => `sent:${request.requestId}`;

/** Messages that arrived after the reader left the bottom (paged-in older ones never count). */
export function unseenCount(baseline: ReadonlySet<string>, keys: readonly string[]): number {
  return appendedIds(baseline, [...new Set(keys)]).size;
}

/** More than about a screen above the end. */
export function isFar(distance: number, viewport: number): boolean { return distance > viewport; }

/** The jump button: shown once the reader is more than about a screen up, or something new arrived while away. */
export function jumpVisible(input: { atBottom: boolean; far: boolean; unseen: number }): boolean {
  if (input.atBottom) return false;
  return input.unseen > 0 || input.far;
}

export function jumpLabel(unseen: number): string {
  return unseen === 1 ? "1 new message" : unseen > 1 ? `${unseen} new messages` : "";
}

/** After a render: keep the place after "Load earlier", follow the end only when the reader is at the bottom. */
export function scrollAction(input: { restoring: boolean; atBottom: boolean }): "restore" | "bottom" | "stay" {
  return input.restoring ? "restore" : input.atBottom ? "bottom" : "stay";
}

/** Within this many pixels of the end counts as "at the bottom". */
export const BOTTOM_SLACK = 80;
