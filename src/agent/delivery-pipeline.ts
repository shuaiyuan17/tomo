import { existsSync } from "node:fs";
import { log } from "../logger.js";
import type { Channel } from "../channels/types.js";
import { deliverText } from "../channels/delivery.js";
import { restoreLiteralNewlines } from "../channels/text-utils.js";
import { endsWithTrailingNoReply, extractAttachments, isSilentReply, stripTrailingNoReply } from "./text-utils.js";

interface DeliveryPipelineDeps {
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
}

export interface DeliverOptions {
  /** Thread the reply to this provider message id, if the channel supports it. */
  replyTo?: string;
  /**
   * The turn's content blocks, in order (LiveSession's renderResponseBlocks).
   * Attachment placement is defined per block: `A`, `MEDIA:x`, `B` ships
   * A → photo → B, and a caption rides the media of its OWN block. Absent for
   * callers that only have a string; then the whole response is one block.
   */
  blocks?: string[];
}

export function isAgentErrorResponse(response: string): boolean {
  const text = response.trim();
  return /^API Error: \d+/i.test(text)
    || /^Failed to authenticate\.\s+API Error: \d+/i.test(text)
    || /^\{"type":"error"/.test(text)
    || /^You['’]ve hit (?:your )?(?:session )?limit\b/i.test(text);
}

/**
 * Outbound delivery for a completed turn.
 *
 * Delivery is non-streaming by design: the turn runs to completion,
 * LiveSession renders its content blocks into one response string (block TYPE
 * decides what is included — see live-session.ts renderResponseBlocks), and
 * that string is delivered here as a single reply. Nothing in this file
 * inspects the model's words to decide whether they are "really" a reply.
 */
export class DeliveryPipeline {
  constructor(private deps: DeliveryPipelineDeps) {}

  /**
   * Deliver a completed turn's response to a chat.
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

    await this.deliverAssistantContent(replyChannel, replyChatId, options.blocks ?? [visible], options);
  }

  /**
   * Ship a turn's content blocks in order.
   *
   * Attachments are extracted PER BLOCK, never from the joined turn, so a
   * block's MEDIA:/STICKER: lands where the model put it: `A`, `MEDIA:x`, `B`
   * ships A → photo → B, and a caption rides the media of its own block only.
   * Adjacent text-only blocks are merged into ONE send, so the common all-text
   * turn is still exactly one message with its newlines inside the bubble.
   * Reply threading targets the first shipped message, whatever its kind.
   */
  async deliverAssistantContent(
    channel: Channel,
    chatId: string,
    blocks: string[],
    options: DeliverOptions = {},
  ): Promise<void> {
    // Thread only the FIRST shipped message — one reply, not one per send.
    let pendingReplyTo = options.replyTo;
    const takeReplyTo = (): { replyTo?: string } => {
      const target = pendingReplyTo;
      pendingReplyTo = undefined;
      return target ? { replyTo: target } : {};
    };

    let textRun: string[] = [];
    const flushTextRun = async () => {
      if (textRun.length === 0) return;
      const merged = textRun.join("\n");
      textRun = [];
      await deliverText(channel, chatId, merged, takeReplyTo());
    };

    for (const block of blocks) {
      // Defence in depth: the per-block bare-NO_REPLY drop already happened in
      // renderResponseBlocks, but callers that hand us raw text get it here too.
      if (endsWithTrailingNoReply(block)) continue;

      const { cleanText, mediaPaths, stickerIds } = extractAttachments(block);
      if (mediaPaths.length === 0 && stickerIds.length === 0) {
        // No tags stripped, so no blank line to collapse: ship it verbatim.
        if (block.trim()) textRun.push(block);
        continue;
      }

      await flushTextRun();

      const validPaths = mediaPaths.filter((path) => existsSync(path));
      const caption = restoreLiteralNewlines(cleanText).trim();
      let captionSent = false;
      for (const [i, path] of validPaths.entries()) {
        await channel.send({ chatId, photo: path, text: i === 0 ? caption : "", ...takeReplyTo() });
        if (i === 0 && caption) captionSent = true;
      }
      if (!captionSent) await deliverText(channel, chatId, cleanText, takeReplyTo());
      for (const stickerId of stickerIds) {
        await channel.send({ chatId, text: "", sticker: stickerId, ...takeReplyTo() });
      }
    }

    await flushTextRun();
  }
}
