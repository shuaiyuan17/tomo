import { parseSendMarker } from "./send-marker.js";
import { splitThinking } from "./thinking.js";

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

// A quoted message Tomo sent on its own is recorded with a send marker in front; the quote never has it.
const normalize = (text: string) => parseReply(parseSendMarker("assistant", text).body).body.replace(/\s+/g, " ").trim();

/**
 * The markers a messaging channel puts in front of an inbound message
 * (attachments: "[Sent an image, saved to: …]", "[Sent 2 files: …]", a
 * Telegram sticker; satellite; a late attachment follow-up). The channel
 * quotes the provider's text, which has none. Only these: a message that
 * itself starts with brackets ("[1, 2, 3]", a markdown link) keeps them.
 */
const LEADING_MARKERS = /^(?:\s*\[(?:Sent (?:an?|\d+) [^\]]*|via satellite[^\]]*|Attachments from an earlier message[^\]]*)\])+\s*/;
/** A picture line Tomo's reply carries (delivery-pipeline MEDIA:/STICKER: tags); never part of the quote. */
const MEDIA_LINE = /^[ \t]*(?:MEDIA|STICKER):\S.*$/gm;

/**
 * The text a reply or reaction quotes for a message, as a messaging channel
 * would: what the sender wrote, without the markers tomo puts in front
 * (send marker, reply quote, attachments), Tomo's thinking or picture tags.
 * Whitespace is collapsed, as the reply marker does.
 */
export function quotableText(role: string, content: string): string {
  return messageText(role, content).replace(/\s+/g, " ").trim();
}

/** The same text with its line breaks (what Copy copies). */
export function messageText(role: string, content: string): string {
  let body = parseReply(parseSendMarker(role, content).body).body;
  // Channel markers lead inbound (user) messages only; Tomo's text is its own.
  body = role === "assistant"
    ? splitThinking(body, "joined").filter((s) => s.kind === "reply").map((s) => s.text).join("\n").replace(MEDIA_LINE, "")
    : body.replace(LEADING_MARKERS, "");
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The message a reply quotes, among messages earlier in time than the reply:
 * first the nearest whose text EQUALS the excerpt (a message can itself end
 * in "…"); only if none does and the excerpt may be a cut, the nearest that
 * starts with it (minus the trailing "…"). Whitespace is collapsed, as the
 * marker does. Undefined when the excerpt is missing or nothing matches.
 */
export function findQuoted<T extends { id: string; content: string; timestamp: number; role?: string }>(messages: T[], replyIndex: number, reply: ReplyContext): T | undefined {
  if (!reply.excerpt) return undefined;
  const exact = reply.excerpt.replace(/\s+/g, " ").trim();
  if (!exact) return undefined;
  const replyAt = messages[replyIndex]?.timestamp ?? Infinity;
  const earlier: T[] = [];
  for (let i = Math.min(replyIndex, messages.length) - 1; i >= 0; i--) if (messages[i].timestamp <= replyAt) earlier.push(messages[i]);
  // Each message's text as the transcript has it, and as a quote of it reads (quotableText).
  const forms = (m: T) => [normalize(m.content), quotableText(m.role ?? "user", m.content)];
  const same = earlier.find((m) => forms(m).includes(exact));
  if (same || !reply.truncated) return same;
  const prefix = exact.replace(/…$/, "").trimEnd();
  return prefix ? earlier.find((m) => forms(m).some((form) => form.startsWith(prefix))) : undefined;
}
