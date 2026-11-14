import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IO_LIMIT, itemsFromLine, MAX_LINE_BYTES, PAGE_BYTES, readSubagentPage, SubagentReadError } from "../src/web/subagent-reader.js";

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
    expect(itemsFromLine(line("user", [{ type: "text", text: "secret prompt" }]), 0)).toEqual([]);
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
  });
});
