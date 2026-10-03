import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { prepareSessionRewind } from "../src/agent/session-rewind.js";
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

  it("refuses to split a tool call from its result at a steered message", async () => {
    human("Start work");
    add("assistant", [{ type: "tool_use", id: "tool-example", name: "Read", input: {} }]);
    human("Steered request");
    add("user", [{ type: "tool_result", tool_use_id: "tool-example", content: "Done" }]);
    assistant("Finished"); save();
    await expect(rewind()).rejects.toThrow("during a tool call");
    expect((await rewind(2)).sessionId).toBeUndefined();
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
