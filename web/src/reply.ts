/**
 * Threaded-reply prefixes tomo writes for iMessage replies and reactions
 * (src/channels/text-utils.ts formatReplyContextMarker):
 *   [replying to: "<excerpt>"] text      — excerpt is one line, at most 60
 *                                           code points then "…", and its
 *                                           [ ] < > are fullwidth lookalikes
 *   [replying to an earlier message] text — original text unavailable
 *   [reacting to: "<excerpt>"] …
 * Other markers (satellite, attachments) may precede it. Telegram replies
 * carry no such prefix.
 */
export interface ReplyContext { verb: "replying" | "reacting"; excerpt: string | null; truncated: boolean }

const PREFIX = /^((?:\[[^\]]*\]\s*)*?)\[(replying|reacting) to(?:: "(.*?)"| an earlier message)\]\s*/s;
const FULLWIDTH: Record<string, string> = { "［": "[", "］": "]", "＜": "<", "＞": ">" };

/** Pull the reply context off the front of a message; `body` is the rest (other leading markers kept). */
export function parseReply(content: string): { reply?: ReplyContext; body: string } {
  const match = PREFIX.exec(content);
  if (!match) return { body: content };
  const [whole, before, verb, raw] = match;
  const excerpt = raw === undefined ? null : raw.replace(/[［］＜＞]/g, (c) => FULLWIDTH[c]);
  const truncated = !!excerpt && excerpt.endsWith("…");
  return { reply: { verb: verb as ReplyContext["verb"], excerpt: truncated ? excerpt!.slice(0, -1).trimEnd() : excerpt, truncated },
    body: before + content.slice(whole.length) };
}

const normalize = (text: string) => parseReply(text).body.replace(/\s+/g, " ").trim();

/**
 * The message a reply quotes: an excerpt that was not cut must equal the
 * message's text; a cut one ("…") must be its prefix (whitespace collapsed,
 * as the marker does). Of several matches, the nearest one earlier in time
 * than the reply. Undefined when the excerpt is missing or nothing matches.
 */
export function findQuoted<T extends { id: string; content: string; timestamp: number }>(messages: T[], replyIndex: number, reply: ReplyContext): T | undefined {
  if (!reply.excerpt) return undefined;
  const needle = reply.excerpt.replace(/\s+/g, " ").trim();
  if (!needle) return undefined;
  const replyAt = messages[replyIndex]?.timestamp ?? Infinity;
  for (let i = Math.min(replyIndex, messages.length) - 1; i >= 0; i--) {
    if (messages[i].timestamp > replyAt) continue;
    const text = normalize(messages[i].content);
    if (reply.truncated ? text.startsWith(needle) : text === needle) return messages[i];
  }
  return undefined;
}
