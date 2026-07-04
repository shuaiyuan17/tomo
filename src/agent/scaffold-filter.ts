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
  const candidates = [endOfDialogIndex(text), narratorParagraphIndex(text)].filter((i) => i >= 0);
  if (candidates.length === 0) return { text, filtered: false };
  const cut = Math.min(...candidates);
  return { text: text.slice(0, cut).replace(/\s+$/, ""), filtered: true };
}
