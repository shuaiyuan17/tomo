import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUnreadable, parseEntry, reportUnreadable, setUnreadableReporter, type UnreadableReport } from "../src/web/sdk-transcript.js";
import { readSubagentPage } from "../src/web/subagent-reader.js";
import { readSessionTools, toolItemsFromLine } from "../src/web/session-tools.js";

const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: "2026-11-15T10:00:00.000Z", message: { role: type, content } });

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

describe("thinking in the main chat", () => {
  // In a subagent transcript: web-subagent-reader.test.ts. A withheld output's image count: web-turn-items.test.ts.
  it("the main chat never gets thinking", () => {
    const thinking = line("assistant", [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }]);
    expect(toolItemsFromLine(thinking, 0).map((i) => i.kind)).toEqual(["tool"]);
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
