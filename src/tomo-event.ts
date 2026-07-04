/**
 * Unified envelope for harness-composed "system-ish" user-turn messages.
 *
 * Historically these used two ad-hoc conventions: a bare `System: ...` prefix
 * (heartbeat, cron, restart, context nudges) and a bracketed `[System: ...]`
 * inline note (summon/dismiss, audience switches, pending notes). Both were
 * easy for the model to fabricate and hard to grep. Every harness producer now
 * wraps its body in one XML envelope:
 *
 *   <tomo-event type="cron" name="daily-backup" ts="2026-07-04T09:30:00-07:00">
 *   Scheduled task "daily-backup" triggered. ...
 *   </tomo-event>
 *
 * The body content is unchanged from the legacy formats (minus the prefix).
 * Consumers should stay tolerant of BOTH formats: old transcripts persist and
 * are never migrated.
 */

export type TomoEventType =
  | "heartbeat"        // continuity tick (free-time beat)
  | "restart"          // daemon restarted with a recorded reason
  | "cron"             // scheduled task trigger (name = job name)
  | "lcm-rollup"       // LCM rollup-due nudge (name = "<level> <period>")
  | "context-nudge"    // context-usage housekeeping nudge (name = prune|daily|compact)
  | "summon"           // summoned into a group chat
  | "summon-reminder"  // per-turn reply-routing reminder on summoned-group messages
  | "summon-expired"   // summon lapsed from group inactivity
  | "dismiss"          // dismissed from a summoned group
  | "audience"         // audience switch/check on a dm session (name = switch|check)
  | "errors"           // recent harness errors surfaced as operational context
  | "direct-send"      // echo of an earlier direct send into this conversation
  | "delegate";        // compose-and-send request from another session

export interface TomoEventOptions {
  /** Optional discriminator, e.g. the cron job name. Omit when meaningless. */
  name?: string;
  /** Event time; defaults to now. */
  ts?: Date;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Body escaping: parts of the body are user-controlled (cron messages,
 * direct-send echoes, delegate requests), and parsing/stripping resolves the
 * envelope at the FIRST closing tag — so body text must never be able to
 * close the envelope early. Only the closing-tag sequence is neutralized;
 * everything else stays byte-identical so prompt readability is unaffected.
 *
 * The scheme is injective (round-trips exactly):
 *   1. every `&` that heads a chain resolving to the escaped closer
 *      (`&(amp;)*lt;/tomo-event>`) gains one more `&amp;` level, then
 *   2. every literal `</tomo-event>` becomes `&lt;/tomo-event>`.
 * After encoding, `&lt;/tomo-event>` can only mean an escaped closer, and the
 * encoded body never contains a literal closer. A fake OPENING tag in the
 * body is harmless: parseTomoEvent reads attributes from the envelope's own
 * opening tag (anchored at the start) and the fake open tag simply rides
 * along inside the body.
 */
function escapeBody(body: string): string {
  return body
    .replace(/&(?=(?:amp;)*lt;\/tomo-event>)/g, "&amp;")
    .replace(/<\/tomo-event>/g, "&lt;/tomo-event>");
}

function unescapeBody(body: string): string {
  return body
    .replace(/&lt;\/tomo-event>/g, "</tomo-event>")
    .replace(/&amp;(?=(?:amp;)*lt;\/tomo-event>)/g, "&");
}

/** ISO 8601 with the local UTC offset, e.g. "2026-07-04T09:15:02-07:00". */
export function isoTimestampWithOffset(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Format a harness event envelope. The single composer for ALL
 * harness-injected user-turn messages — producers must not hand-roll
 * `System:` / `[System: ...]` strings or `<tomo-event>` tags.
 *
 * Any literal `</tomo-event>` in the body is escaped (see escapeBody) so
 * user-controlled body text can never close the envelope early;
 * parseTomoEvent restores it exactly.
 */
export function formatTomoEvent(type: TomoEventType, body: string, opts: TomoEventOptions = {}): string {
  const name = opts.name !== undefined ? ` name="${escapeAttr(opts.name)}"` : "";
  const ts = isoTimestampWithOffset(opts.ts);
  return `<tomo-event type="${type}"${name} ts="${ts}">\n${escapeBody(body)}\n</tomo-event>`;
}

export interface ParsedTomoEvent {
  type: string;
  name?: string;
  ts?: string;
  body: string;
}

// One full envelope at the start of the text. Body spans lines; escapeBody
// guarantees an encoded body never contains a literal closing tag, so
// non-greedy up to the FIRST closing tag is always the envelope's own closer.
const LEADING_ENVELOPE_RE = /^<tomo-event\b([^>]*)>\n?([\s\S]*?)\n?<\/tomo-event>/;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    attrs.set(m[1], unescapeAttr(m[2]));
  }
  return attrs;
}

/**
 * Parse a `<tomo-event>` envelope at the start of `text`. Returns null when
 * the text doesn't begin with a complete envelope (including all legacy
 * `System:` / `[System: ...]` messages — use isHarnessEventText for the
 * tolerant dual-format check).
 */
export function parseTomoEvent(text: string): ParsedTomoEvent | null {
  const m = LEADING_ENVELOPE_RE.exec(text.trimStart());
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  const type = attrs.get("type");
  if (!type) return null;
  return {
    type,
    ...(attrs.has("name") ? { name: attrs.get("name") } : {}),
    ...(attrs.has("ts") ? { ts: attrs.get("ts") } : {}),
    body: unescapeBody(m[2]),
  };
}

/**
 * Strip complete `<tomo-event>...</tomo-event>` envelopes (plus trailing
 * whitespace) from the start of `text`, repeatedly. Used by transcript
 * classifiers that need to see whether any real conversational content
 * follows prepended harness notes.
 */
export function stripLeadingTomoEvents(text: string): string {
  let out = text;
  for (let prev = ""; out !== prev; ) {
    prev = out;
    out = out.replace(/^<tomo-event\b[^>]*>[\s\S]*?<\/tomo-event>\s*/, "");
  }
  return out;
}

/**
 * Tolerant dual-format check: does this text begin with a harness-composed
 * event, in either the new `<tomo-event>` envelope or one of the legacy
 * conventions (`System: ...` bare prefix, `[System: ...]` bracketed note)?
 * Old transcripts are never migrated, so readers must accept both.
 */
export function isHarnessEventText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<tomo-event") || t.startsWith("System:") || t.startsWith("[System:");
}
