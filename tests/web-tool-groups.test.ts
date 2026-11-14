import { describe, expect, it } from "vitest";
import { groupOpen, groupRows, groupSummary, pendingTool, viewRows, type ToolRow } from "../web/src/subagent.js";
import type { SubagentItem } from "../src/web/protocol.js";

let n = 0;
const text = (t: string): SubagentItem => ({ kind: "text", id: `${++n}:0`, text: t, truncated: false });
const call = (name: string, id: string, done = true): SubagentItem[] => [
  { kind: "tool", id: `${++n}:0`, toolUseId: id, name, summary: `${name} x`, input: "{}", inputTruncated: false },
  ...(done ? [{ kind: "result" as const, id: `${++n}:0`, toolUseId: id, output: "ok", truncated: false, isError: false }] : []),
];
const shape = (items: SubagentItem[]) => groupRows(viewRows(items)).map((b) => b.kind === "group" ? `group:${b.key}:${b.tools.length}` : b.kind === "tool" ? `tool:${b.row.toolUseId}` : "text");

describe("tool-call groups", () => {
  it("text splits calls into groups; a single call stays a plain row", () => {
    const items = [...call("Read", "t1"), ...call("Bash", "t2"), text("found it"), ...call("Grep", "t3"), text("next"), ...call("Read", "t4"), ...call("Edit", "t5"), ...call("Read", "t6")];
    expect(shape(items)).toEqual(["group:t1:2", "text", "tool:t3", "text", "group:t4:3"]);
  });

  it("appending calls grows the last group under the same key", () => {
    const first = [text("start"), ...call("Read", "a1"), ...call("Read", "a2")];
    expect(shape(first)).toEqual(["text", "group:a1:2"]);
    const more = [...first, ...call("Bash", "a3", false)];
    expect(shape(more)).toEqual(["text", "group:a1:3"]);
    // A lone call becomes a group (keyed by itself) once a second one follows.
    expect(shape([text("x"), ...call("Read", "b1")])).toEqual(["text", "tool:b1"]);
    expect(shape([text("x"), ...call("Read", "b1"), ...call("Grep", "b2")])).toEqual(["text", "group:b1:2"]);
  });

  it("summarises by tool, most used first", () => {
    const tools = viewRows([...call("Read", "1"), ...call("Bash", "2"), ...call("Read", "3"), ...call("Grep", "4"), ...call("Bash", "5"), ...call("Read", "6"), ...call("Edit", "7")]) as ToolRow[];
    expect(groupSummary(tools)).toBe("7 tool calls · Read ×3, Bash ×2, Grep, Edit");
    expect(pendingTool(tools)).toBeUndefined();
    const running = viewRows([...call("Read", "1"), ...call("Bash", "2", false)]) as ToolRow[];
    expect(pendingTool(running)?.name).toBe("Bash");
  });

  it("open state: the reader's choice sticks to the key; by default only the growing last group while running", () => {
    expect(groupOpen({}, "k", true, true)).toBe(true);
    expect(groupOpen({}, "k", false, true)).toBe(false);
    expect(groupOpen({}, "k", true, false)).toBe(false);
    expect(groupOpen({ k: false }, "k", true, true)).toBe(false);
    expect(groupOpen({ k: true }, "k", false, false)).toBe(true);
    // The key survives growth, so a stored choice keeps applying after new calls arrive.
    const before = groupRows(viewRows([...call("Read", "g1"), ...call("Read", "g2")]));
    const after = groupRows(viewRows([...call("Read", "g1"), ...call("Read", "g2"), ...call("Bash", "g3")]));
    expect(before[0].kind === "group" && after[0].kind === "group" && before[0].key === after[0].key).toBe(true);
  });
});
