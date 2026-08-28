import { existsSync } from "node:fs";
import { log } from "../logger.js";
import type { Channel, OutgoingMessage, SendResult } from "../channels/types.js";
import { deliverText } from "../channels/delivery.js";
import { restoreLiteralNewlines } from "../channels/text-utils.js";
import { endsWithTrailingNoReply, extractAttachments, isSilentReply, stripTrailingNoReply } from "./text-utils.js";

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

        const validPaths = mediaPaths.filter((path) => existsSync(path));
        const caption = restoreLiteralNewlines(cleanText).trim();
        let captionSent = false;
        for (const [i, path] of validPaths.entries()) {
          await send({ chatId, photo: path, text: i === 0 ? caption : "", ...offerReplyTo() });
          if (i === 0 && caption) captionSent = true;
        }
        if (!captionSent) settleReplyTo(await deliverText(channel, chatId, cleanText, offerReplyTo()));
        for (const stickerId of stickerIds) {
          await send({ chatId, text: "", sticker: stickerId, ...offerReplyTo() });
        }
      },
    };
  }
}
