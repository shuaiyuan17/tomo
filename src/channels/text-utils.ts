/**
 * Legacy placeholder the assistant used to emit for a literal newline back
 * when a newline was a message boundary (#179). Since #292/#293 a reply ships
 * as one message with its newlines intact, so the marker is DEPRECATED — the
 * model is told to write a real newline. It is still TOLERATED: an older
 * prompt, a cached habit, or a cron job written before the change can still
 * produce it, and it must never reach a chat literally (it did on 2026-08-30,
 * through `send_message` direct mode, which skipped this rewrite).
 *
 * The rewrite is a single `\n` per marker. Spaces or tabs hugging the marker
 * belong to it, not to the prose (`AI [[NL]] · item` is `AI\n· item`, not
 * `AI \n · item`), and a source newline immediately after it is absorbed so
 * `intro[[NL]]\ndetail` does not gain a blank line. Two markers in a row are
 * two newlines — a deliberate blank line.
 */
const LITERAL_NEWLINE_TOKEN_RE = /[ \t]*\[\[NL\]\][ \t]*(?:\r\n|\r|\n)?/g;

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
