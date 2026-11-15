import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { splitThinking, THINKING_MARKER } from "../web/src/thinking.js";
import { THINKING_MARKER as SERVER_MARKER, renderResponseBlocks } from "../src/agent/block-render.js";
import { MessageBody } from "../web/src/message-body.js";
import { groupRows, INITIAL_TRANSCRIPT, transcriptReducer, viewRows } from "../web/src/subagent.js";
import { mergeTools, NO_TOOLS } from "../web/src/inline-tools.js";
import type { SubagentItem, SubagentPage } from "../src/web/protocol.js";

const M = THINKING_MARKER;

describe("splitThinking", () => {
  it("uses the marker the server writes", () => { expect(M).toBe(SERVER_MARKER); });

  it("a body without the marker is returned whole, as is", () => {
    for (const mode of ["block", "joined"] as const) expect(splitThinking("Hi.\n\nTwo  lines\n", mode)).toEqual([{ kind: "reply", text: "Hi.\n\nTwo  lines\n" }]);
  });

  it("block: a live block is thinking exactly when it starts with the marker — all of it", () => {
    expect(splitThinking(`${M}Plan:\n- one\n- two`, "block")).toEqual([{ kind: "thinking", text: "Plan:\n- one\n- two" }]);
    expect(splitThinking(`Quote: ${M}not thinking`, "block")).toEqual([{ kind: "reply", text: `Quote: ${M}not thinking` }]);
    expect(splitThinking(M, "block")).toEqual([]);
  });

  it("joined: recovers the blocks renderResponseBlocks joined, for paragraph-shaped thinking", () => {
    const turn = renderResponseBlocks([
      { type: "thinking", text: "First paragraph of reasoning.\n\nSecond paragraph." },
      { type: "text", text: "The reply.\n\nIts second paragraph." },
      { type: "thinking", text: "More reasoning." },
      { type: "text", text: "A closing line." },
    ], true).text;
    expect(splitThinking(turn, "joined")).toEqual([
      { kind: "thinking", text: "First paragraph of reasoning.\n\nSecond paragraph." },
      { kind: "reply", text: "The reply.\n\nIts second paragraph." },
      { kind: "thinking", text: "More reasoning." },
      { kind: "reply", text: "A closing line." },
    ]);
    // Two thinking blocks in a row stay two.
    expect(splitThinking(renderResponseBlocks([{ type: "thinking", text: "a" }, { type: "thinking", text: "b" }, { type: "text", text: "c" }], true).text, "joined"))
      .toEqual([{ kind: "thinking", text: "a" }, { kind: "thinking", text: "b" }, { kind: "reply", text: "c" }]);
  });

  it("joined: thinking with a single line break ends early — the reply is never folded away", () => {
    const turn = renderResponseBlocks([{ type: "thinking", text: "Steps:\n- read\n- fix" }, { type: "text", text: "Fixed." }], true).text;
    const segments = splitThinking(turn, "joined");
    expect(segments[0]).toEqual({ kind: "thinking", text: "Steps:" });
    expect(segments.at(-1)!.text.endsWith("Fixed.")).toBe(true);
    expect(segments.filter((s) => s.kind === "reply").map((s) => s.text).join("\n")).toContain("Fixed.");
  });
});

describe("thinking in the chat", () => {
  const html = (body: string, thinking?: "block" | "joined") => renderToStaticMarkup(createElement(MessageBody, { body, sessionId: "s1", thinking }));

  it("renders a folded, sans Thinking row instead of a reply paragraph", () => {
    const out = html(`${M}Weighing the two options.\nHere is the answer.`, "joined");
    expect(out).toContain(">Thinking</span>");
    expect(out).toContain("font-sans");
    expect(out).not.toContain("💭");
    // Folded: the reasoning is not in the page until it is opened; the reply is.
    expect(out).not.toContain("Weighing the two options.");
    expect(out).toContain("Here is the answer.");
  });

  it("only where asked: a user's message that starts with the marker stays text", () => {
    expect(html(`${M}just an emoji`)).toContain("💭 just an emoji");
  });
});

describe("thinking and image rows in the task view", () => {
  let n = 0;
  const think = (t: string): SubagentItem => ({ kind: "thinking", id: `${++n}:0`, text: t, truncated: false });
  const text = (t: string): SubagentItem => ({ kind: "text", id: `${++n}:0`, text: t, truncated: false });
  const call = (id: string): SubagentItem[] => [
    { kind: "tool", id: `${++n}:0`, toolUseId: id, name: "Read", summary: "Read x", input: "{}", inputTruncated: false },
    { kind: "result", id: `${++n}:0`, toolUseId: id, output: "ok", truncated: false, isError: false },
  ];
  const shape = (items: SubagentItem[]) => groupRows(viewRows(items)).map((b) => b.kind === "group" ? `group:${b.key}:${b.tools.length}:${b.steps.length}` : b.kind);

  it("thinking is a step: it folds into a run of calls and never breaks one", () => {
    expect(shape([think("a"), ...call("t1"), think("b"), ...call("t2"), text("done")])).toEqual(["group:t1:2:4", "text"]);
    expect(shape([think("a"), ...call("t1"), text("done")])).toEqual(["thinking", "tool", "text"]);
    expect(shape([think("only"), text("x")])).toEqual(["thinking", "text"]);
  });

  it("an image output shows as a chip, never as [image]", () => {
    const [row] = viewRows([{ kind: "tool", id: "1:0", toolUseId: "i1", name: "Read", summary: "Read shot.png", input: "{}", inputTruncated: false },
      { kind: "result", id: "2:0", toolUseId: "i1", output: "", truncated: false, isError: false, images: 1 }]);
    expect(row).toMatchObject({ kind: "tool", result: { images: 1 } });
    expect(row.kind === "tool" && row.result?.images).toBe(1);
  });

  it("the transcript remembers that a page had unreadable lines until a jump", () => {
    const page = (over: Partial<SubagentPage>): SubagentPage => ({ items: [], start: 0, end: 10, size: 10, hasEarlier: false, ...over });
    let state = transcriptReducer(INITIAL_TRANSCRIPT, { type: "tail", gen: 0, page: page({ unreadable: 2 }) });
    expect(state.unreadable).toBe(true);
    state = transcriptReducer(state, { type: "newer", gen: 0, page: page({ end: 20, size: 20 }) });
    expect(state.unreadable).toBe(true);
    expect(transcriptReducer(state, { type: "jump" }).unreadable).toBe(false);
    const tools = mergeTools(NO_TOOLS, { items: [], end: 5, transcript: "x", complete: true, unreadable: 1 }, "full");
    expect(mergeTools(tools, { items: [], end: 9, transcript: "x", complete: true }, "newer").unreadable).toBe(true);
    expect(mergeTools(tools, { items: [], end: 9, transcript: "x", complete: true }, "full").unreadable).toBe(false);
  });
});
