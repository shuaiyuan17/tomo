/**
 * Placeholder the assistant can use when it wants a literal newline to remain
 * inside one outbound chat message instead of acting as a message separator.
 */
export const LITERAL_NEWLINE_TOKEN = "[[NL]]";

const LITERAL_NEWLINE_SENTINEL = "\0TOMO_LITERAL_NEWLINE\0";
// Models often write the token at the end of a source line; that physical
// newline is formatting, not an extra message separator.
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
 * BlueBubbles reports satellite messages with the "iMessageLite" service rather
 * than "iMessage". Match defensively on any service containing "lite" so a
 * future variant spelling still gets flagged.
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
 * Marker prepended to inbound threaded replies (long-press → Reply) so the
 * model sees which earlier message the sender is responding to. Same visual
 * family as SATELLITE_MARKER. When the original text is unavailable the
 * marker degrades to a quote-less form — reply context is best-effort and
 * must never block delivery.
 */
export function formatReplyContextMarker(originalText?: string): string {
  const collapsed = originalText?.replace(/\s+/g, " ").trim();
  if (!collapsed) return "[replying to an earlier message]";
  const sanitized = collapsed.replace(MARKER_DELIMITERS_RE, (c) => FULLWIDTH_DELIMITERS[c]);
  // Truncate by code points, not UTF-16 units — never split a surrogate pair.
  const points = Array.from(sanitized);
  const excerpt = points.length > REPLY_CONTEXT_EXCERPT_LIMIT
    ? `${points.slice(0, REPLY_CONTEXT_EXCERPT_LIMIT).join("").trimEnd()}…`
    : sanitized;
  return `[replying to: "${excerpt}"]`;
}

export function splitOutboundMessageText(text: string): string[] {
  if (!text) return [];
  const protectedText = text.replace(LITERAL_NEWLINE_TOKEN_RE, LITERAL_NEWLINE_SENTINEL);
  return protectedText
    .split(/\r\n|\r|\n/g)
    .map((part) => part.replaceAll(LITERAL_NEWLINE_SENTINEL, "\n").trim())
    .filter((part) => part.length > 0);
}

/**
 * Split text into chunks of at most `limit` characters, preferring to break
 * at a newline, then a space, falling back to a hard cut. Shared by channels
 * whose APIs cap message length (Telegram: 4096, BlueBubbles: 4000).
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
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
