import type { SubagentItem, SubagentPage, TodoEntry, WebSource } from "../../src/web/protocol.js";
import { safeHref } from "./links.js";
import { i18n } from "./i18n/index.js";
import { formatUnit, formatUnitPair } from "./i18n/format.js";

/** Pure state for the read-only subagent view, kept out of React so it is testable. */

export interface ToolRow {
  kind: "tool"; id: string; toolUseId: string; name: string; summary: string; input: string; inputTruncated: boolean;
  /** `summary` is words the model wrote (a Bash description), not a command: set in the text face. */
  prose?: true;
  /** When the call was made (ms epoch); with the result's, its duration. */
  ts?: number;
  /** The page a WebFetch reads. */
  sources?: WebSource[];
  /** `images`: image blocks in the output (never served; the row shows a chip). `sources`: a WebSearch's links. */
  result?: { output: string; truncated: boolean; isError: boolean; images?: number; ts?: number; sources?: WebSource[] };
}
/** A subagent's thinking: a folded, muted row. */
export interface ThinkingRow { kind: "thinking"; id: string; text: string; truncated: boolean }
/** One TodoWrite call's list. `failed`: its result was an error (the list did not change). */
export interface TodosRow { kind: "todos"; id: string; toolUseId: string; todos: TodoEntry[]; more: number; failed: boolean }
export type ViewRow = { kind: "text" | "message"; id: string; text: string; truncated: boolean } | ToolRow | ThinkingRow | TodosRow;

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
  /** A page read so far had lines the server could not read: the view says some entries are missing. */
  unreadable: boolean;
}
export const INITIAL_TRANSCRIPT: TranscriptState = { mode: "follow", gen: 0, status: "loading", items: [], start: 0, end: 0, size: 0, hasEarlier: false, unreadable: false };
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
      // A task that left the panel cannot be reloaded: keep what was read.
      if (state.status === "gone") return state;
      return { ...INITIAL_TRANSCRIPT, gen: state.gen + 1 };
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
    return { ...state, status: "ready", items: page.items, start: page.start, end: page.end, size: page.size, hasEarlier: page.hasEarlier, unreadable: !!page.unreadable };
  }
  const seen = new Set(state.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  if (action.type === "newer") {
    if (state.mode !== "follow") return state;
    const all = [...state.items, ...fresh];
    const items = all.length > MAX_KEPT_ITEMS ? keepLines(all, "newest") : all;
    const dropped = items.length < all.length;
    return { ...state, status: "ready", items, end: Math.max(state.end, page.end), size: Math.max(state.size, page.size),
      start: dropped ? lineOf(items[0]) : state.start, hasEarlier: state.hasEarlier || dropped, unreadable: state.unreadable || !!page.unreadable };
  }
  if (state.mode !== "browse") return state;
  const all = [...fresh, ...state.items];
  const items = all.length > MAX_KEPT_ITEMS ? keepLines(all, "oldest") : all;
  return { ...state, items, start: page.start, hasEarlier: page.hasEarlier, unreadable: state.unreadable || !!page.unreadable };
}

/** In follow mode, more lines are already on disk than have been read. */
export function behind(state: TranscriptState): boolean { return state.mode === "follow" && state.end < state.size; }

/** Pair tool calls with their results (which may arrive on a later page). */
export function viewRows(items: SubagentItem[]): ViewRow[] {
  const results = new Map<string, Extract<SubagentItem, { kind: "result" }>>();
  for (const item of items) if (item.kind === "result") results.set(item.toolUseId, item);
  const rows: ViewRow[] = [];
  for (const item of items) {
    if (item.kind === "text" || item.kind === "message" || item.kind === "thinking") rows.push({ kind: item.kind, id: item.id, text: item.text, truncated: item.truncated });
    else if (item.kind === "todos") {
      rows.push({ kind: "todos", id: item.id, toolUseId: item.toolUseId, todos: item.todos, more: item.more ?? 0, failed: results.get(item.toolUseId)?.isError === true });
    } else if (item.kind === "tool") {
      const result = results.get(item.toolUseId);
      rows.push({ kind: "tool", id: item.id, toolUseId: item.toolUseId, name: item.name, summary: item.summary, input: item.input, inputTruncated: item.inputTruncated,
        ...(item.prose ? { prose: true as const } : {}), ...(item.ts !== undefined ? { ts: item.ts } : {}), ...(item.sources ? { sources: item.sources } : {}),
        ...(result ? { result: { output: result.output, truncated: result.truncated, isError: result.isError, ...(result.images ? { images: result.images } : {}),
          ...(result.ts !== undefined ? { ts: result.ts } : {}), ...(result.sources ? { sources: result.sources } : {}) } } : {}) });
    }
  }
  return rows;
}

/** How long a call took, "4s" / "1m 12s", when both ends are known and it took a second or more. */
export function callDuration(row: ToolRow): string | undefined {
  return row.ts !== undefined && row.result?.ts !== undefined ? formatDuration(row.result.ts - row.ts) : undefined;
}
/** From the first call's start to the last result: a group's duration. */
export function groupDuration(tools: readonly ToolRow[]): string | undefined {
  const starts = tools.flatMap((tool) => tool.ts !== undefined ? [tool.ts] : []);
  const ends = tools.flatMap((tool) => tool.result?.ts !== undefined ? [tool.result.ts] : []);
  if (!starts.length || ends.length < tools.length) return undefined;
  return formatDuration(Math.max(...ends) - Math.min(...starts));
}
/** When a run of calls began: its first call's time. */
export function groupStart(tools: readonly ToolRow[]): number | undefined {
  const starts = tools.flatMap((tool) => tool.ts !== undefined ? [tool.ts] : []);
  return starts.length ? Math.min(...starts) : undefined;
}
/** A running step's elapsed time so far, "23s" / "5m 3s"; nothing in its first second or with no start. */
export function elapsedSince(start: number | undefined, now: number): string | undefined {
  return start === undefined ? undefined : formatDuration(Math.max(0, now - start));
}
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 1_000) return undefined;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return formatUnit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? formatUnitPair(formatUnit(minutes, "minute"), formatUnit(seconds % 60, "second")) : formatUnit(minutes, "minute");
  return formatUnitPair(formatUnit(Math.floor(minutes / 60), "hour"), formatUnit(minutes % 60, "minute"));
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

export const POLL_MS = 2_000;
/**
 * One step of follow mode: load the tail (first time) or the lines after
 * `end`, then say when to step again: at once while behind the file's end
 * (a backlog, including after the task ended), after POLL_MS while the task
 * runs, or never. `apply` must update the state synchronously (the caller
 * mirrors it in a ref), so the decision sees the page just read.
 */
export async function followStep(io: {
  gen: number;
  running: boolean;
  get: () => TranscriptState;
  apply: (action: TranscriptAction) => void;
  fetchPage: (query: string) => Promise<SubagentPage>;
  classify: (error: unknown) => "gone" | "missing" | "error" | "reset";
}): Promise<number | null> {
  const current = io.get();
  if (current.gen !== io.gen || current.mode !== "follow" || current.status === "gone") return null;
  try {
    if (current.status === "loading" || (current.end === 0 && current.size === 0)) {
      io.apply({ type: "tail", gen: io.gen, page: await io.fetchPage("") });
    } else {
      io.apply({ type: "newer", gen: io.gen, page: await io.fetchPage(`?after=${current.end}`) });
    }
  } catch (error) {
    const kind = io.classify(error);
    if (kind === "reset") {
      try { io.apply({ type: "tail", gen: io.gen, page: await io.fetchPage("") }); }
      catch (again) { const k = io.classify(again); io.apply({ type: "failed", gen: io.gen, kind: k === "reset" ? "error" : k }); }
    } else io.apply({ type: "failed", gen: io.gen, kind });
  }
  const next = io.get();
  if (next.gen !== io.gen || next.mode !== "follow" || next.status === "gone") return null;
  if (behind(next) && next.end > current.end) return 0;
  return io.running ? POLL_MS : null;
}

/**
 * What the transcript shows: assistant text (and messages sent to the
 * subagent) always in full; a single tool
 * call as its own row; a run of two or more consecutive tool calls folded
 * into one group, keyed by its first tool_use id (stable while the run grows,
 * so an open/closed choice survives incremental updates). Thinking is a step
 * like a call: it does not break a run, and folds into the group with the
 * calls around it (`steps`, in order; `tools` stays the calls alone). A run
 * with fewer than two calls shows its rows as they are.
 *
 * Per TURN (up to a message sent to the subagent; the chat calls this once
 * per turn), two more blocks:
 * - `todos`: the agent's todo list as the turn's LAST successful TodoWrite
 *   left it — one block however many calls rewrote it, standing where the
 *   first one was made (so it does not move while the turn runs). TodoWrite
 *   calls are not steps: they neither join nor split a run.
 * - `sources`: the pages the turn used (sourcesOf), one block right after the
 *   turn's last tool block.
 * Both are keyed by the call that first produced them, so an open/closed
 * choice survives growth.
 */
export type ViewBlock =
  | { kind: "text"; row: Extract<ViewRow, { kind: "text" | "message" }> }
  | { kind: "message"; row: Extract<ViewRow, { kind: "text" | "message" }> }
  | { kind: "thinking"; row: ThinkingRow }
  | { kind: "tool"; row: ToolRow }
  | { kind: "group"; key: string; tools: ToolRow[]; steps: Array<ToolRow | ThinkingRow> }
  | { kind: "todos"; key: string; row: TodosRow }
  | { kind: "sources"; key: string; sources: WebSource[] };

export function groupRows(rows: ViewRow[]): ViewBlock[] {
  const blocks: ViewBlock[] = [];
  let run: Array<ToolRow | ThinkingRow> = [];
  let turn: { todosAt?: number; todos: TodosRow[]; tools: ToolRow[]; afterTools: number } = { todos: [], tools: [], afterTools: 0 };
  const flush = () => {
    const tools = run.filter((row): row is ToolRow => row.kind === "tool");
    if (tools.length > 1) blocks.push({ kind: "group", key: tools[0].toolUseId, tools, steps: run });
    else for (const row of run) blocks.push(row.kind === "tool" ? { kind: "tool", row } : { kind: "thinking", row });
    if (tools.length) turn.afterTools = blocks.length;
    run = [];
  };
  const endTurn = () => {
    flush();
    if (turn.todosAt !== undefined) {
      const first = turn.todos[0];
      blocks[turn.todosAt] = { kind: "todos", key: `todos:${first.toolUseId}`, row: latestTodos(turn.todos) };
    }
    const sources = sourcesOf(turn.tools);
    if (sources.length) {
      const first = turn.tools.find((tool) => sourcesOf([tool]).length)!;
      blocks.splice(turn.afterTools, 0, { kind: "sources", key: `sources:${first.toolUseId}`, sources });
    }
    turn = { todos: [], tools: [], afterTools: 0 };
  };
  for (const row of rows) {
    if (row.kind === "tool" || row.kind === "thinking") {
      run.push(row);
      if (row.kind === "tool") turn.tools.push(row);
    } else if (row.kind === "todos") {
      // Held in place by the first list; filled with the latest at the end of the turn.
      if (turn.todosAt === undefined) { turn.todosAt = blocks.length; blocks.push({ kind: "todos", key: "", row }); }
      turn.todos.push(row);
    } else if (row.kind === "message") { endTurn(); blocks.push({ kind: "message", row }); }
    else { flush(); blocks.push({ kind: "text", row }); }
  }
  endTurn();
  return blocks;
}

/** The list as the last TodoWrite that did not fail left it (the last one, if all failed). */
export function latestTodos(rows: readonly TodosRow[]): TodosRow {
  return [...rows].reverse().find((row) => !row.failed) ?? rows.at(-1)!;
}

/** Pages listed in one Sources block. */
export const MAX_SOURCES = 50;

/**
 * The pages a run of calls used, in the order the calls were made: each
 * WebFetch URL and each link its WebSearch results listed, once a call has
 * finished without an error. Deduplicated by URL (ignoring a #fragment); a
 * title, when any copy has one, is kept.
 */
export function sourcesOf(tools: readonly ToolRow[]): WebSource[] {
  const seen = new Map<string, WebSource>();
  for (const tool of tools) {
    if (!tool.result || tool.result.isError) continue;
    const found = tool.name === "WebFetch" ? tool.sources : tool.name === "WebSearch" ? tool.result.sources : undefined;
    for (const source of found ?? []) {
      if (!safeHref(source.url)) continue;
      const key = source.url.replace(/#.*$/, "");
      const known = seen.get(key);
      if (!known) { if (seen.size < MAX_SOURCES) seen.set(key, { ...source }); }
      else if (!known.title && source.title) known.title = source.title;
    }
  }
  return [...seen.values()];
}

/** A todo list's summary: "3 of 7 done". */
export function todoSummary(row: Pick<TodosRow, "todos" | "more">): string {
  const done = row.todos.filter((todo) => todo.status === "completed").length;
  return i18n.t("chat:trace.todoSummary", { done, count: row.todos.length + row.more });
}

/** What a todo list shows: the item in progress, what is left, what is done (each in the agent's order). */
export function todoSections(todos: readonly TodoEntry[]): { active: TodoEntry[]; left: TodoEntry[]; done: TodoEntry[] } {
  return { active: todos.filter((todo) => todo.status === "in_progress"), left: todos.filter((todo) => todo.status === "pending"),
    done: todos.filter((todo) => todo.status === "completed") };
}

/** What a tool call did, for counting. Anything unlisted is "used N tools". */
type ToolKind = "command" | "read" | "edit" | "search" | "page" | "started" | "heard" | "background" | "other";
const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "command", Read: "read",
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search", WebSearch: "page", WebFetch: "page",
  Agent: "started", Task: "started", SubagentMessage: "heard", BackgroundTask: "background",
};
/** One kind's count in words: "ran 5 commands", "edited a file". */
function kindText(kind: ToolKind, count: number): string {
  switch (kind) {
    case "command": return i18n.t("chat:trace.kind.command", { count });
    case "read": return i18n.t("chat:trace.kind.read", { count });
    case "edit": return i18n.t("chat:trace.kind.edit", { count });
    case "search": return i18n.t("chat:trace.kind.search", { count });
    case "page": return i18n.t("chat:trace.kind.page", { count });
    case "started": return i18n.t("chat:trace.kind.started", { count });
    case "heard": return i18n.t("chat:trace.kind.heard", { count });
    case "background": return i18n.t("chat:trace.kind.background", { count });
    case "other": return i18n.t("chat:trace.kind.other", { count });
  }
}

/** "Ran 5 commands, read 3 files, edited a file" — by what the calls did, in order of first use. */
export function groupSummary(tools: ToolRow[]): string {
  const counts = new Map<ToolKind, number>();
  for (const tool of tools) {
    const kind = TOOL_KINDS[tool.name] ?? "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const text = [...counts].map(([kind, n]) => kindText(kind, n)).join(i18n.t("common:format.listSeparator"));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Whether a group is open: the reader's own choice if made; otherwise closed
 * (every group, the growing last one too: its summary line names the running call).
 */
export function groupOpen(choices: Readonly<Record<string, boolean>>, key: string): boolean {
  return choices[key] ?? false;
}

/**
 * A group's one line. While its turn runs it says only what the agent is
 * doing now: the latest call's title, shimmering ("Run the test suite…"; no
 * ellipsis in the moment between two calls). Once the turn is over it sums
 * the run up: "Ran 5 commands, read 3 files".
 */
export function groupLabel(tools: ToolRow[], running = false): { lead: string; running?: string } {
  const latest = tools.at(-1);
  if (!running || !latest) return { lead: groupSummary(tools) };
  return { lead: "", running: `${latest.summary || latest.name}${latest.result ? "" : "…"}` };
}

/** The call still waiting for its result in a running group, if any. */
export function pendingTool(tools: ToolRow[]): ToolRow | undefined {
  const last = tools.at(-1);
  return last && !last.result ? last : undefined;
}
