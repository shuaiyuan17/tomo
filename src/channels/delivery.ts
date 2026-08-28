import type { Channel, SendResult } from "./types.js";
import { restoreLiteralNewlines } from "./text-utils.js";

/**
 * Deliver one assistant reply as ONE channel message.
 *
 * Newlines inside a reply are formatting, not message separators: a
 * three-line reply is one bubble with two embedded newlines, not three
 * bubbles. `[[NL]]` is rewritten to a real newline here — the model has been
 * trained to emit it, and it must never ship literally.
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
  const body = restoreLiteralNewlines(text).trim();
  if (!body) return null;
  return await channel.send({
    chatId,
    text: body,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  }) ?? {};
}
