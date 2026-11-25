import { describe, expect, it } from "vitest";
import type { HistoryMessage, SessionTools, SubagentItem, WebRequest } from "../src/web/protocol.js";
import { blockKey, interleave, jumpLabel, jumpVisible, mergeTools, messageKey, NO_TOOLS, pendingKey, unseenKeys } from "../web/src/inline-tools.js";
import { chatRows, openingAnchors, rowId } from "../web/src/chat-rows.js";

const msg = (id: string, role: "user" | "assistant", timestamp: number, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ id, role, content: id, channel: "web", timestamp, ...extra });
let offset = 0;
const call = (id: string, name: string, ts: number, done = true): SubagentItem[] => {
  const at = (offset += 100);
  return [{ kind: "tool", id: `${at}:0`, toolUseId: id, name, summary: `${name} x`, input: "{}", inputTruncated: false, ts },
    ...(done ? [{ kind: "result" as const, id: `${at + 50}:0`, toolUseId: id, output: "ok", truncated: false, isError: false }] : [])];
};
const shape = (out: ReturnType<typeof interleave>) => [
  ...out.entries.map((e) => e.kind === "message" ? e.message.id : `${e.block.kind}:${e.block.key}`), "|",
  ...out.trailing.map((b) => `${b.kind}:${b.key}`)];

describe("interleave: tool calls between the chat's messages", () => {
  it("places each turn's calls before the message that follows them; one call is a row, a run is a group", () => {
    const messages = [msg("u1", "user", 100), msg("a1", "assistant", 500), msg("u2", "user", 600), msg("a2", "assistant", 900)];
    const items = [...call("r1", "Read", 200), ...call("b1", "Bash", 300), ...call("g1", "Grep", 700)];
    expect(shape(interleave(messages, items))).toEqual(["u1", "group:calls:r1", "a1", "u2", "tool:call:g1", "a2", "|"]);
  });
  it("text is interleaved, never folded: narration between two runs splits them", () => {
    const messages = [msg("u1", "user", 100), msg("a1", "assistant", 300), msg("a2", "assistant", 600)];
    const items = [...call("r1", "Read", 200), ...call("r2", "Read", 250), ...call("b1", "Bash", 400), ...call("b2", "Bash", 500)];
    expect(shape(interleave(messages, items))).toEqual(["u1", "group:calls:r1", "a1", "group:calls:b1", "a2", "|"]);
  });
  it("calls after the last message are the running turn's (how its group is labelled: web-subagent.test.ts)", () => {
    const items = [...call("r1", "Read", 200), ...call("b1", "Bash", 300, false)];
    const out = interleave([msg("u1", "user", 100)], items);
    expect(shape(out)).toEqual(["u1", "|", "group:calls:r1"]);
    expect(out.trailing[0]).toMatchObject({ kind: "group", tools: [{ toolUseId: "r1" }, { toolUseId: "b1" }] });
  });
  it("drops calls before the oldest loaded message (older history not loaded) and calls without a time", () => {
    const items = [...call("old", "Read", 50), { kind: "tool", id: "1:0", toolUseId: "nots", name: "X", summary: "", input: "{}", inputTruncated: false } as SubagentItem,
      ...call("r1", "Read", 200)];
    expect(shape(interleave([msg("u1", "user", 100), msg("a1", "assistant", 300)], items, 100))).toEqual(["u1", "tool:call:r1", "a1", "|"]);
  });
  it("keys are stable: paging in older history and live growth keep a run's key", () => {
    const base = [...call("r1", "Read", 200), ...call("r2", "Read", 210)];
    const before = interleave([msg("u1", "user", 100)], base).trailing[0].key;
    const grown = interleave([msg("u1", "user", 100)], [...base, ...call("b1", "Bash", 220)]).trailing[0].key;
    const paged = interleave([msg("u0", "user", 10), msg("a0", "assistant", 20), msg("u1", "user", 100)], [...call("e1", "Read", 15), ...base]);
    expect(grown).toBe(before);
    expect(paged.trailing[0].key).toBe(before);
    expect(before).toBe("calls:r1");
  });
});

describe("mergeTools", () => {
  const page = (items: SubagentItem[], end: number, transcript = "t"): SessionTools => ({ items, end, transcript, complete: true });
  it("a scan replaces; a tail appends only new ids; a new transcript replaces", () => {
    const a = call("a", "Read", 1); const b = call("b", "Bash", 2);
    const full = mergeTools(NO_TOOLS, page(a, 10), "full");
    const tail = mergeTools(full, page([...a, ...b], 20), "newer");
    expect(tail.items.map((i) => i.id)).toEqual([...a, ...b].map((i) => i.id));
    expect(tail.end).toBe(20);
    expect(mergeTools(tail, page(b, 5, "other"), "newer").items).toEqual(b);
  });
  it("a scan that stopped at its cap is marked incomplete (the chat says older calls are not shown); tails keep the mark", () => {
    const capped = mergeTools(NO_TOOLS, { items: call("a", "Read", 1), end: 10, transcript: "t", complete: false }, "full");
    expect(capped.complete).toBe(false);
    expect(mergeTools(capped, page(call("b", "Bash", 2), 20), "newer").complete).toBe(false);
    expect(mergeTools(capped, page([], 30), "full").complete).toBe(true);
  });
  it("a tail that brings nothing new returns the same state, so the chat does not re-render for a quiet poll", () => {
    const full = mergeTools(NO_TOOLS, page(call("a", "Read", 1), 10), "full");
    expect(mergeTools(full, page([], 10), "newer")).toBe(full);
    expect(mergeTools(full, page(full.items, 10), "newer")).toBe(full);
    expect(mergeTools(full, page([], 12), "newer")).not.toBe(full);
    expect(mergeTools(full, { ...page([], 10), unreadable: true }, "newer").unreadable).toBe(true);
  });
});

describe("new-message counter", () => {
  it("a streamed reply and its recorded copy count once; paged-in older messages never count", () => {
    const baseline = new Set([messageKey(msg("u1", "user", 1, { requestId: "q1" })), "reply:x"]);
    const streaming = [...baseline, blockKey({ requestId: "q2", turnId: "turn2" })];
    expect(unseenKeys(baseline, streaming).size).toBe(1);
    const recorded = [...baseline, messageKey(msg("a2", "assistant", 5, { requestId: "q2", turnId: "turn2" })), blockKey({ requestId: "q2", turnId: "turn2" })];
    expect([...unseenKeys(baseline, recorded)]).toEqual(["reply:turn2"]);
    expect(unseenKeys(baseline, ["msg:older", ...baseline]).size).toBe(0);
    expect(pendingKey({ requestId: "q3" })).toBe(messageKey(msg("u3", "user", 6, { requestId: "q3" })));
  });
  it("labels, and the pill shows only with conversation below: a new message, or the last row out of view", () => {
    expect(jumpLabel(0)).toBe(""); expect(jumpLabel(1)).toBe("1 new message"); expect(jumpLabel(3)).toBe("3 new messages");
    // At the end (or following it) the scroller reports nothing below: never shown.
    expect(jumpVisible({ canScrollEnd: false, lastRowVisible: false, unseen: 4 })).toBe(false);
    expect(jumpVisible({ canScrollEnd: true, lastRowVisible: true, unseen: 0 })).toBe(false);
    expect(jumpVisible({ canScrollEnd: true, lastRowVisible: false, unseen: 0 })).toBe(true);
    expect(jumpVisible({ canScrollEnd: true, lastRowVisible: true, unseen: 2 })).toBe(true);
  });
});

describe("chatRows: the Message Scroller's rows", () => {
  const request = (requestId: string, extra: Partial<WebRequest> = {}): WebRequest => ({ requestId, sessionId: "s", state: "running", text: requestId, ...extra } as WebRequest);
  const shapeOf = (rows: ReturnType<typeof chatRows>) => rows.map((row) => `${row.id}${row.anchor ? "*" : ""}${row.kind === "message" && row.tools.length ? `[${row.tools.map((t) => t.key).join(",")}]` : ""}`);
  it("tool calls ride in the row of the message they precede: loading them grows a row, never inserts one", () => {
    const messages = [msg("u1", "user", 100), msg("a1", "assistant", 500), msg("u2", "user", 600), msg("a2", "assistant", 900)];
    const before = chatRows(interleave(messages, []).entries, [], false);
    const after = chatRows(interleave(messages, [...call("r1", "Read", 200), ...call("b1", "Bash", 300), ...call("g1", "Grep", 700)]).entries, [], false);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(shapeOf(after)).toEqual(["u1", "a1[calls:r1]", "u2*", "a2[call:g1]"]);
  });
  it("only the latest user message anchors (pending or recorded); a web message keeps one id from bubble to record", () => {
    const history = [msg("u1", "user", 100), msg("a1", "assistant", 200)];
    const sent = chatRows(interleave(history, []).entries, [request("q2")], true);
    expect(shapeOf(sent)).toEqual(["u1", "a1", "sent:q2*"]);
    const recorded = chatRows(interleave([...history, msg("x9", "user", 300, { requestId: "q2" })], []).entries, [], true);
    expect(shapeOf(recorded)).toEqual(["u1", "a1", "sent:q2*"]);
    expect(rowId(msg("x9", "user", 300, { requestId: "q2" }))).toBe("sent:q2");
    expect(rowId(msg("a9", "assistant", 300, { requestId: "q2" }))).toBe("a9");
    const queued = chatRows(interleave(history, []).entries, [request("q2"), request("q3", { state: "queued" })], false);
    expect(shapeOf(queued)).toEqual(["u1", "a1", "sent:q2", "sent:q3*"]);
  });
  it("only the rows a conversation opened with may anchor; what this tab sends never does", () => {
    const opened = openingAnchors(["u1", "a1", "u2"], new Set());
    expect([...opened]).toEqual(["u1", "a1", "u2"]);
    expect(opened.has("sent:q9")).toBe(false);
    // A first message into an empty conversation, claimed by this tab before its row shows.
    expect([...openingAnchors(["sent:q1"], new Set(["sent:q1"]))]).toEqual([]);
  });
  it("history paged in above only prepends; live content with no row to ride in gets one", () => {
    const newer = chatRows(interleave([msg("u2", "user", 600), msg("a2", "assistant", 700)], []).entries, [], false).map((row) => row.id);
    const paged = chatRows(interleave([msg("u1", "user", 100), msg("a1", "assistant", 200), msg("u2", "user", 600), msg("a2", "assistant", 700)], []).entries, [], false).map((row) => row.id);
    expect(paged.slice(-newer.length)).toEqual(newer);
    expect(shapeOf(chatRows([], [], true))).toEqual(["live"]);
    expect(chatRows([], [], false)).toEqual([]);
  });
});
