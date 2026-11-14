import { describe, expect, it } from "vitest";
import { EMPTY_TRANSCRIPT, isOutputTask, MAX_KEPT_ITEMS, mergePage, preview, PREVIEW_CHARS, stripAnsi, viewRows } from "../web/src/subagent.js";
import type { SubagentItem, SubagentPage } from "../src/web/protocol.js";

const textItem = (offset: number, text = `t${offset}`): SubagentItem => ({ kind: "text", id: `${offset}:0`, text, truncated: false });
const page = (items: SubagentItem[], start: number, end: number, hasEarlier = start > 0): SubagentPage => ({ items, start, end, size: end, hasEarlier });

describe("subagent view state", () => {
  it("tail, older and newer pages merge in order without duplicates", () => {
    let state = mergePage(EMPTY_TRANSCRIPT, page([textItem(100), textItem(200)], 100, 300), "tail");
    state = mergePage(state, page([textItem(0), textItem(50)], 0, 100), "older");
    expect(state).toMatchObject({ start: 0, end: 300, hasEarlier: false });
    state = mergePage(state, page([textItem(200), textItem(300)], 300, 400), "newer");
    expect(state.items.map((i) => i.id)).toEqual(["0:0", "50:0", "100:0", "200:0", "300:0"]);
    expect(state.end).toBe(400);
    // An empty poll never moves the tail cursor back.
    expect(mergePage(state, page([], 400, 400), "newer").end).toBe(400);
  });

  it("keeps a bounded number of items; dropping old ones makes them pageable again", () => {
    let state = mergePage(EMPTY_TRANSCRIPT, page(Array.from({ length: MAX_KEPT_ITEMS }, (_, i) => textItem(i * 10)), 0, MAX_KEPT_ITEMS * 10), "tail");
    state = mergePage(state, page([textItem(MAX_KEPT_ITEMS * 10)], MAX_KEPT_ITEMS * 10, MAX_KEPT_ITEMS * 10 + 10), "newer");
    expect(state.items).toHaveLength(MAX_KEPT_ITEMS);
    expect(state.items[0].id).toBe("10:0");
    expect(state).toMatchObject({ start: 10, hasEarlier: true });
  });

  it("pairs tool calls with results that arrive later, and leaves unmatched calls running", () => {
    const items: SubagentItem[] = [
      { kind: "tool", id: "1:0", toolUseId: "t1", name: "Read", summary: "Read a.ts", input: "{}", inputTruncated: false },
      { kind: "tool", id: "2:0", toolUseId: "t2", name: "Bash", summary: "Bash: npm test", input: "{}", inputTruncated: false },
      textItem(3, "thinking aloud"),
      { kind: "result", id: "4:0", toolUseId: "t1", output: "ok", truncated: false, isError: false },
    ];
    expect(viewRows(items)).toMatchObject([
      { kind: "tool", summary: "Read a.ts", result: { output: "ok" } },
      { kind: "tool", summary: "Bash: npm test" },
      { kind: "text", text: "thinking aloud" },
    ]);
    expect((viewRows(items)[1] as { result?: unknown }).result).toBeUndefined();
  });

  it("previews long text with a capped Show more, strips escapes, and knows output tasks", () => {
    expect(preview("short", false)).toEqual({ text: "short", more: false });
    expect(preview("x".repeat(PREVIEW_CHARS + 1), false)).toEqual({ text: "x".repeat(PREVIEW_CHARS), more: true });
    expect(preview("x".repeat(PREVIEW_CHARS + 1), true).more).toBe(false);
    expect(stripAnsi("\u001b[32m ✓\u001b[0m pass \u001b]0;title\u0007done")).toBe(" ✓ pass done");
    expect([isOutputTask("local_bash"), isOutputTask("monitor"), isOutputTask("local_agent")]).toEqual([true, true, false]);
  });
});
