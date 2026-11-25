import { describe, expect, it } from "vitest";
import { parseSendMarker, sendMarkerLabel } from "../web/src/send-marker.js";
import { findQuoted, messageText, parseReply, quotableText } from "../web/src/reply.js";
import { parseTapback, quoteFor, reactionKind } from "../web/src/reactions.js";
import { formatReactionMarker, formatReplyContextMarker } from "../src/channels/text-utils.js";
import { messageInputSchema, type HistoryMessage } from "../src/web/protocol.js";

// The markers a message carries in the transcript ([proactive], [via …],
// [replying to: …], [reacting to: …] [tapback: …]) and how the web chat reads
// them back. Which reactions a message shows: web-reactions.test.ts.

const msg = (id: string, role: HistoryMessage["role"], content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ id, role, content, timestamp: Number(id), channel: "web", ...extra });

describe("reply context", () => {
  it("parses an excerpt cut with an ellipsis and keeps only the real reply as the body", () => {
    expect(parseReply('[replying to: "Picked up the stale #383 and split it into 3 PRs,…"] nice!!')).toEqual({
      reply: { verb: "replying", excerpt: "Picked up the stale #383 and split it into 3 PRs,…", truncated: true }, body: "nice!!" });
  });
  it("English, quotes inside, fullwidth delimiters restored", () => {
    expect(parseReply('[replying to: "he said "ok" ［see #1］"] Sounds good')).toEqual({
      reply: { verb: "replying", excerpt: 'he said "ok" [see #1]', truncated: false }, body: "Sounds good" });
  });
  it("no excerpt, reactions, other markers first, and no prefix", () => {
    expect(parseReply("[replying to an earlier message] yes").reply).toEqual({ verb: "replying", excerpt: null, truncated: false });
    expect(parseReply('[reacting to: "lunch?"] ❤️').reply!.verb).toBe("reacting");
    expect(parseReply('[via satellite] [replying to: "where"] here')).toEqual({
      reply: { verb: "replying", excerpt: "where", truncated: false }, body: "[via satellite] here" });
    expect(parseReply("just text [replying to: \"x\"]")).toEqual({ body: "just text [replying to: \"x\"]" });
  });
  it("finds the quoted message: exact for a whole excerpt, prefix for a cut one, nearest earlier in time", () => {
    const messages = [
      { id: "1", timestamp: 1, content: "Picked up the stale #383 and split it into 3 PRs, the first is merged" },
      { id: "2", timestamp: 2, content: "Other\nthing" },
      { id: "3", timestamp: 3, content: "Picked up the stale #383 and split it into 3 PRs, second draft" },
      { id: "4", timestamp: 4, content: '[replying to: "Picked up the stale #383 and split it into 3 PRs,…"] nice!!' },
      { id: "5", timestamp: 5, content: "lunch?" },
      { id: "6", timestamp: 6, content: "lunch? at noon" },
      { id: "7", timestamp: 7, content: '[replying to: "lunch?"] sure' },
    ];
    const cut = parseReply(messages[3].content).reply!;
    expect(findQuoted(messages, 3, cut)?.id).toBe("3");
    expect(findQuoted(messages, 1, cut)?.id).toBe("1");
    expect(findQuoted(messages, 0, cut)).toBeUndefined();
    // A whole excerpt must match exactly: "lunch? at noon" is not "lunch?".
    expect(findQuoted(messages, 6, parseReply(messages[6].content).reply!)?.id).toBe("5");
    // Never a message later in time than the reply, whatever the order.
    const shuffled = [{ id: "late", timestamp: 99, content: "lunch?" }, { id: "r", timestamp: 10, content: '[replying to: "lunch?"] ok' }];
    expect(findQuoted(shuffled, 1, parseReply(shuffled[1].content).reply!)).toBeUndefined();
    expect(findQuoted(messages, 3, { verb: "replying", excerpt: "nothing like this", truncated: false })).toBeUndefined();
    // An original that itself ends in "…": the exact match wins over a longer message with that prefix.
    const ellipsis = [{ id: "a", timestamp: 1, content: "wait…" }, { id: "b", timestamp: 2, content: "wait for me" }, { id: "c", timestamp: 3, content: '[replying to: "wait…"] ok' }];
    expect(findQuoted(ellipsis, 2, parseReply(ellipsis[2].content).reply!)?.id).toBe("a");
    // An excerpt at the marker's 60-character limit may be a cut even without "…".
    const long = "x".repeat(60);
    expect(parseReply(`[replying to: "${long}"] ok`).reply!.truncated).toBe(true);
    expect(findQuoted(messages, 3, { verb: "replying", excerpt: null, truncated: false })).toBeUndefined();
  });
});

describe("send markers (proactive-send.ts) in the web chat", () => {
  it("a direct send's [proactive] marker becomes a label, never text", () => {
    const { sent, body } = parseSendMarker("assistant", "[proactive] Restarted, you can carry on");
    expect(body).toBe("Restarted, you can carry on");
    expect(sent && sendMarkerLabel(sent)).toBe("Sent proactively");
  });
  it("a send from a summoning main session names it", () => {
    const { sent, body } = parseSendMarker("assistant", "[via dm:claw (summoned)] On my way.");
    expect(body).toBe("On my way.");
    expect(sent && sendMarkerLabel(sent)).toBe("Sent from dm:claw");
  });
  it("leaves the user's words, other markers, and a marker not at the front alone", () => {
    expect(parseSendMarker("user", "[proactive] hi")).toEqual({ body: "[proactive] hi" });
    expect(parseSendMarker("assistant", "I wrote [proactive] in passing")).toEqual({ body: "I wrote [proactive] in passing" });
    expect(parseSendMarker("assistant", "[delivery failed] a photo")).toEqual({ body: "[delivery failed] a photo" });
    expect(parseReply(parseSendMarker("assistant", "[proactive] multi\nline").body).body).toBe("multi\nline");
  });
  it("a reply quoting a message Tomo sent on its own finds it", () => {
    const messages = [
      { id: "a1", content: "[proactive] The build is green.", timestamp: 1 },
      { id: "u1", content: '[replying to: "The build is green."] thanks', timestamp: 2 },
    ];
    expect(findQuoted(messages, 1, parseReply(messages[1].content).reply!)?.id).toBe("a1");
  });
});

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
    expect(quotableText("user", '[replying to: "x"] [Sent an image, saved to: /a/b.png] look  at\nthis')).toBe("look at this");
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
