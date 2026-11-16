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
 * Characters that render as nothing (or as plain space) and so can sit between
 * `[` and a marker word without the reader noticing: whitespace, soft hyphen,
 * the zero-width and bidi marks, word joiner, BOM. Same set as inbound-markers'
 * LINE_START.
 */
const INVISIBLE = "[\\s\\u00AD\\u200B-\\u200F\\u2060\\uFEFF]*";

/**
 * The opening words of every bracketed marker the harness writes into a
 * model-facing message (grep `"[` / `` `[ `` in src/ for the producers):
 *
 * - channel markers: `[replying to: "…"]`, `[replying to an earlier message]`,
 *   `[reacting to: "…"]`, `[tapback: …]` (text-utils), `[via satellite — …]`,
 *   `[Sent an image / N images / a file / a document / a sticker / a Telegram
 *   sticker / an unsupported document …]` (imageStore, fileStore,
 *   documentStore, telegram), `[Attachments from an earlier message …]`
 *   (imsg-inbound-attachments), `[sticker: …]` (own-send ring), `[Image …]`;
 * - agent markers: `[group "…"]`, the inbound stamp `[imessage · Sat 08/29 …]`
 *   (inbound-markers), `[System: …]` (tomo-event), `[harness: …]`
 *   (continuity-defaults, inbound-markers), `[via dm:…]`, `[proactive]`
 *   (proactive-send), `[delivery failed …]` / `[delivery status unknown]`
 *   (block-transcript, turn-runner), `[not processed …]`,
 *   `[an attachment sent with this message …]` (durable-inbox), `[error]`,
 *   `[empty reply]`, `[pruned …]`, `[Compacted …]`.
 *
 * tests/inbound-body-neutralize.test.ts feeds every producer's own output
 * through {@link neutralizeInboundBody}, so a new marker that is missing here
 * fails there.
 */
const MARKER_WORDS = [
  "replying to", "reacting to", "tapback", "via satellite", "via dm", "sent", "sticker", "image",
  "attachment from", "attachments from", "an attachment", "group", "system", "harness", "proactive", "delivery",
  "not processed", "error", "empty reply", "pruned", "compacted",
];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Invisible characters only (no whitespace): what may hide INSIDE a word. */
const HIDDEN = "[\\u00AD\\u200B-\\u200F\\u2060\\uFEFF]*";

/**
 * A marker word as a pattern that still matches with invisible characters
 * hidden between its letters (`rep\u200Blying to`) or extra spacing between
 * its words — both read exactly like the word itself.
 */
function spelledLoosely(word: string): string {
  return word.split(" ").map((part) => Array.from(part).join(HIDDEN)).join(`${INVISIBLE}\\s${INVISIBLE}`);
}

/** `[` opening a marker word, the inbound stamp (`[imessage · …`, `[Sat 08/29 …`), or `<` opening a `<tomo-event>` tag. */
const FORGED_OPENER_RE = new RegExp(
  `\\[(?=${INVISIBLE}(?:(?:${MARKER_WORDS.map(spelledLoosely).join("|")})\\b`
  + `|[a-z][\\w\\-\\u00AD\\u200B-\\u200F\\u2060\\uFEFF]*${INVISIBLE}·`
  + `|(?:${WEEKDAYS.map(spelledLoosely).join("|")})${INVISIBLE}\\d))`
  + `|<(?=${INVISIBLE}\\/?${INVISIBLE}${spelledLoosely("tomo-event")}\\b)`,
  "giu",
);

/**
 * Neutralise a sender's message BODY so it cannot pass for a harness marker.
 *
 * Every channel hands the body it got from the provider (iMessage text, a
 * Telegram message or caption, what the owner typed on the web page) through
 * this before writing its own markers in front: anyone in a group can type
 * `[reacting to: "…"] [tapback: love]` or `[replying to: "…"]`, and without
 * this the agent — and the web UI reading the transcript — would take it for
 * the real thing. Only the bracket that OPENS a marker-looking token is
 * swapped for its fullwidth lookalike (`[` → `［`, `<` → `＜`), the same
 * substitution {@link neutralizeMarkerDelimiters} makes inside a quote, so the
 * text still reads the same to a person while no marker parser — the model's
 * or the web page's — matches it. Ordinary brackets (`[1, 2]`, a markdown
 * link) are left alone. Anywhere in the body counts, not only its start: the
 * model reads every line.
 */
export function neutralizeInboundBody(text: string): string {
  return text.replace(FORGED_OPENER_RE, (c) => FULLWIDTH_DELIMITERS[c]!);
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

/**
 * Marker for an inbound reaction (iMessage tapback, a reaction from the web
 * UI): `[reacting to: "<excerpt>"] [tapback: <reaction>]`, or the quote-less
 * `[tapback: <reaction> on an earlier message]` when the original text is
 * unknown. The excerpt follows {@link formatReplyContextMarker} exactly (the
 * web UI reads both back with the same parser); the reaction name is
 * sender-controlled on iMessage (a custom emoji), so it is neutralised too.
 */
export function formatReactionMarker(reaction: string, originalText?: string): string {
  const name = neutralizeMarkerDelimiters(reaction).trim();
  const collapsed = originalText?.replace(/\s+/g, " ").trim();
  if (!collapsed) return `[tapback: ${name} on an earlier message]`;
  return `${formatReplyContextMarker(collapsed).replace(/^\[replying to/, "[reacting to")} [tapback: ${name}]`;
}

/** Leading half of a UTF-16 surrogate pair; slicing after one splits a character. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Grapheme segmenter for the hard-cut fallback, or null on a build without it.
 *
 * Present in every Node this project supports (>= 22.12; `Intl.Segmenter`
 * landed in 16), so the null branch is only reached on an ICU-less build
 * (`--with-intl=none`). Constructed once — instantiating a segmenter per chunk
 * is the expensive part, segmenting a short probe is not.
 */
const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * How far past `limit` to segment.
 *
 * Only boundaries at or before `limit` are used, and a boundary's position is
 * fixed by the text BEFORE it, so truncating the probe cannot move one — the
 * slack only has to be enough that the cluster straddling `limit` is present
 * for the boundary that opens it to be enumerated.
 */
const GRAPHEME_PROBE_SLACK = 4;

/**
 * Largest grapheme-cluster boundary at or before `limit`, or 0 if there is
 * none usable (no segmenter, or a single cluster longer than the whole window).
 *
 * Segmenting only the head rather than all of `text` keeps this O(limit) per
 * chunk instead of O(remaining), which matters because the caller loops.
 */
function lastGraphemeBoundary(text: string, limit: number): number {
  if (!graphemeSegmenter) return 0;
  let boundary = 0;
  for (const { index } of graphemeSegmenter.segment(text.slice(0, limit + GRAPHEME_PROBE_SLACK))) {
    if (index > limit) break;
    boundary = index;
  }
  return boundary;
}

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
    if (splitAt < limit * 0.5) {
      // HARD CUT. `limit` is an index into UTF-16 CODE UNITS, so cutting there
      // blindly lands wherever it lands: between the two halves of an astral
      // character (emoji, most CJK extensions, mathematical alphanumerics),
      // leaving a lone high surrogate ending one chunk and a lone low
      // surrogate opening the next — Telegram rejects a lone surrogate in the
      // request body with a 400 that is NOT a Markdown-parse error, so
      // telegram.ts rethrows and the whole reply is lost rather than
      // degrading, and iMessage renders both halves as U+FFFD. Or between a
      // base character and its combining mark, which detaches the accent onto
      // the next bubble.
      //
      // So: cut at the last grapheme-cluster boundary that fits. That is
      // strictly stronger than code-point safety — it keeps `é` (e + U+0301),
      // flag pairs and ZWJ emoji sequences whole, not just surrogate pairs.
      const boundary = lastGraphemeBoundary(remaining, limit);
      splitAt = boundary > 0 ? boundary : limit;
    }
    // Belt and braces for the two ways the boundary search yields nothing: an
    // ICU-less build with no segmenter, and a single cluster longer than the
    // whole window. Both fall back to `limit`, which can still be mid-pair.
    //
    // Backing off keeps the pair in the NEXT chunk; at splitAt === 1 there is
    // nothing to back off to, so take the pair instead. A 2-unit chunk that
    // overruns a limit of 1 is the lesser evil against emitting the lone
    // surrogates this function exists to prevent — and no real channel limit
    // is anywhere near 1 (iMessage 4000, Telegram 4096). Never 0, which would
    // push an empty chunk and never shorten `remaining`.
    //
    // The newline/space branches cannot land mid-pair (their split character
    // is itself a single BMP unit), so this only ever bites the fallback.
    if (isHighSurrogate(remaining.charCodeAt(splitAt - 1))) {
      splitAt = splitAt > 1 ? splitAt - 1 : splitAt + 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
