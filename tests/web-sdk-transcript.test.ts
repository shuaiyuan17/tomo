import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUnreadable, parseEntry, reportUnreadable, setUnreadableReporter, type UnreadableReport } from "../src/web/sdk-transcript.js";
import { itemsFromLine, readSubagentPage } from "../src/web/subagent-reader.js";
import { pairOutputs, PRIVATE_HIDDEN, readSessionTools, toolItemsFromLine } from "../src/web/session-tools.js";

const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: "2026-11-15T10:00:00.000Z", message: { role: type, content } });
const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA=" } };

let root: string;
let reports: UnreadableReport[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-sdk-transcript-"));
  reports = [];
  setUnreadableReporter((report) => reports.push(report));
});
afterEach(() => { setUnreadableReporter(undefined); rmSync(root, { recursive: true, force: true }); });

describe("parseEntry", () => {
  it("bookkeeping records are not problems; malformed or unknown content is", () => {
    for (const record of [{ type: "queue-operation", operation: "enqueue" }, { type: "attachment", attachment: { type: "date" } }, { type: "system", subtype: "x" },
      { type: "api-request-blob", message: { content: "x" } }]) {
      expect(parseEntry(JSON.stringify(record)).problems).toEqual([]);
    }
    expect(parseEntry("{not json").problems).toEqual(["not_json"]);
    expect(parseEntry("[1,2]").problems).toEqual(["no_type"]);
    expect(parseEntry(JSON.stringify({ kind: "assistant" })).problems).toEqual(["no_type"]);
    expect(parseEntry(JSON.stringify({ type: "assistant", msg: { content: [] } })).problems).toEqual(["no_content"]);
    expect(parseEntry(line("assistant", [{ type: "tool_use", id: "t1" }])).problems).toEqual(["bad_block"]);
    expect(parseEntry(line("assistant", [{ type: "hologram", data: 1 }])).problems).toEqual(["unknown_block"]);
    // Known blocks the views do not show are fine.
    expect(parseEntry(line("assistant", [{ type: "redacted_thinking", data: "x" }, { type: "server_tool_use", id: "s", name: "web_search" },
      { type: "web_search_tool_result", content: [] }])).problems).toEqual([]);
  });
});

describe("thinking and images in a subagent transcript", () => {
  it("non-empty thinking is an item, clipped like text; empty or redacted thinking is nothing", () => {
    const items = itemsFromLine(line("assistant", [{ type: "thinking", thinking: "Check the pager first.", signature: "s" },
      { type: "thinking", thinking: "  ", signature: "s" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "On it." }]), 10);
    expect(items).toEqual([
      { kind: "thinking", id: "10:0", text: "Check the pager first.", truncated: false, ts: Date.parse("2026-11-15T10:00:00.000Z") },
      { kind: "text", id: "10:3", text: "On it.", truncated: false, ts: Date.parse("2026-11-15T10:00:00.000Z") },
    ]);
    const [long] = itemsFromLine(line("assistant", [{ type: "thinking", thinking: "t".repeat(9_000) }]), 20);
    expect(long).toMatchObject({ kind: "thinking", truncated: true });
  });

  it("an image in a tool result is counted, never written as text or carried", () => {
    const [result] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "saved" }, png, png] }]), 30);
    expect(result).toMatchObject({ kind: "result", output: "saved", images: 2 });
    expect(JSON.stringify(result)).not.toContain("[image]");
    expect(JSON.stringify(result)).not.toContain("iVBORw0KGgo");
    const [only] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "t2", content: [png] }]), 40);
    expect(only).toMatchObject({ output: "", images: 1 });
    // Other non-text parts keep their [type] label.
    const [doc] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "document", source: {} }] }]), 50);
    expect(doc).toMatchObject({ output: "[document]" });
    expect(doc).not.toHaveProperty("images");
  });

  it("the main chat never gets thinking, and a withheld output loses its image count too", () => {
    const thinking = line("assistant", [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }]);
    expect(toolItemsFromLine(thinking, 0).map((i) => i.kind)).toEqual(["tool"]);
    const items = [...toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "p1", name: "Read", input: { file_path: "/w/memory/private/a.png" } }]), 0),
      ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "p1", content: [png] }]), 100)];
    const [, result] = pairOutputs(items);
    expect(result).toMatchObject({ kind: "result", output: PRIVATE_HIDDEN });
    expect(result).not.toHaveProperty("images");
    const [unpaired] = pairOutputs(toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "zz", content: [png] }]), 0));
    expect(unpaired).not.toHaveProperty("images");
  });
});

describe("unreadable entries are said, not dropped in silence", () => {
  const SDK = "sdk-session-1";
  const file = (task: string) => join(root, SDK, "subagents", `agent-${task}.jsonl`);
  beforeEach(() => mkdirSync(join(root, SDK, "subagents"), { recursive: true }));

  it("a subagent page counts the lines it could not read and reports the file once", async () => {
    // As if the SDK had renamed `message`: every entry is unreadable, and the view says so instead of showing nothing.
    const changed = (type: string, content: unknown) => JSON.stringify({ type, timestamp: "2026-11-15T10:00:00.000Z", payload: { role: type, content } });
    writeFileSync(file("a1"), [changed("user", "brief"), changed("assistant", [{ type: "text", text: "hi" }]), line("assistant", [{ type: "text", text: "still read" }])].join("\n") + "\n");
    const page = await readSubagentPage(root, SDK, "a1");
    expect(page.items.map((i) => i.kind)).toEqual(["text"]);
    expect(page.unreadable).toBe(2);
    await readSubagentPage(root, SDK, "a1", { after: 0 });
    expect(reports).toEqual([{ view: "subagent", count: 2, problems: ["no_content"] }]);
    // A clean file reports nothing and carries no field.
    writeFileSync(file("a2"), line("assistant", [{ type: "text", text: "fine" }]) + "\n");
    expect(await readSubagentPage(root, SDK, "a2")).not.toHaveProperty("unreadable");
    expect(reports).toHaveLength(1);
  });

  it("the main chat's scan counts unreadable tool lines", async () => {
    writeFileSync(join(root, `${SDK}.jsonl`), [line("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      JSON.stringify({ type: "assistant", message: { content: { type: "tool_use" } } })].join("\n") + "\n");
    const page = await readSessionTools(root, SDK, { from: 0 });
    expect(page.unreadable).toBe(1);
    expect(reports).toEqual([{ view: "session", count: 1, problems: ["no_content"] }]);
  });

  it("reports once per file, and the daemon's line accepts only enumerated fields", () => {
    reportUnreadable("/x/a.jsonl", "subagent", 3, ["unknown_block", "not_json", "unknown_block"]);
    reportUnreadable("/x/a.jsonl", "subagent", 5, ["not_json"]);
    reportUnreadable("/x/b.jsonl", "subagent", 0, []);
    expect(reports).toEqual([{ view: "subagent", count: 3, problems: ["not_json", "unknown_block"] }]);
    expect(describeUnreadable({ view: "subagent", count: 3, problems: ["not_json"] })).toMatch(/A subagent transcript has 3 entries .*\(not_json\)/);
    expect(describeUnreadable({ view: "session", count: 1, problems: ["bad_block"] })).toMatch(/1 entry/);
    expect(describeUnreadable({ view: "other", count: 1, problems: [] })).toBeUndefined();
    expect(describeUnreadable({ view: "session", count: 0, problems: [] })).toBeUndefined();
    expect(describeUnreadable({ view: "session", count: 1, problems: ["/etc/passwd"] })).toBeUndefined();
  });
});
