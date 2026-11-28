import { posix } from "node:path";
import { scrubSecretValues } from "../redact.js";
import { redactText } from "./redact-command.js";
import type { ToolActivity, ToolOutcome } from "./protocol.js";
import { webSessionId } from "./owner.js";
import { extractAttachments } from "../agent/text-utils.js";

/**
 * Tomo's own tools (the in-process `tomo-internal` MCP server) as the web UI
 * shows them: an activity card or a one-line sentence instead of
 * `mcp__tomo-internal__task_spawn: {"title":…`.
 *
 * Two parsers, both pure and both server-side, so the browser never parses a
 * clipped JSON text or the tools' English sentences:
 * - `toolActivity` reads a call's RAW input (before the 4,000-character clip
 *   of the INPUT pane) and keeps only the fields a card shows, each clipped
 *   and scrubbed on its own. Picking fields by name is also what keeps the
 *   input redaction (which blanks any key that looks like `session`/`token`)
 *   from blanking a send target or a schedule's destination session.
 * - `toolOutcome` reads the result text the tool returned. The tests run the
 *   real tool handlers and feed their text through it, so a change of wording
 *   fails a test rather than quietly breaking a card.
 * Either returns undefined when it cannot read what it was given: the row
 * then falls back to the plain tool line. Nothing is ever hidden by a parse
 * failure.
 */

export const INTERNAL_TOOL_PREFIX = "mcp__tomo-internal__";
/** A card's one-line fields (titles, ids, paths). */
export const ACTIVITY_LINE_LIMIT = 200;
/** Each side of a memory_str_replace on its card. */
const MEMORY_SNIPPET = 80;
/**
 * A memory path for a card: shown as `line` gives it, and `altered` when that
 * is not the exact path the store resolved (whitespace collapsed, clipped,
 * scrubbed), so the card does not link a file that is not there.
 */
const altered = (p: { altered: boolean }) => (p.altered ? { pathAltered: true as const } : {});
const memoryPath = (value: unknown): { path: string; altered: boolean } | undefined => {
  const path = line(value);
  if (!path || typeof value !== "string") return undefined;
  // Exact and already in the form the store resolves it to (no "./", "..", "//", leading "/" or backslash): only then a link.
  const canonical = posix.normalize(path) === path && !path.startsWith("/") && !path.startsWith("./") && !path.includes("\\");
  return { path, altered: path !== value.trim() || !canonical };
};
/** A card's body text (a brief, a message). */
export const ACTIVITY_TEXT_LIMIT = 2_000;

/** The tool's own name (`task_spawn`) when `name` is one of Tomo's internal tools. */
export function internalToolName(name: string): string | undefined {
  return name.startsWith(INTERNAL_TOOL_PREFIX) ? name.slice(INTERNAL_TOOL_PREFIX.length) : undefined;
}

/** Scrubbed WHOLE, then clipped: a registered secret cut at the clip would no longer match the scrubber. */
const clean = (value: string, limit: number, oneLine = false) => {
  // Normalised only after the scrub too: a registered secret with a run of spaces in it would not match once collapsed.
  const raw = redactText(scrubSecretValues(value));
  const scrubbed = oneLine ? raw.replace(/\s+/g, " ").trim() : raw;
  return scrubbed.length > limit ? { text: scrubbed.slice(0, limit), truncated: true as const } : { text: scrubbed };
};
const line = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? clean(value, ACTIVITY_LINE_LIMIT, true).text || undefined : undefined;
const body = (value: unknown): { text: string; truncated?: true } | undefined =>
  typeof value === "string" && value.trim() ? clean(value.trim(), ACTIVITY_TEXT_LIMIT) : undefined;
const optional = <K extends string>(key: K, value: string | undefined) => (value ? { [key]: value } : {}) as Partial<Record<K, string>>;
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | undefined =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : undefined;

/**
 * A destination session key as the field carries it (`dm:owner`,
 * `telegram:-100…`, `imessage:any;+;chat…`): only that shape is kept. The
 * input pane blanks a field named `session`; this keeps the key so the card
 * can name the conversation, but nothing else a model might have put there.
 */
const sessionKey = (value: unknown): string | undefined => {
  const key = line(value);
  return key && /^(?:dm|telegram|imessage|web|task):[^\s]{1,150}$/.test(key) && scrubSecretValues(key) === key ? key : undefined;
};

/**
 * Where a send_message goes, as the page can name it: the owner (a `dm:` key,
 * or their name / "owner", which is how the tool takes them), or a
 * conversation by the id the page lists it under (WebSession.id).
 */
function destination(target: string): { toOwner: true } | { targetId: string } | Record<string, never> {
  if (target.startsWith("dm:") || !target.includes(":")) return { toOwner: true };
  return /^[a-z]+:\S+$/.test(target) ? { targetId: webSessionId(target) } : {};
}


/** What a call to one of Tomo's internal tools asked for, or undefined (not internal, unknown, or unreadable). */
export function toolActivity(name: string, input: Record<string, unknown>): ToolActivity | undefined {
  const tool = internalToolName(name);
  if (!tool) return undefined;
  switch (tool) {
    case "task_spawn": {
      const title = line(input.title);
      const brief = body(input.brief);
      if (!title || !brief) return undefined;
      return { kind: tool, title, brief: brief.text, ...(brief.truncated ? { briefTruncated: true } : {}), ...optional("model", line(input.model)),
        ...(Array.isArray(input.quote) && input.quote.length ? { quoted: true } : {}) };
    }
    case "task_message": {
      const id = line(input.id); const text = body(input.text);
      if (!id || !text) return undefined;
      return { kind: tool, id, text: text.text, ...(text.truncated ? { textTruncated: true } : {}), ...(input.attach_owner_message === true ? { withOwner: true } : {}) };
    }
    case "task_cancel": case "task_done": {
      const id = line(input.id);
      return id ? { kind: tool, id, ...optional("reason", line(input.reason)) } : undefined;
    }
    case "task_status": return { kind: tool, ...optional("id", line(input.id)) };
    case "send_message": {
      const target = line(input.target);
      if (!target || typeof input.message !== "string") return undefined;
      // A direct send: the same tags delivery strips (proactive-send), MEDIA anywhere in a line, quoted or not, and STICKER.
      // A delegated one goes to the other session verbatim, so its text is shown as it was asked.
      const direct = input.mode === "direct";
      const { cleanText, mediaPaths, stickerIds } = direct ? extractAttachments(input.message) : { cleanText: input.message, mediaPaths: [], stickerIds: [] };
      const media = mediaPaths.map((path) => path.split(/[\\/]/).pop() ?? "").filter(Boolean);
      const said = body(cleanText);
      return { kind: tool, target, ...destination(target), mode: direct ? "direct" : "delegate", text: said?.text ?? "", ...(said?.truncated ? { textTruncated: true } : {}),
        chars: input.message.length, ...(media.length ? { media: media.slice(0, 10).map((m) => clean(m, ACTIVITY_LINE_LIMIT).text) } : {}),
        ...(stickerIds.length ? { stickers: stickerIds.length } : {}),
        ...optional("replyTo", line(input.reply_to)), ...optional("effect", line(input.effect)) };
    }
    case "react_to_message": {
      const target = line(input.target); const reaction = line(input.reaction);
      return target && reaction ? { kind: tool, target, reaction, ...(input.remove === true ? { remove: true } : {}) } : undefined;
    }
    case "edit_message": case "unsend_message": {
      const target = line(input.target);
      return target ? { kind: tool, target } : undefined;
    }
    case "rename_group_chat": {
      const target = line(input.target); const title = line(input.title);
      return target && title ? { kind: tool, target, title } : undefined;
    }
    case "list_sessions": case "schedule_list": case "home_check": case "list_people": case "pet_status":
      return { kind: tool };
    case "todo_add": {
      const title = line(input.title); const next = line(input.next); const waitingOn = oneOf(input.waiting_on, ["me", "owner", "external"] as const);
      if (!title || !next || !waitingOn) return undefined;
      return { kind: tool, title, next, waitingOn, ...optional("reviewIn", line(input.review_in)), ...optional("ref", line(input.ref)) };
    }
    case "todo_resolve": {
      const id = line(input.id); const action = oneOf(input.action, ["done", "drop", "snooze", "handoff"] as const);
      if (!id || !action) return undefined;
      return { kind: tool, id, action, ...optional("until", line(input.until)), ...optional("reason", line(input.reason)),
        ...optional("evidence", line(input.evidence)), ...optional("next", line(input.next)) };
    }
    case "todo_list": return { kind: tool, filter: oneOf(input.filter, ["due", "mine", "owner", "all"] as const) ?? "all" };
    case "schedule_create": {
      const name = line(input.name); const schedule = line(input.schedule); const message = body(input.message);
      if (!name || !schedule || !message) return undefined;
      return { kind: tool, name, schedule, message: message.text, ...(message.truncated ? { messageTruncated: true } : {}),
        ...optional("session", sessionKey(input.session)), ...(sessionKey(input.session) ? { sessionId: webSessionId(sessionKey(input.session)!) } : {}),
        ...(input.once === true ? { once: true } : {}) };
    }
    case "schedule_remove": {
      const id = line(input.id);
      return id ? { kind: tool, id } : undefined;
    }
    case "schedule_enable": {
      const id = line(input.id);
      return id ? { kind: tool, id, enabled: input.enabled !== false } : undefined;
    }
    case "request_permission": {
      const path = line(input.path); const access = oneOf(input.access, ["read", "write"] as const); const reason = line(input.reason);
      return path && access && reason ? { kind: tool, path, access, reason } : undefined;
    }
    case "request_credential": {
      const credential = line(input.name); const purpose = line(input.purpose);
      return credential && purpose ? { kind: tool, name: credential, purpose } : undefined;
    }
    case "pet_feed": return { kind: tool, ...(input.treat === true ? { treat: true } : {}) };
    case "pet_play": return { kind: tool, ...optional("activity", line(input.activity)) };
    case "pet_sleep": {
      const action = oneOf(input.action, ["sleep", "wake"] as const);
      return action ? { kind: tool, action } : undefined;
    }
    case "pet_hatch": {
      const pet = line(input.name);
      return pet ? { kind: tool, name: pet } : undefined;
    }
    case "recall_conversation": {
      const queries = [...(Array.isArray(input.queries) ? input.queries : []), input.query].flatMap((q) => line(q) ?? []);
      return { kind: tool, ...(queries.length ? { query: queries[0], ...(queries.length > 1 ? { more: queries.length - 1 } : {}) } : {}) };
    }
    case "lcm_rollup": {
      const level = oneOf(input.level, ["daily", "weekly", "monthly", "yearly"] as const);
      return level ? { kind: tool, level, ...optional("period", line(input.period)) } : undefined;
    }
    case "upsert_person": {
      const person = line(input.name);
      return person ? { kind: tool, name: person } : undefined;
    }
    case "memory_write": {
      const p = memoryPath(input.path);
      return p && typeof input.content === "string" ? { kind: tool, path: p.path, ...altered(p), ...(input.if_version === "new" ? { created: true } : {}), chars: input.content.length } : undefined;
    }
    case "memory_str_replace": {
      const p = memoryPath(input.path);
      if (!p || typeof input.old !== "string" || typeof input.new !== "string") return undefined;
      return { kind: tool, path: p.path, ...altered(p), old: clean(input.old, MEMORY_SNIPPET, true).text, new: clean(input.new, MEMORY_SNIPPET, true).text };
    }
    case "memory_append": {
      const p = memoryPath(input.path);
      if (!p || typeof input.content !== "string") return undefined;
      return { kind: tool, path: p.path, ...altered(p), lines: input.content.replace(/\n+$/, "").split("\n").length };
    }
    case "memory_move": {
      const from = memoryPath(input.from); const to = memoryPath(input.to);
      return from && to ? { kind: tool, from: from.path, to: to.path, ...altered(to) } : undefined;
    }
    case "memory_delete": case "memory_read": {
      const p = memoryPath(input.path);
      return p ? { kind: tool, path: p.path, ...altered(p) } : undefined;
    }
    case "memory_list": return { kind: tool, ...optional("prefix", line(input.prefix)) };
    case "memory_search": {
      const query = line(input.query);
      return query ? { kind: tool, query } : undefined;
    }
    default: return undefined;
  }
}

/** A failed call's reason, without the `<tool> failed: ` prefix every internal tool puts on its errors. */
export function failureReason(name: string, output: string): string | undefined {
  const tool = internalToolName(name);
  if (!tool) return undefined;
  const text = output.trim().replace(new RegExp(`^${tool}(?: failed)?: `), "");
  // A refusal some tools return as JSON (request_permission: {status: "denied", reason}): its reason.
  const reason = json(text)?.reason;
  if (typeof reason === "string" && reason.trim()) return clean(reason.trim().split("\n")[0], ACTIVITY_LINE_LIMIT).text;
  return text ? clean(text.split("\n")[0], ACTIVITY_LINE_LIMIT).text : undefined;
}

const json = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
};
const jsonArray = (text: string): unknown[] | undefined => {
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value : undefined; } catch { return undefined; }
};
const TASK_ID = "s[1-9]\\d{0,8}";
const TODO_ID = "t-\\d+";
/**
 * A to-do's line as todo_add / todo_resolve print it (src/todos/format.ts, the
 * English catalog): `t-41 Title · next: … · waiting on owner · review Nov 17 · snoozed 1/3 · ref`.
 * `title` is everything before the last "waiting on" part, as printed: the
 * title and, when it has a different one, its next step. A title can itself
 * hold " · next: ", so splitting the two would sometimes name the wrong to-do;
 * the printed words never do. A line in another shape gives nothing.
 */
const TODO_LINE = new RegExp(`^${TODO_ID} (.+) · waiting on (?:me|owner|external) · (due|review) ([^·]+?)(?: · snoozed (\\d+)(?:/(\\d+))?)?(?: · .*)?$`);
function todoLine(line: string): Partial<ToolOutcome> {
  const m = TODO_LINE.exec(line);
  if (!m) return {};
  return { title: clean(m[1], ACTIVITY_LINE_LIMIT).text, review: clean(m[3], 40).text, ...(m[2] === "due" ? { due: true } : {}),
    ...(m[4] ? { snoozes: Number(m[4]) } : {}), ...(m[5] ? { maxSnoozes: Number(m[5]) } : {}) };
}
/** A job's schedule as the page words it: one date (`firesOnce`), an interval (`everyMs`), or a cron expression (`cron`, `tz`) shown as written. */
function scheduleParts(schedule: unknown): Partial<ToolOutcome> {
  if (!schedule || typeof schedule !== "object") return {};
  const s = schedule as Record<string, unknown>;
  // A date: it fires once, whatever its lifecycle (a "recurring" one is only kept, disabled, after it ran).
  if (s.kind === "at") return { firesOnce: true };
  if (s.kind === "every" && typeof s.everyMs === "number" && s.everyMs > 0) return { everyMs: s.everyMs };
  if (s.kind === "cron" && typeof s.expr === "string") return { cron: clean(s.expr, 80).text, ...(typeof s.tz === "string" ? { tz: clean(s.tz, 60).text } : {}) };
  return {};
}
const count = (n: number): ToolOutcome => ({ count: n });

/**
 * What a successful call's result says happened, or undefined when the text
 * is not in a shape this knows (an older or newer wording). `noop`: the tool
 * returned normally but nothing happened (a note held for the owner's word, a
 * job not found, a pet asleep); its value is the tool's own sentence.
 */
export function toolOutcome(name: string, output: string): ToolOutcome | undefined {
  const tool = internalToolName(name);
  if (!tool) return undefined;
  const text = output.trim();
  const first = text.split("\n")[0];
  const noop = (): ToolOutcome => ({ noop: clean(first, ACTIVITY_LINE_LIMIT).text });
  let m: RegExpExecArray | null;
  switch (tool) {
    case "task_spawn":
      return ((m = new RegExp(`^Started (${TASK_ID}) \\((\\w+)\\)\\.`).exec(text))) ? { id: m[1], status: m[2] } : undefined;
    case "task_message":
      if (new RegExp(`^Passed to ${TASK_ID}`).test(text)) return { delivery: "passed" };
      if (new RegExp(`^${TASK_ID} is queued;`).test(text)) return { delivery: "queued" };
      if (new RegExp(`^Lifted ${TASK_ID}'s pause`).test(text)) return { delivery: "released" };
      if (new RegExp(`^${TASK_ID} (still waits for the owner's answer|waits for the owner's own word)`).test(text)) return { delivery: "held", ...noop() };
      return undefined;
    case "task_cancel":
      if (new RegExp(`^Cancelled ${TASK_ID}\\.`).test(text)) return {};
      return new RegExp(`^${TASK_ID} was already cancelled\\.`).test(text) ? noop() : undefined;
    case "task_done":
      return new RegExp(`^${TASK_ID} no longer needs the owner\\.`).test(text) ? {} : undefined;
    case "task_status":
      if (text === "No sub-sessions.") return count(0);
      if (((m = new RegExp(`^${TASK_ID}: .*\\nStatus: ([^\\n—]+)`).exec(text)))) return { status: m[1].trim() };
      return text.split("\n").every((l) => new RegExp(`^${TASK_ID} \\[`).test(l)) ? count(text.split("\n").length) : undefined;
    case "send_message":
      if (((m = /^OK \((direct|delegate)\)\.(?: (.+))?$/s.exec(text)))) return m[2] ? { note: clean(m[2].replace(/\s+/g, " "), ACTIVITY_LINE_LIMIT).text } : {};
      return undefined;
    case "react_to_message": case "edit_message": case "unsend_message": case "rename_group_chat":
      return /^OK\./.test(text) ? {} : undefined;
    case "todo_add":
      return ((m = new RegExp(`^Added (${TODO_ID}) `).exec(text))) ? { id: m[1], ...todoLine(first.slice("Added ".length)) } : undefined;
    case "todo_resolve":
      return ((m = new RegExp(`^(Done|Dropped|Snoozed|Handed to the owner): (${TODO_ID}) `).exec(text))) ? { id: m[2], ...todoLine(first.slice(m[1].length + 2)) } : undefined;
    case "todo_list":
      if (/^No (?:open|due|mine|owner) todos\.$/.test(text)) return count(0);
      return text.split("\n").every((l) => new RegExp(`^${TODO_ID} `).test(l)) ? count(text.split("\n").length) : undefined;
    case "schedule_create": case "schedule_enable": {
      if (/^Job \S+ not found\.$/.test(text)) return noop();
      const job = json(text);
      if (!job || typeof job.id !== "string") return undefined;
      const next = typeof job.nextRunAt === "string" ? Date.parse(job.nextRunAt) : NaN;
      const label = scheduleParts(job.schedule);
      return { id: job.id, ...(job.lifecycle === "once" || job.lifecycle === "recurring" ? { lifecycle: job.lifecycle } : {}), ...label,
        ...(Number.isFinite(next) ? { nextRunAt: next } : {}), ...(typeof job.enabled === "boolean" ? { enabled: job.enabled } : {}) };
    }
    case "schedule_remove":
      if (/^Removed job \S+\.$/.test(text)) return {};
      return /^Job \S+ not found\.$/.test(text) ? noop() : undefined;
    case "schedule_list": case "list_people": {
      // schedule_list may add a line after its JSON (how many jobs belong to other sessions).
      const list = jsonArray(text.slice(0, text.lastIndexOf("]") + 1));
      return list ? count(list.length) : undefined;
    }
    case "request_permission": case "request_credential": {
      const result = json(text);
      const status = result?.status;
      if (typeof status !== "string") return undefined;
      return { status: clean(status, 40).text, ...(tool === "request_credential" && typeof result?.asked_on === "string" ? { channel: clean(result.asked_on, 40).text } : {}) };
    }
    case "recall_conversation":
      if (((m = /^(\d+) message\(s\), oldest first/.exec(text)))) return count(Number(m[1]));
      if (/^No messages searched:/.test(text)) return noop();
      return /^No (?:matching messages found|messages in that time range)/.test(text) ? count(0) : undefined;
    case "lcm_rollup": {
      const result = json(text);
      if (!result || typeof result.status !== "string") return undefined;
      if (result.status !== "ok") return { status: clean(result.status, 40).text, ...noop() };
      return { status: "ok", ...(typeof result.eventsRemoved === "number" ? { count: result.eventsRemoved } : {}) };
    }
    case "home_check":
      if (((m = /^home_check: .*: (?:no problems|(\d+) problems?)/.exec(text)))) return count(m[1] ? Number(m[1]) : 0);
      return undefined;
    case "upsert_person":
      return ((m = /^(Created|Updated) person record:/.exec(text))) ? { status: m[1].toLowerCase() } : undefined;
    // src/memory/store.ts: "Saved <path> (version v)." and, after it, a note (a file over its budget).
    case "memory_write": case "memory_str_replace": case "memory_append":
      if (!((m = /^Saved \S.* \(version [^)\s]+\)\.(?: ([\s\S]+))?$/.exec(text)))) return undefined;
      return m[1] ? { note: clean(m[1].replace(/\s+/g, " ").trim(), ACTIVITY_LINE_LIMIT).text } : {};
    case "memory_move": return /^Moved \S.* to \S.* \(version [^)\s]+\)\.$/.test(text) ? {} : undefined;
    case "memory_delete": return /^Deleted \S.*\. Its content is kept for /.test(text) ? {} : undefined;
    case "memory_read":
      // The lines it returned: the whole file's, or the range's.
      if (((m = /^\S.* \(version [^,)\s]+(?:, (\d+) lines\)|\), lines (\d+)–(\d+) of \d+)/.exec(first)))) return count(m[1] ? Number(m[1]) : Number(m[3]) - Number(m[2]) + 1);
      return /^\S.* \(version [^)\s]+\) has \d+ lines; offset \d+ is past the end\.$/.test(text) ? count(0) : undefined;
    case "memory_list": {
      const lines = text.split("\n");
      if (/^\((?:no memory files under .+|no topic files yet)\)$/.test(lines[0])) return count(0);
      const files = lines.filter((l) => l.startsWith("- "));
      return files.length && lines.every((l) => l.startsWith("- ") || /^\(.+\)$/.test(l)) ? count(files.length) : undefined;
    }
    case "memory_search": {
      if (/^No match for /.test(text)) return count(0);
      const lines = text.split("\n");
      const hits = lines.filter((l) => /^\S.*:\d+: /.test(l));
      return hits.length && lines.every((l) => /^\S.*:\d+: /.test(l) || /^\((?:stopped at|showing the best) /.test(l)) ? count(hits.length) : undefined;
    }
    case "list_sessions":
      return json(text) ? {} : undefined;
    case "pet_status": case "pet_feed": case "pet_play": case "pet_sleep": case "pet_hatch": {
      const state = json(text);
      // Fed while full: it ignored the food (the diary line says so).
      if (state?.event === "too full") return { noop: clean(typeof state.diary === "string" ? state.diary : "too full", ACTIVITY_LINE_LIMIT).text };
      if (state) {
        const mood = typeof state.mood === "string" ? state.mood : undefined;
        return mood ? { status: clean(mood, 40).text } : {};
      }
      if (/ appeared as an egg\./.test(text) || / is sleeping until /.test(text)) return {};
      return noop();
    }
    default: return undefined;
  }
}
