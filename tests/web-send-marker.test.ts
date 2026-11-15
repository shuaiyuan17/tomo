import { describe, expect, it } from "vitest";
import { parseSendMarker, sendMarkerLabel } from "../web/src/send-marker.js";
import { findQuoted, parseReply } from "../web/src/reply.js";

describe("send markers (proactive-send.ts) in the web chat", () => {
  it("a direct send's [proactive] marker becomes a label, never text", () => {
    const { sent, body } = parseSendMarker("assistant", "[proactive] 重启好了，可以继续");
    expect(body).toBe("重启好了，可以继续");
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
