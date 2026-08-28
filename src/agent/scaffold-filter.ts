import { config } from "../config.js";

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

// ---------------------------------------------------------------------------
// Tool-call debris: a bare `count` sentinel line.
//
// Measured 2026-08-27 over the real corpus (312 assistant text blocks in
// ~/.claude/projects/*.jsonl, and 30,864 sent iMessages decoded from
// chat.db): 155 of 312 blocks (49.7%) end with a line that is exactly
// `count`, and 1,120 sent messages carry it. In 155/155 transcript cases the
// line is the LAST non-empty line of the block, byte-exact `count` — no
// whitespace padding, no capitalisation variants, never mid-block.
//
// `count` is an ordinary English word, so the anchor is deliberately three
// constraints at once — the line is EXACTLY `count`, it starts at column 0,
// and it is the final non-empty line. Every legitimate use observed in the
// corpus fails at least one: `git rev-list --count` and "400 Count" are not
// bare lines; `countdown`, `freshTailCount` and `descendantcount` are not
// equal to `count`; an indented `count` inside a fenced code block has
// leading whitespace; a bare `count` line in the MIDDLE of a pasted shell
// transcript is not trailing. Zero false positives across both corpora.
//
// This is tool-call debris, not thinking, so it is stripped regardless of the
// `showThinking` switch (which governs only the preamble below).
const COUNT_SENTINEL_LINE_RE = /^count[ \t]*$/;

// ---------------------------------------------------------------------------
// Thinking preamble.
//
// Same corpus: 22 blocks begin with `思考:` — halfwidth colon, at position 0,
// with the reasoning continuing on the SAME line. The model then glues its
// real reply onto the end of the last reasoning paragraph, separated by a
// CJK sentence terminator plus a single ASCII space:
//
//   思考:<reasoning>。\n\n<more reasoning>。 <the actual reply>
//
// 思考 is an everyday Chinese word and this assistant writes Chinese
// constantly, so detection is anchored to the START of the message and to the
// HALFWIDTH colon. In the corpus, 0 of 290 non-leaking blocks start with
// `思考:`, and every legitimate mention (「思考:」 quoted mid-sentence,
// "值得思考", "深度思考") is either not at position 0 or uses the fullwidth
// `：` that Chinese prose actually calls for.
const THINKING_PREFIX = "思考:";

// The reasoning→reply seam. `。 `/`！ `/`？ ` (CJK terminator + ASCII space) is
// a typographic impossibility in real Chinese prose — an ASCII space never
// follows a fullwidth stop — which is exactly why it marks the seam.
//
// The FIRST match is used, never the last. If the reasoning happens to
// contain an earlier seam-shaped sequence, cutting early leaves some
// reasoning visible; cutting late would silently eat the reply. Leaking is
// recoverable, deletion is not, so the bias is deliberate. When no seam
// exists at all (1 of 22 observed — a block that was reasoning end to end)
// the text is returned UNCHANGED rather than guessed at.
const THINKING_SEAM_RE = /[。！？] (?=\S)/;

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
const ENVELOPE_LINE_RES = [
  // `user<system-reminder>`, `assistant[...]`, `user[imessage · ...]`
  /^\s*(?:user|assistant|human)\s*[<[]/i,
  // A bare harness tag opening a line.
  /^\s*<\/?(?:system-reminder|task-notification|tomo-event|task-id|function_results)\b/i,
  // The literal banner the harness puts on background-task events.
  /^\s*\[?SYSTEM NOTIFICATION - NOT USER INPUT\]?\s*$/i,
];

export interface ScaffoldFilterResult {
  text: string;
  /** True when scaffold was detected and stripped. */
  filtered: boolean;
}

export interface ScaffoldFilterOptions {
  /**
   * Show the model's thinking preamble instead of stripping it. Defaults to
   * `config.showThinking` (TOMO_SHOW_THINKING / `showThinking` in
   * ~/.tomo/config.json), which is false.
   *
   * This is the ONLY reader of that setting: the switch and the thinking
   * filter are one mechanism, so the two call sites (turn-runner's streaming
   * onText + final response, delivery-pipeline's block handler) pass nothing
   * and cannot drift out of sync with it. The parameter exists so tests can
   * exercise both sides without stubbing the config module.
   */
  showThinking?: boolean;
}

/**
 * Offset of a trailing bare `count` sentinel, or -1. Only the final non-empty
 * line is ever considered — see COUNT_SENTINEL_LINE_RE for why all three
 * anchors are needed.
 */
function countSentinelIndex(text: string): number {
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0 || !COUNT_SENTINEL_LINE_RE.test(lines[last])) return -1;
  return lines.slice(0, last).reduce((offset, line) => offset + line.length + 1, 0);
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
 * Drop a leaked thinking preamble, keeping the real reply that follows it.
 * Returns the input unchanged when the text does not open with the marker, or
 * when it does but no reasoning→reply seam can be located.
 */
function stripThinkingPreamble(text: string): string {
  const lead = text.length - text.trimStart().length;
  if (!text.startsWith(THINKING_PREFIX, lead)) return text;
  const seam = THINKING_SEAM_RE.exec(text.slice(lead));
  if (!seam) return text;
  return text.slice(lead + seam.index + seam[0].length);
}

/**
 * Strip scaffold leaks from an outbound assistant message.
 *
 * Two independent passes:
 *   1. Trailing scaffold — everything from the first end-of-dialog sentinel,
 *      narrator paragraph, harness-envelope line, or bare `count` sentinel
 *      onward is dropped. Content before the marker is preserved verbatim.
 *   2. A leading thinking preamble is dropped, keeping the reply glued to its
 *      end. Skipped when `showThinking` is on.
 *
 * Callers log a warning when `filtered` is true.
 */
export function filterScaffoldLeak(text: string, options: ScaffoldFilterOptions = {}): ScaffoldFilterResult {
  const showThinking = options.showThinking ?? config.showThinking;

  const candidates = [
    endOfDialogIndex(text),
    narratorParagraphIndex(text),
    envelopeIndex(text),
    countSentinelIndex(text),
  ].filter((i) => i >= 0);

  let result = text;
  if (candidates.length > 0) result = result.slice(0, Math.min(...candidates)).replace(/\s+$/, "");
  if (!showThinking) result = stripThinkingPreamble(result);

  return result === text ? { text, filtered: false } : { text: result, filtered: true };
}
