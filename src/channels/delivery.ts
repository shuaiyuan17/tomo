import type { Channel } from "./types.js";
import { splitOutboundMessageText } from "./text-utils.js";

export async function deliverTextParts(
  channel: Pick<Channel, "send">,
  chatId: string,
  text: string,
  options: { replyTo?: string } = {},
): Promise<void> {
  const parts = splitOutboundMessageText(text);
  for (const [i, part] of parts.entries()) {
    await channel.send({
      chatId,
      text: part,
      ...(i === 0 && options.replyTo ? { replyTo: options.replyTo } : {}),
    });
  }
}
