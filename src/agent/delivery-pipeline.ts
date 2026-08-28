import { existsSync } from "node:fs";
import { log } from "../logger.js";
import type { Channel } from "../channels/types.js";
import { deliverText } from "../channels/delivery.js";
import { restoreLiteralNewlines } from "../channels/text-utils.js";
import { extractAttachments, isSilentReply, stripTrailingNoReply } from "./text-utils.js";

interface DeliveryPipelineDeps {
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
}

type ParsedAttachments = ReturnType<typeof extractAttachments>;

export interface DeliverOptions {
  /** Thread the reply to this provider message id, if the channel supports it. */
  replyTo?: string;
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

    await this.deliverAssistantContent(replyChannel, replyChatId, visible, undefined, options);
  }

  /**
   * Ship assistant content: MEDIA: attachments (caption riding the first),
   * then plain text, then STICKER: sends. Text goes out as one message —
   * newlines stay inside the bubble (see deliverText).
   */
  async deliverAssistantContent(
    channel: Channel,
    chatId: string,
    text: string,
    parsed: ParsedAttachments = extractAttachments(text),
    options: DeliverOptions = {},
  ): Promise<void> {
    const { cleanText, mediaPaths, stickerIds } = parsed;
    const validPaths = mediaPaths.filter((path) => existsSync(path));
    const caption = restoreLiteralNewlines(cleanText).trim();
    let textSent = false;

    for (const [i, path] of validPaths.entries()) {
      await channel.send({ chatId, photo: path, text: i === 0 ? caption : "" });
      if (i === 0 && caption) textSent = true;
    }

    if (!textSent) {
      await deliverText(channel, chatId, cleanText, options);
    }

    for (const stickerId of stickerIds) {
      await channel.send({ chatId, text: "", sticker: stickerId });
    }
  }
}
