import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { sep } from "node:path";
import { scrubSecretValues } from "../redact.js";
import { toolTitle } from "../agent/tool-summary.js";
import { redactText } from "./redact-command.js";
import type { SubagentBrief, SubagentItem, SubagentPage, TodoEntry, WebSource } from "./protocol.js";
import { fetchedPage, mayBeAssistant, metaModels, parseEntry, reportUnreadable, searchResultLinks, subagentMetaFile, subagentTranscriptFile,
  todoList, taskNotice, BACKGROUND_TASK_TOOL, SUBAGENT_MESSAGE_TOOL, type Block, type Entry, type Problem, type ResultPart, type TaskNotice, type WebLink } from "./sdk-transcript.js";

/**
 * Bounded, read-only pages over one subagent's transcript
 * (`<sdkSessionsDir>/<sdkSessionId>/subagents/agent-<taskId>.jsonl`, the
 * layout `listSubagents` documents; a local_agent's task_id is its agentId).
 * What the SDK's records look like is known only to sdk-transcript.ts (which
 * also says why this is not the SDK's own reader); this module turns its
 * normalised entries into clipped, scrubbed view items.
 *
 * Pages are byte windows over complete JSONL lines, so they are cheap to
 * page backwards ("load earlier") and to tail (`after` = the previous
 * page's `end`) while the subagent is still writing. Every text is clipped
 * and secret-scrubbed; the subagent's own prompt (its first user message) is
 * not returned, as the task panel never carries prompts either.
 */

export const PAGE_BYTES = 256 * 1024;
/** One JSONL line may hold a large tool result; never read more than this for one. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const TEXT_LIMIT = 8_000;
export const IO_LIMIT = 4_000;
/** The brief (first prompt) is shown in full up to this many characters. */
export const BRIEF_LIMIT = 12_000;
export const MAX_PAGE_ITEMS = 400;
/** Blocks shown from one transcript entry; the rest is summarised by a marker. */
export const MAX_LINE_ITEMS = 400;
/** Entries kept from one TodoWrite list (the rest are counted), and the characters kept of each entry's text. */
export const MAX_TODOS = 50;
export const TODO_TEXT_LIMIT = 400;
/** Characters kept of a source's title. */
export const SOURCE_TITLE_LIMIT = 200;
export class SubagentReadError extends Error {
  constructor(readonly code: "invalid_cursor" | "transcript_not_found" | "transcript_reset") { super(code); }
}

export function subagentTranscriptPath(sdkSessionsDir: string, sdkSessionId: string, taskId: string): string {
  const path = subagentTranscriptFile(sdkSessionsDir, sdkSessionId, taskId);
  if (!path) throw new SubagentReadError("transcript_not_found");
  return path;
}

const clip = (text: string, limit: number) => {
  const scrubbed = scrubSecretValues(text.length > limit * 2 ? text.slice(0, limit * 2) : text);
  return scrubbed.length > limit ? { text: scrubbed.slice(0, limit), truncated: true } : { text: scrubbed, truncated: false };
};

/** A tool result's text (other non-text parts by their type, as `[document]`); images are counted, never written. */
function resultText(parts: ResultPart[]): { text: string; images: number } {
  const images = parts.filter((part) => part.type === "image").length;
  const text = parts.flatMap((part) => part.type === "text" ? [part.text] : part.type === "other" ? [`[${part.name}]`] : []).join("\n");
  return { text, images };
}

/** Turn one transcript line into view items. Unknown shapes yield nothing (readLine also says what was not read). */
export function itemsFromLine(line: string, offset: number, redact?: ToolRedaction): SubagentItem[] {
  return readLine(line, offset, redact).items;
}

/** One line's items, and what in it the parser did not recognise (sdk-transcript.ts). */
export function readLine(line: string, offset: number, redact?: ToolRedaction): { items: SubagentItem[]; problems: Problem[] } {
  const { entry, problems } = parseEntry(line);
  return { items: itemsFromEntry(entry, offset, redact), problems };
}

function itemsFromEntry(entry: Entry, offset: number, redact?: ToolRedaction): SubagentItem[] {
  if (entry.kind === "queued") {
    const { text, truncated } = clip(entry.prompt, TEXT_LIMIT);
    return [{ kind: "message", id: `${offset}:queued`, text, truncated, ...(entry.ts ? { ts: entry.ts } : {}) }];
  }
  if (entry.kind !== "message") return [];
  // A background task reporting back (the CLI's own user-role entry) is shown
  // as a step of the turn, like a tool call: a titled row that opens to the
  // report. It is carried as a synthetic call/result pair so every rule a
  // call already obeys (pairing, grouping, redaction, bounds) applies to it.
  if (entry.role === "user") {
    const notice = taskNotice(userText(entry.content));
    if (notice) return noticeItems(notice, offset, entry.ts, redact);
  }
  // A user entry with text is a message to the subagent. The very first entry
  // is its brief (served separately), so it is never repeated here.
  if (entry.role === "user" && offset > 0) {
    const said = userText(entry.content);
    if (said.trim()) {
      const { text, truncated } = clip(said, TEXT_LIMIT);
      return [{ kind: "message", id: `${offset}:msg`, text, truncated, ...(entry.ts ? { ts: entry.ts } : {}) },
        ...(Array.isArray(entry.content) ? itemsFromBlocks(entry, entry.content, offset, redact) : [])];
    }
  }
  if (typeof entry.content === "string") return [];
  return itemsFromBlocks(entry, entry.content, offset, redact);
}

/** Optional server-side masking of tool inputs and outputs (the main chat applies #492's redaction). */
export interface ToolRedaction {
  /** Redacts a call's input; `name` lets a caller drop the body of a call it withholds. */
  input: (input: Record<string, unknown>, name: string) => Record<string, unknown>;
  output: (text: string) => string;
  /** Asked with the RAW input: does this call reach memory/private? Its tool item is then marked `privateOutput`. */
  reachesPrivate?: (name: string, input: Record<string, unknown>) => boolean;
}

function noticeItems(notice: TaskNotice, offset: number, ts: number | undefined, redact?: ToolRedaction): SubagentItem[] {
  const toolUseId = `notice:${offset}`;
  const name = notice.subagent ? SUBAGENT_MESSAGE_TOOL : BACKGROUND_TASK_TOOL;
  const title = clip(scrubSecretValues(`${notice.subagent ? "Message from subagent" : "Background task"} · ${notice.name}`), 200).text;
  const report = clip(notice.text || (notice.status ? `(${notice.status}; no report text)` : "(no report text)"), IO_LIMIT);
  const failed = notice.status === "failed" || notice.status === "killed";
  return [
    // A report is model-written prose with no input to judge by, so the
    // main chat's private-memory rule looks at the report itself: one that
    // names memory/private is withheld whole, like the output of a call that
    // reached it. Best effort, as for Bash: a report can quote private
    // content without naming where it came from.
    { kind: "tool", id: `${offset}:notice`, toolUseId, name, summary: title, input: "", inputTruncated: false, ...(ts ? { ts } : {}),
      ...(redact?.reachesPrivate?.(name, { report: `${notice.name}\n${notice.text}` }) ? { privateOutput: true } : {}) },
    { kind: "result", id: `${offset}:notice-result`, toolUseId, output: redact ? redact.output(report.text) : report.text, truncated: report.truncated, isError: failed, ...(ts ? { ts } : {}) },
  ];
}

/** The text a user entry carries: a string, or its text blocks (tool results are not text). */
function userText(content: string | Block[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((b) => b.type === "text" ? [b.text] : [])
    // Harness reminders ride along on user entries; they are not messages.
    .filter((t) => !t.trimStart().startsWith("<system-reminder>")).join("\n\n");
}

function itemsFromBlocks(entry: Extract<Entry, { kind: "message" }>, content: Block[], offset: number, redact?: ToolRedaction): SubagentItem[] {
  const ts = entry.ts;
  const items: SubagentItem[] = [];
  // One entry is always returned whole (pages never split a line); an entry
  // with more blocks than the cap says how many were left out.
  const hidden = Math.max(0, content.length - MAX_LINE_ITEMS);
  content.slice(0, MAX_LINE_ITEMS).forEach((b, index) => {
    const id = `${offset}:${index}`;
    if (entry.role === "assistant" && b.type === "text" && b.text.trim()) {
      const { text, truncated } = clip(b.text, TEXT_LIMIT);
      items.push({ kind: "text", id, text, truncated, ...(ts ? { ts } : {}) });
    } else if (entry.role === "assistant" && b.type === "thinking" && b.text.trim()) {
      // Empty thinking (display "omitted": a signature-only block) and redacted thinking show nothing.
      const { text, truncated } = clip(b.text, TEXT_LIMIT);
      items.push({ kind: "thinking", id, text, truncated, ...(ts ? { ts } : {}) });
    } else if (entry.role === "assistant" && b.type === "tool_use") {
      const raw = b.input;
      const todos = todoList(b.name, raw);
      if (todos) {
        // The agent's todo list: parsed, bounded and scrubbed like any other text.
        items.push({ kind: "todos", id, toolUseId: b.id ?? id, todos: todos.slice(0, MAX_TODOS).map((todo) => todoEntry(todo, redact)),
          ...(todos.length > MAX_TODOS ? { more: todos.length - MAX_TODOS } : {}), ...(ts ? { ts } : {}) });
        return;
      }
      const input = redact ? redact.input(raw, b.name) : raw;
      const inputText = clip(JSON.stringify(input, null, 2), IO_LIMIT);
      const reaches = redact?.reachesPrivate?.(b.name, raw) === true;
      const page = reaches ? undefined : sources([fetchedPage(b.name, raw)], redact);
      items.push({ kind: "tool", id, toolUseId: b.id ?? id, name: b.name.slice(0, 128),
        summary: clip(toolTitle(b.name, input), 200).text, input: inputText.text, inputTruncated: inputText.truncated,
        ...(ts ? { ts } : {}), ...(page ? { sources: page } : {}), ...(reaches ? { privateOutput: true } : {}) });
    } else if (entry.role === "user" && b.type === "tool_result") {
      const result = resultText(b.parts);
      const { text, truncated } = clip(result.text, IO_LIMIT);
      // Links are read from the whole result (they can sit past the clip), then bounded on their own.
      const links = sources(searchResultLinks(b.parts), redact);
      items.push({ kind: "result", id, toolUseId: b.toolUseId, output: redact ? redact.output(text) : text, truncated, isError: b.isError,
        ...(result.images ? { images: result.images } : {}), ...(ts ? { ts } : {}), ...(links ? { sources: links } : {}) });
    }
  });
  if (hidden) items.push({ kind: "text", id: `${offset}:more`, text: `… ${hidden} more entries in this step are not shown.`, truncated: true });
  return items;
}

/** One todo's text, clipped and scrubbed (and redacted where the caller redacts outputs). */
function todoEntry(todo: { content: string; status: TodoEntry["status"]; activeForm?: string }, redact?: ToolRedaction): TodoEntry {
  const text = (value: string) => { const clipped = clip(value.replace(/\s+/g, " ").trim(), TODO_TEXT_LIMIT).text; return redact ? redact.output(clipped) : clipped; };
  const activeForm = todo.activeForm ? text(todo.activeForm) : "";
  return { content: text(todo.content), status: todo.status, ...(activeForm ? { activeForm } : {}) };
}

/**
 * Links as they may be sent: a URL that the UI's redaction would change (a
 * token in its query string, a credential shape) is left out rather than
 * shown altered or whole;
 * titles are clipped and scrubbed. Undefined when none is left.
 */
function sources(links: ReadonlyArray<WebLink | undefined>, redact?: ToolRedaction): WebSource[] | undefined {
  const kept = links.flatMap((link): WebSource[] => {
    if (!link) return [];
    const url = link.url;
    if (redactText(url) !== url || (redact && redact.output(url) !== url)) return [];
    const title = link.title ? clip(link.title, SOURCE_TITLE_LIMIT).text : "";
    const shown = title && redact ? redact.output(title) : title;
    return [{ url, ...(shown ? { title: shown } : {}) }];
  });
  return kept.length ? kept : undefined;
}

export async function readRange(fd: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await fd.read(buffer, read, buffer.length - read, start + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/**
 * Complete lines inside [start, end): grows the window (up to MAX_LINE_BYTES)
 * until it holds at least one whole line, so one huge entry cannot stall
 * paging. The end is always cut back to the last newline.
 */
export async function readWindow(fd: FileHandle, size: number, start: number, end: number, direction: "back" | "forward"):
  Promise<{ start: number; end: number; lines: { offset: number; bytes: number; text: string }[] }> {
  let lo = start, hi = end;
  for (;;) {
    const bytes = await readRange(fd, lo, hi);
    let from = 0;
    // A forward read starts at a line boundary (a previous page's end); a
    // backward window can begin mid-line, so its first partial line is dropped.
    if (direction === "back" && lo > 0) {
      const nl = bytes.indexOf(0x0a);
      from = nl < 0 ? bytes.length : nl + 1;
    }
    const last = bytes.lastIndexOf(0x0a);
    const to = last < from ? from : last + 1;
    if (to > from || (direction === "back" ? lo === 0 : hi >= size) || hi - lo >= MAX_LINE_BYTES) {
      const lines: { offset: number; bytes: number; text: string }[] = [];
      let cursor = from;
      while (cursor < to) {
        const nl = bytes.indexOf(0x0a, cursor);
        const stop = nl < 0 || nl >= to ? to : nl;
        if (stop > cursor) lines.push({ offset: lo + cursor, bytes: stop - cursor + 1, text: bytes.subarray(cursor, stop).toString("utf8") });
        cursor = stop + 1;
      }
      // An entry larger than the cap: skip past it rather than stall.
      if (to === from && hi - lo >= MAX_LINE_BYTES) {
        return direction === "back" ? { start: lo, end: lo, lines } : { start: lo + from, end: hi, lines };
      }
      return { start: lo + from, end: lo + to, lines };
    }
    if (direction === "back") lo = Math.max(0, lo - (hi - lo));
    else hi = Math.min(size, hi + (hi - lo));
  }
}

/**
 * One page. No cursor: the tail. `before`: the window ending at that byte
 * (load earlier). `after`: new complete lines from that byte (live tail).
 */
export async function readSubagentPage(sdkSessionsDir: string, sdkSessionId: string, taskId: string,
  cursor: { before?: number; after?: number } = {}): Promise<SubagentPage> {
  const path = subagentTranscriptPath(sdkSessionsDir, sdkSessionId, taskId);
  const root = await realpath(sdkSessionsDir).catch(() => { throw new SubagentReadError("transcript_not_found"); });
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new SubagentReadError("transcript_not_found");
  });
  try {
    const canonical = await realpath(path);
    if (!canonical.startsWith(root + sep)) throw new SubagentReadError("transcript_not_found");
    const stat = await fd.stat();
    if (!stat.isFile()) throw new SubagentReadError("transcript_not_found");
    const size = stat.size;
    for (const value of [cursor.before, cursor.after]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SubagentReadError("invalid_cursor");
    }
    // A cursor past the end means the file was replaced: start over.
    if ((cursor.after ?? 0) > size || (cursor.before ?? 0) > size) throw new SubagentReadError("transcript_reset");
    const page = cursor.after !== undefined
      ? await readWindow(fd, size, cursor.after, Math.min(size, cursor.after + PAGE_BYTES), "forward")
      : await readWindow(fd, size, Math.max(0, (cursor.before ?? size) - PAGE_BYTES), cursor.before ?? size, "back");
    // Whole lines only, stopping once a page holds MAX_PAGE_ITEMS: forward
    // pages keep their oldest lines, backward pages their newest. The cursor
    // moves to the edge of the last line kept, so nothing is skipped.
    const perLine = page.lines.map((line) => ({ line, ...readLine(line.text, line.offset) }));
    const ordered = cursor.after !== undefined ? perLine : [...perLine].reverse();
    const kept: typeof perLine = [];
    let count = 0;
    for (const entry of ordered) {
      if (kept.length && count + entry.items.length > MAX_PAGE_ITEMS) break;
      kept.push(entry);
      count += entry.items.length;
    }
    if (cursor.after === undefined) kept.reverse();
    const items = kept.flatMap((entry) => entry.items);
    const all = kept.length === perLine.length;
    const start = all || cursor.after !== undefined ? page.start : kept[0].line.offset;
    const end = all || cursor.after === undefined ? page.end : kept.at(-1)!.line.offset + kept.at(-1)!.line.bytes;
    // Lines the parser did not recognise: said in the page (the view notes
    // it) and logged once per file — a changed format must not read as empty.
    const unreadable = kept.filter((entry) => entry.problems.length);
    reportUnreadable(canonical, "subagent", unreadable.length, unreadable.flatMap((entry) => entry.problems));
    return { items, start, end, size, hasEarlier: start > 0, ...(unreadable.length ? { unreadable: unreadable.length } : {}) };
  } finally { await fd.close(); }
}

/**
 * How much of a transcript's head is read to find its model. A subagent whose
 * first assistant entry starts beyond this (an enormous prompt) shows no
 * badge: an accepted limit, so a lookup never reads a large file.
 */
export const MODEL_HEAD_BYTES = 256 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The subagent's sidecar written when it is spawned (`agent-<id>.meta.json`). */
export function subagentMetaPath(sdkSessionsDir: string, sdkSessionId: string, taskId: string): string {
  return subagentMetaFile(subagentTranscriptPath(sdkSessionsDir, sdkSessionId, taskId));
}
/** A meta.json is a few hundred bytes; anything past this is not one. */
export const META_MAX_BYTES = 16 * 1024;

/** Open a file under `sdkSessionsDir` the same guarded way for every read here. */
async function openUnder(sdkSessionsDir: string, path: string): Promise<FileHandle | undefined> {
  const root = await realpath(sdkSessionsDir);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await realpath(path)).startsWith(root + sep) || !(await fd.stat()).isFile()) { await fd.close(); return undefined; }
  return fd;
}

/**
 * The model a subagent runs on. First from its meta.json — written when the
 * subagent is spawned, so it is there before any transcript entry:
 * `pickedEffortModel` (the resolved id), else `model`. Then, as a fallback,
 * `message.model` of the first assistant entry in its transcript (the SDK's
 * task events carry no model). Undefined when neither has one yet.
 */
export async function readSubagentModel(sdkSessionsDir: string, sdkSessionId: string, taskId: string): Promise<string | undefined> {
  return await readMetaModel(sdkSessionsDir, sdkSessionId, taskId)
    ?? await readTranscriptModel(sdkSessionsDir, sdkSessionId, taskId);
}

async function readMetaModel(sdkSessionsDir: string, sdkSessionId: string, taskId: string): Promise<string | undefined> {
  let fd: FileHandle | undefined;
  try {
    fd = await openUnder(sdkSessionsDir, subagentMetaPath(sdkSessionsDir, sdkSessionId, taskId));
    if (!fd) return undefined;
    const raw = await readRange(fd, 0, META_MAX_BYTES + 1);
    if (raw.length > META_MAX_BYTES) return undefined;
    for (const model of metaModels(raw.toString("utf8"))) {
      if (typeof model === "string" && MODEL_ID.test(model)) return model;
    }
    return undefined;
  } catch { return undefined; }
  finally { await fd?.close(); }
}

async function readTranscriptModel(sdkSessionsDir: string, sdkSessionId: string, taskId: string): Promise<string | undefined> {
  let fd: FileHandle | undefined;
  try {
    fd = await openUnder(sdkSessionsDir, subagentTranscriptPath(sdkSessionsDir, sdkSessionId, taskId));
    if (!fd) return undefined;
    const head = await readRange(fd, 0, MODEL_HEAD_BYTES);
    const lines = head.toString("utf8").split("\n");
    if (head.length === MODEL_HEAD_BYTES) lines.pop(); // possibly cut mid-line
    for (const line of lines) {
      if (!mayBeAssistant(line)) continue;
      const { entry } = parseEntry(line);
      if (entry.kind !== "message" || entry.role !== "assistant") continue;
      if (entry.model && MODEL_ID.test(entry.model)) return entry.model;
    }
    return undefined;
  } catch { return undefined; }
  finally { await fd?.close(); }
}

/**
 * The brief: the text of the transcript's FIRST entry, when it is a user
 * entry (the prompt the subagent was spawned with). Later user entries —
 * messages sent while it ran, including after a resume — are never the
 * brief. Clipped to BRIEF_LIMIT characters and secret-scrubbed.
 */
export async function readSubagentBrief(sdkSessionsDir: string, sdkSessionId: string, taskId: string): Promise<SubagentBrief | undefined> {
  let fd: FileHandle | undefined;
  try {
    const path = subagentTranscriptPath(sdkSessionsDir, sdkSessionId, taskId);
    const root = await realpath(sdkSessionsDir);
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await realpath(path)).startsWith(root + sep) || !(await fd.stat()).isFile()) return undefined;
    const head = await readRange(fd, 0, MAX_LINE_BYTES);
    const end = head.indexOf(0x0a);
    if (end < 0) return undefined; // first entry not complete yet
    const { entry } = parseEntry(head.subarray(0, end).toString("utf8"));
    if (entry.kind !== "message" || entry.role !== "user") return undefined;
    const said = userText(entry.content);
    if (!said.trim()) return undefined;
    return clip(said, BRIEF_LIMIT);
  } catch { return undefined; }
  finally { await fd?.close(); }
}
