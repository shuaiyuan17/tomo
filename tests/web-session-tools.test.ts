import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVATE_HIDDEN, readSessionTools, SessionToolsError, transcriptToken, UNPAIRED_HIDDEN } from "../src/web/session-tools.js";
import { SessionStore } from "../src/sessions/store.js";
import { WebData } from "../src/web/data.js";
import { webSessionId } from "../src/web/owner.js";

let root: string;
const SDK = "sdk-main-1";
const file = () => join(root, `${SDK}.jsonl`);
const at = (ms: number) => new Date(ms).toISOString();
const line = (type: string, ms: number, content: unknown, extra: object = {}) =>
  JSON.stringify({ type, timestamp: at(ms), isSidechain: false, ...extra, message: { role: type, content } }) + "\n";
const call = (id: string, name: string, input: unknown, output: string, ms: number) =>
  line("assistant", ms, [{ type: "tool_use", id, name, input }]) + line("user", ms + 1, [{ type: "tool_result", tool_use_id: id, content: output }]);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-session-tools-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readSessionTools", () => {
  it("returns only tool calls and results at or after `from` — no text, no user messages, no sidechains", async () => {
    writeFileSync(file(),
      line("user", 1_000, "hello") +
      call("t0", "Read", { file_path: "/old" }, "old", 1_500) +
      line("assistant", 2_000, [{ type: "text", text: "narration" }]) +
      call("t1", "Bash", { command: "ls" }, "a\nb", 3_000) +
      line("assistant", 3_500, [{ type: "tool_use", id: "s1", name: "Read", input: {} }], { isSidechain: true }) +
      call("t2", "Grep", { pattern: "x" }, "hit", 4_000));
    const page = await readSessionTools(root, SDK, { from: 2_000 });
    expect(page.items.map((i) => `${i.kind}:${i.toolUseId}`)).toEqual(["tool:t1", "result:t1", "tool:t2", "result:t2"]);
    expect(page.complete).toBe(true);
    expect(page.transcript).toBe(transcriptToken(SDK));
    const tool = page.items[0];
    expect(tool.kind === "tool" && tool.ts).toBe(3_000);
  });

  it("tails with `after` and refuses a stale transcript token or an offset past the end (reset)", async () => {
    writeFileSync(file(), call("t1", "Bash", { command: "ls" }, "ok", 1_000));
    const first = await readSessionTools(root, SDK, { from: 0 });
    appendFileSync(file(), call("t2", "Read", { file_path: "/a" }, "A", 2_000) + '{"type":"assistant","partial');
    const next = await readSessionTools(root, SDK, { after: first.end, transcript: first.transcript });
    expect(next.items.map((i) => i.toolUseId)).toEqual(["t2", "t2"]);
    // The partial last line is not read yet: the next tail starts at it.
    expect(next.end).toBeLessThan(statSync(file()).size);
    await expect(readSessionTools(root, SDK, { after: next.end, transcript: "other" })).rejects.toBeInstanceOf(SessionToolsError);
    await expect(readSessionTools(root, SDK, { after: 10 ** 9, transcript: first.transcript })).rejects.toMatchObject({ code: "transcript_reset" });
    await expect(readSessionTools(root, SDK, { after: -1, transcript: first.transcript })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("a scan that hits its item cap says it is incomplete", async () => {
    let lines = "";
    for (let i = 0; i < 500; i++) lines += call(`t${i}`, "Read", { file_path: `/f${i}` }, "ok", 1_000 + i * 10);
    writeFileSync(file(), lines);
    const page = await readSessionTools(root, SDK, { from: 0 });
    expect(page.complete).toBe(false);
    expect(page.items.at(-1)?.toolUseId).toBe("t499");
    expect((await readSessionTools(root, SDK, { from: 4_000 })).complete).toBe(true);
  });
  it("a session without an SDK transcript has no calls", async () => {
    expect(await readSessionTools(root, undefined, { from: 0 })).toMatchObject({ items: [], complete: true });
    expect((await readSessionTools(root, "missing-id", { from: 0 })).items).toEqual([]);
  });

  it("redacts inputs and outputs on the server (#492): secrets, env values, private paths", async () => {
    writeFileSync(file(), call("t1", "Bash", { command: "API_TOKEN=abc123 curl -H 'Authorization: Bearer sekret-value' https://x?token=zzz", description: "cat ~/.tomo/workspace/memory/private/notes.md" },
      "key sk-ant-abcdefghijkl and /w/memory/private/diary.md", 1_000));
    const page = await readSessionTools(root, SDK, { from: 0 });
    const tool = page.items.find((i) => i.kind === "tool")!;
    const result = page.items.find((i) => i.kind === "result")!;
    const shown = JSON.stringify([tool, result]);
    for (const secret of ["abc123", "sekret-value", "zzz", "sk-ant-abcdefghijkl", "diary.md", "notes.md"]) expect(shown).not.toContain(secret);
    expect(tool.kind === "tool" && tool.summary).not.toContain("abc123");
    expect(shown).toContain("<private>");
  });
});

describe("private memory: outputs withheld on the server (#464's predicate)", () => {
  const ws = () => join(root, "ws");
  it("a Read of a private file never sends its text; the redacted input stays", async () => {
    const secret = join(ws(), "memory", "private", "diary.md");
    writeFileSync(file(), call("p1", "Read", { file_path: secret }, "DEAR DIARY the secret text", 1_000)
      + call("p2", "Read", { file_path: join(ws(), "memory", "MEMORY.md") }, "public notes", 2_000));
    const page = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws() });
    const text = JSON.stringify(page);
    expect(text).not.toContain("DEAR DIARY");
    expect(page.items.find((i) => i.kind === "result" && i.toolUseId === "p1")).toMatchObject({ output: PRIVATE_HIDDEN });
    expect(page.items.find((i) => i.kind === "result" && i.toolUseId === "p2")).toMatchObject({ output: "public notes" });
    expect(page.items.find((i) => i.kind === "tool" && i.toolUseId === "p1")).toMatchObject({ input: expect.stringContaining("<private>") });
    expect(text).not.toContain("privateOutput");
  });
  it("Bash `cat memory/private/x` (relative, from the workspace) is hidden too, and Grep rooted there", async () => {
    writeFileSync(file(), call("b1", "Bash", { command: "cat memory/private/x.md" }, "TOP SECRET", 1_000)
      + call("g1", "Grep", { pattern: "x", path: join(ws(), "memory", "private") }, "memory/private/a.md:1:SECRET LINE", 2_000));
    const text = JSON.stringify(await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws() }));
    expect(text).not.toContain("TOP SECRET");
    expect(text).not.toContain("SECRET LINE");
  });
  it("an `after` read pairs a result with its call from an earlier page; a result with no call in view is hidden", async () => {
    const secret = join(ws(), "memory", "private", "d.md");
    writeFileSync(file(), line("assistant", 1_000, [{ type: "tool_use", id: "p1", name: "Read", input: { file_path: secret } }])
      + line("assistant", 1_100, [{ type: "tool_use", id: "o1", name: "Read", input: { file_path: "/tmp/ok" } }]));
    const first = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws() });
    appendFileSync(file(), line("user", 2_000, [{ type: "tool_result", tool_use_id: "p1", content: "PRIVATE BODY" }])
      + line("user", 2_001, [{ type: "tool_result", tool_use_id: "o1", content: "fine" }])
      + line("user", 2_002, [{ type: "tool_result", tool_use_id: "ghost", content: "ORPHAN BODY" }]));
    const next = await readSessionTools(root, SDK, { after: first.end, transcript: first.transcript }, { workspaceDir: ws() });
    const by = (id: string) => next.items.find((i) => i.kind === "result" && i.toolUseId === id);
    expect(by("p1")).toMatchObject({ output: PRIVATE_HIDDEN });
    expect(by("o1")).toMatchObject({ output: "fine" });
    expect(by("ghost")).toMatchObject({ output: UNPAIRED_HIDDEN });
    expect(JSON.stringify(next)).not.toMatch(/PRIVATE BODY|ORPHAN BODY/);
  });
});

describe("a file tool aimed at memory/private shows only its name and redacted path", () => {
  it("Edit/Write/MultiEdit bodies never reach the response, nor the summary", async () => {
    const ws = join(root, "ws");
    const secret = join(ws, "memory", "private", "notes.md");
    writeFileSync(file(),
      call("e1", "Edit", { file_path: secret, old_string: "OLD SECRET", new_string: "NEW SECRET" }, "ok", 1_000) +
      call("w1", "Write", { file_path: secret, content: "WRITTEN SECRET" }, "ok", 2_000) +
      call("m1", "MultiEdit", { file_path: secret, edits: [{ old_string: "A SECRET", new_string: "B SECRET" }] }, "ok", 3_000) +
      call("e2", "Edit", { file_path: join(ws, "memory", "MEMORY.md"), old_string: "public old", new_string: "public new" }, "ok", 4_000));
    const page = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws });
    const text = JSON.stringify(page);
    for (const body of ["OLD SECRET", "NEW SECRET", "WRITTEN SECRET", "A SECRET", "B SECRET", "notes.md"]) expect(text).not.toContain(body);
    const edit = page.items.find((i) => i.kind === "tool" && i.toolUseId === "e1");
    expect(edit).toMatchObject({ name: "Edit", input: expect.stringContaining("<private>") });
    expect(edit && "input" in edit && JSON.parse(edit.input)).toEqual({ file_path: "<private>" });
    // A public edit keeps its body.
    expect(text).toContain("public new");
  });
});

describe("the owner's DM shows its calls whole; a group keeps the withholding", () => {
  const ws = () => join(root, "ws");
  const privateCalls = () => call("p1", "Read", { file_path: join(ws(), "memory", "private", "diary.md") }, "DEAR DIARY the owner's text", 1_000)
    + call("b1", "Bash", { command: "cat memory/private/x.md" }, "TOP SECRET", 2_000);
  it("owner: a Read or a Bash into memory/private returns its output as it is", async () => {
    writeFileSync(file(), privateCalls());
    const page = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws(), owner: true });
    const by = (id: string) => page.items.find((i) => i.kind === "result" && i.toolUseId === id);
    expect(by("p1")).toMatchObject({ output: "DEAR DIARY the owner's text" });
    expect(by("b1")).toMatchObject({ output: "TOP SECRET" });
    expect(JSON.stringify(page)).not.toContain(PRIVATE_HIDDEN);
    expect(JSON.stringify(page)).not.toContain("privateOutput");
  });
  it("group: the same calls are still withheld", async () => {
    writeFileSync(file(), privateCalls());
    const text = JSON.stringify(await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws() }));
    expect(text).not.toMatch(/DEAR DIARY|TOP SECRET/);
    expect(text).toContain(PRIVATE_HIDDEN);
  });
  it("owner: an `after` read shows a result whose call is out of view", async () => {
    writeFileSync(file(), line("assistant", 1_000, [{ type: "tool_use", id: "o1", name: "Read", input: { file_path: "/tmp/ok" } }]));
    const first = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws(), owner: true });
    appendFileSync(file(), line("user", 2_000, [{ type: "tool_result", tool_use_id: "ghost", content: "ORPHAN BODY" }]));
    const next = await readSessionTools(root, SDK, { after: first.end, transcript: first.transcript }, { workspaceDir: ws(), owner: true });
    expect(next.items.find((i) => i.kind === "result" && i.toolUseId === "ghost")).toMatchObject({ output: "ORPHAN BODY" });
  });
  it("group: a grep of SDK type files over `*.d.ts` is not judged private (its glob cannot name memory/ or private/)", async () => {
    const command = 'cd ~/Developer/tomo/node_modules/@anthropic-ai/claude-agent-sdk && grep -n -i -E "automemory|auto_memory|AUTO_MEMORY|autoMemoryDirectory" *.d.ts | head -15 | cut -c1-220; grep -n "SDK_SETTING_SOURCES" -A2 sdk.d.ts | head -6';
    writeFileSync(file(), call("g1", "Bash", { command }, "sdk.d.ts:42:  autoMemoryDirectory?: string;", 1_000));
    const page = await readSessionTools(root, SDK, { from: 0 }, { workspaceDir: ws() });
    expect(page.items.find((i) => i.kind === "result" && i.toolUseId === "g1")).toMatchObject({ output: "sdk.d.ts:42:  autoMemoryDirectory?: string;" });
  });
});

describe("WebData.tools: which conversation is the owner's", () => {
  it("the owner's DM gets the private output; a group's view of the same call stays withheld", async () => {
    const ws = join(root, "ws");
    const dirs = { sessionsDir: join(root, "sessions"), sdkSessionsDir: root, workspaceDir: ws };
    const store = new SessionStore(dirs.sessionsDir, 20, dirs.sdkSessionsDir);
    const group = "telegram:-100123";
    store.setSdkSessionId("dm:owner", "sdk-owner");
    store.setSdkSessionId(group, "sdk-group");
    const body = call("p1", "Read", { file_path: join(ws, "memory", "private", "diary.md") }, "DEAR DIARY", 1_000);
    writeFileSync(join(root, "sdk-owner.jsonl"), body);
    writeFileSync(join(root, "sdk-group.jsonl"), body);
    const data = new WebData({ ...dirs, owner: { name: "owner", telegram: ["1"], imessage: [] } });
    const result = async (id: string) => (await data.tools(id, { from: 0 })).items.find((i) => i.kind === "result");
    expect(await result(webSessionId("dm:owner"))).toMatchObject({ output: "DEAR DIARY" });
    expect(await result(webSessionId(group))).toMatchObject({ output: PRIVATE_HIDDEN });
  });
});
