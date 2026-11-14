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
  hasEarlier: boolean;
}
export const EMPTY_TRANSCRIPT: TranscriptState = { items: [], start: 0, end: 0, hasEarlier: false };
/** Kept in memory per open view; older items are dropped (and can be paged back in). */
export const MAX_KEPT_ITEMS = 2_000;

/** Fold a fetched page in. `tail`: the first page; `older`/`newer`: paging and live append. */
export function mergePage(state: TranscriptState, page: SubagentPage, mode: "tail" | "older" | "newer"): TranscriptState {
  if (mode === "tail") return { items: page.items, start: page.start, end: page.end, hasEarlier: page.hasEarlier };
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  if (mode === "older") {
    return { ...state, items: [...fresh, ...state.items].slice(0, MAX_KEPT_ITEMS), start: page.start, hasEarlier: page.hasEarlier };
  }
  const items = [...state.items, ...fresh];
  const dropped = Math.max(0, items.length - MAX_KEPT_ITEMS);
  const kept = items.slice(dropped);
  return { items: kept, start: dropped ? Number(kept[0].id.split(":")[0]) : state.start,
    end: Math.max(state.end, page.end), hasEarlier: state.hasEarlier || dropped > 0 };
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
