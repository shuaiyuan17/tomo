import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentItem, ToolActivity, ToolOutcome } from "../src/web/protocol.js";
import { groupLabel, groupRows, groupSummary, viewRows, type ToolRow } from "../web/src/subagent.js";
import { activityLine } from "../web/src/activity.js";
import { ToolCall } from "../web/src/tool-calls.js";
import { i18n } from "../web/src/i18n/index.js";

const I = (tool: string) => `mcp__tomo-internal__${tool}`;
let n = 0;
const call = (activity: ToolActivity | undefined, result?: { outcome?: ToolOutcome; isError?: boolean; reason?: string; output?: string }): SubagentItem[] => {
  const id = `u${++n}`;
  const name = I(activity?.kind ?? "task_spawn");
  return [{ kind: "tool", id: `${n}:0`, toolUseId: id, name, summary: `${name}: {"raw":true}`, input: "{}", inputTruncated: false, ts: 1_000,
    ...(activity ? { activity } : {}) },
  ...(result ? [{ kind: "result" as const, id: `${n}:1`, toolUseId: id, output: result.output ?? "ok", truncated: false, isError: result.isError === true, ts: 1_200,
    ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.reason ? { reason: result.reason } : {}) }] : [])];
};
const row = (items: SubagentItem[]) => viewRows(items)[0] as ToolRow;
const html = (r: ToolRow, running = false) => renderToStaticMarkup(createElement(ToolCall, { row: r, running }));
const spawn: ToolActivity = { kind: "task_spawn", title: "Activity cards", brief: "Build them" };

describe("an internal tool's row is a sentence", () => {
  it("success: the sentence with what came of it, never the raw call", () => {
    const shown = html(row(call(spawn, { outcome: { id: "s12", status: "active" } })));
    expect(shown).toContain("Started s12 · Activity cards");
    expect(shown).not.toContain("mcp__tomo-internal__");
    expect(shown).toContain('data-activity="task_spawn"');
    expect(html(row(call({ kind: "todo_list", filter: "all" }, { outcome: { count: 12 } })))).toContain("12 open");
    expect(html(row(call({ kind: "task_status", id: "s3" }, { outcome: { status: "working" } })))).toMatch(/Checked on s3.*working/);
  });
  it("running: the sentence shimmers next to the running mark", () => {
    const shown = html(row(call(spawn)), true);
    expect(shown).toContain("Started a task · Activity cards");
    expect(shown).toContain('data-slot="running-mark"');
  });
  it("failed: the reason the server stripped of its prefix, in the error state", () => {
    const shown = html(row(call({ kind: "todo_add", title: "x", next: "y", waitingOn: "me" },
      { isError: true, reason: "\"2026-11-13\" is not in the future.", output: "todo_add failed: \"2026-11-13\" is not in the future." })));
    expect(shown).toContain("Added a to-do · x");
    expect(shown).toContain("is not in the future.");
    expect(shown).toContain("Failed");
  });
  it("returned normally but nothing happened: said in the warn colour", () => {
    const line = activityLine(row(call({ kind: "schedule_remove", id: "ab12" }, { outcome: { noop: "Job ab12 not found." } })));
    expect(line).toMatchObject({ held: true, detail: "Job ab12 not found." });
    expect(html(row(call({ kind: "task_message", id: "s3", text: "go" }, { outcome: { delivery: "held", noop: "s3 still waits" } })))).toMatch(/Held a note for s3.*text-warn/);
  });
  it("without an activity, or with one this page does not know, it keeps the plain line", () => {
    expect(html(row(call(undefined, {})))).toContain("mcp__tomo-internal__task_spawn: {&quot;raw&quot;:true}");
    const future = row(call({ kind: "memory_teleport" } as unknown as ToolActivity, {}));
    expect(activityLine(future)).toBeUndefined();
    expect(html(future)).toContain("{&quot;raw&quot;:true}");
  });
  it("speaks the reader's language", async () => {
    await i18n.changeLanguage("zh-Hans");
    try {
      expect(html(row(call(spawn, { outcome: { id: "s12" } })))).toContain("开了 s12 · Activity cards");
      expect(groupSummary([row(call({ kind: "pet_feed" }, {})), row(call({ kind: "pet_play" }, {}))])).toBe("照顾了 2 次宠物");
    } finally { await i18n.changeLanguage("en"); }
  });
});

describe("a fold of calls counts internal tools by what they did", () => {
  it("in words, in order of first use", () => {
    const rows = [...call({ kind: "react_to_message", target: "dm:o", reaction: "love" }, {}), ...call({ kind: "pet_feed" }, {}),
      ...call({ kind: "task_status" }, {}), ...call({ kind: "pet_play" }, {})];
    const [block] = groupRows(viewRows(rows));
    expect(block.kind === "group" && groupSummary(block.tools)).toBe("Reacted to a message, looked after the pet 2 times, checked a task");
  });
  it("a running fold names the running call by its sentence", () => {
    const tools = viewRows([...call({ kind: "pet_feed" }, {}), ...call({ kind: "home_check" })]) as ToolRow[];
    expect(groupLabel(tools, true)).toEqual({ lead: "", running: "Checked the home…" });
  });
});
