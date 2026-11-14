import { describe, expect, it } from "vitest";
import { EMPTY_TRANSCRIPT, hasNewer, isOutputTask, MAX_KEPT_ITEMS, mergePage, preview, PREVIEW_CHARS, stripAnsi, viewRows } from "../web/src/subagent.js";
import type { SubagentItem, SubagentPage } from "../src/web/protocol.js";

const textItem = (offset: number, text = `t${offset}`): SubagentItem => ({ kind: "text", id: `${offset}:0`, text, truncated: false });
const page = (items: SubagentItem[], start: number, end: number, hasEarlier = start > 0, size = end): SubagentPage => ({ items, start, end, size, hasEarlier });

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

  it("paging back past the cap drops the newest lines and rolls the tail cursor back, so nothing is lost for good", () => {
    const N = MAX_KEPT_ITEMS;
    // The newest N lines are loaded (offsets N*10 .. 2N*10), the file ends at 2N*10.
    let state = mergePage(EMPTY_TRANSCRIPT, page(Array.from({ length: N }, (_, i) => textItem((N + i) * 10)), N * 10, 2 * N * 10), "tail");
    expect(hasNewer(state)).toBe(false);
    state = mergePage(state, page([textItem((N - 2) * 10), textItem((N - 1) * 10)], (N - 2) * 10, N * 10, true, 2 * N * 10), "older");
    expect(state.items).toHaveLength(N);
    expect(state.items[0].id).toBe(`${(N - 2) * 10}:0`);
    const lastKept = Number(state.items.at(-1)!.id.split(":")[0]);
    expect(state.end).toBe(lastKept + 10);
    expect(hasNewer(state)).toBe(true);
    // Reading forward from the rolled-back end returns the dropped lines.
    const again = mergePage(state, page([textItem(lastKept + 10), textItem(lastKept + 20)], lastKept + 10, 2 * N * 10, true, 2 * N * 10), "newer");
    expect(again.items.some((i) => i.id === `${lastKept + 20}:0`)).toBe(true);
    expect(hasNewer(again)).toBe(false);
  });

  it("dropping is by whole lines", () => {
    const multi = (offset: number, n: number): SubagentItem[] => Array.from({ length: n }, (_, i) => ({ kind: "text", id: `${offset}:${i}`, text: "x", truncated: false }));
    let state = mergePage(EMPTY_TRANSCRIPT, page(multi(0, MAX_KEPT_ITEMS - 1), 0, 10), "tail");
    state = mergePage(state, page(multi(10, 3), 10, 20), "newer");
    expect(state.items.every((i) => i.id.startsWith("10:"))).toBe(true);
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
