import type { SubagentItem, SubagentPage } from "../../src/web/protocol.js";

/** Pure state for the read-only subagent view, kept out of React so it is testable. */

export interface ToolRow {
  kind: "tool"; id: string; name: string; summary: string; input: string; inputTruncated: boolean;
  result?: { output: string; truncated: boolean; isError: boolean };
}
export type ViewRow = { kind: "text"; id: string; text: string; truncated: boolean } | ToolRow;

/**
 * The transcript window has two mutually exclusive modes:
 * - follow (default): pinned to the end; polling appends, and over the cap
 *   the oldest lines are dropped from the front.
 * - browse: entered by "Load earlier". Polling stops at once; paging back
 *   prepends, and over the cap the newest lines are dropped from the back.
 *   "Jump to latest" returns to follow: the window is cleared and reloaded
 *   from the tail.
 * Every request carries the generation it was made in; switching mode or
 * jumping bumps the generation, and a response from an older one is ignored.
 */
export type TranscriptMode = "follow" | "browse";
export type TranscriptStatus = "loading" | "ready" | "missing" | "error" | "gone";
export interface TranscriptState {
  mode: TranscriptMode;
  gen: number;
  status: TranscriptStatus;
  items: SubagentItem[];
  /** Byte cursors: page back with `before=start`; in follow mode, tail with `after=end`. */
  start: number;
  end: number;
  /** File length at the last read; in follow mode, `end < size` means more to read now. */
  size: number;
  hasEarlier: boolean;
}
export const INITIAL_TRANSCRIPT: TranscriptState = { mode: "follow", gen: 0, status: "loading", items: [], start: 0, end: 0, size: 0, hasEarlier: false };
/** Kept in memory per open view. */
export const MAX_KEPT_ITEMS = 2_000;

export type TranscriptAction =
  | { type: "tail" | "newer" | "older"; gen: number; page: SubagentPage }
  /** "Load earlier" from follow mode: stop following. */
  | { type: "browse" }
  /** "Jump to latest": back to follow, reload from the tail. */
  | { type: "jump" }
  /** A failed read. `gone`: the task left the panel (the server refuses it now). */
  | { type: "failed"; gen: number; kind: "gone" | "missing" | "error" };

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

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "browse":
      return state.mode === "browse" ? state : { ...state, mode: "browse", gen: state.gen + 1 };
    case "jump":
      return { ...INITIAL_TRANSCRIPT, gen: state.gen + 1, status: state.status === "gone" ? "gone" : "loading" };
    case "failed": {
      if (action.gen !== state.gen) return state;
      if (action.kind === "gone") return { ...state, status: "gone" };
      return state.items.length ? state : { ...state, status: action.kind };
    }
    default: break;
  }
  if (action.gen !== state.gen || state.status === "gone") return state;
  const page = action.page;
  if (action.type === "tail") {
    return { ...state, status: "ready", items: page.items, start: page.start, end: page.end, size: page.size, hasEarlier: page.hasEarlier };
  }
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  if (action.type === "newer") {
    if (state.mode !== "follow") return state;
    const all = [...state.items, ...fresh];
    const items = all.length > MAX_KEPT_ITEMS ? keepLines(all, "newest") : all;
    const dropped = items.length < all.length;
    return { ...state, status: "ready", items, end: Math.max(state.end, page.end), size: Math.max(state.size, page.size),
      start: dropped ? lineOf(items[0]) : state.start, hasEarlier: state.hasEarlier || dropped };
  }
  if (state.mode !== "browse") return state;
  const all = [...fresh, ...state.items];
  const items = all.length > MAX_KEPT_ITEMS ? keepLines(all, "oldest") : all;
  return { ...state, items, start: page.start, hasEarlier: page.hasEarlier };
}

/** In follow mode, more lines are already on disk than have been read. */
export function behind(state: TranscriptState): boolean { return state.mode === "follow" && state.end < state.size; }

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
