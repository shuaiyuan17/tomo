import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { scrubSecretValues } from "../redact.js";
import { summarizeToolInput } from "../agent/tool-summary.js";
import type { SubagentItem, SubagentPage } from "./protocol.js";

/**
 * Bounded, read-only pages over one subagent's transcript
 * (`<sdkSessionsDir>/<sdkSessionId>/subagents/agent-<taskId>.jsonl`, the
 * layout `listSubagents` documents; a local_agent's task_id is its agentId).
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
export const MAX_PAGE_ITEMS = 400;
/** Blocks shown from one transcript entry; the rest is summarised by a marker. */
export const MAX_LINE_ITEMS = 400;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SDK_SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;

export class SubagentReadError extends Error {
  constructor(readonly code: "invalid_cursor" | "transcript_not_found" | "transcript_reset") { super(code); }
}

export function subagentTranscriptPath(sdkSessionsDir: string, sdkSessionId: string, taskId: string): string {
  if (!SDK_SESSION_ID.test(sdkSessionId) || !TASK_ID.test(taskId)) throw new SubagentReadError("transcript_not_found");
  return join(sdkSessionsDir, sdkSessionId, "subagents", `agent-${taskId}.jsonl`);
}

const clip = (text: string, limit: number) => {
  const scrubbed = scrubSecretValues(text.length > limit * 2 ? text.slice(0, limit * 2) : text);
  return scrubbed.length > limit ? { text: scrubbed.slice(0, limit), truncated: true } : { text: scrubbed, truncated: false };
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown };
      if (typeof b.text === "string") return b.text;
      if (b.type) return `[${b.type}]`;
    }
    return "";
  }).join("\n");
}

/** Turn one transcript line into view items. Unknown shapes yield nothing. */
export function itemsFromLine(line: string, offset: number): SubagentItem[] {
  let record: { type?: string; message?: { content?: unknown }; timestamp?: string };
  try { record = JSON.parse(line); } catch { return []; }
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];
  const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) || undefined : undefined;
  const items: SubagentItem[] = [];
  // One entry is always returned whole (pages never split a line); an entry
  // with more blocks than the cap says how many were left out.
  const hidden = Math.max(0, content.length - MAX_LINE_ITEMS);
  content.slice(0, MAX_LINE_ITEMS).forEach((block: unknown, index: number) => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    const id = `${offset}:${index}`;
    if (record.type === "assistant" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const { text, truncated } = clip(b.text, TEXT_LIMIT);
      items.push({ kind: "text", id, text, truncated, ...(ts ? { ts } : {}) });
    } else if (record.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
      const inputText = clip(JSON.stringify(input, null, 2), IO_LIMIT);
      items.push({ kind: "tool", id, toolUseId: typeof b.id === "string" ? b.id : id, name: b.name.slice(0, 128),
        summary: clip(summarizeToolInput(b.name, input), 200).text, input: inputText.text, inputTruncated: inputText.truncated,
        ...(ts ? { ts } : {}) });
    } else if (record.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const { text, truncated } = clip(resultText(b.content), IO_LIMIT);
      items.push({ kind: "result", id, toolUseId: b.tool_use_id, output: text, truncated, isError: b.is_error === true });
    }
  });
  if (hidden) items.push({ kind: "text", id: `${offset}:more`, text: `… ${hidden} more entries in this step are not shown.`, truncated: true });
  return items;
}

async function readRange(fd: FileHandle, start: number, end: number): Promise<Buffer> {
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
async function window(fd: FileHandle, size: number, start: number, end: number, direction: "back" | "forward"):
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
      ? await window(fd, size, cursor.after, Math.min(size, cursor.after + PAGE_BYTES), "forward")
      : await window(fd, size, Math.max(0, (cursor.before ?? size) - PAGE_BYTES), cursor.before ?? size, "back");
    // Whole lines only, stopping once a page holds MAX_PAGE_ITEMS: forward
    // pages keep their oldest lines, backward pages their newest. The cursor
    // moves to the edge of the last line kept, so nothing is skipped.
    const perLine = page.lines.map((line) => ({ line, items: itemsFromLine(line.text, line.offset) }));
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
    return { items, start, end, size, hasEarlier: start > 0 };
  } finally { await fd.close(); }
}

/** How much of a transcript's head is read to find its model. */
export const MODEL_HEAD_BYTES = 256 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * The model a subagent runs on: `message.model` of the first assistant entry
 * in its transcript (the SDK's task events carry no model). Undefined when
 * there is none yet, or it is not a plain model id (e.g. "<synthetic>").
 */
export async function readSubagentModel(sdkSessionsDir: string, sdkSessionId: string, taskId: string): Promise<string | undefined> {
  let fd: FileHandle | undefined;
  try {
    const path = subagentTranscriptPath(sdkSessionsDir, sdkSessionId, taskId);
    const root = await realpath(sdkSessionsDir);
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await realpath(path)).startsWith(root + sep) || !(await fd.stat()).isFile()) return undefined;
    const head = await readRange(fd, 0, MODEL_HEAD_BYTES);
    const lines = head.toString("utf8").split("\n");
    if (head.length === MODEL_HEAD_BYTES) lines.pop(); // possibly cut mid-line
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      let record: { type?: string; message?: { model?: unknown } };
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== "assistant") continue;
      const model = record.message?.model;
      if (typeof model === "string" && MODEL_ID.test(model)) return model;
    }
    return undefined;
  } catch { return undefined; }
  finally { await fd?.close(); }
}
