/**
 * Placeholder the assistant emits when it wants a literal newline in an
 * outbound message. Outbound replies now ship as one message with their
 * newlines intact, so the token is redundant — but the model has been trained
 * to emit it, so it is still rewritten to a real newline and must never
 * reach a chat literally.
 */
const LITERAL_NEWLINE_TOKEN_RE = /\[\[NL\]\](?:[ \t]*(?:\r\n|\r|\n))?/g;

export function restoreLiteralNewlines(text: string): string {
  return text.replace(LITERAL_NEWLINE_TOKEN_RE, "\n");
}

/**
 * Marker prepended to inbound satellite (Apple emergency low-bandwidth relay)
 * messages so the model knows the sender is off-grid: keep replies short,
 * text-only, and don't expect or request photos.
 */
export const SATELLITE_MARKER = "[via satellite — sender off-grid, text-only, keep it short]";

/**
 * Apple reports satellite messages with the "iMessageLite" service rather than
 * "iMessage" (observed first via the BlueBubbles backend, removed 2026-08-27;
 * the imsg channel reads the same value out of chat.db). Match defensively on
 * any service containing "lite" so a future variant spelling still gets
 * flagged.
 */
export function isSatelliteService(service: unknown): boolean {
  return typeof service === "string" && service.toLowerCase().includes("lite");
}

/** Longest excerpt (in code points) of the replied-to message quoted in the reply marker. */
export const REPLY_CONTEXT_EXCERPT_LIMIT = 60;

// Bracket/angle characters are swapped for fullwidth lookalikes inside the
// quoted excerpt so a crafted original can't forge privileged markers
// ("[via satellite …]", "<tomo-event …>") in the delivered prompt.
const MARKER_DELIMITERS_RE = /[[\]<>]/g;
const FULLWIDTH_DELIMITERS: Record<string, string> = { "[": "［", "]": "］", "<": "＜", ">": "＞" };

/**
 * Neutralise the delimiters that make a marker look like a marker.
 *
 * Any sender-controlled string that ends up *inside* one of our bracketed
 * markers has to go through this: `[`, `]`, `<` and `>` become fullwidth
 * lookalikes, so the text still reads correctly to a human but can no longer
 * close our bracket and open a forged one ("[via satellite …]",
 * "<tomo-event …>"). Newlines and other control characters collapse to a
 * single space for the same reason — a marker is one line by construction,
 * and a second line is exactly what a forged marker needs.
 *
 * Shared by {@link formatReplyContextMarker} (quoted reply excerpts) and the
 * inbound file notice in `fileStore.ts` (sender-supplied MIME types).
 */
export function neutralizeMarkerDelimiters(text: string): string {
  return text
    // C0/C1 control characters — newline included — collapse to one space.
    // The control class is the entire point here, so the rule is disabled
    // deliberately: a newline reaching a marker is the forgery being stopped.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(MARKER_DELIMITERS_RE, (c) => FULLWIDTH_DELIMITERS[c]);
}

/**
 * Marker prepended to inbound threaded replies (long-press → Reply) so the
 * model sees which earlier message the sender is responding to. Same visual
 * family as SATELLITE_MARKER. When the original text is unavailable the
 * marker degrades to a quote-less form — reply context is best-effort and
 * must never block delivery.
 */
export function formatReplyContextMarker(originalText?: string): string {
  const collapsed = originalText?.replace(/\s+/g, " ").trim();
  if (!collapsed) return "[replying to an earlier message]";
  const sanitized = neutralizeMarkerDelimiters(collapsed);
  // Truncate by code points, not UTF-16 units — never split a surrogate pair.
  const points = Array.from(sanitized);
  const excerpt = points.length > REPLY_CONTEXT_EXCERPT_LIMIT
    ? `${points.slice(0, REPLY_CONTEXT_EXCERPT_LIMIT).join("").trimEnd()}…`
    : sanitized;
  return `[replying to: "${excerpt}"]`;
}

/** Leading half of a UTF-16 surrogate pair; slicing after one splits a character. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Split text into chunks of at most `limit` characters, preferring to break
 * at a newline, then a space, falling back to a hard cut. Shared by channels
 * whose APIs cap message length (Telegram: 4096, iMessage: 4000).
 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline or space
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    // A hard cut at `limit` is an index into UTF-16 CODE UNITS, so it can land
    // between the two halves of an astral character (emoji, most CJK
    // extensions, mathematical alphanumerics) and leave a lone high surrogate
    // ending one chunk and a lone low surrogate opening the next. Telegram
    // rejects a lone surrogate in the request body with a 400 that is not a
    // Markdown-parse error, so telegram.ts rethrows and the whole reply is
    // lost; iMessage renders both halves as U+FFFD. Back off one unit — never
    // to 0, which would push an empty chunk and never shorten `remaining`.
    // The newline/space branches above cannot land mid-pair (their split
    // character is itself a single BMP unit), so this only ever bites the
    // fallback.
    if (splitAt > 1 && isHighSurrogate(remaining.charCodeAt(splitAt - 1))) splitAt -= 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
