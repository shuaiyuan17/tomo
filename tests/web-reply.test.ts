import { describe, expect, it } from "vitest";
import { findQuoted, parseReply } from "../web/src/reply.js";

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
