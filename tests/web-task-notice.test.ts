import { describe, expect, it } from "vitest";
import { BACKGROUND_TASK_TOOL, mayHoldToolBlocks, SUBAGENT_MESSAGE_TOOL, taskNotice } from "../src/web/sdk-transcript.js";
import { itemsFromLine } from "../src/web/subagent-reader.js";
import { toolItemsFromLine } from "../src/web/session-tools.js";
import { toolTitle } from "../src/agent/tool-summary.js";
import { groupSummary, viewRows, type ToolRow } from "../web/src/subagent.js";

const NOTICE = `<task-notification>
<task-id>a9e7</task-id>
<tool-use-id>toolu_01</tool-use-id>
<status>completed</status>
<summary>Agent "Study model picker" finished</summary>
<result>The picker is in. Nine tests pass.</result>
<usage><total_tokens>266073</total_tokens></usage>
</task-notification>`;
const line = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", isSidechain: false, timestamp: "2026-11-15T04:00:00.000Z", message: { role: "user", content }, ...extra });

describe("task notifications: a background task reporting back", () => {
  it("reads a subagent's hand-back: who, how it ended, and its report", () => {
    expect(taskNotice(NOTICE)).toEqual({ subagent: true, name: "Study model picker", status: "completed", text: "The picker is in. Nine tests pass." });
  });
  it("reads a background command, a bare envelope, and nothing from ordinary text", () => {
    expect(taskNotice("<task-notification><status>completed</status><summary>Background command \"npm test\" completed (exit code 0)</summary></task-notification>"))
      .toEqual({ subagent: false, name: 'Background command "npm test" completed (exit code 0)', status: "completed", text: "" });
    expect(taskNotice("<task-notification>background task complete</task-notification>")).toEqual({ subagent: false, name: "Background task", text: "background task complete" });
    expect(taskNotice("Please read <task-notification> for me")).toBeUndefined();
    expect(taskNotice("hello")).toBeUndefined();
  });

  it("becomes a titled step that opens to the report, in the main chat and the subagent view", () => {
    const text = line([{ type: "text", text: NOTICE }]);
    expect(mayHoldToolBlocks(text)).toBe(true);
    for (const items of [toolItemsFromLine(text, 500), itemsFromLine(text, 500)]) {
      expect(items).toEqual([
        { kind: "tool", id: "500:notice", toolUseId: "notice:500", name: SUBAGENT_MESSAGE_TOOL, summary: "Message from subagent · Study model picker", input: "", inputTruncated: false, ts: Date.parse("2026-11-15T04:00:00.000Z") },
        { kind: "result", id: "500:notice-result", toolUseId: "notice:500", output: "The picker is in. Nine tests pass.", truncated: false, isError: false, ts: Date.parse("2026-11-15T04:00:00.000Z") },
      ]);
    }
    // As a string-content entry, and a failed one.
    const failed = toolItemsFromLine(line(NOTICE.replace("completed", "failed")), 7);
    expect(failed.map((item) => item.kind === "result" ? item.isError : item.kind)).toEqual(["tool", true]);
    const shell = toolItemsFromLine(line("<task-notification><summary>Background command finished</summary></task-notification>"), 9);
    expect(shell[0]).toMatchObject({ name: BACKGROUND_TASK_TOOL, summary: "Background task · Background command finished" });
    expect(shell[1]).toMatchObject({ output: "(no report text)" });
  });

  it("is never read from a sidechain line or from a person's ordinary message in the main chat", () => {
    expect(toolItemsFromLine(line([{ type: "text", text: NOTICE }], { isSidechain: true }), 1)).toEqual([]);
    expect(toolItemsFromLine(line([{ type: "text", text: "what does <task-notification> mean?" }]), 1)).toEqual([]);
  });

  it("scrubs a secret out of the title and the report, and bounds the report", () => {
    const secret = "sk-ant-api03-" + "a".repeat(40);
    const items = toolItemsFromLine(line(NOTICE.replace("Study model picker", `deploy with ${secret}`).replace("Nine tests pass.", `key ${secret} ` + "x".repeat(9_000))), 3);
    expect(JSON.stringify(items)).not.toContain(secret);
    expect(items[1]).toMatchObject({ truncated: true });
  });

  it("counts in a group as hearing from a subagent, and a subagent's own call is titled by what it was sent to do", () => {
    const rows = viewRows(toolItemsFromLine(line([{ type: "text", text: NOTICE }]), 500)) as ToolRow[];
    expect(groupSummary([rows[0], rows[0]])).toBe("Heard from 2 subagents");
    expect(groupSummary([{ name: BACKGROUND_TASK_TOOL } as ToolRow])).toBe("Finished a background task");
    expect(toolTitle("Agent", { subagent_type: "Explore", description: "Find the scroll code", prompt: "…" })).toBe("Subagent · Find the scroll code");
    expect(toolTitle("Agent", { subagent_type: "Explore" })).toContain("Agent");
  });
});
