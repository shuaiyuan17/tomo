import { describe, expect, it } from "vitest";
import { elapsedSince, groupLabel, groupOpen, groupStart, groupRows, groupSummary, pendingTool, viewRows, type ToolRow } from "../web/src/subagent.js";
import type { SubagentItem } from "../src/web/protocol.js";

let n = 0;
const text = (t: string): SubagentItem => ({ kind: "text", id: `${++n}:0`, text: t, truncated: false });
const call = (name: string, id: string, done = true): SubagentItem[] => [
  { kind: "tool", id: `${++n}:0`, toolUseId: id, name, summary: `${name} x`, input: "{}", inputTruncated: false },
  ...(done ? [{ kind: "result" as const, id: `${++n}:0`, toolUseId: id, output: "ok", truncated: false, isError: false }] : []),
];
const shape = (items: SubagentItem[]) => groupRows(viewRows(items)).map((b) => b.kind === "group" ? `group:${b.key}:${b.tools.length}` : b.kind === "tool" ? `tool:${b.row.toolUseId}` : b.kind);

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

  it("a message sent to the subagent also splits a run, and is its own block", () => {
    const msg: SubagentItem = { kind: "message", id: `${++n}:msg`, text: "Also check the tests", truncated: false };
    expect(shape([...call("Read", "m1"), ...call("Read", "m2"), msg, ...call("Bash", "m3"), ...call("Bash", "m4")]))
      .toEqual(["group:m1:2", "text", "group:m3:2"].map((x) => x === "text" ? "message" : x));
  });

  it("summarises by what the calls did, in order of first use", () => {
    const tools = viewRows([...call("Read", "1"), ...call("Bash", "2"), ...call("Read", "3"), ...call("Grep", "4"), ...call("Bash", "5"), ...call("Read", "6"), ...call("Edit", "7")]) as ToolRow[];
    expect(groupSummary(tools)).toBe("Read 3 files, ran 2 commands, ran a search, edited a file");
    const mixed = [{ name: "mcp__tomo-internal__recall" }, { name: "Edit" }, { name: "Write" }, { name: "Agent" }, { name: "WebFetch" }, { name: "Glob" }, { name: "Grep" }] as ToolRow[];
    expect(groupSummary(mixed)).toBe("Used a tool, edited 2 files, started a subagent, looked up a page, ran 2 searches");
    expect(pendingTool(tools)).toBeUndefined();
    const running = viewRows([...call("Read", "1"), ...call("Bash", "2", false)]) as ToolRow[];
    expect(pendingTool(running)?.name).toBe("Bash");
  });

  it("a closed running group says only what it is doing now: the latest call by its title; the summary comes when the turn is over", () => {
    const running = viewRows([...call("Read", "1"), ...call("Read", "2"), ...call("Bash", "3", false)]) as ToolRow[];
    const pending = pendingTool(running)!;
    expect(groupLabel(running, true)).toEqual({ lead: "", running: `${pending.summary || "Bash"}…` });
    const described = { ...pending, summary: "Run the test suite" };
    expect(groupLabel([described], true)).toEqual({ lead: "", running: "Run the test suite…" });
    // Between two calls the latest finished one is still what the line says, without the ellipsis.
    const finished = viewRows([...call("Read", "1"), ...call("Bash", "2")]) as ToolRow[];
    expect(groupLabel(finished, true)).toEqual({ lead: "", running: finished[1].summary });
    expect(groupLabel(running)).toEqual({ lead: groupSummary(running) });
  });

  it("open state: every group starts closed, the running last one too; the reader's choice sticks to the key", () => {
    expect(groupOpen({}, "k")).toBe(false);
    expect(groupOpen({ k: false }, "k")).toBe(false);
    expect(groupOpen({ k: true }, "k")).toBe(true);
    // The key survives growth, so a stored choice keeps applying after new calls arrive.
    const before = groupRows(viewRows([...call("Read", "g1"), ...call("Read", "g2")]));
    const after = groupRows(viewRows([...call("Read", "g1"), ...call("Read", "g2"), ...call("Bash", "g3")]));
    expect(before[0].kind === "group" && after[0].kind === "group" && before[0].key === after[0].key).toBe(true);
  });

  it("a running step counts from its first call; nothing in the first second or without a start", () => {
    const tools = [{ ts: 5_000 }, { ts: 2_000 }, {}] as ToolRow[];
    expect(groupStart(tools)).toBe(2_000);
    expect(groupStart([{} as ToolRow])).toBeUndefined();
    expect(elapsedSince(2_000, 25_400)).toBe("23s");
    expect(elapsedSince(2_000, 305_000)).toBe("5m 3s");
    expect(elapsedSince(2_000, 2_400)).toBeUndefined();
    // A phone whose clock is behind the Mac's never shows a negative time.
    expect(elapsedSince(9_000, 2_000)).toBeUndefined();
    expect(elapsedSince(undefined, 9_000)).toBeUndefined();
  });
});
