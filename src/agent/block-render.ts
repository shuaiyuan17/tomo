/** Per-block rendering rules for assistant content (thinking, scaffold leaks, NO_REPLY, fabricated markers). */

import { endsWithTrailingNoReply } from "./text-utils.js";
import { filterScaffoldLeak } from "./scaffold-filter.js";
import { detectFabricatedMarkers, type FabricatedMarker } from "./inbound-markers.js";

/**
 * Marker prefixed to a thinking block when showThinking is on, so the reader
 * can tell the model's reasoning from its reply. Chosen over a fenced block
 * because chat channels render neither Markdown nor code fences.
 *
 * Only ever applied with the flag ON. With it off, a thinking block that
 * survives to delivery is not being shown as reasoning — it IS the message
 * (see renderBlock) — so it ships plain.
 */
export const THINKING_MARKER = "💭 ";

/** An assistant content block worth keeping for the turn response. */
export interface ResponseBlock {
  type: "text" | "thinking";
  text: string;
}

/**
 * A rendered turn. Delivery units are NOT part of it: blocks ship as they
 * complete (see renderBlock), so by the time a turn is rendered there is
 * nothing left to hand a channel — only the joined text the turn-level
 * bookkeeping needs.
 */
export interface RenderedTurn {
  /** The kept blocks joined with "\n" — logging, transcript, error/silence checks. */
  text: string;
  /** True when at least one block had a training-scaffold leak stripped. */
  scaffoldFiltered: boolean;
}

/** What one content block turns into once the per-block rules have run. */
export type BlockRender =
  /**
   * Ships as one channel message.
   *
   * `text` is the model's words, NEVER the harness's advisory: the
   * fabricated-marker notice is prepended on the delivery path (shipBlock) so
   * that the transcript — built from this same field via
   * renderResponseBlocks — stays exactly what the model wrote.
   */
  | { kind: "ship"; text: string; scaffoldFiltered: boolean; fabricatedMarkers: FabricatedMarker[] }
  /** Trailing line(s) were the bare control token — the block ships nothing. */
  | { kind: "no-reply"; scaffoldFiltered: boolean }
  /** Wrong type for this session, or nothing left after filtering. */
  | { kind: "empty"; scaffoldFiltered: boolean };

/**
 * Decide what ONE completed content block ships, from its `type` and its
 * LENGTH alone.
 *
 * This is the ONLY place that decides what reaches a channel, and it never
 * inspects the text to judge whether it is "really" a reply. A `text` block is
 * the model's chosen words and always ships, even when it happens to read like
 * reasoning (`思考: ...`) or like tool debris (`count`).
 * `redacted_thinking` carries no readable text and is dropped at collection
 * time.
 *
 * A `thinking` block:
 *   - showThinking ON  → ships prefixed with THINKING_MARKER, so the reader can
 *     tell reasoning from reply.
 *   - showThinking OFF → the SDK is running thinking `display: "omitted"`,
 *     which strips the reasoning and leaves a signature-only block whose text
 *     is EMPTY. An empty one is the normal case and is dropped silently. A
 *     NON-EMPTY one is dropped too, with a warn that records its length; it
 *     reaches neither the channel nor the transcript.
 *
 * WHY A NON-EMPTY ONE IS NOT DELIVERED (2026-09-09, reversing the 2026-08-28
 * rule). On 2026-08-28 the non-empty thinking blocks seen under `omitted`
 * were, every one, verbatim prose the model had aimed at the owner in the
 * wrong block type, so they were shipped as messages. That reading stopped
 * being true after the 2026-09-01 model change: under `omitted` the model now
 * returns a SUMMARY of the block (short, paraphrased, punctuation-stripped)
 * rather than what it wrote, and on 2026-09-09 four of those summaries went
 * out as replies. Each replaced the reply the model had actually composed,
 * and one asserted a next step the model never planned. A paraphrase the
 * model did not write is worse than a lost message: the lost message is at
 * least absent. The warn keeps the rate visible — a model that puts replies in thinking
 * blocks needs a model-side fix (compose the reply as a text block, or send
 * it through a tool), not delivery of whatever the API hands back.
 *
 * The two remaining rules are per block by design (#292) and now also per
 * block in TIME — they run as the block completes, because that is when it
 * ships:
 *   1. scaffold-leak filter — a leak truncates its own block, not the turn, so
 *      blocks after a `<system-reminder>` slip still ship;
 *   2. bare-NO_REPLY drop — a block whose trailing line(s) are only the token
 *      is dropped WHOLE (text, MEDIA: and STICKER: alike), so housekeeping
 *      narration and its attachments never leak out of a mid-turn slip;
 *   3. fabricated-inbound-marker DETECTION — a line shaped like one of the
 *      harness's own inbound markers is reported on the result, and shipBlock
 *      prepends an advisory to the DELIVERED copy. Nothing is cut and the
 *      transcript is untouched (src/agent/inbound-markers.ts).
 */
export function renderBlock(block: ResponseBlock, showThinking: boolean): BlockRender {
  // With the flag off a thinking block contributes nothing anywhere — not
  // to delivery, not to the transcript, not to the response string. Under
  // `omitted` its text is a summary of what the model wrote, not the words
  // (see the header); recording it would let recall read a paraphrase back
  // as something the model said. shipBlock logs the drop with its length.
  if (block.type === "thinking" && !showThinking) return { kind: "empty", scaffoldFiltered: false };
  const scaffold = filterScaffoldLeak(block.text);
  const scaffoldFiltered = scaffold.filtered;
  const text = scaffold.text.trim();
  if (!text) return { kind: "empty", scaffoldFiltered };
  if (endsWithTrailingNoReply(text)) return { kind: "no-reply", scaffoldFiltered };

  return {
    kind: "ship",
    // Marked only when thinking is being shown AS thinking. With the flag off
    // this block is a message, and a message does not get a 💭 on it.
    text: block.type === "thinking" && showThinking ? `${THINKING_MARKER}${text}` : text,
    scaffoldFiltered,
    // Reported, not acted on, here: this is what the block WILL ship, and the
    // guard's whole point is that the words stay. The advisory goes on in
    // shipBlock, where "delivered" and "recorded in the transcript" part ways.
    fabricatedMarkers: detectFabricatedMarkers(text),
  };
}

/**
 * Join a turn's collected content blocks into its RESPONSE STRING.
 *
 * Delivery does not go through here — each block was already shipped by
 * `renderBlock` as it completed. What is left is everything that legitimately
 * needs the whole turn: the transcript, the response log line, the value
 * `send()`/`steer()` resolve with, and the end-of-turn silence and
 * agent-error checks.
 *
 * Because those checks read this string, the trailing bare NO_REPLY is still
 * represented here even though the block itself shipped nothing — otherwise a
 * housekeeping turn would render as empty and be replaced by the "I'm not sure
 * how to respond to that." fallback in the transcript.
 */
export function renderResponseBlocks(blocks: ResponseBlock[], showThinking: boolean): RenderedTurn {
  const rendered: string[] = [];
  let scaffoldFiltered = false;
  // Tracks whether the last block that carried any content was a NO_REPLY
  // block — a TRAILING one is load-bearing (see below), a mid-turn one is not.
  let lastKeptWasNoReply = false;

  for (const block of blocks) {
    const result = renderBlock(block, showThinking);
    if (result.scaffoldFiltered) scaffoldFiltered = true;
    if (result.kind === "empty") continue;
    if (result.kind === "no-reply") {
      lastKeptWasNoReply = true;
      continue;
    }
    lastKeptWasNoReply = false;
    rendered.push(result.text);
  }

  // NO_REPLY is Tomo's own control token, not the model's prose. A block whose
  // trailing line(s) are the bare token MID-turn is a slip and is dropped —
  // under per-block delivery the channels dropped it too. A TRAILING one is
  // load-bearing: it marks the whole turn as not-for-the-channel (owner
  // decision 2026-07-08), so exactly one is kept at the end for the delivery
  // layer's trailing-NO_REPLY check to find.
  const kept = lastKeptWasNoReply ? [...rendered, "NO_REPLY"] : rendered;

  return { text: kept.join("\n").trim(), scaffoldFiltered };
}
