import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryReader } from "../src/workspace/memory-reader.js";
import { CronStore } from "../src/cron/store.js";
import { MAX_CRON_STORE_BYTES, WebCron, readSessionContext } from "../src/web/inspection.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";
import { readWebTodos } from "../src/web/todos-view.js";
import { configFields, mcpServers, WebConfigReader } from "../src/web/config-view.js";
import { computeContextStats } from "../src/lcm/stats.js";
import { readSummaryBlocks } from "../src/lcm/summary-reader.js";
import { McpLiveStatus } from "../src/mcp/live-status.js";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { SessionStore } from "../src/sessions/store.js";
import { watchBus } from "../src/watch/bus.js";
import type { SessionEntry } from "../src/sessions/types.js";
import type { WebBootstrap } from "../src/web/protocol.js";

let root: string;
let memory: MemoryReader;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-study-")));
  mkdirSync(join(root, "memory", "topics"), { recursive: true });
  memory = new MemoryReader(root);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("memory reader", () => {
  it("lists an index, topic subdirectories and markdown files, and searches literally", async () => {
    writeFileSync(join(root, "memory", "MEMORY.md"), "# Index\n[Topic](topics/topic.md)");
    writeFileSync(join(root, "memory", "TODO-work.md"), "- [x] Done\n- [ ] Next [literal]");
    writeFileSync(join(root, "memory", "topics", "topic.md"), "A topic [literal]");
    writeFileSync(join(root, "memory", "topics", "TODO-nested.md"), "- [ ] Nested");
    expect((await memory.tree()).entries.map((e) => e.path)).toEqual(["MEMORY.md", "TODO-work.md", "topics", "topics/TODO-nested.md", "topics/topic.md"]);
    expect((await memory.search("[literal]")).results).toHaveLength(2);
    expect((await memory.file("MEMORY.md")).content).toContain("# Index");
  });

  it.each(["../outside.md", "/outside.md", "topics/../../outside.md", "topics\\outside.md", "topics/./topic.md", "note.txt"])("rejects an unsafe path %s", async (path) => {
    await expect(memory.file(path)).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects file, directory and root symlinks, plus hard links", async () => {
    writeFileSync(join(root, "outside.md"), "outside content");
    symlinkSync(join(root, "outside.md"), join(root, "memory", "alias.md"));
    symlinkSync(root, join(root, "memory", "escape"));
    linkSync(join(root, "outside.md"), join(root, "memory", "hard.md"));
    await expect(memory.file("alias.md")).rejects.toThrow();
    await expect(memory.file("escape/outside.md")).rejects.toThrow();
    await expect(memory.file("hard.md")).rejects.toThrow();
    expect(JSON.stringify(await memory.search("outside content"))).not.toContain("outside content");
    rmSync(join(root, "memory"), { recursive: true }); symlinkSync(root, join(root, "memory"));
    await expect(memory.tree()).rejects.toThrow();
  });

  it("bounds reads and tells missing memory apart from an empty result", async () => {
    writeFileSync(join(root, "memory", "large.md"), "x".repeat(256 * 1024 + 1));
    await expect(memory.file("large.md")).rejects.toMatchObject({ code: "limit" });
    await expect(memory.file("missing.md")).rejects.toMatchObject({ code: "not_found" });
    rmSync(join(root, "memory"), { recursive: true });
    expect(await memory.tree()).toMatchObject({ missing: true });
  });

  describe("memory/private/ is never served", () => {
    beforeEach(() => {
      mkdirSync(join(root, "memory", "private", "people"), { recursive: true });
      writeFileSync(join(root, "memory", "private", "note.md"), "PRIVATE-NEEDLE owner-only note");
      writeFileSync(join(root, "memory", "private", "TODO.md"), "- [ ] PRIVATE-NEEDLE task");
      writeFileSync(join(root, "memory", "private", "people", "friend.md"), "PRIVATE-NEEDLE person");
      writeFileSync(join(root, "memory", "MEMORY.md"), "# Index\n- [Public](topics/topic.md)\n- [Secret](private/note.md) PRIVATE-NEEDLE\n- [Also](./private/people/friend.md)");
      writeFileSync(join(root, "memory", "topics", "topic.md"), "public topic");
    });

    it("is absent from the tree and search", async () => {
      const tree = await memory.tree();
      expect(tree.entries.map((e) => e.path)).toEqual(["MEMORY.md", "topics", "topics/topic.md"]);
      const found = await memory.search("PRIVATE-NEEDLE");
      expect(found.results).toEqual([]);
      expect(found.unreadable).toBe(0);
    });

    it.each(["private/note.md", "PRIVATE/note.md", "Private/people/friend.md", "private/TODO.md"])("reads %s as not found", async (path) => {
      await expect(memory.file(path)).rejects.toMatchObject({ code: "not_found" });
    });

    it("withholds index lines that link into private/", async () => {
      const index = await memory.file("MEMORY.md");
      expect(index.content).toBe("# Index\n- [Public](topics/topic.md)");
      expect(index.hiddenLines).toBe(2);
    });

    it("does not follow a public-looking symlink into private/", async () => {
      symlinkSync(join(root, "memory", "private"), join(root, "memory", "notes"));
      expect((await memory.tree()).entries.map((e) => e.path)).not.toContain("notes");
      await expect(memory.file("notes/note.md")).rejects.toThrow();
    });

    it("uses the agent's own private-memory fence, not a copy", async () => {
      // A case-insensitive volume would open memory/PRIVATE/ as private/; the
      // shared fence folds case, so the reader refuses it before opening.
      expect(memory.isPrivate("PRIVATE/x.md")).toBe(true);
      expect(memory.isPrivate("privateer.md")).toBe(false);
    });
  });
});

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

describe("cron list", () => {
  it("lists a job's intent and run state", async () => {
    const path = join(root, "data", "cron", "jobs.json");
    const store = new CronStore(path);
    const job = store.add({ name: "Example task", schedule: { kind: "every", everyMs: 60_000 }, message: "Review the test note", sessionKey: "dm:owner" });
    expect((await new WebCron(path).list()).jobs).toEqual([expect.objectContaining({ id: job.id, name: "Example task", message: "Review the test note",
      sessionKey: "dm:owner", scheduleLabel: "every 1m", enabled: true, lastStatus: null })]);
  });
  it("reports an unreadable store as unavailable, not as no jobs", async () => {
    const path = join(root, "jobs.json");
    writeFileSync(path, "{not json");
    await expect(new WebCron(path).list()).rejects.toMatchObject({ status: 503, code: "cron_unavailable" });
    writeFileSync(path, JSON.stringify({ jobs: [null] }));
    await expect(new WebCron(path).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("reads a missing store as no jobs, and has no path of its own", async () => {
    expect(await new WebCron(join(root, "absent.json")).list()).toEqual({ jobs: [] });
    await expect(new WebCron(undefined).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("refuses a FIFO, a symlink and a directory without blocking", async () => {
    const fifo = join(root, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    await expect(new WebCron(fifo).list()).rejects.toMatchObject({ code: "cron_unavailable" });
    const real = join(root, "real.json"); writeFileSync(real, JSON.stringify({ version: 1, revision: 1, jobs: [] }));
    symlinkSync(real, join(root, "link.json"));
    await expect(new WebCron(join(root, "link.json")).list()).rejects.toMatchObject({ code: "cron_unavailable" });
    await expect(new WebCron(root).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("refuses a store over the size bound with an explicit error", async () => {
    const path = join(root, "big.json");
    writeFileSync(path, JSON.stringify({ version: 1, revision: 1, jobs: [], pad: "x".repeat(MAX_CRON_STORE_BYTES) }));
    await expect(new WebCron(path).list()).rejects.toMatchObject({ status: 413, code: "cron_store_too_large" });
  });
});

describe("config view", () => {
  const secrets = ["123456:AAH-telegram-bot-token-value", "sk-ant-synthetic-api-key-0001", "synthetic-group-secret", "env-secret-value-0001",
    "header-secret-value-0001", "https://user:pw-synthetic@example.test/v1", "litellm-key-value-0001"];
  const file = {
    model: "claude-opus-5-5",
    channels: { telegram: { token: secrets[0], allowlist: ["12345"] } },
    auth: { apiKey: secrets[1] },
    groupSecret: secrets[2],
    litellm: { baseUrl: secrets[5], apiKey: secrets[6] },
    mcpServers: {
      search: { type: "stdio", command: "npx", args: ["--token", "x"], env: { SEARCH_KEY: secrets[3] }, timeout: 30, enabled: true },
      remote: { type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: secrets[4] }, enabled: false },
    },
    web: { enabled: true, port: 9465 },
  };

  it("shows ordinary values and masks every credential", () => {
    const { fields } = configFields(file);
    const text = JSON.stringify(fields);
    for (const secret of secrets) expect(text).not.toContain(secret);
    const at = (path: string) => fields.find((f) => f.path.join(".") === path);
    expect(at("model")).toMatchObject({ secret: false, value: "claude-opus-5-5" });
    expect(at("web.port")).toMatchObject({ secret: false, value: 9465 });
    expect(at("channels.telegram.allowlist")).toMatchObject({ secret: false, value: ["12345"] });
    expect(at("channels.telegram.token")).toEqual({ path: ["channels", "telegram", "token"], secret: true, set: true, length: secrets[0].length });
    expect(at("groupSecret")).toMatchObject({ secret: true, set: true });
    expect(at("litellm.baseUrl")).toMatchObject({ secret: true });
    // Every MCP value except the safe list is opaque, whatever its key is called.
    expect(at("mcpServers.search.command")).toMatchObject({ secret: true });
    expect(at("mcpServers.search.args")).toMatchObject({ secret: true });
    expect(at("mcpServers.search.timeout")).toMatchObject({ secret: false, value: 30 });
    expect(at("mcpServers.remote.url")).toMatchObject({ secret: true });
  });

  it("shows strings only on allowlisted paths; any other string is masked with a length hint", () => {
    const value = "plain-looking-value";
    const config = {
      model: "claude-opus-5-5", timezone: "America/Los_Angeles", steering: true, maxTurns: 40,
      provider: { key: value }, aws: { accesskey: value, signingkey: value, region: "us-west-2" },
      someNewFeature: { label: value, enabled: true, limit: 3 }, notes: value,
      identities: [{ name: "owner", replyPolicy: "last-active", channels: { telegram: "12345" } }],
      sessionModelOverrides: { "dm:owner": "claude-fable-5-2" },
      channels: { imessage: { provider: "imsg", inboundSettleMs: 1500, allowlist: ["+15550001"] } },
    };
    const { fields } = configFields(config);
    const at = (path: string) => fields.find((f) => f.path.join(".") === path)!;
    // Unknown fields (including ones added in the future) are masked by default.
    expect(at("provider.key")).toEqual({ path: ["provider", "key"], secret: true, set: true, length: value.length });
    expect(at("aws.accesskey")).toMatchObject({ secret: true, length: value.length });
    expect(at("aws.signingkey")).toMatchObject({ secret: true });
    expect(at("aws.region")).toMatchObject({ secret: true });
    expect(at("someNewFeature.label")).toMatchObject({ secret: true });
    expect(at("notes")).toMatchObject({ secret: true });
    expect(JSON.stringify(fields)).not.toContain(value);
    // Allowlisted strings, numbers and booleans are shown as they are.
    for (const [path, shown] of Object.entries({ model: "claude-opus-5-5", timezone: "America/Los_Angeles", steering: true, maxTurns: 40,
      "someNewFeature.enabled": true, "someNewFeature.limit": 3, "identities.0.name": "owner", "identities.0.replyPolicy": "last-active",
      "identities.0.channels.telegram": "12345", "sessionModelOverrides.dm:owner": "claude-fable-5-2", "channels.imessage.provider": "imsg",
      "channels.imessage.inboundSettleMs": 1500 })) {
      expect(at(path), path).toMatchObject({ secret: false, value: shown });
    }
    expect(at("channels.imessage.allowlist")).toMatchObject({ secret: false, value: ["+15550001"] });
  });
  it("shows a wildcard path's value only when it passes that path's value check", () => {
    const { fields } = configFields({
      sessionModelOverrides: { accesskey: "plain-looking-secret", "dm:owner": "claude-opus-5-5", "telegram:-100": "x".repeat(65) },
      identities: [{ name: "owner", channels: { telegram: "12345", imessage: "owner@example.com", Weird_Key: "12345", slack: "xoxb-not-an-id" } }],
      channels: { telegram: { provider: "plain-looking-secret", allowlist: ["-100200", "not an id"] }, Telegram: { provider: "imsg" } },
      plugins: ["./plugins/local", { name: "@scope/plugin", path: "plain looking secret?" }],
    });
    const at = (path: string) => fields.find((f) => f.path.join(".") === path)!;
    expect(at("sessionModelOverrides.accesskey")).toMatchObject({ secret: true, length: "plain-looking-secret".length });
    expect(at("sessionModelOverrides.dm:owner")).toMatchObject({ secret: false, value: "claude-opus-5-5" });
    expect(at("sessionModelOverrides.telegram:-100")).toMatchObject({ secret: true });
    expect(at("identities.0.channels.telegram")).toMatchObject({ secret: false, value: "12345" });
    expect(at("identities.0.channels.imessage")).toMatchObject({ secret: false, value: "owner@example.com" });
    expect(at("identities.0.channels.slack")).toMatchObject({ secret: true });
    expect(at("channels.telegram.provider")).toMatchObject({ secret: true });
    expect(at("channels.Telegram.provider")).toMatchObject({ secret: true });
    expect(at("channels.telegram.allowlist")).toMatchObject({ secret: true });
    expect(at("plugins.0")).toMatchObject({ secret: false, value: "./plugins/local" });
    expect(at("plugins.1.name")).toMatchObject({ secret: false, value: "@scope/plugin" });
    expect(at("plugins.1.path")).toMatchObject({ secret: true });
    expect(JSON.stringify(fields)).not.toContain("plain-looking-secret");
    expect(JSON.stringify(fields)).not.toContain("xoxb-not-an-id");
  });
  it("never echoes a key that looks like a credential", () => {
    const { fields } = configFields({ sessionModelOverrides: { "sk-ant-api03-synthetic000000000000000000": "claude-opus-5-5" } });
    expect(JSON.stringify(fields)).not.toContain("sk-ant-api03");
  });
  it("masks an allowlisted string that looks like a credential, and numbers under a credential name", () => {
    const { fields } = configFields({ model: "sk-ant-api03-synthetic-0000000000000000", auth: { pin: 1234 }, tokenTtl: 5 });
    expect(fields.map((f) => [f.path.join("."), f.secret])).toEqual([["model", true], ["auth.pin", true], ["tokenTtl", true]]);
  });

  it("lists saved MCP servers, including disabled ones, without their values", () => {
    const servers = mcpServers(file);
    expect(servers).toEqual([
      { name: "search", enabled: true, type: "stdio", oauth: false, timeout: 30, alwaysLoad: false, configured: ["args", "command", "env"] },
      { name: "remote", enabled: false, type: "http", oauth: false, timeout: null, alwaysLoad: false, configured: ["headers", "url"] },
    ]);
    for (const secret of secrets) expect(JSON.stringify(servers)).not.toContain(secret);
  });

  it("reports a missing file as missing and an invalid one without echoing it", async () => {
    expect(await new WebConfigReader(root).view()).toMatchObject({ missing: true, fields: [] });
    writeFileSync(join(root, "config.json"), `{"token": "${secrets[0]}",`);
    await expect(new WebConfigReader(root).view()).rejects.toMatchObject({ code: "config_invalid" });
  });
});

describe("MCP live status", () => {
  it("passes through only SDK-reported state, and times out to unknown", async () => {
    const ok = new McpLiveStatus({ mcpServerStatus: async () => [{ name: "search", status: "connected", serverInfo: { name: "x" }, error: "secret" }, { name: "bad name!", status: "connected" }] });
    expect(await ok.read()).toEqual([{ name: "search", status: "connected" }]);
    const hung = new McpLiveStatus({ mcpServerStatus: () => new Promise(() => {}) });
    expect(await hung.read(10)).toBeNull();
    expect(await new McpLiveStatus({}).read()).toBeNull();
  });
});

const DAY = 86_400_000;
/** The fixture's clock: every add and resolve is stamped relative to it, so the response is exact. */
const NOW = Date.UTC(2026, 10, 18, 12);
/** Three visible open items (one per waiting_on, one of a group), one of another DM, two closed. */
function seedTodos(dir: string): void {
  const store = new TodoStore(dir, DEFAULT_TODOS);
  const add = (daysAgo: number, input: Record<string, unknown>) => store.add({ session: "dm:owner", source: "self", ...input } as Parameters<TodoStore["add"]>[0], NOW - daysAgo * DAY);
  const first = add(20, { title: "Fix the flaky test", next: "Reproduce it", waiting_on: "me", review_in: "3d" });
  const second = add(15, { title: "Compare two barrels", next: "Read reviews", waiting_on: "me", review_in: "3d" });
  add(9, { title: "Review the release", next: "Read the diff", waiting_on: "owner", review_in: "7d", ref: "https://example.com/pull/41" });
  const plumber = add(5, { title: "Call the plumber", next: "Phone before noon", waiting_on: "me", review_in: "2d", source: "owner" });
  add(1, { title: "Pick the next book", next: "Post the poll", waiting_on: "external", review_in: "7d", session: "telegram:-2" });
  add(1, { title: "OTHER-DM-NEEDLE", next: "OTHER-DM-NEEDLE step", waiting_on: "me", review_in: "3d", session: "dm:someone-else" });
  store.resolve(first.id, { action: "done", by: "self", evidence: "https://example.com/pull/37" }, NOW - 8 * DAY);
  store.resolve(second.id, { action: "drop", by: "owner", reason: "No longer needed." }, NOW - 3 * DAY);
  store.resolve(plumber.id, { action: "snooze", by: "self", until: "3d", reason: "Line was busy." }, NOW - DAY);
}

describe("web todos view", () => {
  const view = (dir: string, ownerKey?: string) => readWebTodos({ dir, ownerKey, groupTitle: () => "A group" });
  it("shows nothing when no owner is configured, rather than everything", () => {
    const dir = join(root, "data", "todos");
    seedTodos(dir);
    expect(view(dir)).toMatchObject({ items: [], recent: [], resolvedTotal: 0, openTotal: 4, limits: { maxOpen: DEFAULT_TODOS.maxOpen, maxSnoozes: DEFAULT_TODOS.maxSnoozes } });
    expect(view(dir, "dm:owner").items.map((i) => i.id)).toEqual(["t-3", "t-4", "t-5"]);
    // A group key is not an owner: it would see only its own item.
    expect(view(dir, "telegram:-2").items.map((i) => i.id)).toEqual(["t-5"]);
  });
  it("caps the done log at the newest entries and skips lines that are not whole records", () => {
    const dir = join(root, "data", "todos");
    const store = new TodoStore(dir, { ...DEFAULT_TODOS, maxOpen: 100 });
    for (let i = 0; i < 25; i++) {
      const item = store.add({ title: `Item ${i}`, next: "Do it", waiting_on: "me", session: "dm:owner", source: "self" }, NOW - 30 * DAY);
      store.resolve(item.id, { action: "done", by: "self" }, NOW - (25 - i) * DAY);
    }
    writeFileSync(join(dir, "done.ndjson"), readFileSync(join(dir, "done.ndjson"), "utf8")
      + JSON.stringify({ id: "t-90", session: "dm:owner", title: "HALF-RECORD" }) + "\n" + '{"id":"t-91","session":"dm:ow');
    const value = view(dir, "dm:owner");
    expect(value.resolvedTotal).toBe(25);
    expect(value.recent).toHaveLength(20);
    expect(value.recent[0]).toMatchObject({ id: "t-25", title: "Item 24", resolvedAt: NOW - DAY });
    expect(JSON.stringify(value)).not.toContain("HALF-RECORD");
    expect(store.resolved().map((r) => r.id).slice(0, 2)).toEqual(["t-1", "t-2"]);
  });
});

describe("Study HTTP", () => {
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let channel: WebChannel;
  let cookie = "";
  let boot: WebBootstrap;
  let base: string;
  const token = "tomo_web_" + "c".repeat(64);
  const call = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/v1" + path, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie, ...headers } });
    return { status: response.status, value: await response.json() as Record<string, unknown>, text: "" };
  };
  beforeEach(async () => {
    cookie = "";
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
    service = await startWebHttp(0, { accessToken: token, assetsDir: root, data,
      subscribe: (fn) => channel.events.subscribe(fn), rpc: async (rpc) => {
        if (rpc.method === "snapshot") return { snapshot: channel.snapshot(), replay: null };
        if (rpc.method === "mcp-status") return [{ sessionId: boot.ownerId, connections: [{ name: "search", status: "connected" }] }];
        if (rpc.method === "context-events") return channel.contextEvents(rpc.sessionId);
        throw new Error("unexpected rpc");
      } });
    base = `http://127.0.0.1:${service.port}`;
    const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
    cookie = response.headers.getSetCookie()[0].split(";")[0];
    boot = await response.json() as WebBootstrap;
  });
  afterEach(async () => { await service?.close(); await channel?.stop(); });

  it("requires authentication on every Study read", async () => {
    for (const path of ["/todos", "/memory/tree", "/memory/file?path=TODO.md", "/memory/search?q=test", "/cron", "/config", "/mcp", `/sessions/${boot.ownerId}/context`]) {
      expect((await call(path, { cookie: "" })).status, path).toBe(401);
      expect((await call(path, { "x-tomo-request": "" })).status, path).toBe(403);
      expect((await call(path)).status, path).toBe(200);
    }
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
    expect((await call("/mcp")).value.live).toEqual({ available: true, sessions: [{ sessionId: boot.ownerId, connections: [{ name: "search", status: "connected" }] }] });
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
    expect(value.resolvedTotal).toBe(2);
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
    expect((await call("/todos")).value).toMatchObject({ items: [], recent: [], openTotal: 0, resolvedTotal: 0 });
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

describe("Study page helpers", async () => {
  const { viewFromHash } = await import("../web/src/study-data.js");
  it("routes #study/<page> and falls back to Todos", () => {
    expect(viewFromHash("#study/memory")).toBe("memory");
    expect(viewFromHash("#study")).toBe("todos");
    expect(viewFromHash("#study/nope")).toBe("todos");
    expect(viewFromHash("")).toBeNull();
    expect(viewFromHash("#conversation")).toBeNull();
  });
});
