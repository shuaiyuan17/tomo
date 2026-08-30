import { existsSync } from "node:fs";
import { log } from "../logger.js";
import {
  AttachmentUnreadableError,
  isDefiniteFailure,
  PartialSendError,
  type Channel,
  type OutgoingMessage,
  type SendResult,
} from "../channels/types.js";
import { deliverText } from "../channels/delivery.js";
import { restoreLiteralNewlines } from "../channels/text-utils.js";
import { DELIVERY_FAILED_MARKER } from "./block-transcript.js";
import {
  endsWithTrailingNoReply,
  extractAttachments,
  isSilentReply,
  MEDIA_RE,
  STICKER_RE,
  stripTrailingNoReply,
} from "./text-utils.js";

/**
 * One independently deliverable piece of a block — the caption text, one
 * `MEDIA:<path>`, one `STICKER:<id>` — and whether it is KNOWN to have shipped.
 * `delivered: false` covers both a definite failure and an ambiguous one: the
 * transcript marker means "not known to have reached the owner", never "known
 * not to have".
 */
export interface DeliverySegment {
  /** The piece as it appeared in the block. */
  text: string;
  delivered: boolean;
}

/**
 * A block that partly shipped: at least one piece failed, and the rest were
 * still given their chance. Carries the per-piece outcome, in model order, so
 * the transcript can record exactly what the owner is known to have received
 * (`failedDeliveryEntry`) instead of marking the whole block failed — which
 * would have recall later deny him text that was on his phone.
 */
export class PartialDeliveryError extends Error {
  constructor(
    /** The first failure, verbatim. */
    readonly failure: unknown,
    readonly segments: readonly DeliverySegment[],
  ) {
    const failed = segments.filter((s) => !s.delivered).length;
    const detail = failure instanceof Error ? failure.message : String(failure);
    super(`Block partly delivered: ${failed} of ${segments.length} part(s) not known to have shipped — ${detail}`, { cause: failure });
    this.name = "PartialDeliveryError";
  }
}

/**
 * The transcript entry for a block whose `deliver()` rejected. A partial
 * failure marks only the pieces that are not known to have shipped; anything
 * else marks the whole block, as before.
 */
export function failedDeliveryEntry(block: string, err: unknown): string {
  if (!(err instanceof PartialDeliveryError)) return `${DELIVERY_FAILED_MARKER}${block}`;
  return err.segments
    .map((s) => (s.delivered ? s.text : `${DELIVERY_FAILED_MARKER}${s.text}`))
    .join("\n");
}

/**
 * Local-file error codes: the send failed while READING the attachment,
 * before any request went out. Defence in depth behind the channels' own
 * pre-checks, for a wrapper (grammY's HttpError keeps the underlying error on
 * `error`, Node on `cause`) around an fs error the channel did not intercept.
 */
const PREFLIGHT_FS_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

/**
 * Can this failure PROVE nothing reached the owner?
 *
 * The distinction decides whether the caption may be re-sent by another
 * route. Both channels already refuse to retry an AMBIGUOUS failure (a
 * timeout, a dead child, a dropped connection) because the message may have
 * landed — see the `ImsgRpcResponseError` discrimination in imessage-imsg.ts
 * and the Markdown fallback in telegram.ts. A caption fallback is a retry of
 * the caption, so it honours the same rule: only a failure the channel can
 * vouch for (`markDefiniteFailure` — the file could not be read, or the
 * provider answered and refused) frees the caption. Anything else, and a
 * second copy is the likelier outcome of "helping".
 */
export function provablyUndelivered(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 5; depth++) {
    if (isDefiniteFailure(current) || current instanceof AttachmentUnreadableError) return true;
    const { code, cause, error } = current as { code?: unknown; cause?: unknown; error?: unknown };
    if (typeof code === "string" && PREFLIGHT_FS_CODES.has(code)) return true;
    current = cause ?? error;
  }
  return false;
}

/**
 * The block's independently deliverable pieces, IN THE ORDER THEY APPEAR and
 * with each tag's original text, so a failure entry reads like the block the
 * model wrote (a quoted path stays quoted, a sticker before a picture stays
 * before it). The caption sits where the first non-tag text does. The send
 * order is a separate matter — pictures, then the caption if it has no
 * picture to ride, then stickers — and unchanged.
 */
function planSegments(block: string, caption: string): {
  segments: DeliverySegment[];
  captionSegment: DeliverySegment | null;
  media: Array<{ path: string; segment: DeliverySegment }>;
  stickers: Array<{ id: string; segment: DeliverySegment }>;
} {
  type Placed = { index: number; segment: DeliverySegment };
  const placed: Placed[] = [];
  const media: Array<{ path: string; segment: DeliverySegment }> = [];
  const stickers: Array<{ id: string; segment: DeliverySegment }> = [];
  // Media first, then stickers over the text with the media spans blanked —
  // the same precedence extractAttachments applies, so the two agree on
  // which tags exist.
  let blanked = block;
  for (const m of block.matchAll(MEDIA_RE)) {
    const segment = { text: m[0], delivered: false };
    media.push({ path: String(m[1] ?? m[2]).trim(), segment });
    placed.push({ index: m.index, segment });
    blanked = blanked.slice(0, m.index) + " ".repeat(m[0].length) + blanked.slice(m.index + m[0].length);
  }
  for (const m of blanked.matchAll(STICKER_RE)) {
    const segment = { text: m[0], delivered: false };
    stickers.push({ id: String(m[1] ?? m[2]).trim(), segment });
    placed.push({ index: m.index, segment });
    blanked = blanked.slice(0, m.index) + " ".repeat(m[0].length) + blanked.slice(m.index + m[0].length);
  }
  let captionSegment: DeliverySegment | null = null;
  if (caption) {
    captionSegment = { text: caption, delivered: false };
    const firstText = blanked.search(/\S/);
    placed.push({ index: firstText === -1 ? 0 : firstText, segment: captionSegment });
  }
  placed.sort((a, b) => a.index - b.index);
  return { segments: placed.map((p) => p.segment), captionSegment, media, stickers };
}

interface DeliveryPipelineDeps {
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
}

export interface DeliverOptions {
  /** Thread the reply to this provider message id, if the channel supports it. */
  replyTo?: string;
}

/**
 * Ships a turn's blocks, one at a time, as each completes.
 *
 * One sender per turn: the reply target is one-shot and has to survive from
 * the block that was offered it to the block that finally takes it, which
 * cannot be expressed by independent per-block calls.
 */
export interface BlockSender {
  /** Ship one completed block. Resolves when it has reached the channel. */
  deliver(block: string): Promise<void>;
}

export function isAgentErrorResponse(response: string): boolean {
  const text = response.trim();
  return /^API Error: \d+/i.test(text)
    || /^Failed to authenticate\.\s+API Error: \d+/i.test(text)
    || /^\{"type":"error"/.test(text)
    || /^You['’]ve hit (?:your )?(?:session )?limit\b/i.test(text);
}

/**
 * Outbound delivery, one completed content block at a time.
 *
 * Delivery is non-streaming but not end-of-turn: there are no token deltas to
 * split on (that was the rejected "几十条消息" design), and there is no waiting
 * for the turn either (#292's regression — a reply written before a
 * twenty-minute tool call sat in a buffer until the tool returned). A block
 * ships the moment the SDK closes it. Newlines inside a block are formatting
 * and stay inside one message.
 *
 * Nothing in this file inspects the model's words to decide whether they are
 * "really" a reply; block TYPE decided that already (live-session.ts
 * renderBlock).
 */
export class DeliveryPipeline {
  constructor(private deps: DeliveryPipelineDeps) {}

  /**
   * Deliver a WHOLE response string as one block.
   *
   * The model's own turns do not come through here any more — their blocks
   * ship individually via `createBlockSender`. What is left are responses that
   * never had blocks to begin with: the fabricated fallbacks in
   * LiveSessionManager ("I ran out of steps trying to complete that.") and
   * agent-error text.
   *
   * Order matters: silence and agent errors are classified on the response as
   * the model produced it, then trailing bare-NO_REPLY suppression runs, then
   * whatever survives ships. Callers with a different silent-reply policy (see
   * TurnRunner's silent matchers) pass their own `isSilent`.
   */
  async deliverResponse(
    sessionKey: string,
    replyChannel: Channel,
    replyChatId: string,
    response: string,
    isSilent: (response: string) => boolean = isSilentReply,
    options: DeliverOptions = {},
  ): Promise<void> {
    if (isAgentErrorResponse(response)) {
      const visibleError = `[error] ${response}`;
      this.deps.queuePendingErrorNote(sessionKey, visibleError);
      await replyChannel.send({ chatId: replyChatId, text: visibleError });
      return;
    }

    // A response whose trailing line(s) are bare NO_REPLY ships NOTHING — no
    // text, no media, no stickers (owner decision 2026-07-08). The agent
    // narrates housekeeping turns and ends with NO_REPLY, and that narration
    // is not for the channel. Only TRAILING lines are inspected, so prose that
    // merely mentions NO_REPLY mid-line still delivers (#222).
    const { visible, hadTrailingNoReply } = stripTrailingNoReply(response);
    if (hadTrailingNoReply || isSilent(response) || !visible.trim()) {
      log.info("Silent reply (no message sent)");
      return;
    }

    await this.createBlockSender(replyChannel, replyChatId, options).deliver(visible);
  }

  /**
   * Open a sender for ONE turn. Every completed block of that turn goes
   * through it, in order, as it completes.
   *
   * Attachments are extracted PER BLOCK, never from a joined turn, so a
   * block's MEDIA:/STICKER: lands where the model put it: blocks `A`,
   * `MEDIA:x`, `B` ship A → photo → B, and a caption rides the media of its
   * own block only.
   *
   * There is deliberately no merging of adjacent text blocks. Under
   * end-of-turn delivery the whole turn was in hand at once and merging kept
   * an all-text turn to a single bubble; mid-turn there is no second block to
   * merge with — it has not been written yet — so a merge step here would be
   * code for a case that cannot occur. One completed block is one message.
   */
  createBlockSender(channel: Channel, chatId: string, options: DeliverOptions = {}): BlockSender {
    // Thread only the FIRST shipped message of the turn — one reply, not one
    // per send. This is why the sender is per turn and not per block.
    //
    // "Shipped" is the whole difficulty. A step can decline to send (a block
    // that is empty after filtering, a tag-only block whose MEDIA: path does
    // not exist) and a channel can send without threading (imsg stickers).
    // Either way the target must survive to the next send, so it is offered to
    // each send and only retired once a send confirms it took it.
    let pendingReplyTo = options.replyTo;
    const offerReplyTo = (): { replyTo?: string } => (pendingReplyTo ? { replyTo: pendingReplyTo } : {});
    /**
     * `null` = nothing shipped; `threaded: false` = shipped but the channel
     * could not thread it. Both keep the target pending.
     */
    const settleReplyTo = (result: SendResult | null | void): void => {
      if (result && result.threaded !== false) pendingReplyTo = undefined;
    };
    /** channel.send returns nothing on the happy path; that counts as taken. */
    const send = async (message: OutgoingMessage): Promise<void> => {
      settleReplyTo(await channel.send(message) ?? {});
    };

    return {
      deliver: async (block: string): Promise<void> => {
        // Defence in depth: the bare-NO_REPLY drop already happened per block
        // in renderBlock, but callers that hand us raw text get it here too.
        if (endsWithTrailingNoReply(block)) return;

        const { cleanText, mediaPaths, stickerIds } = extractAttachments(block);
        if (mediaPaths.length === 0 && stickerIds.length === 0) {
          // No tags stripped, so no blank line to collapse: ship it verbatim.
          settleReplyTo(await deliverText(channel, chatId, block, offerReplyTo()));
          return;
        }

        const caption = restoreLiteralNewlines(cleanText).trim();
        // Outcome per independently deliverable piece, for the transcript
        // should anything fail. A path that no longer exists at this instant
        // is never attempted (that silence is finding #35, out of scope here)
        // and so stays not-known-delivered.
        const { segments, captionSegment, media, stickers } = planSegments(block, caption);
        // The FIRST failure, boxed so a rejection with `null` or `undefined`
        // still counts as one; surfaced once the rest of the block has had
        // its chance. Losing the picture must not also lose the text.
        let failure: { err: unknown } | undefined;
        /** A failed send may have spent the reply target; only a provable one cannot have. */
        const noteFailure = (err: unknown, definite: boolean): void => {
          failure ??= { err };
          if (!definite) pendingReplyTo = undefined;
        };
        // "pending": the caption has not been given to any send that resolved
        // and is known undelivered, so it may still go out — on the next
        // readable picture, or as text.
        // "unknown": it rode a send that failed AMBIGUOUSLY — it may be on the
        // owner's phone, so re-sending it risks a duplicate (see
        // provablyUndelivered); it is left alone and recorded as not known.
        let captionState: "pending" | "sent" | "unknown" = captionSegment ? "pending" : "sent";
        let captionOffered = false;
        for (const { path, segment } of media) {
          if (!existsSync(path)) continue;
          // The caption rides the first readable picture, once.
          const carriesCaption = captionState === "pending" && !captionOffered;
          if (carriesCaption) captionOffered = true;
          try {
            await send({ chatId, photo: path, text: carriesCaption ? caption : "", ...offerReplyTo() });
            // Set only on a send that RESOLVED. Setting it on having called
            // send is what lost the caption: the existsSync above and the
            // channel's own open are different instants, and a file that
            // vanishes in between takes the whole send down.
            segment.delivered = true;
            if (carriesCaption) {
              captionSegment!.delivered = true;
              captionState = "sent";
            }
          } catch (raw) {
            // A channel that ships a captioned picture as two calls says so
            // when the second one failed: the picture is known delivered and
            // only the caption is in doubt, with the second call's own
            // definite/ambiguous character.
            const partial = raw instanceof PartialSendError ? raw : null;
            const err = partial ? partial.failure : raw;
            if (partial?.shipped.photo) segment.delivered = true;
            const definite = provablyUndelivered(err);
            // A picture that shipped may have taken the reply target, whatever
            // became of its caption — so a partial send always retires it.
            noteFailure(raw, definite && partial === null);
            if (carriesCaption && definite) {
              // Nothing of the caption went out: it is still free — it rides
              // the next readable picture, or falls through to deliverText
              // below like any other captionless media.
              captionOffered = false;
            } else if (carriesCaption) {
              captionState = "unknown";
            }
            log.warn(
              { err: raw, path, chatId, definite },
              definite
                ? "Attachment send failed before delivery; delivering the rest of the block"
                : "Attachment send failed ambiguously; delivering the rest of the block without re-sending the caption",
            );
          }
        }
        if (captionState === "pending") {
          // Either no readable picture to ride, or the one that carried it
          // was refused outright. The caption's own send speaks for it.
          try {
            settleReplyTo(await deliverText(channel, chatId, cleanText, offerReplyTo()));
            if (captionSegment) captionSegment.delivered = true;
          } catch (err) {
            noteFailure(err, provablyUndelivered(err));
            log.warn({ err, chatId }, "Caption send failed; delivering the rest of the block");
          }
        }
        for (const { id, segment } of stickers) {
          try {
            await send({ chatId, text: "", sticker: id, ...offerReplyTo() });
            segment.delivered = true;
          } catch (err) {
            noteFailure(err, provablyUndelivered(err));
            log.warn({ err, sticker: id, chatId }, "Sticker send failed; delivering the rest of the block");
          }
        }
        // Surfaced, not swallowed — but only when something is still not known
        // to have shipped. The caller records the block through
        // failedDeliveryEntry, which marks exactly those pieces, so the
        // transcript never claims a delivery that did not happen and never
        // denies one that did. A failure the block recovered from entirely
        // (a refused picture whose caption then went out as text, and no
        // other pieces) is a warn line, not a failed block.
        if (failure && segments.some((s) => !s.delivered)) {
          throw new PartialDeliveryError(failure.err, segments);
        }
      },
    };
  }
}
