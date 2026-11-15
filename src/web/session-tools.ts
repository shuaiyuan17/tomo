import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { PAGE_BYTES, readLine, readWindow, type ToolRedaction } from "./subagent-reader.js";
import { isSidechainLine, mayHoldToolBlocks, reportUnreadable, SDK_SESSION_ID, sessionTranscriptFile, type Problem } from "./sdk-transcript.js";
import { redactText, redactToolInput } from "./redact-command.js";
import { isPrivateMemoryAccess } from "../agent/private-memory-access.js";
import type { SessionTools, SubagentItem } from "./protocol.js";

/**
 * The tool calls of a conversation's CURRENT SDK transcript
 * (`<sdkSessionsDir>/<sdkSessionId>.jsonl`), for the main chat to show
 * inline between its messages. It reuses the subagent view's line parser
 * and clipping, and applies #492's redaction to every input and output.
 * Calls LCM compacted out of the transcript (an earlier SDK session) are not
 * shown: a known limit.
 *
 * Two reads: `from` (ms epoch) scans back from the end until the calls
 * reach that time, at most MAX_SCAN_BYTES; `after` (a byte offset from an
 * earlier answer, with its `transcript` token) reads only the lines appended
 * since. A token that no longer names the current transcript, or an offset
 * past its end, is a reset: read again with `from`.
 */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;
/** Tool and result items in one answer; the newest are kept. */
export const MAX_TOOL_ITEMS = 800;
/** How far back an `after` read looks for the calls of results it got without them. */
export const PAIR_LOOKBACK_BYTES = 2 * 1024 * 1024;
export const PRIVATE_HIDDEN = "[private memory content hidden]";
export const UNPAIRED_HIDDEN = "(output hidden — call not in view)";

/** Where memory/private is, for the #464 predicate (isPrivateMemoryAccess). */
export interface PrivateScope { workspaceDir?: string }
function redaction(scope: PrivateScope): ToolRedaction {
  const ctx = scope.workspaceDir
    ? { cwd: scope.workspaceDir, memoryDir: join(scope.workspaceDir, "memory"), privateDir: join(scope.workspaceDir, "memory", "private") }
    : undefined;
  // No workspace known: any mention of memory/private withholds (fail closed).
  const reaches = (name: string, input: Record<string, unknown>) =>
    (ctx ? isPrivateMemoryAccess(name, input, ctx) : false) || /memory[/\\]private/i.test(JSON.stringify(input));
  return {
    // A file/search tool aimed at memory/private shows its name and its
    // (redacted) path only: no old_string/new_string/content/pattern body,
    // and so no body in its summary either.
    input: (input, name) => PATH_TOOLS[name] && reaches(name, input)
      ? redactToolInput(Object.fromEntries(PATH_TOOLS[name].flatMap((key) => typeof input[key] === "string" ? [[key, input[key]]] : [])))
      : redactToolInput(input),
    output: redactText,
    // Bash is judged by bashTouchesMemory on the command's words: BEST EFFORT,
    // not a security boundary (an alias, a variable or a symlink can reach
    // private/ unseen). The web UI is the owner's alone (token + tailnet);
    // this is defence in depth, like #492's redaction.
    reachesPrivate: reaches,
  };
}

/** Path-addressed tools, and the input fields kept (redacted) when one reaches memory/private. */
const PATH_TOOLS: Record<string, readonly string[]> = {
  Read: ["file_path"], Edit: ["file_path"], Write: ["file_path"], MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"], Grep: ["path"], Glob: ["path"],
};

export class SessionToolsError extends Error {
  constructor(readonly code: "invalid_cursor" | "transcript_reset") { super(code); }
}

/** A short, stable name for one SDK transcript (the id itself stays server-side). */
export function transcriptToken(sdkSessionId: string): string {
  return createHash("sha256").update(sdkSessionId).digest("base64url").slice(0, 16);
}

/** Only the tool calls and results of one main-conversation line (no sidechains, no text, no thinking). */
export function toolItemsFromLine(text: string, offset: number, scope: PrivateScope = {}): SubagentItem[] {
  return toolLine(text, offset, scope).items;
}

/**
 * As toolItemsFromLine, plus what the parser did not recognise. Only lines
 * that can hold a tool block are parsed (the scan covers up to 16 MiB).
 */
function toolLine(text: string, offset: number, scope: PrivateScope): { items: SubagentItem[]; problems: Problem[] } {
  if (!mayHoldToolBlocks(text) || isSidechainLine(text)) return { items: [], problems: [] };
  const { items, problems } = readLine(text, offset, redaction(scope));
  return { items: items.filter((item) => item.kind === "tool" || item.kind === "result"), problems };
}

/**
 * Pair every result with its call, ON THE SERVER, before anything is sent:
 * the output of a call that reached memory/private is replaced whole (its
 * input stays, redacted); a result whose call is not known is hidden too.
 * `known`: calls from outside this page (an `after` read's look-back).
 */
export function pairOutputs(items: SubagentItem[], known: ReadonlyMap<string, boolean> = new Map()): SubagentItem[] {
  const calls = new Map(known);
  for (const item of items) if (item.kind === "tool") calls.set(item.toolUseId, item.privateOutput === true);
  return items.map((item) => {
    if (item.kind === "tool") { const rest = { ...item }; delete rest.privateOutput; return rest; }
    if (item.kind !== "result") return item;
    const reached = calls.get(item.toolUseId);
    // A withheld output is replaced whole: not even how many images it held.
    const rest = { ...item };
    delete rest.images;
    if (reached === undefined) return { ...rest, output: UNPAIRED_HIDDEN, truncated: false };
    return reached ? { ...rest, output: PRIVATE_HIDDEN, truncated: false } : item;
  });
}

const EMPTY: SessionTools = { items: [], end: 0, transcript: "", complete: true };

export async function readSessionTools(sdkSessionsDir: string, sdkSessionId: string | undefined,
  query: { from?: number; after?: number; transcript?: string }, scope: PrivateScope = {}): Promise<SessionTools> {
  for (const value of [query.from, query.after]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SessionToolsError("invalid_cursor");
  }
  if (!sdkSessionId || !SDK_SESSION_ID.test(sdkSessionId)) {
    if (query.after !== undefined && query.transcript) throw new SessionToolsError("transcript_reset");
    return EMPTY;
  }
  const token = transcriptToken(sdkSessionId);
  if (query.after !== undefined && query.transcript !== token) throw new SessionToolsError("transcript_reset");
  let root: string;
  try { root = await realpath(sdkSessionsDir); } catch { return EMPTY; }
  const path = sessionTranscriptFile(root, sdkSessionId)!;
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!fd) {
    if (query.after !== undefined) throw new SessionToolsError("transcript_reset");
    return { ...EMPTY, transcript: token };
  }
  try {
    if (!(await realpath(path)).startsWith(root + sep)) return EMPTY;
    const stat = await fd.stat();
    if (!stat.isFile()) return EMPTY;
    const size = stat.size;
    // Lines this answer read that the parser did not recognise: counted in
    // the answer (the chat notes it) and logged once per transcript.
    const problems: Problem[] = [];
    let unreadable = 0;
    const read = (line: { text: string; offset: number }) => {
      const result = toolLine(line.text, line.offset, scope);
      if (result.problems.length) { unreadable++; problems.push(...result.problems); }
      return result.items;
    };
    const flagged = () => {
      reportUnreadable(path, "session", unreadable, problems);
      return unreadable ? { unreadable } : {};
    };
    if (query.after !== undefined) {
      if (query.after > size) throw new SessionToolsError("transcript_reset");
      const items: SubagentItem[] = [];
      let cursor = query.after;
      while (cursor < size && cursor - query.after < MAX_SCAN_BYTES && items.length < MAX_TOOL_ITEMS) {
        const page = await readWindow(fd, size, cursor, Math.min(size, cursor + PAGE_BYTES), "forward");
        if (page.end <= cursor) break; // only a partial line so far
        for (const line of page.lines) items.push(...read(line));
        cursor = page.end;
      }
      // Results whose call was on an earlier page: find those calls just before `after`.
      const inPage = new Set(items.flatMap((item) => item.kind === "tool" ? [item.toolUseId] : []));
      const wanted = new Set(items.flatMap((item) => item.kind === "result" && !inPage.has(item.toolUseId) ? [item.toolUseId] : []));
      const known = new Map<string, boolean>();
      let hi = query.after;
      while (wanted.size && hi > 0 && query.after - hi < PAIR_LOOKBACK_BYTES) {
        const page = await readWindow(fd, size, Math.max(0, hi - PAGE_BYTES), hi, "back");
        for (const line of page.lines) {
          for (const item of toolItemsFromLine(line.text, line.offset, scope)) {
            if (item.kind === "tool" && wanted.has(item.toolUseId)) { known.set(item.toolUseId, item.privateOutput === true); wanted.delete(item.toolUseId); }
          }
        }
        if (page.start >= hi) break;
        hi = page.start;
      }
      return { items: pairOutputs(items, known), end: cursor, transcript: token, complete: true, ...flagged() };
    }
    const from = query.from ?? 0;
    const pages: SubagentItem[][] = [];
    let end: number | undefined;
    let hi = size;
    let count = 0;
    let reached = false;
    while (hi > 0 && size - hi < MAX_SCAN_BYTES && count < MAX_TOOL_ITEMS) {
      const page = await readWindow(fd, size, Math.max(0, hi - PAGE_BYTES), hi, "back");
      end ??= page.end;
      const items = page.lines.flatMap(read);
      pages.unshift(items);
      count += items.length;
      if (items.some((item) => item.kind === "tool" && item.ts !== undefined && item.ts < from)) { reached = true; break; }
      if (page.start >= hi) break;
      hi = page.start;
    }
    const all = pages.flat();
    const tools = all.filter((item) => item.kind === "tool" && (item.ts ?? Infinity) >= from);
    const kept = new Set(tools.slice(-MAX_TOOL_ITEMS / 2).map((item) => (item as Extract<SubagentItem, { kind: "tool" }>).toolUseId));
    const items = all.filter((item) => (item.kind === "tool" || item.kind === "result") && kept.has(item.toolUseId));
    // Incomplete: the scan stopped at a cap before reaching `from`, or found more calls than it keeps.
    return { items: pairOutputs(items), end: end ?? 0, transcript: token, complete: (reached || hi === 0) && tools.length <= MAX_TOOL_ITEMS / 2, ...flagged() };
  } finally { await fd.close(); }
}
