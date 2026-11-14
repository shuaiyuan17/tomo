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
/**
 * `excerpt` is the quoted text as written in the marker (a trailing "…" kept);
 * `truncated` says it may be a cut (it ends with "…" or reaches the marker's
 * 60-code-point limit). Matching tries the exact text first either way.
 */
export interface ReplyContext { verb: "replying" | "reacting"; excerpt: string | null; truncated: boolean }
/** formatReplyContextMarker cuts excerpts at this many code points (then adds "…"). */
export const REPLY_EXCERPT_LIMIT = 60;

const PREFIX = /^((?:\[[^\]]*\]\s*)*?)\[(replying|reacting) to(?:: "(.*?)"| an earlier message)\]\s*/s;
const FULLWIDTH: Record<string, string> = { "［": "[", "］": "]", "＜": "<", "＞": ">" };

/** Pull the reply context off the front of a message; `body` is the rest (other leading markers kept). */
export function parseReply(content: string): { reply?: ReplyContext; body: string } {
  const match = PREFIX.exec(content);
  if (!match) return { body: content };
  const [whole, before, verb, raw] = match;
  const excerpt = raw === undefined ? null : raw.replace(/[［］＜＞]/g, (c) => FULLWIDTH[c]);
  const truncated = !!excerpt && (excerpt.endsWith("…") || Array.from(excerpt).length >= REPLY_EXCERPT_LIMIT);
  return { reply: { verb: verb as ReplyContext["verb"], excerpt, truncated },
    body: before + content.slice(whole.length) };
}

const normalize = (text: string) => parseReply(text).body.replace(/\s+/g, " ").trim();

/**
 * The message a reply quotes, among messages earlier in time than the reply:
 * first the nearest whose text EQUALS the excerpt (a message can itself end
 * in "…"); only if none does and the excerpt may be a cut, the nearest that
 * starts with it (minus the trailing "…"). Whitespace is collapsed, as the
 * marker does. Undefined when the excerpt is missing or nothing matches.
 */
export function findQuoted<T extends { id: string; content: string; timestamp: number }>(messages: T[], replyIndex: number, reply: ReplyContext): T | undefined {
  if (!reply.excerpt) return undefined;
  const exact = reply.excerpt.replace(/\s+/g, " ").trim();
  if (!exact) return undefined;
  const replyAt = messages[replyIndex]?.timestamp ?? Infinity;
  const earlier: T[] = [];
  for (let i = Math.min(replyIndex, messages.length) - 1; i >= 0; i--) if (messages[i].timestamp <= replyAt) earlier.push(messages[i]);
  const same = earlier.find((m) => normalize(m.content) === exact);
  if (same || !reply.truncated) return same;
  const prefix = exact.replace(/…$/, "").trimEnd();
  return prefix ? earlier.find((m) => normalize(m.content).startsWith(prefix)) : undefined;
}
