import { existsSync } from "node:fs";
import { log } from "../logger.js";
import type { Channel, StreamingMessage } from "../channels/types.js";
import { deliverTextParts } from "../channels/delivery.js";
import { restoreLiteralNewlines } from "../channels/text-utils.js";
import { extractAttachments, isSilentReply } from "./text-utils.js";

interface DeliveryPipelineDeps {
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
}

type ParsedAttachments = ReturnType<typeof extractAttachments>;

export function isAgentErrorResponse(response: string): boolean {
  const text = response.trim();
  return /^API Error: \d+/i.test(text)
    || /^Failed to authenticate\.\s+API Error: \d+/i.test(text)
    || /^\{"type":"error"/.test(text)
    || /^You['’]ve hit (?:your )?(?:session )?limit\b/i.test(text);
}

export class DeliveryPipeline {
  constructor(private deps: DeliveryPipelineDeps) {}

  /**
   * Finalize the streaming message after a turn completes. Per-block delivery
   * happens during the run, so by the time this runs the stream's only
   * remaining job is flushing any trailing buffer state.
   */
  async deliverResponse(
    sessionKey: string,
    replyChannel: Channel,
    replyChatId: string,
    response: string,
    stream: StreamingMessage,
  ): Promise<void> {
    log.info({ channel: replyChannel.name, session: sessionKey }, "Tomo: %s", response);

    if (isSilentReply(response)) {
      log.info("Silent reply (no message sent)");
      await stream.cancel();
      return;
    }

    if (isAgentErrorResponse(response)) {
      const visibleError = `[error] ${response}`;
      this.deps.queuePendingErrorNote(sessionKey, visibleError);
      await stream.cancel();
      await replyChannel.send({ chatId: replyChatId, text: visibleError });
      return;
    }

    await stream.finish();
  }

  /**
   * Deliver assistant text that bypasses StreamingMessage. Caption text rides
   * with the first MEDIA send; plain text is split the same way streamed text is.
   */
  async deliverAssistantContent(
    channel: Channel,
    chatId: string,
    text: string,
    parsed: ParsedAttachments = extractAttachments(text),
  ): Promise<void> {
    const { cleanText, mediaPaths, stickerIds } = parsed;
    const validPaths = mediaPaths.filter((path) => existsSync(path));
    const caption = restoreLiteralNewlines(cleanText);
    let textSent = false;

    for (const [i, path] of validPaths.entries()) {
      await channel.send({ chatId, photo: path, text: i === 0 ? caption : "" });
      if (i === 0 && caption) textSent = true;
    }

    if (!textSent) {
      await deliverTextParts(channel, chatId, cleanText);
    }

    for (const stickerId of stickerIds) {
      await channel.send({ chatId, text: "", sticker: stickerId });
    }
  }

  /**
   * Build the per-block handler passed to the live session. Channel-side
   * delivery errors are caught here so they never kill the SDK event loop and
   * cause a duplicate turn retry.
   */
  makeBlockHandler(
    channel: Channel,
    chatId: string,
    stream: StreamingMessage,
  ): (text: string) => Promise<void> {
    return async (blockText: string) => {
      try {
        if (isAgentErrorResponse(blockText)) {
          await stream.cancel();
          return;
        }
        const attachments = extractAttachments(blockText);
        if (attachments.mediaPaths.length > 0 || attachments.stickerIds.length > 0) {
          await stream.discardBlock();
          await this.deliverAssistantContent(channel, chatId, blockText, attachments);
          return;
        }
        await stream.commitBlock();
      } catch (err) {
        log.warn({ err, channel: channel.name }, "Block delivery failed");
      }
    };
  }
}
