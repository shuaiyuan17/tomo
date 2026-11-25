import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchedPage, LINK_SCAN_CHARS, MAX_RESULT_LINKS, MAX_URL_CHARS, parseEntry, searchResultLinks, todoList, type ResultPart } from "../src/web/sdk-transcript.js";
import { itemsFromLine, MAX_TODOS, TODO_TEXT_LIMIT } from "../src/web/subagent-reader.js";
import { pairOutputs, PRIVATE_HIDDEN, readSessionTools, toolItemsFromLine } from "../src/web/session-tools.js";
import type { SubagentItem } from "../src/web/protocol.js";

/** The server half of the todo list and Sources rows: parsed in the format module, bounded and redacted by the readers. */

const line = (type: string, content: unknown, ms = Date.UTC(2026, 10, 15, 10)) =>
  JSON.stringify({ type, timestamp: new Date(ms).toISOString(), isSidechain: false, message: { role: type, content } });
const todoWrite = (id: string, todos: unknown) => line("assistant", [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }]);
const searchText = (links: Array<{ title?: string; url: unknown }>, query = "astro pnpm") =>
  `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(links)}\n\nAstro is a web framework…\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`;
const text = (t: string): ResultPart => ({ type: "text", text: t });

describe("todoList (TodoWrite input)", () => {
  it("reads the SDK's TodoWriteInput shape", () => {
    expect(todoList("TodoWrite", { todos: [
      { content: "Read the reader", status: "completed", activeForm: "Reading the reader" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Ship it", status: "pending", activeForm: " " },
    ] })).toEqual([
      { content: "Read the reader", status: "completed", activeForm: "Reading the reader" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Ship it", status: "pending" },
    ]);
    expect(todoList("TodoWrite", { todos: [] })).toEqual([]);
  });
  it("anything else is not a list (the call then shows as an ordinary one)", () => {
    expect(todoList("Bash", { todos: [] })).toBeUndefined();
    expect(todoList("TodoWrite", {})).toBeUndefined();
    expect(todoList("TodoWrite", { todos: "x" })).toBeUndefined();
    expect(todoList("TodoWrite", { todos: [{ content: "a", status: "blocked" }] })).toBeUndefined();
    expect(todoList("TodoWrite", { todos: [{ status: "pending" }] })).toBeUndefined();
    expect(todoList("TodoWrite", { todos: [null] })).toBeUndefined();
  });
});

describe("links: WebFetch URLs and WebSearch results", () => {
  it("a WebFetch call's url, http(s) only", () => {
    expect(fetchedPage("WebFetch", { url: "https://docs.astro.build/en/install/", prompt: "x" })).toEqual({ url: "https://docs.astro.build/en/install/" });
    expect(fetchedPage("WebFetch", { url: "javascript:alert(1)" })).toBeUndefined();
    expect(fetchedPage("WebFetch", { url: "file:///etc/passwd" })).toBeUndefined();
    expect(fetchedPage("WebFetch", { url: "HTTPS://x.test" })).toBeUndefined();
    expect(fetchedPage("WebFetch", { url: `https://x.test/${"a".repeat(MAX_URL_CHARS)}` })).toBeUndefined();
    expect(fetchedPage("Read", { url: "https://x.test" })).toBeUndefined();
  });
  it("the Links: lines Claude Code writes, with titles; other text yields nothing", () => {
    const result = searchText([{ title: "Install Astro", url: "https://docs.astro.build/en/install/" }, { title: "pnpm create", url: "https://pnpm.io/cli/create" },
      { title: "bad", url: "javascript:void(0)" }, { url: 42 }, { title: "  Same as url ", url: "https://same.test" }]);
    expect(searchResultLinks([text(result)])).toEqual([
      { url: "https://docs.astro.build/en/install/", title: "Install Astro" }, { url: "https://pnpm.io/cli/create", title: "pnpm create" },
      { url: "https://same.test", title: "Same as url" }]);
    // A second search in the same result adds its links.
    const two = `${searchText([{ title: "A", url: "https://a.test" }])}\n\nLinks: [{"title":"B","url":"https://b.test"}]`;
    expect(searchResultLinks([text(two)]).map((l) => l.url)).toEqual(["https://a.test", "https://b.test"]);
    expect(searchResultLinks([text('Links: [{"title":"x","url":"https://x.test"}]')])).toEqual([]);
    expect(searchResultLinks([text('Web search results for query: "x"\n\nLinks: [not json\n\nNo links found.')])).toEqual([]);
  });
  it("is bounded: at most MAX_RESULT_LINKS, and only the first LINK_SCAN_CHARS of a result are searched", () => {
    const many = Array.from({ length: MAX_RESULT_LINKS + 5 }, (_, i) => ({ title: `t${i}`, url: `https://x.test/${i}` }));
    expect(searchResultLinks([text(searchText(many))])).toHaveLength(MAX_RESULT_LINKS);
    const late = `Web search results for query: "x"\n\n${"y".repeat(LINK_SCAN_CHARS)}\nLinks: [{"title":"late","url":"https://late.test"}]`;
    expect(searchResultLinks([text(late)])).toEqual([]);
  });
  it("search_result blocks (citations on) carry their page as the source", () => {
    const { entry } = parseEntry(line("user", [{ type: "tool_result", tool_use_id: "w1", content: [
      { type: "search_result", source: "https://docs.astro.build", title: "Astro Docs", content: [{ type: "text", text: "…" }] }] }]));
    if (entry.kind !== "message" || typeof entry.content === "string" || entry.content[0].type !== "tool_result") throw new Error("expected a result");
    expect(searchResultLinks(entry.content[0].parts)).toEqual([{ url: "https://docs.astro.build", title: "Astro Docs" }]);
  });
});

describe("reader items", () => {
  it("a TodoWrite call is a todos item: bounded, clipped, scrubbed; no tool row", () => {
    const todos = Array.from({ length: MAX_TODOS + 3 }, (_, i) => ({ content: `Step ${i}`, status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending", activeForm: `Doing step ${i}` }));
    todos[3].content = `Use sk-ant-${"a".repeat(30)} and ${"x".repeat(TODO_TEXT_LIMIT * 2)}`;
    const [item] = itemsFromLine(todoWrite("tw1", todos), 10);
    if (item.kind !== "todos") throw new Error("expected todos");
    expect(item).toMatchObject({ id: "10:0", toolUseId: "tw1", more: 3, ts: Date.UTC(2026, 10, 15, 10) });
    expect(item.todos).toHaveLength(MAX_TODOS);
    expect(item.todos[2]).toEqual({ content: "Step 2", status: "in_progress", activeForm: "Doing step 2" });
    expect(item.todos[3].content.length).toBe(TODO_TEXT_LIMIT);
    expect(item.todos[3].content).not.toContain("sk-ant-aaaa");
    // A malformed list stays an ordinary call, never dropped.
    expect(itemsFromLine(todoWrite("tw2", [{ content: 1 }]), 20)[0]).toMatchObject({ kind: "tool", name: "TodoWrite" });
  });
  it("WebFetch carries its page; a WebSearch result its links; results carry their time", () => {
    const [fetch] = itemsFromLine(line("assistant", [{ type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://pnpm.io/cli/create", prompt: "how" } }]), 0);
    expect(fetch).toMatchObject({ kind: "tool", sources: [{ url: "https://pnpm.io/cli/create" }] });
    const [result] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "s1", content: searchText([{ title: "Astro", url: "https://astro.build" }]) }]), 5);
    expect(result).toMatchObject({ kind: "result", sources: [{ url: "https://astro.build", title: "Astro" }], ts: Date.UTC(2026, 10, 15, 10) });
    // Links past the output clip are still found.
    const long = searchText([{ title: "Far", url: "https://far.test" }], "q".repeat(6_000));
    expect(itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "s2", content: long }]), 6)[0]).toMatchObject({ truncated: true, sources: [{ url: "https://far.test" }] });
    const [plain] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "r1", content: "Links: [] but not a search" }]), 7);
    expect(plain).not.toHaveProperty("sources");
  });
  it("a URL redaction would change (a token in its query) is left out, not shown altered", () => {
    const [fetch] = itemsFromLine(line("assistant", [{ type: "tool_use", id: "f2", name: "WebFetch", input: { url: "https://api.test/x?token=abc123", prompt: "x" } }]), 0);
    expect(fetch).not.toHaveProperty("sources");
    const [result] = itemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "s3", content: searchText([
      { title: "Signed", url: "https://cdn.test/f?sig=deadbeef" }, { title: `ghp_${"b".repeat(20)}`, url: "https://ok.test" }]) }]), 0);
    if (result.kind !== "result") throw new Error("expected a result");
    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0].url).toBe("https://ok.test");
    expect(result.sources?.[0].title).not.toContain("ghp_bbbb");
  });
});

describe("main chat: todos and sources cross the same server-side gate as outputs", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-turn-items-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("todos are main-chat items, redacted like outputs; their result pairs with them", async () => {
    writeFileSync(join(root, "sdk-1.jsonl"), [
      todoWrite("tw1", [{ content: "Read memory/private/people/alex.md", status: "in_progress", activeForm: "Reading Authorization: Bearer abcdefghijk" }]),
      line("user", [{ type: "tool_result", tool_use_id: "tw1", content: "Todos have been modified successfully." }]),
    ].join("\n") + "\n");
    const page = await readSessionTools(root, "sdk-1", { from: 0 });
    expect(page.items.map((i) => i.kind)).toEqual(["todos", "result"]);
    const [todos, result] = page.items;
    if (todos.kind !== "todos" || result.kind !== "result") throw new Error("expected todos and its result");
    expect(todos.todos[0].content).toBe("Read <private>");
    expect(todos.todos[0].activeForm).not.toContain("abcdefghijk");
    expect(result.output).toBe("Todos have been modified successfully.");
  });

  // A private output is withheld whole: nothing it carried (links, an image count) is left beside the notice,
  // and a result without its call carries none either.
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA=" } };
  it.each<[string, string, () => SubagentItem[]]>([
    ["links", "sources", () => [
      { kind: "tool", id: "1:0", toolUseId: "s1", name: "WebSearch", summary: "", input: "{}", inputTruncated: false, privateOutput: true },
      { kind: "result", id: "2:0", toolUseId: "s1", output: "x", truncated: false, isError: false, sources: [{ url: "https://a.test" }] },
      { kind: "result", id: "3:0", toolUseId: "unknown", output: "y", truncated: false, isError: false, sources: [{ url: "https://b.test" }] },
    ]],
    ["image count", "images", () => [
      // A Read of a private path is marked by the reader itself.
      ...toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "p1", name: "Read", input: { file_path: "/w/memory/private/a.png" } }]), 0),
      ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "p1", content: [png] }]), 100),
      ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "zz", content: [png] }]), 200),
    ]],
  ])("a withheld output loses its %s too", (_what, key, items) => {
    const [, withheld, unpaired] = pairOutputs(items());
    expect(withheld).toMatchObject({ kind: "result", output: PRIVATE_HIDDEN });
    expect(withheld).not.toHaveProperty(key);
    expect(unpaired).toMatchObject({ kind: "result" });
    expect(unpaired).not.toHaveProperty(key);
  });

  it("toolItemsFromLine keeps todos (they are calls), never text", () => {
    const items = toolItemsFromLine(line("assistant", [{ type: "text", text: "plan" }, { type: "tool_use", id: "tw", name: "TodoWrite", input: { todos: [] } }]), 0);
    expect(items.map((i) => i.kind)).toEqual(["todos"]);
  });
});
