import { describe, expect, it } from "vitest";
import { collectReactions } from "../web/src/reactions.js";
import { formatReactionMarker } from "../src/channels/text-utils.js";
import type { HistoryMessage, WebRequest } from "../src/web/protocol.js";

// Reading the markers themselves: web-reply-markers.test.ts.

const msg = (id: string, role: HistoryMessage["role"], content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ id, role, content, timestamp: Number(id), channel: "web", ...extra });

describe("collectReactions", () => {
  const history = [
    msg("1", "user", "ship it?", { requestId: "r1" }),
    msg("2", "assistant", "Shipped. Tests are green."),
    msg("3", "user", formatReactionMarker("like", "Shipped. Tests are green.")),
    msg("4", "assistant", "NO_REPLY"),
    msg("5", "user", formatReactionMarker("love", "Shipped. Tests are green.")),
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
});
