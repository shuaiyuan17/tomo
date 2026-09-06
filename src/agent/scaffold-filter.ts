/**
 * Outbound training-scaffold leak filter.
 *
 * Models occasionally leak dialog-formatting scaffold into a reply — e.g. an
 * `_end_of_dialog_` sentinel line, or a trailing narrator paragraph like
 * "Now the user turns to you and asks...". These are never legitimate
 * assistant output, so the delivery path strips from the first such marker
 * onward before the text reaches a channel.
 *
 * Patterns are deliberately tiny and conservative — anchored matches only:
 *   - a line consisting solely of an end-of-dialog sentinel
 *     (optional leading/trailing underscores, case-insensitive)
 *   - a paragraph (start of text or preceded by a blank line) that BEGINS
 *     with "Now the user turns to you"
 * Similar words mid-sentence are never touched.
 */

// A whole line that is only an end_of_dialog sentinel (underscore variants).
const END_OF_DIALOG_LINE_RE = /^\s*_?end_of_dialog_?\s*$/i;

// Paragraph-start narrator scaffold. Anchored to the start of a paragraph.
const NARRATOR_PARAGRAPH_START = "Now the user turns to you";

// Harness envelope leak. The model sometimes emits the *inbound* framing it
// normally only reads — a role marker, a system-reminder block, or a
// task-notification — as if it were composing the transcript rather than a
// reply. Observed 2026-08-20: an entire `<system-reminder>` background-task
// notice reached a Telegram chat, one bubble per line, after a bare internal
// token on its own line.
//
// Anchored to the start of a line so ordinary prose that merely mentions these
// words is untouched: a sentence about "the system-reminder block" does not
// begin a line with `<system-reminder>`.
//
// `<tomo-event>` IS NOT HERE, deliberately. It is a harness envelope like the
// rest, but it is the one shape that has its own owner: inbound-markers.ts
// lists it in MARKER_SHAPES and applies the policy CLAUDE.md and the changelog
// state for a fabricated marker — MARK, DON'T TRUNCATE, and skip lines inside
// a code fence. Both ran, in that order, on the same text: this filter cut at
// the first `<tomo-event` line, so by the time detectFabricatedMarkers saw the
// block the shape it was looking for had already been removed. Its tomo-event
// arm was unreachable, and a pasted log or transcript excerpt inside a fence —
// the case the fence rule exists for — was truncated at the fenced line
// anyway. One shape, one owner; the fence-aware one wins.
const ENVELOPE_LINE_RES = [
  // `user<system-reminder>`, `assistant[...]`, `user[imessage · ...]`
  /^\s*(?:user|assistant|human)\s*[<[]/i,
  // A bare harness tag opening a line.
  /^\s*<\/?(?:system-reminder|task-notification|task-id|function_results)\b/i,
  // The literal banner the harness puts on background-task events.
  /^\s*\[?SYSTEM NOTIFICATION - NOT USER INPUT\]?\s*$/i,
];

export interface ScaffoldFilterResult {
  text: string;
  /** True when scaffold was detected and stripped. */
  filtered: boolean;
}

function endOfDialogIndex(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (END_OF_DIALOG_LINE_RE.test(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function envelopeIndex(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (ENVELOPE_LINE_RES.some((re) => re.test(line))) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function narratorParagraphIndex(text: string): number {
  let idx = text.indexOf(NARRATOR_PARAGRAPH_START);
  while (idx !== -1) {
    const before = text.slice(0, idx);
    const atParagraphStart = /^\s*$/.test(before) || /\n[ \t]*\n[ \t]*$/.test(before);
    if (atParagraphStart) return idx;
    idx = text.indexOf(NARRATOR_PARAGRAPH_START, idx + 1);
  }
  return -1;
}

/**
 * Strip trailing training-scaffold leaks from an outbound assistant message.
 * Returns the (possibly) truncated text; content before the first marker is
 * preserved verbatim. Callers log a warning when `filtered` is true.
 */
export function filterScaffoldLeak(text: string): ScaffoldFilterResult {
  const candidates = [endOfDialogIndex(text), narratorParagraphIndex(text), envelopeIndex(text)].filter((i) => i >= 0);
  if (candidates.length === 0) return { text, filtered: false };
  const cut = Math.min(...candidates);
  return { text: text.slice(0, cut).replace(/\s+$/, ""), filtered: true };
}
