import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, posix, sep } from "node:path";
import { PAGE_BYTES, readLine, readWindow, type ToolRedaction } from "./subagent-reader.js";
import { isSidechainLine, mayHoldToolBlocks, reportUnreadable, SDK_SESSION_ID, sessionTranscriptFile, type Problem } from "./sdk-transcript.js";
import { redactText, redactToolInput } from "./redact-command.js";
import { isPrivateMemoryAccess } from "../agent/private-memory-access.js";
import type { CallItem, SessionTools, SubagentItem } from "./protocol.js";
import { failureReason, toolOutcome } from "./activity.js";

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

/**
 * Where memory/private is, for the #464 predicate (isPrivateMemoryAccess),
 * and whose conversation this is. `owner`: the owner's own DM — its private
 * memory is the reader's own, so nothing is withheld from its calls (#492's
 * secret redaction still applies). Every other conversation (a group) keeps
 * the withholding.
 */
export interface PrivateScope { workspaceDir?: string; owner?: boolean }
function redaction(scope: PrivateScope): ToolRedaction {
  if (scope.owner) return { input: (input) => redactToolInput(input), output: redactText, activities: true };
  const ctx = scope.workspaceDir
    ? { cwd: scope.workspaceDir, memoryDir: join(scope.workspaceDir, "memory"), privateDir: join(scope.workspaceDir, "memory", "private") }
    : undefined;
  // No workspace known: any mention of memory/private withholds (fail closed).
  const reaches = (name: string, input: Record<string, unknown>) =>
    memoryToolReachesPrivate(name, input) || (ctx ? isPrivateMemoryAccess(name, input, ctx) : false) || /memory[/\\]private/i.test(JSON.stringify(input));
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
    activities: true,
  };
}

/** Path-addressed tools, and the input fields kept (redacted) when one reaches memory/private. */
const PATH_TOOLS: Record<string, readonly string[]> = {
  Read: ["file_path"], Edit: ["file_path"], Write: ["file_path"], MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"], Grep: ["path"], Glob: ["path"],
  ...Object.fromEntries(["memory_write", "memory_str_replace", "memory_append", "memory_delete", "memory_read"].map((tool) => [`mcp__tomo-internal__${tool}`, ["path"]])),
  "mcp__tomo-internal__memory_move": ["from", "to"], "mcp__tomo-internal__memory_list": ["prefix"],
};

/**
 * The memory tools address memory/ by a relative path ("private/travel.md"),
 * which the file-tool predicate does not see: one whose path (or a move's
 * either end, or a list's prefix) lands in private/ reaches it. Normalised and
 * case-folded (the disk may not tell case apart); the store refuses links, so
 * the spelled path is the real one.
 */
function memoryToolReachesPrivate(name: string, input: Record<string, unknown>): boolean {
  if (!/^mcp__tomo-internal__memory_/.test(name)) return false;
  return ["path", "from", "to", "prefix"].some((key) => {
    const value = input[key];
    if (typeof value !== "string") return false;
    const rel = posix.normalize(value.replace(/\\/g, "/").replace(/^\/+/, "")).toLowerCase();
    return rel === "private" || rel.startsWith("private/");
  });
}

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
  return { items: items.filter((item) => isCallItem(item) || item.kind === "result"), problems };
}

/** A call as the chat counts and keeps them: an ordinary call or a parsed TodoWrite list. */
export function isCallItem(item: SubagentItem): item is CallItem { return item.kind === "tool" || item.kind === "todos"; }

/** A call a result is paired with: did it reach memory/private, and which tool it was. */
export interface KnownCall { private: boolean; name: string }
const knownCall = (item: CallItem): KnownCall => ({ private: item.kind === "tool" && item.privateOutput === true, name: item.kind === "tool" ? item.name : "TodoWrite" });

/**
 * Pair every result with its call, ON THE SERVER, before anything is sent:
 * the output of a call that reached memory/private is replaced whole (its
 * input stays, redacted); a result whose call is not known is hidden too.
 * `owner` (the owner's DM): nothing is withheld, every output is kept.
 * `known`: calls from outside this page (an `after` read's look-back).
 * A result of one of Tomo's own tools whose output is shown also gets what
 * it says happened (`outcome`) or, failed, why (`reason`): activity.ts.
 */
export function pairOutputs(items: SubagentItem[], known: ReadonlyMap<string, KnownCall> = new Map(), owner = false): SubagentItem[] {
  const calls = new Map(known);
  for (const item of items) if (isCallItem(item)) calls.set(item.toolUseId, knownCall(item));
  return items.map((item) => {
    if (item.kind === "tool") { const rest = { ...item }; delete rest.privateOutput; return rest; }
    if (item.kind !== "result") return item;
    const call = calls.get(item.toolUseId);
    if (owner) return call ? withOutcome(item, call.name) : item;
    // A withheld output is replaced whole: not even how many images or links it held.
    const rest = { ...item };
    delete rest.images;
    delete rest.sources;
    if (call === undefined) return { ...rest, output: UNPAIRED_HIDDEN, truncated: false };
    return call.private ? { ...rest, output: PRIVATE_HIDDEN, truncated: false } : withOutcome(item, call.name);
  });
}

function withOutcome(item: Extract<SubagentItem, { kind: "result" }>, name: string): SubagentItem {
  if (item.isError) { const reason = failureReason(name, item.output); return reason ? { ...item, reason } : item; }
  const outcome = toolOutcome(name, item.output);
  return outcome ? { ...item, outcome } : item;
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
      const inPage = new Set(items.flatMap((item) => isCallItem(item) ? [item.toolUseId] : []));
      const wanted = new Set(items.flatMap((item) => item.kind === "result" && !inPage.has(item.toolUseId) ? [item.toolUseId] : []));
      const known = new Map<string, KnownCall>();
      let hi = query.after;
      while (wanted.size && hi > 0 && query.after - hi < PAIR_LOOKBACK_BYTES) {
        const page = await readWindow(fd, size, Math.max(0, hi - PAGE_BYTES), hi, "back");
        for (const line of page.lines) {
          for (const item of toolItemsFromLine(line.text, line.offset, scope)) {
            if (isCallItem(item) && wanted.has(item.toolUseId)) {
              known.set(item.toolUseId, knownCall(item)); wanted.delete(item.toolUseId);
            }
          }
        }
        if (page.start >= hi) break;
        hi = page.start;
      }
      return { items: pairOutputs(items, known, scope.owner), end: cursor, transcript: token, complete: true, ...flagged() };
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
      if (items.some((item) => isCallItem(item) && item.ts !== undefined && item.ts < from)) { reached = true; break; }
      if (page.start >= hi) break;
      hi = page.start;
    }
    const all = pages.flat();
    const tools = all.filter((item): item is CallItem => isCallItem(item) && (item.ts ?? Infinity) >= from);
    const kept = new Set(tools.slice(-MAX_TOOL_ITEMS / 2).map((item) => item.toolUseId));
    const items = all.filter((item) => (isCallItem(item) || item.kind === "result") && kept.has(item.toolUseId));
    // Incomplete: the scan stopped at a cap before reaching `from`, or found more calls than it keeps.
    return { items: pairOutputs(items, undefined, scope.owner), end: end ?? 0, transcript: token, complete: (reached || hi === 0) && tools.length <= MAX_TOOL_ITEMS / 2, ...flagged() };
  } finally { await fd.close(); }
}
