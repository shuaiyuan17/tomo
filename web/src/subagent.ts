import type { SubagentItem, SubagentPage } from "../../src/web/protocol.js";

/** Pure state for the read-only subagent view, kept out of React so it is testable. */

export interface ToolRow {
  kind: "tool"; id: string; name: string; summary: string; input: string; inputTruncated: boolean;
  result?: { output: string; truncated: boolean; isError: boolean };
}
export type ViewRow = { kind: "text"; id: string; text: string; truncated: boolean } | ToolRow;

export interface TranscriptState {
  items: SubagentItem[];
  /** Byte cursors: page back with `before=start`, tail with `after=end`. */
  start: number;
  end: number;
  /** File length at the last read: `end < size` means newer lines are still to load. */
  size: number;
  hasEarlier: boolean;
}
export const EMPTY_TRANSCRIPT: TranscriptState = { items: [], start: 0, end: 0, size: 0, hasEarlier: false };
const lineOf = (item: SubagentItem) => Number(item.id.split(":")[0]);
/** Whole lines from one end of `items`, as many as fit in MAX_KEPT_ITEMS (at least one line). */
function keepLines(items: SubagentItem[], from: "oldest" | "newest"): SubagentItem[] {
  const lines = new Map<number, SubagentItem[]>();
  for (const item of items) lines.set(lineOf(item), [...(lines.get(lineOf(item)) ?? []), item]);
  const ordered = [...lines.entries()].sort((a, b) => a[0] - b[0]);
  if (from === "newest") ordered.reverse();
  const kept: Array<[number, SubagentItem[]]> = [];
  let count = 0;
  for (const entry of ordered) {
    if (kept.length && count + entry[1].length > MAX_KEPT_ITEMS) break;
    kept.push(entry);
    count += entry[1].length;
  }
  if (from === "newest") kept.reverse();
  return kept.flatMap(([, list]) => list);
}

/** True while lines after `end` exist that have not been loaded yet. */
export function hasNewer(state: TranscriptState): boolean { return state.end < state.size; }
/** Kept in memory per open view; older items are dropped (and can be paged back in). */
export const MAX_KEPT_ITEMS = 2_000;

/**
 * Fold a fetched page in. `tail`: the first page; `older`/`newer`: paging and
 * live append. Memory is capped at MAX_KEPT_ITEMS, and whatever is dropped can
 * always be loaded again: appending drops the oldest lines (and moves `start`
 * so "Load earlier" re-reads them); paging back drops the newest lines (and
 * moves `end` back so the tail re-reads them). Lines are dropped whole.
 */
export function mergePage(state: TranscriptState, page: SubagentPage, mode: "tail" | "older" | "newer"): TranscriptState {
  if (mode === "tail") return { items: page.items, start: page.start, end: page.end, size: page.size, hasEarlier: page.hasEarlier };
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  const size = Math.max(state.size, page.size);
  if (mode === "older") {
    const items = [...fresh, ...state.items];
    if (items.length <= MAX_KEPT_ITEMS) return { ...state, items, start: page.start, size, hasEarlier: page.hasEarlier };
    const kept = keepLines(items, "oldest");
    const keptIds = new Set(kept.map((item) => item.id));
    const cut = lineOf(items.find((item) => !keptIds.has(item.id))!);
    return { items: kept, start: page.start, end: Math.min(state.end, cut), size, hasEarlier: page.hasEarlier };
  }
  const items = [...state.items, ...fresh];
  const end = Math.max(state.end, page.end);
  if (items.length <= MAX_KEPT_ITEMS) return { ...state, items, end, size };
  const kept = keepLines(items, "newest");
  return { items: kept, start: lineOf(kept[0]), end, size, hasEarlier: true };
}

/** Pair tool calls with their results (which may arrive on a later page). */
export function viewRows(items: SubagentItem[]): ViewRow[] {
  const results = new Map<string, Extract<SubagentItem, { kind: "result" }>>();
  for (const item of items) if (item.kind === "result") results.set(item.toolUseId, item);
  const rows: ViewRow[] = [];
  for (const item of items) {
    if (item.kind === "text") rows.push({ kind: "text", id: item.id, text: item.text, truncated: item.truncated });
    else if (item.kind === "tool") {
      const result = results.get(item.toolUseId);
      rows.push({ kind: "tool", id: item.id, name: item.name, summary: item.summary, input: item.input, inputTruncated: item.inputTruncated,
        ...(result ? { result: { output: result.output, truncated: result.truncated, isError: result.isError } } : {}) });
    }
  }
  return rows;
}

/** Collapsed tool rows show this much of an input/output; "Show more" reveals the rest (already capped server-side). */
export const PREVIEW_CHARS = 1_200;
export function preview(text: string, expanded: boolean): { text: string; more: boolean } {
  if (expanded || text.length <= PREVIEW_CHARS) return { text, more: false };
  return { text: text.slice(0, PREVIEW_CHARS), more: true };
}

/** Terminal output is rendered as plain text: drop ANSI/OSC escape sequences. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g, "");
}

/** Shell and Monitor tasks have an output tail instead of a transcript. */
export function isOutputTask(taskType: string): boolean {
  return taskType === "local_bash" || taskType === "monitor";
}
