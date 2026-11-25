import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionContext } from "../src/web/inspection.js";
import { computeContextStats } from "../src/lcm/stats.js";
import { readSummaryBlocks } from "../src/lcm/summary-reader.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { SessionStore } from "../src/sessions/store.js";
import { watchBus } from "../src/watch/bus.js";
import type { SessionEntry } from "../src/sessions/types.js";
import type { WebBootstrap } from "../src/web/protocol.js";
import { channelRpc, startWebService, type Headers, type WebService } from "./helpers/web-http.js";
import { DAY, NOW, seedTodos } from "./helpers/web-todos-fixture.js";

/**
 * The Study's server side: a session's context (src/web/inspection.ts) and
 * every Study route over HTTP. Each tab's reader has its own file:
 * web-memory-reader, web-config-view, web-todos-view, web-cron.
 */
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-study-")));
  mkdirSync(join(root, "memory", "topics"), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("context", () => {
  it("uses the CLI token estimator and summary-block parser, keeping reported usage separate", async () => {
    const events = [
      { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "An example message" } },
      { type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { content: [{ type: "text", text: "Example response" }] } },
      { isCompactSummary: true, blockTag: "daily 2026-01-01", timestamp: "2026-01-02T00:00:00Z", message: { content: "[daily 2026-01-01 — 2 events summarized]\n\nSummary" } },
    ];
    writeFileSync(join(root, "test-sdk.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
    const entry = { sdkSessionId: "test-sdk", lastActiveAt: 100, stats: { contextUsed: 4321, contextMax: 200000, contextEstimated: true } } as SessionEntry;
    const actual = await readSessionContext(entry, root);
    expect(actual).toMatchObject({ used: 4321, max: 200000, estimated: true, recordedAt: 100, analysisStatus: "available" });
    expect(actual.analysis).toMatchObject(computeContextStats("test-sdk", root)!);
    expect(actual.summaries).toMatchObject(readSummaryBlocks("test-sdk", root));
    expect(actual.summaries[0]).toMatchObject({ level: "daily", eventsSummarized: 2 });
    expect(await readSessionContext(undefined, root)).toMatchObject({ used: null, max: null, analysisStatus: "unavailable" });
    expect(await readSessionContext({ stats: { contextUsed: 0, contextMax: 0 } } as SessionEntry, root)).toMatchObject({ used: null, max: null });
  });

  it.each(["large line", "many lines"])("bounds the parser for %s while keeping persisted usage", async (kind) => {
    writeFileSync(join(root, "bounded.jsonl"), kind === "large line"
      ? JSON.stringify({ type: "user", message: { content: "x".repeat(256 * 1024) } }) : "{}\n".repeat(20_001));
    const entry = { sdkSessionId: "bounded", stats: { contextUsed: 50, contextMax: 200000 } } as SessionEntry;
    expect(await readSessionContext(entry, root)).toMatchObject({ used: 50, max: 200000, analysis: null, analysisStatus: "too_large" });
  });

  it("keeps the 100 most recent rollups, each preview bounded", async () => {
    const events = Array.from({ length: 105 }, (_, i) => ({ isCompactSummary: true, timestamp: String(i).padStart(3, "0"), message: { content: "s".repeat(9000) } }));
    writeFileSync(join(root, "summaries.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
    const value = await readSessionContext({ sdkSessionId: "summaries" } as SessionEntry, root);
    expect(value.summaries).toHaveLength(100);
    expect(value.summaries[0]).toMatchObject({ timestamp: "104", truncated: true });
    expect(value.summaries[0].content).toHaveLength(8000);
    expect(value.summariesTruncated).toBe(true);
  });
});

describe("Study HTTP", () => {
  let web: WebService;
  let channel: WebChannel;
  let boot: WebBootstrap;
  let reconnects: string[] = [];
  const reconnect = async (body: unknown, headers: Headers = {}) => {
    const response = await web.send("POST", "/api/v1/mcp/reconnect", body, headers);
    return { status: response.status, value: response.json() };
  };
  const call = async (path: string, headers: Headers = {}) => {
    const response = await web.get("/api/v1" + path, headers);
    return { status: response.status, value: response.json() };
  };
  beforeEach(async () => {
    reconnects = [];
    writeFileSync(join(root, "memory", "TODO.md"), "- [ ] LEGACY-MARKDOWN task");
    seedTodos(join(root, "data", "todos"));
    mkdirSync(join(root, "memory", "private"));
    writeFileSync(join(root, "memory", "private", "note.md"), "PRIVATE-NEEDLE");
    writeFileSync(join(root, "memory", "topics", "public.md"), "public NEEDLE");
    writeFileSync(join(root, "config.json"), JSON.stringify({ model: "test-model", auth: { apiKey: "sk-synthetic-secret-value-01" } }));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
    const sessions = new SessionStore(sessionsDir, 20, sdkSessionsDir);
    sessions.touchSession("dm:owner"); sessions.touchSession("telegram:-2"); sessions.setChatTitle("telegram:-2", "Book club");
    channel = new WebChannel(owner); channel.onMessage(async () => true);
    const data = new WebData({ workspaceDir: root, tomoHome: root, cronStorePath: join(root, "jobs.json"), sessionsDir, sdkSessionsDir, owner, todoLimits: { maxOpen: 12, maxSnoozes: 2 } });
    web = await startWebService({ assetsDir: root, data, subscribe: (fn) => channel.events.subscribe(fn), rpc: channelRpc(channel, {
      "mcp-status": () => ({ sessions: [{ sessionId: boot.ownerId, connections: [{ name: "search", status: "connected" }] }], oauth: [{ name: "search", oauth: "login-required" }] }),
      "context-events": (rpc: { sessionId: string }) => channel.contextEvents(rpc.sessionId),
      "mcp-reconnect": (rpc: { server: string }) => { reconnects.push(rpc.server); return { outcome: "reconnected" }; },
    }) });
    boot = web.boot;
  });
  afterEach(async () => { await web?.close(); await channel?.stop(); });

  it("requires authentication on every Study read", async () => {
    for (const path of ["/todos", "/memory/tree", "/memory/file?path=TODO.md", "/memory/search?q=test", "/cron", "/config", "/mcp", `/sessions/${boot.ownerId}/context`]) {
      expect((await call(path, { cookie: "" })).status, path).toBe(401);
      expect((await call(path, { "x-tomo-request": "" })).status, path).toBe(403);
      expect((await call(path)).status, path).toBe(200);
    }
  });

  it("reconnects an MCP server only behind the write gate: origin, cookie, CSRF, JSON, the current epoch", async () => {
    expect((await reconnect({ server: "search" }, { cookie: "" })).status).toBe(401);
    expect((await reconnect({ server: "search" }, { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await reconnect({ server: "search" }, { "x-tomo-csrf": "bad" })).value).toEqual({ error: "invalid_csrf" });
    expect((await reconnect({ server: "search" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await reconnect({ server: "search" }, { "x-tomo-epoch": "00000000-0000-4000-8000-000000000000" })).value).toEqual({ error: "epoch_changed" });
    expect((await reconnect({ server: "../etc" })).value).toEqual({ error: "invalid_mcp_reconnect" });
    expect((await reconnect({ server: "search", extra: 1 })).value).toEqual({ error: "invalid_mcp_reconnect" });
    expect(reconnects).toEqual([]);
    expect(await reconnect({ server: "search" })).toEqual({ status: 200, value: { outcome: "reconnected" } });
    expect(reconnects).toEqual(["search"]);
  });

  it("serves real workspace data and never private memory or secrets", async () => {
    // One at a time (the server serialises disk inspections), each a real 200
    // with content, so "no private text" is not vacuously true of an error.
    const responses = [];
    for (const path of ["/memory/tree", "/memory/search?q=NEEDLE", "/config", "/mcp"]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      responses.push(response.value);
    }
    expect((responses[0].entries as unknown[]).length).toBeGreaterThan(0);
    expect(responses[1].results).toEqual([{ path: "topics/public.md", line: 1, text: "public NEEDLE" }]);
    const everything = JSON.stringify(responses);
    expect(everything).not.toContain("PRIVATE-NEEDLE");
    expect(everything).not.toContain("private/note.md");
    expect(everything).not.toContain("sk-synthetic-secret-value-01");
    expect(await call("/memory/file?path=private%2Fnote.md")).toMatchObject({ status: 404, value: { error: "memory_not_found" } });
    expect((await call("/memory/file?path=..%2Fconfig.json")).status).toBe(400);
    expect((await call("/mcp")).value.live).toEqual({ available: true, sessions: [{ sessionId: boot.ownerId, connections: [{ name: "search", status: "connected" }] }],
      oauth: [{ name: "search", oauth: "login-required" }] });
  });

  it("serves the todo store: open items, the done log newest first, and the limits in force", async () => {
    const { status, value } = await call("/todos");
    expect(status).toBe(200);
    expect(value.limits).toEqual({ maxOpen: 12, maxSnoozes: 2 });
    expect(value.items).toEqual([
      { id: "t-3", title: "Review the release", next: "Read the diff", waitingOn: "owner", reviewAt: NOW - 2 * DAY, ref: "https://example.com/pull/41",
        createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY, source: "self", snoozes: 0 },
      { id: "t-4", title: "Call the plumber", next: "Phone before noon", waitingOn: "me", reviewAt: NOW + 2 * DAY,
        createdAt: NOW - 5 * DAY, updatedAt: NOW - DAY, source: "owner", snoozes: 1, snoozeReason: "Line was busy." },
      { id: "t-5", title: "Pick the next book", next: "Post the poll", waitingOn: "external", reviewAt: NOW + 6 * DAY,
        createdAt: NOW - DAY, updatedAt: NOW - DAY, source: "self", snoozes: 0, group: "Book club" },
    ]);
    expect((value.recent as Array<Record<string, unknown>>).map((r) => [r.id, r.resolution, r.resolvedAt, r.resolvedBy, r.reason, r.evidence])).toEqual([
      ["t-2", "drop", NOW - 3 * DAY, "owner", "No longer needed.", undefined],
      ["t-1", "done", NOW - 8 * DAY, "self", undefined, "https://example.com/pull/37"],
    ]);
    expect(value.moreResolved).toBe(false);
  });

  it("shows what the owner's conversation sees, and counts every open item toward the cap", async () => {
    const { value } = await call("/todos");
    const text = JSON.stringify(value);
    // t-6 belongs to another identity's DM: hidden like in the owner's /todo, but it still takes a slot.
    expect(text).not.toContain("OTHER-DM-NEEDLE");
    expect(value.openTotal).toBe(4);
    expect((value.items as unknown[]).length).toBe(3);
    // Session keys stay on the server; a group item carries its chat title.
    expect(text).not.toContain("telegram:-2");
    expect(text).not.toContain("dm:owner");
  });

  it("no longer reads memory/TODO*.md", async () => {
    const { value } = await call("/todos");
    expect(value).not.toHaveProperty("files");
    expect(JSON.stringify(value)).not.toContain("LEGACY-MARKDOWN");
  });

  it("never writes the todo store: no lock, no new file, the same bytes", async () => {
    const dir = join(root, "data", "todos");
    const snapshot = () => readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8"), statSync(join(dir, name)).mtimeMs]);
    const before = snapshot();
    expect(before.map(([name]) => name)).toEqual(["done.ndjson", "todos.json"]);
    for (let i = 0; i < 3; i++) expect((await call("/todos")).status).toBe(200);
    expect(snapshot()).toEqual(before);
    // An install with no todos yet: an empty list, and still nothing created.
    rmSync(dir, { recursive: true });
    expect((await call("/todos")).value).toMatchObject({ items: [], recent: [], openTotal: 0, moreResolved: false });
    expect(() => statSync(dir)).toThrow();
  });

  it("reports an unreadable store as unavailable, never as an empty list or with a path", async () => {
    writeFileSync(join(root, "data", "todos", "todos.json"), "{ not json");
    const response = await call("/todos");
    expect(response).toMatchObject({ status: 503, value: { error: "todos_unavailable" } });
    expect(JSON.stringify(response.value)).not.toContain(root);
  });

  it("adds compactions seen on the bus to the context view", async () => {
    watchBus.publish({ type: "compact", ts: 1000, sessionKey: "dm:owner", preTokens: 150000, postTokens: 30000 });
    const context = await call(`/sessions/${boot.ownerId}/context`);
    expect(context.value).toMatchObject({ used: null, analysisStatus: "unavailable", recentCompactions: [{ timestamp: 1000, preTokens: 150000, postTokens: 30000 }] });
    expect((await call(`/sessions/${"x".repeat(43)}/context`)).status).toBe(404);
  });
});
