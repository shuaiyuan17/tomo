import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { sdkSessionsDirForWorkspace } from "../src/runtime-paths.js";
import { readSubagentPage, subagentTranscriptPath } from "../src/web/subagent-reader.js";
import { readSessionTools } from "../src/web/session-tools.js";
import { sessionTranscriptFile } from "../src/web/sdk-transcript.js";
import type { SubagentItem } from "../src/web/protocol.js";

/**
 * The web views read the SDK's transcripts with their own bounded reader
 * (src/web/sdk-transcript.ts says why). This pins that reader to the SDK's
 * public ones: the SDK's `getSubagentMessages` / `getSessionMessages` /
 * `listSubagents` and ours run over the SAME files, found at the SAME
 * paths, and must agree on every tool call, result and piece of assistant
 * text. An SDK upgrade that moves the files or changes the record shape
 * fails here instead of emptying the views.
 *
 * Only the record envelope is the SDK's to define; what is compared is read
 * from `SessionMessage.message.content`, the Anthropic Messages API's
 * public content blocks.
 */

let home: string;
let workspace: string;
let sdkSessionsDir: string;
let sdk: typeof import("@anthropic-ai/claude-agent-sdk");
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
const SESSION = "6f0c1a2b-3d4e-4f50-8a61-7b8c9d0e1f20";
const AGENT = "a3f9c2e1b7d04e15";

/** A transcript as the SDK writes one: a parentUuid chain, bookkeeping records between the messages. */
function transcript(options: { sidechain: boolean; agentId?: string }): string {
  let n = 0;
  let parent: string | null = null;
  const at = (i: number) => new Date(Date.UTC(2026, 10, 15, 9, 0, i)).toISOString();
  const envelope = () => ({ isSidechain: options.sidechain, ...(options.agentId ? { agentId: options.agentId } : {}), userType: "external",
    entrypoint: "sdk-ts", cwd: workspace, sessionId: SESSION, version: "2.1.325", gitBranch: "main" });
  const message = (type: "user" | "assistant", content: unknown, extra: object = {}) => {
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const record = { parentUuid: parent, ...envelope(), type, uuid, timestamp: at(n), ...extra,
      message: type === "assistant"
        ? { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : { role: "user", content } };
    parent = uuid;
    return JSON.stringify(record);
  };
  const attachment = (body: object) => {
    const uuid = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
    const record = { parentUuid: parent, ...envelope(), attachment: body, type: "attachment", uuid, timestamp: at(n) };
    parent = uuid;
    return JSON.stringify(record);
  };
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  return [
    message("user", "Audit the transcript readers."),
    attachment({ type: "date", date: "2026-11-15" }),
    message("assistant", [{ type: "thinking", thinking: "Start with the reader module.", signature: "sig1" },
      { type: "text", text: "Looking at the readers first." }]),
    message("assistant", [{ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/repo/src/web/subagent-reader.ts" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "export const PAGE_BYTES = 256 * 1024;" }] }],
      { toolUseResult: { type: "text" } }),
    message("assistant", [{ type: "thinking", thinking: "", signature: "sig-omitted" },
      { type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "npm test", description: "Run the tests" } },
      { type: "tool_use", id: "toolu_03", name: "Grep", input: { pattern: "itemsFromLine", path: "/repo/src" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_02", content: "Tests 12 failed", is_error: true },
      { type: "tool_result", tool_use_id: "toolu_03", content: [{ type: "text", text: "src/web/session-tools.ts" }, png] }]),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: at(++n), sessionId: SESSION }),
    message("assistant", [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "Two findings." }]),
    message("user", [{ type: "text", text: "Also check the images." }]),
    message("assistant", [{ type: "tool_use", id: "toolu_04", name: "Read", input: { file_path: "/repo/shot.png" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_04", content: [png] }]),
    // The calls the views show as more than a call: a todo list, a web search's links, a fetched page.
    message("assistant", [{ type: "tool_use", id: "toolu_05", name: "TodoWrite", input: { todos: [
      { content: "Check the images", status: "completed", activeForm: "Checking the images" },
      { content: "Look up the format", status: "in_progress", activeForm: "Looking up the format" }] } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_05", content: "Todos have been modified successfully." }]),
    message("assistant", [{ type: "tool_use", id: "toolu_06", name: "WebSearch", input: { query: "jsonl transcript format" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_06", content: 'Web search results for query: "jsonl transcript format"\n\n'
      + 'Links: [{"title":"JSON Lines","url":"https://jsonlines.org/"},{"title":"NDJSON","url":"https://github.com/ndjson/ndjson-spec"}]\n\n'
      + "JSON Lines is one JSON value per line.\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks." }]),
    message("assistant", [{ type: "tool_use", id: "toolu_07", name: "WebFetch", input: { url: "https://jsonlines.org/", prompt: "What is it?" } }]),
    message("user", [{ type: "tool_result", tool_use_id: "toolu_07", content: "A format for structured data." }]),
    message("assistant", [{ type: "text", text: "Done: the image is a screenshot." }]),
  ].join("\n") + "\n";
}

type Fact = string;
/** What the SDK's reader says, from the public content blocks. The first message is the brief, which the view serves apart. */
function sdkFacts(messages: SessionMessage[], { brief }: { brief: boolean }): Fact[] {
  return messages.flatMap((m, index): Fact[] => {
    const content = (m.message as { content?: unknown }).content;
    if (typeof content === "string") return m.type === "user" && !(brief && index === 0) ? [`message:${content}`] : [];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: Record<string, unknown>): Fact[] => {
      if (m.type === "assistant" && block.type === "text" && String(block.text).trim()) return [`text:${String(block.text)}`];
      if (m.type === "assistant" && block.type === "thinking" && String(block.thinking).trim()) return [`thinking:${String(block.thinking)}`];
      if (m.type === "assistant" && block.type === "tool_use") {
        const input = block.input as { todos?: Array<{ status: string; content: string }>; url?: string };
        // The SDK's TodoWriteInput / WebFetchInput, read straight from the block.
        if (block.name === "TodoWrite") return [`todos:${String(block.id)}:${input.todos!.map((t) => `${t.status}=${t.content}`).join("|")}`];
        return [`tool:${String(block.id)}:${String(block.name)}`, ...(block.name === "WebFetch" ? [`source:${input.url}`] : [])];
      }
      if (m.type === "user" && block.type === "text" && !(brief && index === 0)) return [`message:${String(block.text)}`];
      if (m.type === "user" && block.type === "tool_result") {
        const parts = typeof block.content === "string" ? [{ type: "text", text: block.content }] : (block.content as Array<Record<string, unknown>>);
        const text = parts.filter((p) => p.type === "text").map((p) => String(p.text)).join("\n");
        const images = parts.filter((p) => p.type === "image").length;
        // Every URL a web search's result text names (found here with a plain pattern, not our parser).
        const links = text.startsWith("Web search results") ? [...text.matchAll(/"url":"([^"]+)"/g)].map((match) => `source:${match[1]}`) : [];
        return [`result:${String(block.tool_use_id)}:${block.is_error === true}:${text}:${images}`, ...links];
      }
      return [];
    });
  });
}
function ourFacts(items: SubagentItem[]): Fact[] {
  const sources = (item: { sources?: Array<{ url: string }> }) => (item.sources ?? []).map((source) => `source:${source.url}`);
  return items.flatMap((item) => {
    switch (item.kind) {
      case "text": return [`text:${item.text}`];
      case "thinking": return [`thinking:${item.text}`];
      case "message": return [`message:${item.text}`];
      case "tool": return [`tool:${item.toolUseId}:${item.name}`, ...sources(item)];
      case "todos": return [`todos:${item.toolUseId}:${item.todos.map((t) => `${t.status}=${t.content}`).join("|")}`];
      case "result": return [`result:${item.toolUseId}:${item.isError}:${item.output}:${item.images ?? 0}`, ...sources(item)];
    }
  });
}

beforeAll(async () => {
  // Resolved: the SDK keys the project directory on the workspace's REAL path,
  // and on macOS the temp dir is behind a symlink (/var -> /private/var), so an
  // unresolved one put the fixture where the SDK never looks.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "tomo-sdk-agreement-")));
  workspace = join(home, "workspace");
  mkdirSync(workspace);
  // The SDK resolves `dir` (a project working directory) under CLAUDE_CONFIG_DIR/projects;
  // Tomo derives the same directory from the workspace path.
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  sdkSessionsDir = sdkSessionsDirForWorkspace(workspace, home);
  const subagentFile = subagentTranscriptPath(sdkSessionsDir, SESSION, AGENT);
  mkdirSync(dirname(subagentFile), { recursive: true });
  writeFileSync(subagentFile, transcript({ sidechain: true, agentId: AGENT }));
  writeFileSync(sessionTranscriptFile(sdkSessionsDir, SESSION)!, transcript({ sidechain: false }));
  sdk = await import("@anthropic-ai/claude-agent-sdk");
});
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  rmSync(home, { recursive: true, force: true });
});

describe("our transcript reader agrees with the SDK's", () => {
  it("finds the files where the SDK does", async () => {
    expect(await sdk.listSubagents(SESSION, { dir: workspace })).toEqual([AGENT]);
    expect((await sdk.getSessionMessages(SESSION, { dir: workspace })).length).toBeGreaterThan(0);
  });

  it("subagent view: the same thinking, text, messages, tool calls and results (images counted, not carried)", async () => {
    const theirs = sdkFacts(await sdk.getSubagentMessages(SESSION, AGENT, { dir: workspace }), { brief: true });
    const items: SubagentItem[] = [];
    let page = await readSubagentPage(sdkSessionsDir, SESSION, AGENT, { after: 0 });
    items.push(...page.items);
    while (page.end < page.size) { page = await readSubagentPage(sdkSessionsDir, SESSION, AGENT, { after: page.end }); items.push(...page.items); }
    expect(page.unreadable).toBeUndefined();
    // Sanity: the fixture exercises every kind compared.
    expect(theirs.map((f) => f.split(":")[0])).toEqual(expect.arrayContaining(["text", "thinking", "message", "tool", "result", "todos", "source"]));
    expect(ourFacts(items)).toEqual(theirs);
    expect(JSON.stringify(items)).not.toContain("iVBORw0KGgo");
  });

  it("main chat: the same tool calls, todo lists, results and pages", async () => {
    const theirs = sdkFacts(await sdk.getSessionMessages(SESSION, { dir: workspace }), { brief: false })
      .filter((fact) => /^(tool|result|todos|source):/.test(fact));
    const page = await readSessionTools(sdkSessionsDir, SESSION, { from: 0 });
    expect(page.unreadable).toBeUndefined();
    // 7 calls (one of them a todo list) with 7 results, a search's 2 links and a fetched page.
    expect(theirs.length).toBe(17);
    expect(ourFacts(page.items)).toEqual(theirs);
  });
});
