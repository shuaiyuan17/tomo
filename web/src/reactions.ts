import { WEB_REPLY_TEXT_LIMIT, type HistoryMessage, type WebReaction, type WebRequest } from "../../src/web/protocol.js";
import { findQuoted, parseReply, quotableText, type ReplyContext } from "./reply.js";

/**
 * Tapbacks in the chat. The owner's reactions (from this page, or an iMessage
 * tapback) are recorded in the transcript as the iMessage channel words them
 * (src/channels/text-utils.ts formatReactionMarker):
 *   [reacting to: "<excerpt>"] [tapback: <reaction>]
 *   [tapback: <reaction> on an earlier message]
 * Tomo's own reactions on web messages are not in the transcript: the daemon
 * keeps them by request id (bootstrap `reactions`, `reaction` events).
 */
/** `kind`: one of the six (absent: a custom emoji tapback from iMessage). */
export interface ReactionKind { kind?: WebReaction; emoji: string; label: string; verb: string }

/** iMessage's six tapbacks, in its order. */
export const REACTIONS: ReadonlyArray<ReactionKind & { kind: WebReaction }> = [
  { kind: "love", emoji: "❤️", label: "Love", verb: "loved" },
  { kind: "like", emoji: "👍", label: "Like", verb: "liked" },
  { kind: "dislike", emoji: "👎", label: "Dislike", verb: "disliked" },
  { kind: "laugh", emoji: "😂", label: "Ha ha", verb: "laughed at" },
  { kind: "emphasize", emoji: "‼️", label: "Emphasize", verb: "emphasized" },
  { kind: "question", emoji: "❓", label: "Question", verb: "questioned" },
];
/** Names a recorded tapback may carry beyond ours (imsg's spellings). */
const ALIASES: Record<string, WebReaction> = { loved: "love", heart: "love", liked: "like", thumbsup: "like", disliked: "dislike",
  thumbsdown: "dislike", haha: "laugh", laughed: "laugh", emphasis: "emphasize", emphasized: "emphasize", exclamation: "emphasize", questioned: "question" };

/** One of the six, or a custom emoji tapback shown as it is. */
export function reactionKind(name: string): ReactionKind {
  const key = name.trim().toLowerCase();
  const found = REACTIONS.find((r) => r.kind === key || r.kind === ALIASES[key]);
  return found ?? { emoji: name.trim(), label: name.trim(), verb: "reacted to" };
}

const TAPBACK = /^\[tapback: ([^\]\n]+?)\]\s*$/;
const TAPBACK_UNQUOTED = /^\[tapback: ([^\]\n]+?) on an earlier message\]\s*$/;

/** A tapback record, or undefined for any other message. `reply` is what it reacted to (absent: unknown). */
export function parseTapback(content: string): { reaction: ReactionKind; reply?: ReplyContext } | undefined {
  const { reply, body } = parseReply(content);
  if (reply?.verb === "reacting") {
    const match = TAPBACK.exec(body.trim());
    return match ? { reaction: reactionKind(match[1]), reply } : undefined;
  }
  if (reply) return undefined;
  const match = TAPBACK_UNQUOTED.exec(content.trim());
  return match ? { reaction: reactionKind(match[1]) } : undefined;
}

export type ReactionFrom = "you" | "agent" | "participant";
export interface ShownReaction { from: ReactionFrom; reaction: ReactionKind; pending?: boolean }

/** A pending reaction's quote, read as a reply marker reads its excerpt. */
function pendingQuote(request: WebRequest): ReplyContext | undefined {
  const text = request.reply?.text.replace(/\s+/g, " ").trim();
  return text ? { verb: "reacting", excerpt: text, truncated: text.endsWith("…") } : undefined;
}

/**
 * Who reacted to each message, by message id (history messages) or request
 * id (pending web messages). One reaction per sender per message, the latest
 * winning, as on iMessage: the owner's (recorded tapbacks, then this page's
 * pending ones), then Tomo's.
 */
export function collectReactions(messages: readonly HistoryMessage[], pending: readonly WebRequest[],
  agentReactions: Readonly<Record<string, WebReaction>>, group: boolean): Map<string, ShownReaction[]> {
  const owner = new Map<string, ShownReaction>();
  const list = messages as HistoryMessage[];
  list.forEach((message, index) => {
    if (message.role !== "user") return;
    const tapback = parseTapback(message.content);
    const target = tapback?.reply && findQuoted(list, index, tapback.reply);
    if (target) owner.set(target.id, { from: group ? "participant" : "you", reaction: tapback.reaction });
  });
  for (const request of pending) {
    const quote = request.reply?.reaction ? pendingQuote(request) : undefined;
    const target = quote && findQuoted(list, list.length, quote);
    if (target) owner.set(target.id, { from: "you", reaction: reactionKind(request.reply!.reaction!), pending: true });
  }
  const out = new Map<string, ShownReaction[]>();
  for (const [id, reaction] of owner) out.set(id, [reaction]);
  const byRequest = new Map(messages.filter((m) => m.role === "user" && m.requestId).map((m) => [m.requestId!, m.id]));
  for (const [requestId, kind] of Object.entries(agentReactions)) {
    const id = byRequest.get(requestId) ?? (pending.some((r) => r.requestId === requestId) ? requestId : undefined);
    if (id) out.set(id, [...(out.get(id) ?? []), { from: "agent", reaction: reactionKind(kind) }]);
  }
  return out;
}

/**
 * What a reply or reaction from this page quotes of a message (the agent sees
 * its first 60 code points). Cut to the server's limit, which counts UTF-16
 * units as every string length does (an emoji is two), never between the two
 * halves of a surrogate pair.
 */
export function quoteFor(message: { role: string; content: string }, limit = WEB_REPLY_TEXT_LIMIT): string {
  const text = quotableText(message.role, message.content);
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit);
}
