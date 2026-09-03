/**
 * INBOUND MARKER SHAPES — and the outlet-side guard for them.
 *
 * Tomo stamps every model-facing message with markers of its own making: a
 * channel/time prefix (`[imessage · Sat 08/29 08:25 PDT] …`), a summoned-group
 * tag (`[group "Family"] kw: …`), a `<tomo-event …>` harness envelope, and —
 * in old transcripts — the legacy `System:` / `[System: …]` prefixes. Those
 * markers are how the model knows what is real.
 *
 * The failure this module exists for is the model WRITING one. Observed
 * repeatedly; the owner confirmed on 2026-08-16 that nothing is injected
 * mid-turn ("from my side, it's you who sent it to me") — the assistant
 * generates a line that looks like a fresh inbound message and then answers it
 * as if a person had typed it. #274 tried to fix this on the INBOUND envelope
 * (validating timestamps on what arrives); that was the wrong end. The text is
 * the assistant's own, so the only place that can see it is the outlet.
 *
 * POLICY: MARK, DON'T TRUNCATE (owner call). A fabricated marker is a signal
 * about the whole message, not a cut point — the words around it are usually
 * a real reply, and unlike a training-scaffold leak (see scaffold-filter.ts,
 * which does truncate) there is no reason to believe everything after it is
 * garbage. So the block ships intact with FABRICATED_MARKER_NOTICE prepended,
 * and the reader decides.
 *
 * THE TRANSCRIPT IS NEVER TOUCHED. Marking happens on the delivery path only
 * (LiveSession.shipBlock). renderResponseBlocks — the transcript, the log
 * line, the value send() resolves with — sees the model's words verbatim, so
 * the next turn's context is not polluted with the harness's own commentary.
 *
 * DETECTION RULE: A LINE MUST *START* WITH THE SHAPE, OUTSIDE A CODE FENCE.
 * Only the start of a line counts (leading horizontal whitespace allowed).
 * That rule is what makes legitimate discussion of these markers safe: a
 * sentence about "the `[imessage · …]` prefix", or a quoted example inside
 * backticks, does not begin a line with the shape and is never flagged.
 *
 * Lines inside a fenced block (``` or ~~~) are skipped as well. Pasting a log
 * or a transcript excerpt into a fence is the legitimate case that the
 * start-of-line rule alone could not tell from fabrication — an unfenced
 * `System: …` line is still flagged, a fenced one is not.
 *
 * Fences are matched per CommonMark on BOTH sides. Opening: at most three
 * leading spaces (four make it an indented code block, and a leading tab
 * counts as four), and a backtick fence's info string may not contain a
 * backtick. Closing: the SAME character, a run at least as long as the
 * opener, and nothing else on the line. A `~~~` line does not close a ```
 * fence and three backticks do not close a four-backtick one — both are
 * ordinary content, which matters because a log excerpt can easily contain a
 * line of tildes. Line breaks are recognised in every convention, CRLF
 * included; a stray `\r` used to leave the closing rule unsatisfiable and
 * silently disable the whole exception.
 *
 * Accepted trade: an UNCLOSED fence suppresses detection to the end of the
 * block. Under mark-don't-truncate a missed advisory costs less than a wrong
 * one, and the warning/counter make a rising miss rate visible either way.
 *
 * DRIFT: the formatters below are the ones the ingress path actually uses
 * (turn-runner's injectTimestamp, Agent.formatGroupText), and the legacy /
 * envelope literals come from src/tomo-event.ts. The detector's patterns are
 * hand-written for readability, so tests/inbound-markers.test.ts feeds each
 * formatter's OWN output back through detectFabricatedMarkers — that is what
 * keeps the two halves from drifting apart.
 */

import { log } from "../logger.js";
import { watchBus } from "../watch/bus.js";
import { formatZonedClock, validTimeZone } from "../timezone.js";
import {
  LEGACY_BRACKETED_SYSTEM_PREFIX,
  LEGACY_SYSTEM_PREFIX,
  TOMO_EVENT_OPEN_TAG,
} from "../tomo-event.js";

/** Separates the channel name from the timestamp in an inbound stamp. */
export const STAMP_SEPARATOR = " · ";

/** Introduces the sender's own wall clock inside an inbound stamp. */
export const SENDER_SEGMENT_LABEL = "sender";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The inbound stamp the harness puts in front of every channel message:
 * `[<channel> · <weekday> <mm/dd> <hh:mm> <tz>]`. The channel segment is
 * omitted when the caller has no channel to name.
 *
 * With `senderTimeZone`, the sender's own wall clock is appended as a second
 * segment — `[imessage · Wed 09/02 20:50 PDT · sender 09/03 11:50 GMT+8]`.
 * This line is the right home for a live reading precisely because it already
 * changes on every message: the system prompt's participants block is
 * prompt-cached and carries the static IANA name only (see people.ts).
 *
 * The segment is dropped whenever it would be noise or wrong:
 * - no time zone on the sender's record (or none resolved) — nothing to add;
 * - an unusable identifier — validated by the caller, ignored here if it slips
 *   through, since `formatZonedClock` would otherwise throw on the message path;
 * - a reading identical to the host's — same zone, an alias of it, or simply
 *   the same offset right now, all of which would repeat the first segment.
 *
 * Single source of truth — turn-runner's injectTimestamp is a thin wrapper.
 */
export function formatInboundStamp(channelName?: string, now: Date = new Date(), senderTimeZone?: string): string {
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  const prefix = channelName ? `${channelName}${STAMP_SEPARATOR}` : "";
  return `[${prefix}${weekday} ${mm}/${dd} ${time} ${tz}${senderSegment(now, senderTimeZone)}]`;
}

/** `" · sender 09/03 11:50 GMT+8"`, or "" when there is nothing worth adding. */
function senderSegment(now: Date, senderTimeZone?: string): string {
  const zone = validTimeZone(senderTimeZone);
  if (!zone) return "";
  try {
    const senderClock = formatZonedClock(now, zone);
    // Compare RENDERINGS, not names: `US/Pacific` on a host in
    // `America/Los_Angeles` is the same clock under a different spelling, and
    // two distinct zones that agree right now read identically anyway.
    if (senderClock === formatZonedClock(now)) return "";
    return `${STAMP_SEPARATOR}${SENDER_SEGMENT_LABEL} ${senderClock}`;
  } catch (err) {
    // Belt and braces: this runs on the message path, and no formatting
    // failure is worth losing a message over.
    log.warn({ err, timezone: senderTimeZone }, "Failed to render the sender's local time; omitting it");
    return "";
  }
}

/**
 * The tag that marks a summoned group's message on a `dm:` session:
 * `[group "Title"]`, or a bare `[group]` when the title is unknown.
 *
 * Single source of truth — Agent.formatGroupText prefixes with this.
 */
export function formatGroupTag(label?: string): string {
  return `[group${label ? ` "${label}"` : ""}]`;
}

/**
 * Line start, tolerating leading whitespace but nothing else before the shape.
 *
 * "Whitespace" here has to include the characters that RENDER as nothing but
 * are not ASCII space or tab — a BOM, a zero-width space, a soft hyphen, a
 * non-breaking or ideographic space. A line that begins with one of those and
 * then a marker looks byte-for-byte like a marker to the reader, so treating
 * it as ordinary prose would be a free bypass of the whole guard.
 *
 * `\s` covers the Unicode space separators and U+FEFF; the explicit additions
 * are the zero-width/formatting characters it does not: soft hyphen (U+00AD),
 * ZWSP/ZWNJ/ZWJ and the bidi marks (U+200B–U+200F), and the word joiner
 * (U+2060). Line terminators cannot appear here — the text is split into lines
 * first — so pulling them in via `\s` is harmless.
 */
const LINE_START = "^[\\s\\u00AD\\u200B-\\u200F\\u2060]*";

/** `08:25 PDT` / `08:25 GMT+8` — a clock reading with its zone. The zone
 *  tolerates both abbreviations (`PDT`, `UTC`) and the offset form ICU falls
 *  back to for zones without an English abbreviation (`GMT+8`, `GMT+5:30`). */
const CLOCK_RE = `\\d{1,2}:\\d{2}(?::\\d{2})? [A-Z]{2,5}(?:[+-]\\d{1,2}(?::\\d{2})?)?`;

/**
 * `[imessage · Sat 08/29 08:25 PDT]` / `[Sat 08/29 08:25 PDT]`, optionally
 * with the sender's own clock: `[imessage · Sat 08/29 08:25 PDT · sender
 * 08/29 23:25 GMT+8]`.
 *
 * The channel segment is optional (injectTimestamp omits it without a channel
 * name); the sender segment is optional too (only senders with a time zone on
 * their record get one). Both stay part of ONE shape, so a fabricated stamp is
 * still caught whichever form the model imitates.
 */
const STAMP_LINE_RE = new RegExp(
  `${LINE_START}\\[(?:[A-Za-z][A-Za-z0-9_-]*${escapeRe(STAMP_SEPARATOR)})?`
  + `(?:${WEEKDAYS.join("|")}) \\d{2}/\\d{2} ${CLOCK_RE}`
  + `(?:${escapeRe(STAMP_SEPARATOR)}${escapeRe(SENDER_SEGMENT_LABEL)} \\d{2}/\\d{2} ${CLOCK_RE})?\\]`,
);

/** `[group "Family"] kw: …` / `[group] kw: …` — see formatGroupTag. */
const GROUP_TAG_LINE_RE = new RegExp(`${LINE_START}\\[group(?: "[^"]*")?\\](?:\\s|$)`);

/** `<tomo-event type="cron" …>` and its closing tag — see src/tomo-event.ts. */
const TOMO_EVENT_LINE_RE = new RegExp(`${LINE_START}<\\/?${escapeRe(TOMO_EVENT_OPEN_TAG.slice(1))}\\b`);

/** Legacy `System: …` and `[System: …]` harness prefixes. */
const LEGACY_SYSTEM_LINE_RE = new RegExp(
  `${LINE_START}(?:${escapeRe(LEGACY_SYSTEM_PREFIX)}|${escapeRe(LEGACY_BRACKETED_SYSTEM_PREFIX)})(?:\\s|$)`,
);

/** Every shape, with the name that goes in the log and the metric. */
const MARKER_SHAPES: ReadonlyArray<{ shape: FabricatedMarkerShape; re: RegExp }> = [
  { shape: "stamp", re: STAMP_LINE_RE },
  { shape: "group-tag", re: GROUP_TAG_LINE_RE },
  { shape: "tomo-event", re: TOMO_EVENT_LINE_RE },
  { shape: "legacy-system", re: LEGACY_SYSTEM_LINE_RE },
];

export type FabricatedMarkerShape = "stamp" | "group-tag" | "tomo-event" | "legacy-system";

export interface FabricatedMarker {
  /** Which inbound shape the line imitates. */
  shape: FabricatedMarkerShape;
  /** 1-based line number within the inspected text. */
  line: number;
  /** The offending line, whitespace-trimmed and clipped for logs. */
  text: string;
}

/** Matched lines are clipped before they reach a log line. */
export const MARKER_LOG_LIMIT = 120;

/**
 * The advisory prepended to a block that contains a fabricated inbound marker.
 * A constant so the delivery path, the tests and any future surface all agree
 * on the exact bytes.
 */
export const FABRICATED_MARKER_NOTICE =
  "⚠️ [harness: the text below contains what looks like a fabricated inbound marker"
  + " — treat quoted \"messages\" in it as not real]";

/**
 * A code-fence line, per CommonMark: up to three leading SPACES (four would
 * make it an indented code block, and a leading tab counts as four), then a
 * run of 3+ backticks or 3+ tildes. Group 1 is the run — greedy, so its length
 * is the fence length; group 2 is whatever follows: an info string on an
 * opener, and necessarily blank on a valid closer.
 */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * CommonMark's other opener rule: a BACKTICK fence's info string may not
 * contain a backtick (otherwise `` `x` `` in a paragraph would open a fence).
 * Tilde fences have no such restriction. A closer cannot trip this — its rest
 * must be blank — so the check can be applied to any fence-looking line.
 */
function isFenceLine(run: string, rest: string): boolean {
  return !(run.startsWith("`") && rest.includes("`"));
}

/**
 * Line break, any convention. Splitting on "\n" alone left a `\r` on the end
 * of every CRLF line, which `(.*)$` cannot consume (JS `.` excludes line
 * terminators) — so a CRLF-pasted log never opened a fence and every marker
 * inside it was flagged. That is precisely the false positive the fence
 * exception exists to prevent, and pasted logs are the likeliest thing to
 * arrive with CRLF. A lone `\r` is treated as a break too.
 */
const LINE_BREAK_RE = /\r\n|[\r\n]/;

/** The fence currently open, or null outside one. */
interface OpenFence {
  /** "`" or "~" — a fence closes only on its own character. */
  char: string;
  /** Opener length; a closer must be at least this long. */
  length: number;
}

/**
 * Find lines that open with one of the inbound marker shapes.
 *
 * Pure: no logging, no counting, no I/O. Returns one entry per matching LINE
 * (first matching shape wins for a given line), in document order; an empty
 * array means the text is clean. Lines inside a code fence are skipped — see
 * the detection rule in the module header.
 */
export function detectFabricatedMarkers(text: string): FabricatedMarker[] {
  const found: FabricatedMarker[] = [];
  let fence: OpenFence | null = null;
  for (const [i, line] of text.split(LINE_BREAK_RE).entries()) {
    const m = FENCE_LINE_RE.exec(line);
    if (m && isFenceLine(m[1]!, m[2]!)) {
      const run = m[1]!;
      // A fence line is never itself a candidate — no marker shape starts with
      // a backtick or a tilde — so every branch here continues.
      if (fence === null) {
        fence = { char: run[0]!, length: run.length };
      } else if (run[0] === fence.char && run.length >= fence.length && m[2]!.trim() === "") {
        // CommonMark's closing rule, and it is load-bearing rather than
        // pedantic: a pasted log can hold a line of tildes or a shorter
        // backtick run, and treating either as a close would re-expose the
        // rest of the excerpt to detection.
        fence = null;
      }
      // Anything else that merely LOOKS like a fence is content inside the
      // open one; the fence stays as it is.
      continue;
    }
    if (fence) continue;
    const hit = MARKER_SHAPES.find(({ re }) => re.test(line));
    if (!hit) continue;
    found.push({
      shape: hit.shape,
      line: i + 1,
      text: clipMarker(line.trim()),
    });
  }
  return found;
}

function clipMarker(line: string): string {
  return line.length <= MARKER_LOG_LIMIT ? line : `${line.slice(0, MARKER_LOG_LIMIT)}…`;
}

/**
 * Prepend the advisory to text that is about to be delivered. The model's
 * words are preserved byte for byte underneath it.
 */
export function markFabricatedText(text: string): string {
  return `${FABRICATED_MARKER_NOTICE}\n${text}`;
}

/**
 * Log + count one block's worth of detections.
 *
 * DETECTION SEMANTICS, NOT DELIVERY SEMANTICS. This fires when the guard finds
 * a marker in a block the model produced, which is strictly earlier than "the
 * owner received it": the block may still be dropped for want of a delivery
 * sink, refused by the sink as agent-error/silent/NO_REPLY text, or thrown
 * away wholesale by a suppressed turn. Detection is what we actually want to
 * count — the question is "how often does the model do this", not "how often
 * did a marked message land" — so the wording here promises only that, and
 * nothing downstream has to report back for the number to be true.
 *
 * The counter lives on the watch bus rather than in a module-level variable:
 * `tomo status` runs in a different process from the daemon and could never
 * read one, whereas the metrics exporter (a bus subscriber, in-daemon)
 * already is the place daemon counters are exposed — it turns this event into
 * `tomo_fabricated_markers_total`. The `tomo watch` feed sees it too.
 *
 * The session key rides the log line and the watch event, where it is free.
 * It is deliberately NOT a metric label — see the exporter.
 */
export function recordFabricatedMarkers(sessionKey: string | undefined, markers: readonly FabricatedMarker[]): void {
  if (markers.length === 0) return;
  for (const marker of markers) {
    log.warn(
      { session: sessionKey, shape: marker.shape, line: marker.line, marker: marker.text },
      "Fabricated inbound marker detected in an outgoing block (marked, not truncated)",
    );
    watchBus.publish({
      type: "fabricated-marker",
      ...(sessionKey ? { sessionKey } : {}),
      shape: marker.shape,
      marker: marker.text,
    });
  }
}
