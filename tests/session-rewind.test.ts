import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { prepareSessionRewind } from "../src/agent/session-rewind.js";
import { HISTORY_KEPT_CHANGING, prepareSettledSessionRewind } from "../src/agent/settled-rewind.js";
import { SessionStore } from "../src/sessions/store.js";
import * as fsUtils from "../src/fs-utils.js";

// Keep the native implementations while allowing failure injection around a fork.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let root: string;
let workspace: string;
let sdkDir: string;
let sid: string;
let path: string;
let entries: Array<Record<string, unknown>>;
function add(type: string, content: unknown, extra: Record<string, unknown> = {}) {
  const uuid = randomUUID();
  entries.push({
    type, uuid, parentUuid: entries.at(-1)?.uuid ?? null,
    sessionId: sid, timestamp: new Date().toISOString(), cwd: workspace, isSidechain: false,
    message: { role: type, content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) },
    ...extra,
  });
  return uuid;
}
function human(text: string) { return add("user", text, { origin: { kind: "human" } }); }
function assistant(text: string) { return add("assistant", [{ type: "text", text }]); }
function save() { writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); }
function rewind(count = 1) { return prepareSessionRewind(sid, count, workspace, sdkDir); }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-rewind-")));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  const claudeDir = join(root, "claude");
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
  sdkDir = join(claudeDir, "projects", workspace.replace(/[/.]/g, "-"));
  mkdirSync(sdkDir, { recursive: true });
  sid = randomUUID();
  path = join(sdkDir, `${sid}.jsonl`);
  entries = [];
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("conversation rewind with the installed SDK (no model requests)", () => {
  it("discards only an unpublished fork and tolerates repeated cleanup", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const original = readFileSync(path, "utf8");
    const prepared = await rewind();
    const forkPath = join(sdkDir, `${prepared.sessionId}.jsonl`);
    expect(existsSync(forkPath)).toBe(true);
    await prepared.discard();
    await prepared.discard();
    expect(existsSync(forkPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("removes the fork when source validation fails after the SDK created it", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const fork = sdk.forkSession;
    let forkId: string | undefined;
    vi.spyOn(sdk, "forkSession").mockImplementationOnce(async (...args) => {
      const result = await fork(...args);
      forkId = result.sessionId;
      appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: "Changed" }) + "\n");
      return result;
    });
    await expect(rewind()).rejects.toThrow("changed during rewind");
    expect(forkId).toBeTruthy();
    expect(existsSync(join(sdkDir, `${forkId}.jsonl`))).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("Changed");
  });

  it("rejects changes during the asynchronous initial read before creating a fork", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const fork = vi.spyOn(sdk, "forkSession");
    const pending = rewind();
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: "Changed" }) + "\n");
    await expect(pending).rejects.toThrow("changed during rewind");
    expect(fork).not.toHaveBeenCalled();
  });

  it("forks before the selected human message and preserves the source byte for byte", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("API Error: Example Model's safeguards flagged this message");
    human("Another attempt"); assistant("Still unavailable"); save();
    const source = readFileSync(path, "utf8");
    const result = await rewind(2);
    expect(result.sessionId).toBeTruthy();
    const messages = await getSessionMessages(result.sessionId!, { dir: workspace });
    expect(messages.map((m) => m.message)).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("Initial answer");
    expect(JSON.stringify(messages)).not.toContain("Request to edit");
    expect(readFileSync(path, "utf8")).toBe(source);
    expect(result.assertUnchanged).not.toThrow();
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: "Changed" }) + "\n");
    expect(result.assertUnchanged).toThrow("changed during rewind");
  });

  it("keeps a completed tool result and does not count it or a background turn as human", async () => {
    human("Initial request");
    add("assistant", [{ type: "tool_use", id: "tool-example", name: "Read", input: {} }]);
    const carrier = add("user", [{ type: "tool_result", tool_use_id: "tool-example", content: "Done" }]);
    add("user", "Background maintenance", { origin: { kind: "unclassified" } });
    assistant("Maintenance finished"); human("Request to edit"); assistant("Unavailable"); save();
    const result = await rewind();
    const fork = readFileSync(join(sdkDir, `${result.sessionId}.jsonl`), "utf8");
    expect(fork).toContain(carrier); // forkedFrom retains the original UUID
    expect(fork).toContain("tool_result");
    expect(fork).toContain("Maintenance finished");
    expect(fork).not.toContain("Request to edit");
    const all = await rewind(2);
    expect(all.sessionId).toBeUndefined();
  });

  it("keeps a compact summary when rewinding the first fresh user message", async () => {
    add("user", "Earlier conversation summary", { isCompactSummary: true, origin: { kind: "human" } });
    assistant("Ready to continue"); human("Fresh request"); assistant("Unavailable"); save();
    const result = await rewind();
    const messages = await getSessionMessages(result.sessionId!, { dir: workspace });
    expect(JSON.stringify(messages)).toContain("Earlier conversation summary");
    await expect(rewind(2)).rejects.toThrow("Only 1 recorded human");
  });

  it("moves the cut back past a steered message that split a tool call from its later result", async () => {
    human("Start work");
    add("assistant", [{ type: "tool_use", id: "tool-example", name: "Read", input: {} }]);
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-example", content: "Done" }]);
    assistant("Finished"); save();
    const first = await rewind();
    expect(first).toMatchObject({ sessionId: undefined, count: 2, preview: "Start work" });
    expect(await rewind(2)).toMatchObject({ sessionId: undefined, count: 2 });
  });

  it("lands at the end of the previous complete turn, keeping that turn's tool result", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Start work");
    add("assistant", [{ type: "tool_use", id: "tool-done", name: "Read", input: {} }]);
    add("user", [{ type: "tool_result", tool_use_id: "tool-done", content: "Done" }]);
    add("assistant", [{ type: "tool_use", id: "tool-split", name: "Read", input: {} }]);
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-split", content: "Done" }]);
    assistant("Finished"); human("Next request"); assistant("Unavailable"); save();
    expect(await rewind()).toMatchObject({ count: 1, preview: "Next request" });
    const moved = await rewind(2);
    expect(moved).toMatchObject({ count: 3, preview: "Start work" });
    const fork = JSON.stringify(await getSessionMessages(moved.sessionId!, { dir: workspace }));
    expect(fork).toContain("Initial answer");
    expect(fork).not.toContain("Start work");
    expect(fork).not.toContain("tool-split");
  });

  it("refuses when even the earliest human message split a tool call from its result", async () => {
    add("user", "Background maintenance", { origin: { kind: "unclassified" } });
    add("assistant", [{ type: "tool_use", id: "tool-example", name: "Read", input: {} }]);
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-example", content: "Done" }]);
    assistant("Finished"); save();
    const fork = vi.spyOn(sdk, "forkSession");
    await expect(rewind()).rejects.toThrow("no completed turn to return to");
    expect(fork).not.toHaveBeenCalled();
  });

  it("steps back when the fork would keep a compaction-preserved tool call whose result comes later", async () => {
    human("Before compaction");
    const preserved = add("assistant", [{ type: "tool_use", id: "tool-preserved", name: "Read", input: {} }]);
    const boundary = add("system", undefined, {
      subtype: "compact_boundary", parentUuid: null, logicalParentUuid: preserved,
      compactMetadata: { trigger: "auto", preTokens: 1, preservedMessages: { anchorUuid: "", uuids: [preserved] } },
    });
    (entries.at(-1)!.compactMetadata as { preservedMessages: { anchorUuid: string } }).preservedMessages.anchorUuid = boundary;
    delete entries.at(-1)!.message;
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-preserved", content: "Done" }]);
    assistant("Finished"); save();
    const before = new Set(readdirSync(sdkDir));
    const fork = vi.spyOn(sdk, "forkSession");
    await expect(rewind()).rejects.toThrow("no completed turn to return to");
    expect(fork).toHaveBeenCalledOnce();
    expect(new Set(readdirSync(sdkDir))).toEqual(before);
  });

  it("steps back when the fork would keep an off-chain tool call whose result comes later", async () => {
    const start = human("Start work");
    const offChain = add("assistant", [{ type: "tool_use", id: "tool-team", name: "Read", input: {} }], { teamName: "example-team" });
    const answer = add("assistant", [{ type: "text", text: "Working" }], { parentUuid: start });
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-team", content: "Done" }], { parentUuid: offChain, teamName: "example-team" });
    assistant("Finished");
    entries.at(-1)!.parentUuid = entries.at(-3)!.uuid; save();
    expect(answer).toBeTruthy();
    const before = new Set(readdirSync(sdkDir));
    const fork = vi.spyOn(sdk, "forkSession");
    expect(await rewind()).toMatchObject({ sessionId: undefined, count: 2, preview: "Start work" });
    expect(fork).toHaveBeenCalledOnce();
    expect(new Set(readdirSync(sdkDir))).toEqual(before);
  });

  it("jumps straight past an early split tool call instead of forking once per message", async () => {
    const start = human("Start work");
    const offChain = add("assistant", [{ type: "tool_use", id: "tool-team", name: "Read", input: {} }], { teamName: "example-team" });
    add("assistant", [{ type: "text", text: "Working" }], { parentUuid: start });
    for (let i = 0; i < 12; i++) { human(`Message ${i}`); assistant(`Answer ${i}`); }
    const last = entries.at(-1)!.uuid as string;
    add("user", [{ type: "tool_result", tool_use_id: "tool-team", content: "Done" }], { parentUuid: offChain, teamName: "example-team" });
    human("Request to edit"); entries.at(-1)!.parentUuid = last;
    assistant("Unavailable"); save();
    const fork = vi.spyOn(sdk, "forkSession");
    expect(await rewind()).toMatchObject({ sessionId: undefined, count: 14, preview: "Start work" });
    expect(fork.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("stops instead of stepping back when a rejected fork cannot be removed", async () => {
    const start = human("Start work");
    const offChain = add("assistant", [{ type: "tool_use", id: "tool-team", name: "Read", input: {} }], { teamName: "example-team" });
    add("assistant", [{ type: "text", text: "Working" }], { parentUuid: start });
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-team", content: "Done" }], { parentUuid: offChain, teamName: "example-team" });
    assistant("Finished"); entries.at(-1)!.parentUuid = entries.at(-3)!.uuid; save();
    const fork = vi.spyOn(sdk, "forkSession");
    vi.spyOn(sdk, "deleteSession").mockRejectedValueOnce(new Error("Disk busy"));
    await expect(rewind()).rejects.toThrow("Could not remove a rejected rewind branch");
    expect(fork).toHaveBeenCalledOnce();
  });

  it("ignores historical tool calls whose result never arrived", async () => {
    human("Earlier request");
    add("assistant", [{ type: "tool_use", id: "tool-orphan", name: "Read", input: {} }]);
    human("Request after an interrupted turn"); assistant("Answer");
    add("assistant", [{ type: "tool_use", id: "tool-blocked", name: "Bash", input: {} }]);
    human("Request to edit"); assistant("Unavailable"); save();
    const result = await rewind();
    expect(result).toMatchObject({ count: 1, preview: "Request to edit" });
    const fork = JSON.stringify(await getSessionMessages(result.sessionId!, { dir: workspace }));
    expect(fork).toContain("tool-orphan");
    expect(fork).toContain("tool-blocked");
    expect(fork).not.toContain("Request to edit");
    expect(await rewind(2)).toMatchObject({ count: 2, preview: "Request after an interrupted turn" });
  });

  it("quotes the opening words of the rewound message, trimmed", async () => {
    human("Initial request"); assistant("Answer");
    add("user", [{ type: "text", text: `[imessage · Mon 10/05 16:54 PDT]   ${"word ".repeat(40)}` }], { origin: { kind: "human" } });
    assistant("Unavailable"); save();
    const { preview } = await rewind();
    expect(preview.startsWith("[imessage · Mon 10/05 16:54 PDT] word word")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect([...preview].length).toBeLessThanOrEqual(81);
  });

  it("rewinding the first human message prepares a fresh context without deleting the source", async () => {
    human("First request"); assistant("Unavailable"); save();
    const original = readFileSync(path, "utf8");
    expect((await rewind()).sessionId).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses unknown authorship, invalid counts and corrupt or partial history", async () => {
    add("user", "Legacy message without provenance"); assistant("Answer"); save();
    await expect(rewind()).rejects.toThrow("Only 0 recorded human");
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(rewind(count)).rejects.toThrow("positive integer");
    writeFileSync(path, "{broken}\n");
    await expect(rewind()).rejects.toThrow();
    writeFileSync(path, "{unfinished");
    await expect(rewind()).rejects.toThrow("still being written");
  });
});

// What the CLI child appends to the transcript as it exits — after its event
// stream has already ended (seen live on 2026-10-06 at 16:07 PDT).
const exitRecord = () => JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: 1 }) + "\n";
const forkFiles = () => readdirSync(sdkDir).filter((name) => name.endsWith(".jsonl") && name !== `${sid}.jsonl`);

describe("rewinding a session that was just closed", () => {
  it("waits out the closed CLI's trailing writes, then rewinds on the first try", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const writes: number[] = [];
    const timers = [80, 200].map((ms) => setTimeout(() => { appendFileSync(path, exitRecord()); writes.push(Date.now()); }, ms));
    const read = vi.spyOn(sdk, "getSessionMessages");
    const publish = vi.fn((prepared: { assertUnchanged(): void }) => prepared.assertUnchanged());
    try {
      const prepared = await prepareSettledSessionRewind(sid, 1, workspace, sdkDir, publish, { quietMs: 250, pollMs: 10 });
      expect(writes).toHaveLength(2);
      expect(read).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
      expect(existsSync(join(sdkDir, `${prepared.sessionId}.jsonl`))).toBe(true);
      expect(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)).toContain("cost-state");
    } finally { timers.forEach(clearTimeout); }
  });

  it("retries when a trailing write still lands mid-prepare", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const original = sdk.getSessionMessages;
    const read = vi.spyOn(sdk, "getSessionMessages").mockImplementationOnce(async (...args) => {
      appendFileSync(path, exitRecord());
      return original(...args);
    });
    const publish = vi.fn((prepared: { assertUnchanged(): void }) => prepared.assertUnchanged());
    const prepared = await prepareSettledSessionRewind(sid, 1, workspace, sdkDir, publish, { quietMs: 50, pollMs: 10 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
    expect(forkFiles()).toEqual([`${prepared.sessionId}.jsonl`]);
  });

  it("fails cleanly after two retries when the transcript never stops changing, discarding every fork", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const original = readFileSync(path, "utf8");
    const fork = sdk.forkSession;
    const forked: string[] = [];
    vi.spyOn(sdk, "forkSession").mockImplementation(async (...args) => {
      const result = await fork(...args);
      forked.push(result.sessionId);
      appendFileSync(path, exitRecord());
      return result;
    });
    const publish = vi.fn();
    await expect(prepareSettledSessionRewind(sid, 1, workspace, sdkDir, publish, { quietMs: 30, pollMs: 5 }))
      .rejects.toThrow(HISTORY_KEPT_CHANGING);
    expect(forked).toHaveLength(3);
    expect(publish).not.toHaveBeenCalled();
    expect(forkFiles()).toEqual([]);
    expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
  });

  it("discards the fork and does not retry when publishing fails for another reason", async () => {
    human("Initial request"); assistant("Initial answer");
    human("Request to edit"); assistant("Unavailable"); save();
    const fork = vi.spyOn(sdk, "forkSession");
    await expect(prepareSettledSessionRewind(sid, 1, workspace, sdkDir, () => { throw new Error("Session changed"); }, { quietMs: 0 }))
      .rejects.toThrow("Session changed");
    expect(fork).toHaveBeenCalledOnce();
    expect(forkFiles()).toEqual([]);
  });
});

describe("publishing a rewind", () => {
  it("atomically swaps links, preserves metadata and transcript, and survives reload", () => {
    const dir = join(root, "store");
    const store = new SessionStore(dir, 20, sdkDir);
    const key = "dm:example";
    store.setSdkSessionId(key, sid);
    store.setChatTitle(key, "Example conversation");
    store.setReplyTarget(key, { channelName: "test", chatId: "example-chat" });
    store.append(key, { role: "user", content: "Preserved history", channel: "test", timestamp: Date.now() });
    const newId = randomUUID();
    store.replaceSdkSessionId(key, sid, newId);
    const reloaded = new SessionStore(dir, 20, sdkDir);
    expect(reloaded.getSdkSessionId(key)).toBe(newId);
    expect(reloaded.getEntry(key)).toMatchObject({ chatTitle: "Example conversation", replyTarget: { channelName: "test", chatId: "example-chat" } });
    expect(reloaded.get(key).messages[0].content).toBe("Preserved history");
    expect(reloaded.listAllSessions().find((s) => s.sdkSessionId === sid)?.expiresAt).toBeGreaterThan(Date.now());
    expect(() => reloaded.replaceSdkSessionId(key, sid, randomUUID())).toThrow("Session changed");
    expect(reloaded.getSdkSessionId(key)).toBe(newId);
    reloaded.replaceSdkSessionId(key, newId);
    expect(reloaded.getSdkSessionId(key)).toBeUndefined();
    expect(reloaded.getEntry(key)?.chatTitle).toBe("Example conversation");
  });

  it("leaves the old link intact when the registry cannot be read", () => {
    const dir = join(root, "store");
    const store = new SessionStore(dir, 20, sdkDir);
    store.setSdkSessionId("dm:example", sid);
    const registry = join(dir, "_sessions.json");
    writeFileSync(registry, "{broken");
    expect(() => store.replaceSdkSessionId("dm:example", sid, randomUUID())).toThrow();
    expect(readFileSync(registry, "utf8")).toBe("{broken");
    expect(store.getSdkSessionId("dm:example")).toBe(sid);
  });

  it("rolls back the in-memory link when publishing the registry fails", () => {
    const dir = join(root, "store");
    const store = new SessionStore(dir, 20, sdkDir);
    store.setSdkSessionId("dm:example", sid);
    const registry = join(dir, "_sessions.json");
    const before = readFileSync(registry, "utf8");
    vi.spyOn(fsUtils, "writeJsonAtomicSync").mockImplementationOnce(() => { throw new Error("Write failed"); });
    expect(() => store.replaceSdkSessionId("dm:example", sid, randomUUID())).toThrow("Write failed");
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(store.getSdkSessionId("dm:example")).toBe(sid);
    expect(store.listAllSessions()).toHaveLength(1);
  });
});
