import { join } from "node:path";

/**
 * EVERYTHING the web views know about the Claude Agent SDK's on-disk
 * transcript format lives in this module: where the files are, which JSONL
 * records are conversation messages, where their content blocks sit, and
 * what a queued message looks like. The readers (subagent-reader.ts,
 * session-tools.ts) see only the normalised `Entry` below.
 *
 * Why not the SDK's own readers (`getSessionMessages`, `getSubagentMessages`,
 * `listSubagents`)? As of 0.3.325 each call reads the WHOLE file
 * (`readFile`; a main transcript over 5 MiB from its last compact boundary
 * on), parses every line and rebuilds the parentUuid chain before it
 * applies `limit`/`offset` as an array slice; it has no byte cursor, so the
 * 2-second live tail would re-read a multi-megabyte transcript every poll and
 * "load earlier" would re-read it per page. Its `dir` is a project working
 * directory resolved against `CLAUDE_CONFIG_DIR`, not the sessions directory
 * the daemon hands the web process, and its messages carry no byte offset to
 * key a stable item id on. `listSubagents` returns ids, not paths, from an
 * unbounded recursive walk. So the bounded byte-window reader stays, and the
 * format it depends on is pinned instead: tests/web-sdk-transcript-agreement
 * runs the SDK's readers and ours over the same files and fails when they
 * stop agreeing (an SDK upgrade that changes the format fails a test instead
 * of emptying the view), and a record the parser does not recognise is
 * COUNTED (`problems`), surfaced in the view and logged once per file —
 * never silently dropped.
 *
 * The content blocks themselves (text / thinking / tool_use / tool_result /
 * image) are the Anthropic Messages API's public shapes, which the SDK
 * stores verbatim (`SessionMessage.message`). The few TOOL formats the views
 * read more closely live here too: TodoWrite's input (the todo list),
 * WebFetch's `url`, and the links a WebSearch result lists.
 */

/** An SDK session id as it names a transcript file (`<id>.jsonl`). */
export const SDK_SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;
/** A local_agent's task id, which is its agentId. */
export const SUBAGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `<sdkSessionsDir>/<sdkSessionId>.jsonl`, or undefined for an id that is not one. */
export function sessionTranscriptFile(sdkSessionsDir: string, sdkSessionId: string): string | undefined {
  return SDK_SESSION_ID.test(sdkSessionId) ? join(sdkSessionsDir, `${sdkSessionId}.jsonl`) : undefined;
}

/** `<sdkSessionsDir>/<sdkSessionId>/subagents/agent-<taskId>.jsonl` (the layout `listSubagents` documents). */
export function subagentTranscriptFile(sdkSessionsDir: string, sdkSessionId: string, taskId: string): string | undefined {
  if (!SDK_SESSION_ID.test(sdkSessionId) || !SUBAGENT_ID.test(taskId)) return undefined;
  return join(sdkSessionsDir, sdkSessionId, "subagents", `agent-${taskId}.jsonl`);
}

/** The sidecar written when a subagent is spawned (`agent-<id>.meta.json`). */
export function subagentMetaFile(transcriptFile: string): string {
  return transcriptFile.replace(/\.jsonl$/, ".meta.json");
}

/** The model a subagent's meta.json names: `pickedEffortModel` (the resolved id), else `model`. */
export function metaModels(raw: string): unknown[] {
  const meta = JSON.parse(raw) as { pickedEffortModel?: unknown; model?: unknown } | null;
  const model = meta?.model;
  const picked = meta?.pickedEffortModel;
  // A spawn-time override is an alias ("fable", "opus"). `pickedEffortModel` is
  // not always the id that alias resolved to: a "fable" subagent spawned from an
  // Opus session wrote `pickedEffortModel: "claude-opus-5-5"` and ran on
  // claude-fable-5-2. Trust it only when it is of the alias's family; otherwise
  // say nothing, so the transcript's own model is read.
  if (typeof model === "string" && !model.startsWith("claude-") && model !== "inherit") {
    if (typeof picked === "string") return picked.includes(model) ? [picked] : [];
    return [model];
  }
  return [picked, model];
}

/** One part of a tool result's content. Images are counted, never carried. `link`: a `search_result` block's page. */
export type ResultPart = { type: "text"; text: string } | { type: "image" } | { type: "other"; name: string; link?: WebLink };

/**
 * One content block, in its original position (so an item id `<offset>:<index>`
 * stays the index the SDK wrote). `skip`: a known block the views do not show
 * (server-side tool blocks, documents…); `unreadable`: not a block we know.
 */
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; isError: boolean; parts: ResultPart[] }
  | { type: "image" }
  | { type: "skip" }
  | { type: "unreadable" };

export type Entry =
  /** A user or assistant record: its content is a string or blocks. */
  | { kind: "message"; role: "user" | "assistant"; ts?: number; sidechain: boolean; model?: string; content: string | Block[] }
  /** A message sent to a busy subagent, written first as a `queued_command` attachment. */
  | { kind: "queued"; ts?: number; prompt: string }
  /** Anything else (bookkeeping, attachments, API request blobs): never shown, and not a problem. */
  | { kind: "other" };

/** Why a line or block could not be read. Enumerated: these, never text from the file, cross the process boundary. */
export const PROBLEM_CODES = ["not_json", "no_type", "no_content", "bad_block", "unknown_block"] as const;
export type Problem = typeof PROBLEM_CODES[number];

/**
 * Block types the Messages API defines that the views deliberately do not
 * show. Anything outside this set and the shown ones is `unknown_block`.
 */
const SKIPPED_BLOCKS = new Set(["redacted_thinking", "document", "search_result", "container_upload", "tool_reference"]);
const isServerToolBlock = (type: string) => /^[a-z_]+_tool_(use|result)$/.test(type) || type === "server_tool_use";

/**
 * A complete JSONL line as an Entry, plus what in it could not be read.
 * Never throws. A line that is not JSON at all is `not_json` (a partial
 * line is never passed here: pages cut at the last newline).
 */
export function parseEntry(line: string): { entry: Entry; problems: Problem[] } {
  let record: unknown;
  try { record = JSON.parse(line); } catch { return { entry: { kind: "other" }, problems: ["not_json"] }; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return { entry: { kind: "other" }, problems: ["no_type"] };
  const r = record as { type?: unknown; timestamp?: unknown; isSidechain?: unknown; message?: unknown; attachment?: unknown };
  if (typeof r.type !== "string") return { entry: { kind: "other" }, problems: ["no_type"] };
  const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) || undefined : undefined;
  // A message sent while the subagent was busy is first written as a
  // `queued_command` attachment; the SDK later folds it into the next API
  // request (an `api-request-blob` entry, the API's own copy — never shown,
  // so it is not shown twice).
  if (r.type === "attachment") {
    const attachment = r.attachment as { type?: unknown; prompt?: unknown } | undefined;
    if (attachment?.type !== "queued_command" || typeof attachment.prompt !== "string" || !attachment.prompt.trim()) return { entry: { kind: "other" }, problems: [] };
    return { entry: { kind: "queued", prompt: attachment.prompt, ...(ts ? { ts } : {}) }, problems: [] };
  }
  if (r.type !== "user" && r.type !== "assistant") return { entry: { kind: "other" }, problems: [] };
  const message = r.message as { content?: unknown; model?: unknown } | undefined;
  const content = message && typeof message === "object" ? message.content : undefined;
  const role: "user" | "assistant" = r.type;
  const base = { kind: "message" as const, role, sidechain: r.isSidechain === true, ...(ts ? { ts } : {}),
    ...(typeof message?.model === "string" ? { model: message.model } : {}) };
  if (typeof content === "string") return { entry: { ...base, content }, problems: [] };
  if (!Array.isArray(content)) return { entry: { ...base, content: [] }, problems: ["no_content"] };
  const problems: Problem[] = [];
  const blocks = content.map((block): Block => {
    const parsed = parseBlock(block);
    if (parsed.type === "unreadable") problems.push(block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string" && !KNOWN_BLOCKS.has((block as { type: string }).type)
      ? "unknown_block" : "bad_block");
    return parsed;
  });
  return { entry: { ...base, content: blocks }, problems };
}

const KNOWN_BLOCKS = new Set(["text", "thinking", "tool_use", "tool_result", "image"]);

function parseBlock(block: unknown): Block {
  if (!block || typeof block !== "object") return { type: "unreadable" };
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text": return typeof b.text === "string" ? { type: "text", text: b.text } : { type: "unreadable" };
    case "thinking": return typeof b.thinking === "string" ? { type: "thinking", text: b.thinking } : { type: "unreadable" };
    case "image": return { type: "image" };
    case "tool_use":
      if (typeof b.name !== "string") return { type: "unreadable" };
      return { type: "tool_use", name: b.name, input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
        ...(typeof b.id === "string" ? { id: b.id } : {}) };
    case "tool_result": {
      if (typeof b.tool_use_id !== "string") return { type: "unreadable" };
      const parts = resultParts(b.content);
      return parts ? { type: "tool_result", toolUseId: b.tool_use_id, isError: b.is_error === true, parts } : { type: "unreadable" };
    }
    default:
      if (typeof b.type === "string" && (SKIPPED_BLOCKS.has(b.type) || isServerToolBlock(b.type))) return { type: "skip" };
      return { type: "unreadable" };
  }
}

/** A tool result's content: a string, or blocks (text, images, anything else named by its type). Absent is empty. */
function resultParts(content: unknown): ResultPart[] | undefined {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((part): ResultPart[] => {
    if (!part || typeof part !== "object") return [];
    const p = part as { type?: unknown; text?: unknown; source?: unknown; title?: unknown };
    if (typeof p.text === "string") return [{ type: "text", text: p.text }];
    if (p.type === "image") return [{ type: "image" }];
    if (typeof p.type !== "string") return [];
    // WebSearch with citations on returns its hits as search_result blocks (`source`: the page's URL).
    const link = p.type === "search_result" ? webLink(p.source, p.title) : undefined;
    return [{ type: "other", name: p.type.slice(0, 64), ...(link ? { link } : {}) }];
  });
}

// ---- Tool calls the views show as more than a call ----

/** A page link as the transcript names it: http(s) only (the markdown renderer's own rule), at most MAX_URL_CHARS. */
export interface WebLink { url: string; title?: string }
export const MAX_URL_CHARS = 2_048;
/** Links read from one WebSearch result; the rest are left out. */
export const MAX_RESULT_LINKS = 20;
/** How much of one result's text is searched for its links (the commentary after them is not). */
export const LINK_SCAN_CHARS = 256 * 1024;

function webLink(url: unknown, title?: unknown): WebLink | undefined {
  if (typeof url !== "string" || url.length > MAX_URL_CHARS || !/^https?:\/\//.test(url)) return undefined;
  try { new URL(url); } catch { return undefined; }
  const named = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return { url, ...(named && named !== url ? { title: named } : {}) };
}

/** The page a WebFetch call reads (its `url` input). */
export function fetchedPage(name: string, input: Record<string, unknown>): WebLink | undefined {
  return name === "WebFetch" ? webLink(input.url) : undefined;
}

/**
 * The links a WebSearch result lists. Claude Code writes the result as text:
 * `Web search results for query: "…"`, then for each search a line
 * `Links: [{"title":…,"url":…},…]` (JSON), then the model's commentary.
 * With citations on, the hits are `search_result` blocks instead. Any other
 * text (another tool's output that happens to say "Links:") yields nothing.
 */
export function searchResultLinks(parts: readonly ResultPart[]): WebLink[] {
  const links: WebLink[] = [];
  for (const part of parts) {
    if (links.length >= MAX_RESULT_LINKS) break;
    if (part.type === "other" && part.link) links.push(part.link);
    if (part.type !== "text" || !part.text.startsWith("Web search results for query:")) continue;
    for (const line of part.text.slice(0, LINK_SCAN_CHARS).split("\n")) {
      if (links.length >= MAX_RESULT_LINKS) break;
      if (!line.startsWith("Links: [")) continue;
      let hits: unknown;
      try { hits = JSON.parse(line.slice("Links: ".length)); } catch { continue; }
      if (!Array.isArray(hits)) continue;
      for (const hit of hits) {
        const link = hit && typeof hit === "object" ? webLink((hit as { url?: unknown }).url, (hit as { title?: unknown }).title) : undefined;
        if (link) links.push(link);
        if (links.length >= MAX_RESULT_LINKS) break;
      }
    }
  }
  return links;
}

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export interface Todo { content: string; status: typeof TODO_STATUSES[number]; activeForm?: string }

/**
 * A TodoWrite call's list (`{ todos: [{ content, status, activeForm }] }`,
 * the SDK's TodoWriteInput), or undefined when the input is not that shape:
 * such a call is then shown as an ordinary one, never dropped.
 */
export function todoList(name: string, input: Record<string, unknown>): Todo[] | undefined {
  if (name !== "TodoWrite" || !Array.isArray(input.todos)) return undefined;
  const todos: Todo[] = [];
  for (const raw of input.todos as unknown[]) {
    if (!raw || typeof raw !== "object") return undefined;
    const { content, status, activeForm } = raw as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof content !== "string" || !(TODO_STATUSES as readonly unknown[]).includes(status)) return undefined;
    todos.push({ content, status: status as Todo["status"], ...(typeof activeForm === "string" && activeForm.trim() ? { activeForm } : {}) });
  }
  return todos;
}

/**
 * Cheap pre-filters for the main transcript scan (up to 16 MiB), so only the
 * lines that can hold a tool call or result are parsed. A format change that
 * defeats them is what the agreement test exists to catch.
 */
export function mayHoldToolBlocks(line: string): boolean {
  return line.includes('"tool_use"') || line.includes('"tool_result"') || line.includes(TASK_NOTIFICATION_OPEN);
}

// ---- Task notifications: a background task reporting back into the conversation ----

const TASK_NOTIFICATION_OPEN = "<task-notification>";
/** The names the two views give a task notification's synthetic call (see subagent-reader.ts). */
export const SUBAGENT_MESSAGE_TOOL = "SubagentMessage";
export const BACKGROUND_TASK_TOOL = "BackgroundTask";
export interface TaskNotice {
  /** True when the task was a subagent (its report is a message from it); false for a shell or other background task. */
  subagent: boolean;
  /** The subagent's description, or the notification's own summary line. */
  name: string;
  /** completed | failed | stopped | …, when given. */
  status?: string;
  /** The report it handed back; may be empty. */
  text: string;
}
/**
 * A user-role entry the CLI wrote itself when a background task ended: an
 * XML-ish envelope (`<task-notification>` with `<status>`, `<summary>`,
 * `<result>` …), not something a person typed. `Agent "<description>"
 * finished` in the summary marks a subagent. Undefined for any other text.
 */
export function taskNotice(text: string): TaskNotice | undefined {
  const body = text.trimStart();
  if (!body.startsWith(TASK_NOTIFICATION_OPEN)) return undefined;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();
  const summary = (tag("summary") ?? "").replace(/\s+/g, " ");
  const agent = /^Agent\s+"([^"]{1,300})"/.exec(summary)?.[1];
  const status = tag("status");
  // An envelope with no inner tags carries its text directly.
  const bare = body.slice(TASK_NOTIFICATION_OPEN.length).replace(/<\/task-notification>\s*$/, "").trim();
  const result = tag("result") ?? (/<[a-z-]+>/.test(bare) ? "" : bare);
  return { subagent: agent !== undefined, name: (agent ?? summary) || "Background task", ...(status ? { status } : {}), text: result };
}
export function isSidechainLine(line: string): boolean { return line.includes('"isSidechain":true'); }
/** A line that may be an assistant record (the model lookup reads only those). */
export function mayBeAssistant(line: string): boolean { return line.includes('"assistant"'); }

// ---- Reporting ----

/** What crosses from the web process to the daemon log: enumerated fields only, never a path or file text. */
export interface UnreadableReport { view: "subagent" | "session"; count: number; problems: Problem[] }
let reporter: ((report: UnreadableReport) => void) | undefined;
const reported = new Set<string>();
const MAX_REPORTED_FILES = 1_024;

/** The web process sends these to the daemon (child.ts); unset, nothing is reported. */
export function setUnreadableReporter(fn: ((report: UnreadableReport) => void) | undefined): void { reporter = fn; }

/**
 * Report a file's unreadable entries (`count` lines, for these reasons) ONCE
 * per file for the life of the process; later reads of it stay quiet.
 */
export function reportUnreadable(file: string, view: UnreadableReport["view"], count: number, problems: readonly Problem[]): void {
  if (count < 1 || reported.has(file)) return;
  if (reported.size >= MAX_REPORTED_FILES) reported.clear();
  reported.add(file);
  try { reporter?.({ view, count, problems: [...new Set(problems)].sort() }); } catch { /* reporting is best effort */ }
}

/** The daemon's log line for a report from the web process, or undefined when the message is not a valid one. */
export function describeUnreadable(value: Record<string, unknown>): string | undefined {
  const { view, count, problems } = value;
  if (view !== "subagent" && view !== "session") return undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 1) return undefined;
  if (!Array.isArray(problems) || !problems.every((p) => (PROBLEM_CODES as readonly unknown[]).includes(p))) return undefined;
  const where = view === "subagent" ? "A subagent transcript" : "A session transcript";
  return `${where} has ${count} entr${count === 1 ? "y" : "ies"} the web view could not read (${problems.join(", ")}); `
    + "the Claude Agent SDK's transcript format may have changed. The view says so; reported once per file.";
}
