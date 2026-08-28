import type { Channel } from "./types.js";
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
 */
export async function deliverText(
  channel: Pick<Channel, "send">,
  chatId: string,
  text: string,
  options: { replyTo?: string } = {},
): Promise<void> {
  const body = restoreLiteralNewlines(text).trim();
  if (!body) return;
  await channel.send({
    chatId,
    text: body,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  });
}
