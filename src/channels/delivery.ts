import type { Channel, SendResult } from "./types.js";

/**
 * Deliver one text unit through the channel.
 *
 * Newlines inside a reply are formatting, not message separators: a
 * three-line unit is one bubble with two embedded newlines, not three bubbles
 * (unless the channel must chunk it at its provider limit).
 *
 * Splitting is left to the channel's own `send()`, which chunks at its
 * provider limit (iMessage 4000, Telegram 4096) and never truncates.
 *
 * Returns `null` when the text was empty after normalisation and NOTHING was
 * sent, otherwise the channel's own SendResult. Callers that hand out a
 * one-shot `replyTo` must distinguish the two: a send that never happened
 * cannot have consumed the reply target.
 */
export async function deliverText(
  channel: Pick<Channel, "send">,
  chatId: string,
  text: string,
  options: { replyTo?: string } = {},
): Promise<SendResult | null> {
  const body = text.trim();
  if (!body) return null;
  return await channel.send({
    chatId,
    text: body,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  }) ?? {};
}
