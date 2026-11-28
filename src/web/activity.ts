import { scrubSecretValues } from "../redact.js";
import { redactText } from "./redact-command.js";
import type { ToolActivity, ToolOutcome } from "./protocol.js";

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

/** A `MEDIA:/path` line's file name (never the path: the card shows a chip). */
const MEDIA_LINE = /^MEDIA:\s*(\S.*)$/;

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
      const lines = input.message.split("\n");
      const media = lines.flatMap((l) => { const m = MEDIA_LINE.exec(l.trim()); return m ? [m[1].trim().split(/[\\/]/).pop() ?? ""] : []; }).filter(Boolean);
      const said = body(lines.filter((l) => !MEDIA_LINE.test(l.trim())).join("\n"));
      return { kind: tool, target, mode: input.mode === "direct" ? "direct" : "delegate", text: said?.text ?? "", ...(said?.truncated ? { textTruncated: true } : {}),
        chars: input.message.length, ...(media.length ? { media: media.slice(0, 10).map((m) => clean(m, ACTIVITY_LINE_LIMIT).text) } : {}),
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
        ...optional("session", line(input.session)), ...(input.once === true ? { once: true } : {}) };
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
    default: return undefined;
  }
}

/** A failed call's reason, without the `<tool> failed: ` prefix every internal tool puts on its errors. */
export function failureReason(name: string, output: string): string | undefined {
  const tool = internalToolName(name);
  if (!tool) return undefined;
  const text = output.trim().replace(new RegExp(`^${tool}(?: failed)?: `), "");
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
      return ((m = new RegExp(`^Added (${TODO_ID}) `).exec(text))) ? { id: m[1] } : undefined;
    case "todo_resolve":
      return ((m = new RegExp(`^(?:Done|Dropped|Snoozed|Handed to the owner): (${TODO_ID}) `).exec(text))) ? { id: m[1] } : undefined;
    case "todo_list":
      if (/^No (?:open|due|mine|owner) todos\.$/.test(text)) return count(0);
      return text.split("\n").every((l) => new RegExp(`^${TODO_ID} `).test(l)) ? count(text.split("\n").length) : undefined;
    case "schedule_create": case "schedule_enable": {
      if (/^Job \S+ not found\.$/.test(text)) return noop();
      const job = json(text);
      if (!job || typeof job.id !== "string") return undefined;
      const next = typeof job.nextRunAt === "string" ? Date.parse(job.nextRunAt) : NaN;
      return { id: job.id, ...(job.lifecycle === "once" || job.lifecycle === "recurring" ? { lifecycle: job.lifecycle } : {}),
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
      const status = json(text)?.status;
      return typeof status === "string" ? { status: clean(status, 40).text } : undefined;
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
