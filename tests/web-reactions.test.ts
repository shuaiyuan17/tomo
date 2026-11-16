import { describe, expect, it } from "vitest";
import { collectReactions, parseTapback, quoteFor, reactionKind } from "../web/src/reactions.js";
import { findQuoted, messageText, quotableText } from "../web/src/reply.js";
import { formatReactionMarker, formatReplyContextMarker } from "../src/channels/text-utils.js";
import { pendingUserMessages } from "../web/src/pending.js";
import { messageInputSchema, type HistoryMessage, type WebRequest } from "../src/web/protocol.js";

const msg = (id: string, role: HistoryMessage["role"], content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ id, role, content, timestamp: Number(id), channel: "web", ...extra });

describe("tapback records", () => {
  it("reads both forms the channels write, and nothing else", () => {
    expect(parseTapback(formatReactionMarker("love", "pizza tonight?"))).toEqual({
      reaction: expect.objectContaining({ kind: "love", emoji: "❤️" }), reply: { verb: "reacting", excerpt: "pizza tonight?", truncated: false } });
    expect(parseTapback(formatReactionMarker("like"))).toEqual({ reaction: expect.objectContaining({ kind: "like" }) });
    expect(parseTapback("[tapback: love] and more")).toBeUndefined();
    expect(parseTapback('[replying to: "x"] [tapback: love]')).toBeUndefined();
    expect(parseTapback("just text")).toBeUndefined();
  });
  it("a custom emoji tapback (iMessage) is shown as it is", () => {
    expect(parseTapback(formatReactionMarker("🔥", "hi"))!.reaction).toEqual({ emoji: "🔥", label: "🔥", verb: "reacted to" });
    expect(reactionKind("Emphasis").kind).toBe("emphasize");
  });
});

describe("what a reply quotes", () => {
  it("drops tomo's markers, thinking and picture tags; Copy keeps line breaks", () => {
    expect(quotableText("user", '[replying to: "x"] [Sent an image, saved to: /a/b.png] look  at\nthis', { isReply: true })).toBe("look at this");
    expect(quotableText("assistant", "[proactive] 💭 musing\nHere you go\nMEDIA:/tmp/a.png")).toBe("Here you go");
    expect(messageText("assistant", "One\n\nTwo")).toBe("One\n\nTwo");
    expect(Array.from(quoteFor({ role: "user", content: "x".repeat(3000) }))).toHaveLength(2000);
  });
  it("only the channels' own markers are stripped; a message that starts with brackets keeps them", () => {
    expect(quotableText("assistant", "[Documentation](https://example.com) explains it.")).toBe("[Documentation](https://example.com) explains it.");
    expect(quotableText("user", "[1, 2, 3]")).toBe("[1, 2, 3]");
    expect(quotableText("user", "[via satellite — sender off-grid, text-only, keep it short] [Sent a Telegram sticker: file_id=x] hi")).toBe("hi");
    expect(quotableText("user", "[Sent 2 files: a.md (text/markdown, 1 KB) saved to /x] [notes] here")).toBe("[notes] here");
  });
  it("a quote fits the server's limit in UTF-16 units and never splits an emoji", () => {
    const quote = quoteFor({ role: "user", content: "🙂".repeat(1500) });
    expect(quote.length).toBeLessThanOrEqual(2000);
    expect(Array.from(quote)).toHaveLength(1000);
    const odd = quoteFor({ role: "user", content: `x${"🙂".repeat(1500)}` });
    expect(odd.length).toBe(1999);
    expect(messageInputSchema.safeParse({ requestId: "00000000-0000-4000-8000-000000000000", text: "", reply: { text: odd, reaction: "like" } }).success).toBe(true);
  });
  it("a reply sent from this page finds its original again, also one with an attachment marker", () => {
    const messages = [
      msg("1", "user", "[Sent an image, saved to: /a/b.png] the new desk"),
      msg("2", "assistant", "Looks great — the walnut really works with the lamp, and the cable tray is tidy"),
    ];
    for (const original of messages) {
      const marker = formatReplyContextMarker(quoteFor(original));
      const reply = msg("3", "user", `${marker} thanks`);
      const context = parseTapback(`${marker.replace("[replying to", "[reacting to")} [tapback: like]`)!.reply!;
      expect(findQuoted([...messages, reply], 2, context)?.id).toBe(original.id);
    }
  });
});

describe("collectReactions", () => {
  const history = [
    msg("1", "user", "ship it?", { requestId: "r1" }),
    msg("2", "assistant", "Shipped. Tests are green."),
    msg("3", "user", formatReactionMarker("like", "Shipped. Tests are green."), { isReaction: true }),
    msg("4", "assistant", "NO_REPLY"),
    msg("5", "user", formatReactionMarker("love", "Shipped. Tests are green."), { isReaction: true }),
  ];
  it("one reaction per sender per message, the latest winning; Tomo's come from the daemon by request id", () => {
    const shown = collectReactions(history, [], { r1: "laugh", gone: "love" }, false);
    expect(shown.get("2")).toEqual([{ from: "you", reaction: expect.objectContaining({ kind: "love" }) }]);
    expect(shown.get("1")).toEqual([{ from: "agent", reaction: expect.objectContaining({ kind: "laugh" }) }]);
    expect([...shown.keys()].sort()).toEqual(["1", "2"]);
  });
  it("a pending reaction shows at once, marked as sending; in a group, tapbacks are someone's", () => {
    const pending: WebRequest = { requestId: "p", state: "queued", sessionId: "s", text: "", reply: { text: "ship it?", reaction: "question" } };
    expect(collectReactions(history, [pending], {}, false).get("1")).toEqual([{ from: "you", pending: true, reaction: expect.objectContaining({ kind: "question" }) }]);
    expect(collectReactions(history, [], {}, true).get("2")![0].from).toBe("participant");
  });
  it("a pending reaction is a pending message (it has no text)", () => {
    const pending: WebRequest = { requestId: "p", state: "queued", sessionId: "s", text: "", reply: { text: "x", reaction: "like" } };
    expect(pendingUserMessages([pending], { messages: [], nextCursor: null }, "s")).toHaveLength(1);
  });
});
