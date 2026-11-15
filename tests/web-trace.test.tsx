import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentItem, TodoEntry, WebSource } from "../src/web/protocol.js";
import { callDuration, formatDuration, groupDuration, groupRows, latestTodos, MAX_SOURCES, sourcesOf, todoSections, todoSummary, viewRows,
  type TodosRow, type ToolRow } from "../web/src/subagent.js";
import { interleave } from "../web/src/inline-tools.js";
import { safeHref, sourceHost } from "../web/src/links.js";
import { codeBlockInfo } from "../web/src/code-block.js";
import { Text } from "../web/src/markdown.js";
import { ToolSection } from "../web/src/components/ai/tool.js";
import { Sources, Thinking, TodoList, ToolCall, ToolGroup, TurnBlock } from "../web/src/tool-calls.js";

let n = 0;
const T0 = Date.UTC(2026, 10, 15, 9);
const call = (id: string, name: string, opts: { done?: boolean; error?: boolean; ts?: number; took?: number; sources?: WebSource[]; resultSources?: WebSource[] } = {}): SubagentItem[] => {
  const { done = true, error = false, ts, took, sources, resultSources } = opts;
  return [{ kind: "tool", id: `${++n}:0`, toolUseId: id, name, summary: `${name} x`, input: "{}", inputTruncated: false, ...(ts !== undefined ? { ts } : {}), ...(sources ? { sources } : {}) },
    ...(done ? [{ kind: "result" as const, id: `${++n}:0`, toolUseId: id, output: "ok", truncated: false, isError: error,
      ...(ts !== undefined && took !== undefined ? { ts: ts + took } : {}), ...(resultSources ? { sources: resultSources } : {}) }] : [])];
};
const todos = (id: string, list: TodoEntry[], opts: { ts?: number; failed?: boolean } = {}): SubagentItem[] => [
  { kind: "todos", id: `${++n}:0`, toolUseId: id, todos: list, ...(opts.ts !== undefined ? { ts: opts.ts } : {}) },
  { kind: "result", id: `${++n}:0`, toolUseId: id, output: "ok", truncated: false, isError: opts.failed === true },
];
const text = (t: string): SubagentItem => ({ kind: "text", id: `${++n}:0`, text: t, truncated: false });
const message = (t: string): SubagentItem => ({ kind: "message", id: `${++n}:msg`, text: t, truncated: false });
const plan = (done: number, total: number): TodoEntry[] => Array.from({ length: total }, (_, i) => ({
  content: `Step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }));
const shape = (items: SubagentItem[]) => groupRows(viewRows(items)).map((b) =>
  b.kind === "group" ? `group:${b.tools.length}` : b.kind === "todos" ? `todos:${todoSummary(b.row)}` : b.kind === "sources" ? `sources:${b.sources.length}` : b.kind);
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("todo list per turn", () => {
  it("many TodoWrite calls are one list with the latest state, where the first was made; they neither join nor split a run", () => {
    const items = [...todos("p1", plan(0, 3)), ...call("r1", "Read"), ...todos("p2", plan(1, 3)), ...call("r2", "Read"), ...todos("p3", plan(2, 3))];
    expect(shape(items)).toEqual(["todos:2 of 3 done", "group:2"]);
    const blocks = groupRows(viewRows(items));
    expect(blocks[0].kind === "todos" && blocks[0].key).toBe("todos:p1");
  });
  it("a message sent to the subagent starts a new turn, with its own list; text does not", () => {
    const items = [...todos("a", plan(0, 2)), ...call("r1", "Read"), text("narration"), ...todos("b", plan(1, 2)), message("now the docs"), ...todos("c", plan(0, 4))];
    expect(shape(items)).toEqual(["todos:1 of 2 done", "tool", "text", "message", "todos:0 of 4 done"]);
  });
  it("a failed TodoWrite did not change the list", () => {
    const rows = viewRows([...todos("a", plan(1, 3)), ...todos("b", plan(3, 3), { failed: true })]).filter((r): r is TodosRow => r.kind === "todos");
    expect(todoSummary(latestTodos(rows))).toBe("1 of 3 done");
    expect(latestTodos([rows[1]]).toolUseId).toBe("b");
  });
  it("summary and sections: in progress, left, done; entries left out still count", () => {
    expect(todoSummary({ todos: plan(3, 7), more: 0 })).toBe("3 of 7 done");
    expect(todoSummary({ todos: plan(2, 2), more: 3 })).toBe("2 of 5 done");
    const sections = todoSections(plan(1, 4));
    expect([sections.active, sections.left, sections.done].map((list) => list.map((todo) => todo.content))).toEqual([["Step 2"], ["Step 3", "Step 4"], ["Step 1"]]);
  });
});

describe("sources per turn", () => {
  const search = (id: string, links: WebSource[], opts: { error?: boolean } = {}) => call(id, "WebSearch", { resultSources: links, ...opts });
  const fetch = (id: string, url: string, opts: { done?: boolean; error?: boolean } = {}) => call(id, "WebFetch", { sources: [{ url }], ...opts });
  it("WebFetch URLs and WebSearch links, deduplicated (ignoring #fragments), titles kept from any copy; failed or running calls do not count", () => {
    const rows = viewRows([
      ...fetch("f1", "https://pnpm.io/cli/create"),
      ...search("s1", [{ url: "https://pnpm.io/cli/create#usage", title: "pnpm create" }, { url: "https://docs.astro.build", title: "Astro" }]),
      ...fetch("f2", "https://broken.test", { error: true }),
      ...fetch("f3", "https://later.test", { done: false }),
      ...search("s2", [{ url: "javascript:alert(1)" }, { url: "https://docs.astro.build" }]),
      // A tool that is neither: its sources are not pages the turn read.
      ...call("x", "Read", { sources: [{ url: "https://not-a-page.test" }] }),
    ]).filter((r): r is ToolRow => r.kind === "tool");
    expect(sourcesOf(rows)).toEqual([{ url: "https://pnpm.io/cli/create", title: "pnpm create" }, { url: "https://docs.astro.build", title: "Astro" }]);
  });
  it("one Sources block per turn, right after the turn's last tool block, keyed by its first source", () => {
    const items = [...search("s1", [{ url: "https://a.test" }]), text("found"), ...fetch("f1", "https://b.test"), ...call("r1", "Read"), text("answer")];
    expect(shape(items)).toEqual(["tool", "text", "group:2", "sources:2", "text"]);
    const block = groupRows(viewRows(items)).find((b) => b.kind === "sources");
    expect(block?.kind === "sources" && block.key).toBe("sources:s1");
    expect(shape([...call("r", "Read"), text("x")])).toEqual(["tool", "text"]);
  });
  it("is capped", () => {
    const links = Array.from({ length: MAX_SOURCES + 10 }, (_, i) => ({ url: `https://x.test/${i}` }));
    expect(sourcesOf(viewRows(search("s", links)) as ToolRow[])).toHaveLength(MAX_SOURCES);
  });
  it("links follow the markdown renderer's rule; hosts are shown without www", () => {
    expect([safeHref("https://a.test"), safeHref("http://a.test"), safeHref("javascript:x"), safeHref("//a.test"), safeHref(undefined)]).toEqual([true, true, false, false, false]);
    expect(sourceHost("https://www.docs.example.com/x")).toBe("docs.example.com");
    expect(sourceHost("nonsense")).toBe("nonsense");
  });
});

describe("the chat's turns", () => {
  const msg = (id: string, role: "user" | "assistant", timestamp: number) => ({ id, role, content: id, channel: "web", timestamp });
  it("a turn's todo list, calls and sources are its blocks, in that order; the running turn's are trailing", () => {
    const items = [...todos("p1", plan(0, 2), { ts: 150 }), ...call("s1", "WebSearch", { ts: 200, resultSources: [{ url: "https://a.test" }] }),
      ...todos("p2", plan(2, 2), { ts: 250 }), ...call("r1", "Read", { ts: 300 }), ...todos("p3", plan(0, 1), { ts: 700 }), ...call("b1", "Bash", { ts: 800, done: false })];
    const out = interleave([msg("u1", "user", 100), msg("a1", "assistant", 500), msg("u2", "user", 600)], items);
    expect(out.entries.map((e) => e.kind === "message" ? e.message.id : e.block.key)).toEqual(["u1", "todos:p1", "calls:s1", "sources:s1", "a1", "u2"]);
    const first = out.entries[1];
    expect(first.kind === "tools" && first.block.kind === "todos" && todoSummary(first.block.row)).toBe("2 of 2 done");
    expect(out.trailing.map((b) => b.key)).toEqual(["todos:p3", "call:b1"]);
  });
});

describe("durations", () => {
  it("formats seconds, minutes and hours; under a second is nothing", () => {
    expect([formatDuration(400), formatDuration(4_200), formatDuration(72_000), formatDuration(120_000), formatDuration(3_700_000), formatDuration(NaN)])
      .toEqual([undefined, "4s", "1m 12s", "2m", "1h 1m", undefined]);
  });
  it("a call from its start to its result; a group from the first start to the last result, once all are done", () => {
    const rows = viewRows([...call("a", "Read", { ts: T0, took: 2_000 }), ...call("b", "Bash", { ts: T0 + 2_500, took: 9_000 })]) as ToolRow[];
    expect(callDuration(rows[1])).toBe("9s");
    expect(groupDuration(rows)).toBe("12s");
    expect(groupDuration(viewRows([...call("a", "Read", { ts: T0, took: 2_000 }), ...call("b", "Bash", { ts: T0 + 1, done: false })]) as ToolRow[])).toBeUndefined();
    expect(callDuration(viewRows(call("c", "Read"))[0] as ToolRow)).toBeUndefined();
  });
});

describe("Trace rows (markup)", () => {
  const row = (items: SubagentItem[]) => viewRows(items)[0] as ToolRow;
  it("a tool call is one Trace line: icon, title, duration; it opens to input/output only when opened", () => {
    const out = html(createElement(ToolCall, { row: row(call("t1", "Bash", { ts: T0, took: 4_000 })), running: false }));
    expect(out).toContain('data-slot="trace-line"');
    expect(out).toContain('data-slot="trace-icon"');
    expect(out).toMatch(/data-slot="trace-title"[^>]*>Bash x</);
    expect(out).toMatch(/data-slot="trace-description"[^>]*>4s</);
    expect(out).not.toContain("INPUT");
    expect(out).not.toContain("Input");
  });
  it("running shimmers via the line's status; an error colours it and says so", () => {
    expect(html(createElement(ToolCall, { row: row(call("t2", "Read", { done: false })), running: true }))).toMatch(/data-status="running"[\s\S]*>Running</);
    expect(html(createElement(ToolCall, { row: row(call("t3", "Read", { error: true })), running: false }))).toMatch(/data-status="error"[\s\S]*>Failed</);
    expect(html(createElement(ToolCall, { row: row(call("t4", "Read", { done: false })), running: false }))).not.toContain("data-status");
  });
  it("a running group names only the latest call; once the turn is over it sums the run up", () => {
    const tools = viewRows([...call("a", "Read"), ...call("b", "Read"), ...call("c", "Bash", { done: false })]) as ToolRow[];
    const out = html(createElement(ToolGroup, { tools, open: false, onOpenChange: () => {}, running: true }));
    expect(out).not.toContain("Read 2 files");
    expect(out).toContain('<span class="shimmer">Bash x…</span>');
    expect(html(createElement(ToolGroup, { tools: tools.slice(0, 2), open: false, onOpenChange: () => {}, running: false }))).toContain("Read 2 files<");
  });
  it("thinking is a folded Trace line in the sans", () => {
    const out = html(createElement(Thinking, { text: "secret reasoning" }));
    expect(out).toMatch(/data-slot="trace-title"[^>]*>Thinking</);
    expect(out).toContain("font-sans");
    expect(out).not.toContain("secret reasoning");
  });
  it("the todo list: open while running with the active item shimmering by its activeForm; folded otherwise", () => {
    const [todoRow] = viewRows(todos("p", plan(1, 3))) as TodosRow[];
    const open = html(createElement(TodoList, { row: todoRow, running: true, open: true, onOpenChange: () => {} }));
    expect(open).toContain(">1 of 3 done<");
    expect(open).toMatch(/data-status="running"[^>]*>[\s\S]*?>Doing step 2</);
    expect(open).toMatch(/data-todo="left"[\s\S]*data-status="pending"/);
    expect(open).toMatch(/data-todo="done"[\s\S]*line-through[^>]*>Step 1</);
    // The order: in progress, left, done.
    expect(open.indexOf("Doing step 2")).toBeLessThan(open.indexOf("Step 3"));
    expect(open.indexOf("Step 3")).toBeLessThan(open.indexOf(">Step 1<"));
    const over = html(createElement(TurnBlock, { block: { kind: "todos", key: "todos:p", row: todoRow }, running: false, choices: {}, onChoice: () => {} }));
    expect(over).toContain(">1 of 3 done<");
    expect(over).not.toContain("Step 3");
    // Once the turn is over the in-progress item reads as written, without a shimmer.
    expect(html(createElement(TodoList, { row: todoRow, running: false, open: true, onOpenChange: () => {} }))).toMatch(/data-todo="active"[^>]*><span data-slot="trace-line"(?![^>]*data-status)[\s\S]*?>Step 2</);
    expect(html(createElement(TurnBlock, { block: { kind: "todos", key: "todos:p", row: todoRow }, running: true, choices: { "todos:p": false }, onChoice: () => {} })))
      .not.toContain("Step 3");
  });
  it("Sources: a folded count; open, each page is a safe new-tab link with its title and host; nothing else is fetched", () => {
    const sources = [{ url: "https://www.docs.astro.build/en/install/", title: "Install Astro" }, { url: "https://pnpm.io/cli/create" }, { url: "javascript:alert(1)" }];
    expect(html(createElement(Sources, { sources, open: false, onOpenChange: () => {} }))).toMatch(/>Sources<[\s\S]*>2</);
    const out = html(createElement(Sources, { sources, open: true, onOpenChange: () => {} }));
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out).toContain('href="https://www.docs.astro.build/en/install/" target="_blank" rel="noopener noreferrer"');
    expect(out).toMatch(/>Install Astro<span class="sr-only"> \(opens in a new tab\)<\/span><\/span><span data-slot="trace-description"[^>]*>docs.astro.build</);
    expect(out).toContain(">pnpm.io/cli/create<");
    expect(out).not.toContain("javascript:");
    expect(out).not.toMatch(/<img|style=/);
    expect(html(createElement(Sources, { sources: [{ url: "data:text/html,x" }], open: true, onOpenChange: () => {} }))).toBe("");
  });
});

describe("code blocks in replies", () => {
  const render = (md: string) => html(createElement(Text, null, md));
  it("a fenced block gets a copy button and, when named, a quiet language label; no inline styles", () => {
    const out = render("```ts\nconst a = 1;\n```");
    expect(out).toContain('data-slot="code-block"');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toMatch(/data-slot="code-block-title"[^>]*>ts</);
    expect(out).toContain('<code class="language-ts">const a = 1;\n</code></pre>');
    expect(out).not.toContain("style=");
    const bare = render("```\nplain\n```");
    expect(bare).toContain('aria-label="Copy code"');
    expect(bare).not.toContain("code-block-title");
    // Inline code is not a block.
    expect(render("use `npm test`")).not.toContain("code-block");
  });
  it("copies the code exactly (without the closing newline); a fence label that is not a plain name is not shown", () => {
    const pre = { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", properties: { className: ["language-sh"] },
      children: [{ type: "text", value: "echo a\n\necho b\n" }] }] };
    expect(codeBlockInfo(pre)).toEqual({ code: "echo a\n\necho b", language: "sh" });
    const odd = { ...pre, children: [{ ...pre.children[0], properties: { className: ["language-<b>x</b>"] } }] };
    expect(codeBlockInfo(odd)).toEqual({ code: "echo a\n\necho b" });
    expect(codeBlockInfo(undefined)).toEqual({ code: "" });
  });
  it("tool input/output panes have no copy button", () => {
    expect(html(createElement(ToolSection, { label: "Input", text: "```ts\nx\n```" }))).not.toContain("Copy");
  });
});
