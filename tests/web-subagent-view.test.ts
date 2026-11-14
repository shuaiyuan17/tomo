import { describe, expect, it } from "vitest";
import { behind, followStep, INITIAL_TRANSCRIPT, POLL_MS, isOutputTask, MAX_KEPT_ITEMS, preview, PREVIEW_CHARS, stripAnsi, transcriptReducer, viewRows,
  type TranscriptAction, type TranscriptState } from "../web/src/subagent.js";
import type { SubagentItem, SubagentPage } from "../src/web/protocol.js";

const textItem = (offset: number, text = `t${offset}`): SubagentItem => ({ kind: "text", id: `${offset}:0`, text, truncated: false });
const page = (items: SubagentItem[], start: number, end: number, hasEarlier = start > 0, size = end): SubagentPage => ({ items, start, end, size, hasEarlier });

describe("subagent transcript modes", () => {
  const T = (overrides: Partial<TranscriptState> = {}): TranscriptState => ({ ...INITIAL_TRANSCRIPT, ...overrides });
  const run = (state: TranscriptState, ...actions: TranscriptAction[]) => actions.reduce(transcriptReducer, state);

  it("follow mode: tail then append; over the cap the oldest whole lines go and Load earlier can re-read them", () => {
    let state = run(T(), { type: "tail", gen: 0, page: page([textItem(100), textItem(200)], 100, 300) });
    state = run(state, { type: "newer", gen: 0, page: page([textItem(200), textItem(300)], 300, 400) });
    expect(state.items.map((i) => i.id)).toEqual(["100:0", "200:0", "300:0"]);
    expect(state).toMatchObject({ end: 400, mode: "follow", status: "ready" });
    const multi = (offset: number, n: number): SubagentItem[] => Array.from({ length: n }, (_, k) => ({ kind: "text", id: `${offset}:${k}`, text: "x", truncated: false }));
    let full = run(T(), { type: "tail", gen: 0, page: page(multi(0, MAX_KEPT_ITEMS - 1), 0, 10) });
    full = run(full, { type: "newer", gen: 0, page: page(multi(10, 3), 10, 20) });
    expect(full.items.every((i) => i.id.startsWith("10:"))).toBe(true);
    expect(full).toMatchObject({ start: 10, hasEarlier: true });
  });

  it("a response from an older generation is dropped (interleaved requests)", () => {
    let state = run(T(), { type: "tail", gen: 0, page: page([textItem(100)], 100, 200) });
    const pollGen = state.gen;
    state = run(state, { type: "browse" });
    // The poll that was in flight when the user started browsing lands late.
    state = run(state, { type: "newer", gen: pollGen, page: page([textItem(200)], 200, 300) });
    expect(state.items.map((i) => i.id)).toEqual(["100:0"]);
    // A jump bumps again: a late page from browsing is dropped too.
    const browseGen = state.gen;
    state = run(state, { type: "jump" });
    state = run(state, { type: "older", gen: browseGen, page: page([textItem(0)], 0, 100) });
    expect(state.items).toEqual([]);
    expect(state.status).toBe("loading");
  });

  it("browse mode: polling results are refused; paging back prepends and over the cap the newest lines go", () => {
    let state = run(T(), { type: "tail", gen: 0, page: page(Array.from({ length: MAX_KEPT_ITEMS }, (_, i) => textItem(1000 + i * 10)), 1000, 1000 + MAX_KEPT_ITEMS * 10) });
    state = run(state, { type: "browse" });
    expect(state.mode).toBe("browse");
    expect(run(state, { type: "newer", gen: state.gen, page: page([textItem(99_999)], 99_999, 100_000) })).toBe(state);
    state = run(state, { type: "older", gen: state.gen, page: page([textItem(980), textItem(990)], 980, 1000, true) });
    expect(state.items).toHaveLength(MAX_KEPT_ITEMS);
    expect(state.items[0].id).toBe("980:0");
    expect(state.items.at(-1)!.id).toBe(`${1000 + (MAX_KEPT_ITEMS - 3) * 10}:0`);
    expect(state.start).toBe(980);
  });

  it("Jump to latest returns to follow with an empty window and a new generation", () => {
    let state = run(T(), { type: "tail", gen: 0, page: page([textItem(100)], 100, 200) }, { type: "browse" });
    const before = state.gen;
    state = run(state, { type: "jump" });
    expect(state).toMatchObject({ mode: "follow", status: "loading", items: [], end: 0, gen: before + 1 });
    state = run(state, { type: "tail", gen: state.gen, page: page([textItem(500)], 500, 600) });
    expect(state).toMatchObject({ status: "ready", end: 600 });
    expect(behind(state)).toBe(false);
  });

  it("after the task ends, follow mode keeps reading a backlog of several pages until it reaches the end", async () => {
    const SIZE = 400;
    const pages: Record<string, SubagentPage> = {
      "": page([textItem(0)], 0, 100, false, 100),
      "?after=100": page([textItem(100)], 100, 200, true, SIZE),
      "?after=200": page([textItem(200)], 200, 300, true, SIZE),
      "?after=300": page([textItem(300)], 300, 400, true, SIZE),
    };
    let state = T();
    const queries: string[] = [];
    const io = (running: boolean) => ({ gen: state.gen, running, get: () => state, apply: (a: TranscriptAction) => { state = transcriptReducer(state, a); },
      fetchPage: async (q: string) => { queries.push(q); return pages[q]; }, classify: () => "error" as const });
    expect(await followStep(io(true))).toBe(POLL_MS);
    // The task ended with three pages still unread.
    const delays: Array<number | null> = [];
    for (let i = 0; i < 6; i++) { const d = await followStep(io(false)); delays.push(d); if (d === null) break; }
    expect(queries).toEqual(["", "?after=100", "?after=200", "?after=300"]);
    expect(delays).toEqual([0, 0, null]);
    expect(state.end).toBe(SIZE);
    expect(state.items).toHaveLength(4);
  });

  it("a late response from a superseded follow step is not applied", async () => {
    let state = run(T(), { type: "tail", gen: 0, page: page([textItem(0)], 0, 100, false, 200) });
    let release!: (p: SubagentPage) => void;
    const pending = followStep({ gen: 0, running: true, get: () => state, apply: (a) => { state = transcriptReducer(state, a); },
      fetchPage: () => new Promise<SubagentPage>((r) => { release = r; }), classify: () => "error" });
    state = run(state, { type: "browse" });
    release(page([textItem(100)], 100, 200, true, 200));
    expect(await pending).toBeNull();
    expect(state.items.map((i) => i.id)).toEqual(["0:0"]);
  });

  it("when the task leaves the panel, it says so, keeps what was read, and accepts nothing more", () => {
    let state = run(T(), { type: "tail", gen: 0, page: page([textItem(100)], 100, 200) });
    state = run(state, { type: "failed", gen: 0, kind: "gone" });
    expect(state).toMatchObject({ status: "gone", items: [{ id: "100:0" }] });
    expect(run(state, { type: "newer", gen: state.gen, page: page([textItem(200)], 200, 300) })).toBe(state);
    // Jump to latest cannot clear what was read once the task is gone.
    expect(run(state, { type: "jump" })).toBe(state);
    // A not-yet-written transcript is "missing", not gone; with content already shown, nothing changes.
    expect(run(T(), { type: "failed", gen: 0, kind: "missing" }).status).toBe("missing");
    const shown = run(T(), { type: "tail", gen: 0, page: page([textItem(1)], 0, 10) });
    expect(run(shown, { type: "failed", gen: 0, kind: "error" })).toBe(shown);
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
