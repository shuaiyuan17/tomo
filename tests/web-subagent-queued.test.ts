import { describe, expect, it } from "vitest";
import { itemsFromLine } from "../src/web/subagent-reader.js";
import { toolItemsFromLine } from "../src/web/session-tools.js";
import { groupRows, viewRows } from "../web/src/subagent.js";

// Shapes as the SDK (2.1.325) writes them, ids and text replaced.
const toolResult = JSON.stringify({ parentUuid: "p1", isSidechain: true, agentId: "a1", type: "user", timestamp: "2026-11-15T01:15:25.584Z",
  message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "Tests 13 passed", is_error: false }] }, uuid: "u1" });
const queued = JSON.stringify({ parentUuid: "u1", isSidechain: true, agentId: "a1", type: "attachment", uuid: "u2", timestamp: "2026-11-15T01:15:25.588Z",
  attachment: { type: "queued_command", prompt: "One more bug: do it as its own PR.", source_uuid: "s1", origin: { kind: "coordinator" }, isMeta: true, reminderId: "r1" },
  rendered: [{ content: "<system-reminder id=\"r1\">\nThe coordinator sent a message while you were working:\nOne more bug…</system-reminder>" }], renderedRole: "system" });
const blob = JSON.stringify({ type: "api-request-blob", sessionId: "s", agentId: "a1", hash: "h",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Tests 13 passed" }, { type: "text", text: "One more bug: do it as its own PR." }] } });
const otherAttachment = JSON.stringify({ type: "attachment", attachment: { type: "edited_text_file", filename: "/x" }, timestamp: "2026-11-15T01:15:26.000Z" });

describe("messages sent while the subagent is busy (queued_command)", () => {
  it("a queued_command attachment is a message to the subagent, with its prompt and time", () => {
    expect(itemsFromLine(queued, 500)).toEqual([{ kind: "message", id: "500:queued", text: "One more bug: do it as its own PR.", truncated: false, ts: Date.parse("2026-11-15T01:15:25.588Z") }]);
  });
  it("the api-request-blob copy and other attachments show nothing (no duplicate message or result)", () => {
    expect(itemsFromLine(blob, 900)).toEqual([]);
    expect(itemsFromLine(otherAttachment, 950)).toEqual([]);
  });
  it("in order: the result, then the message — which splits the run of calls like any message", () => {
    const tool = JSON.stringify({ type: "assistant", timestamp: "2026-11-15T01:15:20.000Z", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] } });
    const items = [tool, toolResult, queued, blob].flatMap((line, i) => itemsFromLine(line, i * 100 + 1));
    expect(groupRows(viewRows(items)).map((b) => b.kind)).toEqual(["tool", "message"]);
  });
  it("the main chat's inline calls never pick these up (its own history has the messages)", () => {
    expect(toolItemsFromLine(queued, 10)).toEqual([]);
    expect(toolItemsFromLine(blob, 20)).toEqual([]);
  });
});
