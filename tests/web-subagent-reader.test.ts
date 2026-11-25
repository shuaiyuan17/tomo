import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_LIMIT, IO_LIMIT, itemsFromLine, readSubagentBrief, readSubagentModel, MAX_LINE_BYTES, MAX_LINE_ITEMS, MAX_PAGE_ITEMS, PAGE_BYTES, readSubagentPage, SubagentReadError } from "../src/web/subagent-reader.js";
import { toolItemsFromLine } from "../src/web/session-tools.js";
import { groupRows, viewRows } from "../web/src/subagent.js";

let root: string;
let dir: string;
const SDK = "sdk-session-1";
const file = (task = "a1") => join(dir, SDK, "subagents", `agent-${task}.jsonl`);
const line = (type: string, content: unknown[]) => JSON.stringify({ type, timestamp: "2026-11-14T10:00:00.000Z", message: { role: type, content } }) + "\n";
const text = (t: string) => line("assistant", [{ type: "text", text: t }]);
const tool = (id: string, name: string, input: unknown, output: string, isError = false) =>
  line("assistant", [{ type: "tool_use", id, name, input }]) + line("user", [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-subagent-"));
  dir = join(root, "projects");
  mkdirSync(join(dir, SDK, "subagents"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("subagent transcript items", () => {
  it("keeps assistant text, tool calls and results; drops the prompt; clips and scrubs", () => {
    // The first entry (offset 0) is the brief, served separately: never repeated as an item.
    expect(itemsFromLine(line("user", [{ type: "text", text: "the brief" }]), 0)).toEqual([]);
    const [call] = itemsFromLine(line("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } }]), 10);
    expect(call).toMatchObject({ kind: "tool", id: "10:0", toolUseId: "t1", name: "Read", summary: "Read /repo/a.ts" });
    const [result] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x".repeat(IO_LIMIT + 50) }] }]), 20);
    expect(result).toMatchObject({ kind: "result", toolUseId: "t1", truncated: true, isError: false });
    expect((result as { output: string }).output).toHaveLength(IO_LIMIT);
    const secret = "sk-ant-api03-" + "A".repeat(90);
    const [scrubbed] = itemsFromLine(text(`token ${secret}`), 30);
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
    expect(itemsFromLine("not json", 0)).toEqual([]);
  });
});

describe("thinking and images in a subagent transcript", () => {
  const entry = (type: string, content: unknown) => JSON.stringify({ type, timestamp: "2026-11-15T10:00:00.000Z", message: { role: type, content } });
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA=" } };
  it("non-empty thinking is an item, clipped like text; empty or redacted thinking is nothing", () => {
    const items = itemsFromLine(entry("assistant", [{ type: "thinking", thinking: "Check the pager first.", signature: "s" },
      { type: "thinking", thinking: "  ", signature: "s" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "On it." }]), 10);
    expect(items).toEqual([
      { kind: "thinking", id: "10:0", text: "Check the pager first.", truncated: false, ts: Date.parse("2026-11-15T10:00:00.000Z") },
      { kind: "text", id: "10:3", text: "On it.", truncated: false, ts: Date.parse("2026-11-15T10:00:00.000Z") },
    ]);
    const [long] = itemsFromLine(entry("assistant", [{ type: "thinking", thinking: "t".repeat(9_000) }]), 20);
    expect(long).toMatchObject({ kind: "thinking", truncated: true });
  });

  it("an image in a tool result is counted, never written as text or carried", () => {
    const [result] = itemsFromLine(entry("user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "saved" }, png, png] }]), 30);
    expect(result).toMatchObject({ kind: "result", output: "saved", images: 2 });
    expect(JSON.stringify(result)).not.toContain("[image]");
    expect(JSON.stringify(result)).not.toContain("iVBORw0KGgo");
    const [only] = itemsFromLine(entry("user", [{ type: "tool_result", tool_use_id: "t2", content: [png] }]), 40);
    expect(only).toMatchObject({ output: "", images: 1 });
    // Other non-text parts keep their [type] label.
    const [doc] = itemsFromLine(entry("user", [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "document", source: {} }] }]), 50);
    expect(doc).toMatchObject({ output: "[document]" });
    expect(doc).not.toHaveProperty("images");
  });
});

describe("messages sent while the subagent is busy (queued_command)", () => {
  // Shapes as the SDK (2.1.325) writes them, ids and text replaced.
  const toolResult = JSON.stringify({ parentUuid: "p1", isSidechain: true, agentId: "a1", type: "user", timestamp: "2026-11-15T01:15:25.584Z",
    message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "Tests 13 passed", is_error: false }] }, uuid: "u1" });
  const queued = JSON.stringify({ parentUuid: "u1", isSidechain: true, agentId: "a1", type: "attachment", uuid: "u2", timestamp: "2026-11-15T01:15:25.588Z",
    attachment: { type: "queued_command", prompt: "One more bug: do it as its own PR.", source_uuid: "s1", origin: { kind: "coordinator" }, isMeta: true, reminderId: "r1" },
    rendered: [{ content: "<system-reminder id=\"r1\">\nThe coordinator sent a message while you were working:\nOne more bug…</system-reminder>" }], renderedRole: "system" });
  const blob = JSON.stringify({ type: "api-request-blob", sessionId: "s", agentId: "a1", hash: "h",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Tests 13 passed" }, { type: "text", text: "One more bug: do it as its own PR." }] } });
  const otherAttachment = JSON.stringify({ type: "attachment", attachment: { type: "edited_text_file", filename: "/x" }, timestamp: "2026-11-15T01:15:26.000Z" });
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

describe("readSubagentPage", () => {
  it("reads the tail, pages back with before, and tails new complete lines with after", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => text(`step ${i} ${"pad ".repeat(40)}`)).join("");
    writeFileSync(file(), lines);
    const tail = await readSubagentPage(dir, SDK, "a1");
    expect(tail.end).toBe(tail.size);
    expect(tail.hasEarlier).toBe(true);
    expect(tail.items.at(-1)).toMatchObject({ kind: "text" });
    expect((tail.items.at(-1) as { text: string }).text).toContain("step 1999");
    const older = await readSubagentPage(dir, SDK, "a1", { before: tail.start });
    expect(older.end).toBe(tail.start);
    expect((older.items.at(-1) as { text: string }).text).toContain(`step ${Number((tail.items[0] as { text: string }).text.split(" ")[1]) - 1} `);
    // Live tail: a half-written line is not returned until it is complete.
    appendFileSync(file(), text("new step"));
    appendFileSync(file(), '{"type":"assistant","message":{"content":[{"type":"text","text":"half');
    const newer = await readSubagentPage(dir, SDK, "a1", { after: tail.end });
    expect(newer.items.map((i) => (i as { text: string }).text)).toEqual(["new step"]);
    const again = await readSubagentPage(dir, SDK, "a1", { after: newer.end });
    expect(again.items).toEqual([]);
    expect(again.end).toBe(newer.end);
  });

  it("pairs results by id across pages and never stalls on one oversized entry", async () => {
    writeFileSync(file(), tool("t1", "Bash", { command: "npm test" }, "ok") + text("y".repeat(PAGE_BYTES * 3)) + text("after the big one"));
    const tail = await readSubagentPage(dir, SDK, "a1");
    expect((tail.items.at(-1) as { text: string }).text).toBe("after the big one");
    let cursor = tail.start;
    const seen: string[] = [];
    for (let i = 0; i < 10 && cursor > 0; i++) {
      const page = await readSubagentPage(dir, SDK, "a1", { before: cursor });
      seen.push(...page.items.map((item) => item.kind));
      cursor = page.start;
    }
    expect(cursor).toBe(0);
    expect(seen).toContain("tool");
    expect(seen).toContain("result");
  });

  it("skips an entry larger than the line cap instead of reading it whole", async () => {
    writeFileSync(file(), text("z".repeat(MAX_LINE_BYTES + 1024)) + text("small"));
    const forward = await readSubagentPage(dir, SDK, "a1", { after: 0 });
    expect(forward.items).toEqual([]);
    expect(forward.end).toBeGreaterThan(0);
    let page = forward;
    for (let i = 0; i < 4 && !page.items.length; i++) page = await readSubagentPage(dir, SDK, "a1", { after: page.end });
    expect(page.items.map((x) => (x as { text: string }).text)).toEqual(["small"]);
  });

  it("never splits an entry: a page cap moves the cursor to a line edge, and an oversized entry says what it left out", async () => {
    const many = (n: number, tag: string) => line("assistant", Array.from({ length: n }, (_, i) => ({ type: "text", text: `${tag}${i}` })));
    writeFileSync(file(), many(300, "a") + many(300, "b") + many(MAX_LINE_ITEMS + 50, "c"));
    const seen: string[] = [];
    let page = await readSubagentPage(dir, SDK, "a1", { after: 0 });
    for (let i = 0; i < 5; i++) {
      seen.push(...page.items.map((x) => (x as { text: string }).text));
      if (page.end >= page.size) break;
      page = await readSubagentPage(dir, SDK, "a1", { after: page.end });
    }
    expect(page.end).toBe(page.size);
    // Every block of a and b, the first MAX_LINE_ITEMS of c, and the marker: nothing silently lost.
    expect(seen.filter((t) => t.startsWith("a"))).toHaveLength(300);
    expect(seen.filter((t) => t.startsWith("b"))).toHaveLength(300);
    expect(seen.filter((t) => /^c\d/.test(t))).toHaveLength(MAX_LINE_ITEMS);
    expect(seen.at(-1)).toBe("… 50 more entries in this step are not shown.");
    // The newest page backwards also stops at a whole line.
    const tail = await readSubagentPage(dir, SDK, "a1");
    expect(tail.items.length).toBeLessThanOrEqual(MAX_PAGE_ITEMS + 1);
    expect(tail.items[0].id.endsWith(":0")).toBe(true);
  });

  it("reads the model from the first assistant entry that names a plain model id", async () => {
    const withModel = (model: unknown) => JSON.stringify({ type: "assistant", message: { model, content: [] } }) + "\n";
    writeFileSync(file(), line("user", [{ type: "text", text: "prompt" }]) + withModel("<synthetic>") + withModel("claude-fable-5-2") + withModel("claude-opus-5-5"));
    expect(await readSubagentModel(dir, SDK, "a1")).toBe("claude-fable-5-2");
    writeFileSync(file("a2"), line("user", [{ type: "text", text: "only a prompt so far" }]));
    expect(await readSubagentModel(dir, SDK, "a2")).toBeUndefined();
    expect(await readSubagentModel(dir, SDK, "missing")).toBeUndefined();
    expect(await readSubagentModel(dir, SDK, "../a1")).toBeUndefined();
  });

  it("prefers the meta.json written at spawn: pickedEffortModel (when of the override's family), else model; the transcript is the fallback", async () => {
    const meta = (id: string, body: unknown) => writeFileSync(join(dir, SDK, "subagents", `agent-${id}.meta.json`), JSON.stringify(body));
    const withModel = (model: string) => JSON.stringify({ type: "assistant", message: { model, content: [] } }) + "\n";
    // Spawned, no assistant entry yet: the meta already knows.
    writeFileSync(file("m1"), line("user", [{ type: "text", text: "prompt" }]));
    meta("m1", { agentType: "general-purpose", model: "opus", pickedEffortModel: "claude-opus-5-5" });
    expect(await readSubagentModel(dir, SDK, "m1")).toBe("claude-opus-5-5");
    meta("m2", { agentType: "general-purpose", model: "sonnet" });
    expect(await readSubagentModel(dir, SDK, "m2")).toBe("sonnet");
    // Meta unusable (no model / not JSON / oversized): fall back to the transcript.
    writeFileSync(file("m3"), withModel("claude-fable-5-2"));
    meta("m3", { agentType: "general-purpose" });
    expect(await readSubagentModel(dir, SDK, "m3")).toBe("claude-fable-5-2");
    writeFileSync(join(dir, SDK, "subagents", "agent-m3.meta.json"), "{not json");
    expect(await readSubagentModel(dir, SDK, "m3")).toBe("claude-fable-5-2");
    meta("m3", { pickedEffortModel: "x".repeat(70) });
    expect(await readSubagentModel(dir, SDK, "m3")).toBe("claude-fable-5-2");
    // A "fable" override spawned from an Opus session: the meta's picked id is the
    // parent's, not the run's. The transcript says what it ran on; until it has an
    // assistant entry, nothing (the board retries) rather than the wrong model.
    meta("m4", { agentType: "general-purpose", model: "fable", pickedEffortModel: "claude-opus-5-5" });
    writeFileSync(file("m4"), line("user", [{ type: "text", text: "prompt" }]));
    expect(await readSubagentModel(dir, SDK, "m4")).toBeUndefined();
    writeFileSync(file("m4"), withModel("claude-fable-5-2"));
    expect(await readSubagentModel(dir, SDK, "m4")).toBe("claude-fable-5-2");
  });

  it("the brief is the first entry only (string or text blocks), clipped; later user text is a message", async () => {
    const userLine = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    writeFileSync(file(), userLine("Review **PR #482**.") + text("ok") + userLine([{ type: "text", text: "Also check the tests." }]));
    expect(await readSubagentBrief(dir, SDK, "a1")).toEqual({ text: "Review **PR #482**.", truncated: false });
    const page = await readSubagentPage(dir, SDK, "a1", { after: 0 });
    expect(page.items.map((i) => i.kind)).toEqual(["text", "message"]);
    expect(page.items[1]).toMatchObject({ kind: "message", text: "Also check the tests." });
    // Block-array brief.
    writeFileSync(file("a2"), userLine([{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }]));
    expect((await readSubagentBrief(dir, SDK, "a2"))!.text).toBe("Part one.\n\nPart two.");
    // A transcript whose first entry is not a user prompt (e.g. resumed): later user messages are not the brief.
    writeFileSync(file("a3"), text("resumed") + userLine("Message after resume"));
    expect(await readSubagentBrief(dir, SDK, "a3")).toBeUndefined();
    // Long briefs are clipped and say so.
    writeFileSync(file("a4"), userLine("b".repeat(BRIEF_LIMIT + 10)));
    const long = (await readSubagentBrief(dir, SDK, "a4"))!;
    expect(long).toMatchObject({ truncated: true });
    expect(long.text).toHaveLength(BRIEF_LIMIT);
    // Harness reminders on a user entry are not a message; tool results stay results.
    const mixed = itemsFromLine(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>" },
      { type: "tool_result", tool_use_id: "t9", content: "out" }] } }), 50);
    expect(mixed.map((i) => i.kind)).toEqual(["result"]);
  });

  it("rejects bad ids, escapes and stale cursors", async () => {
    writeFileSync(file(), text("hello"));
    await expect(readSubagentPage(dir, SDK, "../a1")).rejects.toMatchObject({ code: "transcript_not_found" });
    await expect(readSubagentPage(dir, "../x", "a1")).rejects.toBeInstanceOf(SubagentReadError);
    await expect(readSubagentPage(dir, SDK, "missing")).rejects.toMatchObject({ code: "transcript_not_found" });
    await expect(readSubagentPage(dir, SDK, "a1", { after: 10_000 })).rejects.toMatchObject({ code: "transcript_reset" });
    await expect(readSubagentPage(dir, SDK, "a1", { before: -1 })).rejects.toMatchObject({ code: "invalid_cursor" });
    // A symlinked transcript (e.g. to a file outside the projects dir) is refused.
    writeFileSync(join(root, "outside.jsonl"), text("outside"));
    symlinkSync(join(root, "outside.jsonl"), file("a2"));
    await expect(readSubagentPage(dir, SDK, "a2")).rejects.toMatchObject({ code: "transcript_not_found" });
    // So is a session directory that is itself a symlink out of the projects dir.
    mkdirSync(join(root, "elsewhere", "subagents"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "subagents", "agent-a3.jsonl"), text("outside"));
    symlinkSync(join(root, "elsewhere"), join(dir, "sdk-linked"));
    await expect(readSubagentPage(dir, "sdk-linked", "a3")).rejects.toMatchObject({ code: "transcript_not_found" });
  });
});
