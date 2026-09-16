import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore, ConfigConflictError } from "../src/config/store.js";
import { validateFileConfig } from "../src/config/file-schema.js";
import { WebManagement, runningConfigSnapshot } from "../src/web/management.js";
import { McpLiveStatus } from "../src/mcp/live-status.js";
import { restartArguments } from "../src/web/restart.js";
import { TOMO_DAEMON_PID_ENV, TOMO_SESSION_KEY_ENV } from "../src/restart-reason.js";
let root: string; let store: ConfigStore; let web: WebManagement;
const secret = "synthetic-private-credential";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-control-test-")); store = new ConfigStore(join(root, "config.json"));
  store.replace({ model: "default-model", auth: { apiKey: secret }, channels: { telegram: { token: secret } },
    extension: { nested: secret }, opaqueString: secret, identities: [{ name: "owner", channels: { telegram: "test-owner" } }],
    mcpServers: { example: { type: "http", url: `https://example.invalid/?key=${secret}`, headers: { Authorization: secret }, enabled: false } } });
  web = new WebManagement(root, runningConfigSnapshot({ model: "running-model" }, store.read().revision, { CLAUDE_MODEL: "running-model" }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function preview(changes: unknown[]) { return web.previewConfig({ revision: store.read().revision, changes }, "browser-a"); }

describe("configuration review and transactions", () => {
  it("never exposes saved secrets, unknown extension values, or MCP connection details", () => {
    const output = JSON.stringify([web.config(), web.schema(), web.mcp()]);
    expect(output).not.toContain(secret); expect(output).not.toContain("https://example.invalid");
    expect(web.config().fields.find((f) => f.label === "auth.apiKey")).toMatchObject({ set: true, secret: true });
    expect(web.config().fields.find((f) => f.label === "model")).toMatchObject({ value: "default-model", running: "running-model", overridden: true });
    expect(web.config().restartRequired).toBe(false);
  });
  it("keeps malformed values under safe keys opaque", () => {
    store.update((value) => ({ ...value, model: { apiKey: secret }, mcpServers: { example: { type: secret, timeout: { nested: secret }, enabled: false } } }));
    expect(JSON.stringify([web.config(), web.mcp()])).not.toContain(secret);
  });
  it("previews without writing, binds the reviewed replacement, and preserves untouched secrets/placeholders", () => {
    store.update((value) => ({ ...value, city: "$CITY", untouched: [1, 2, 3] }));
    const old = store.read();
    const proposal = preview([{ path: ["model"], value: "next-model" }, { path: ["auth", "apiKey"], value: "replacement-private-credential" }]);
    expect(store.read()).toEqual(old); expect(JSON.stringify(proposal)).not.toContain(secret); expect(JSON.stringify(proposal)).not.toContain("replacement-private-credential");
    expect(proposal.diff[0]).toMatchObject({ before: "default-model", after: "next-model" });
    expect(() => web.apply({ id: proposal.id }, "browser-b")).toThrow("preview_expired");
    expect(web.apply({ id: proposal.id }, "browser-a").restartRequired).toBe(true);
    expect(store.read().value).toMatchObject({ model: "next-model", auth: { apiKey: "replacement-private-credential" }, city: "$CITY", untouched: [1, 2, 3], channels: { telegram: { token: secret } } });
    expect(statSync(store.path).mode & 0o777).toBe(0o600); expect(statSync(store.backupPath).mode & 0o777).toBe(0o600);
    expect(web.config().restartRequired).toBe(true); expect(() => web.apply({ id: proposal.id }, "browser-a")).toThrow("preview_expired");
  });
  it("rejects stale previews after a CLI or daemon writer changes the file", () => {
    const proposal = preview([{ path: ["model"], value: "next-model" }]);
    store.update((value) => ({ ...value, city: "Example city" }));
    expect(() => web.apply({ id: proposal.id }, "browser-a")).toThrow("config_changed");
    expect(store.read().value).toMatchObject({ model: "default-model", city: "Example city" });
  });
  it("checks the expected revision inside the common lock and never rotates unreadable originals", () => {
    const old = store.read(); store.update((value) => ({ ...value, model: "concurrent-model" }));
    expect(() => store.update(() => old.value, old.revision)).toThrow(ConfigConflictError);
    const backup = readFileSync(store.backupPath, "utf8"); writeFileSync(store.path, "{broken");
    expect(() => store.update(() => ({}))).toThrow(); expect(readFileSync(store.backupPath, "utf8")).toBe(backup);
  });
  it("refuses a held file lock instead of writing through it", () => {
    const lock = `${store.path}.lock`; mkdirSync(lock); writeFileSync(join(lock, "owner.test"), JSON.stringify({ pid: process.pid, ts: Date.now(), host: "another-host" }));
    const wait = vi.spyOn(Atomics, "wait");
    try { expect(() => store.update((value) => ({ ...value, model: "lost-update" }))).toThrow(/lock/); expect(wait).not.toHaveBeenCalled(); } finally { wait.mockRestore(); }
    expect(store.read().value.model).toBe("default-model");
  });
  it("uses the shared Zod validators and rejects prototype paths and secret removal", () => {
    expect(() => validateFileConfig({ continuityScript: { path: "example.sh", timeoutMs: -1 } })).toThrow();
    expect(() => validateFileConfig({ maxTurns: -1 })).toThrow(); expect(() => validateFileConfig({ lcm: { nudgeAtPct: 30, nudgeResetPct: 40 } })).toThrow();
    expect(() => preview([{ path: ["web", "port"], value: 0 }])).toThrow("invalid_config");
    expect(() => preview([{ path: ["__proto__", "polluted"], value: true }])).toThrow("invalid_changes");
    expect(() => preview([{ path: ["auth", "apiKey"], remove: true }])).toThrow("invalid_changes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("expires previews and bounds their lifetime", () => {
    let now = 100; const timed = new WebManagement(root, undefined, () => now);
    const p = timed.previewConfig({ revision: store.read().revision, changes: [{ path: ["model"], value: "next-model" }] }, "browser");
    now += 5 * 60_000 + 1; expect(() => timed.apply({ id: p.id }, "browser")).toThrow("preview_expired");
  });
});
describe("MCP configuration", () => {
  it("adds, edits, enables, disables and removes through reviewed config transactions", () => {
    const apply = (input: Record<string, unknown>) => { const p = web.previewMcp({ revision: store.read().revision, ...input }, "browser"); web.apply({ id: p.id }, "browser"); return p; };
    const p = apply({ name: "local-tool", operation: "save", values: { type: "stdio", command: "synthetic-command", args: [secret], env: { KEY: secret } } });
    expect(JSON.stringify(p)).not.toContain(secret); expect(JSON.stringify(web.mcp())).not.toContain("synthetic-command");
    apply({ name: "local-tool", operation: "enable", enabled: false }); expect(web.mcp().servers.find((s) => s.name === "local-tool")?.enabled).toBe(false);
    apply({ name: "local-tool", operation: "save", values: { command: "replacement-command" } });
    apply({ name: "local-tool", operation: "enable", enabled: true });
    expect((store.read().value.mcpServers as Record<string, unknown>)["local-tool"]).toMatchObject({ command: "replacement-command", args: [secret], enabled: true });
    apply({ name: "local-tool", operation: "remove" }); expect(web.mcp().servers.map((s) => s.name)).toEqual(["example"]);
  });
  it("updates the legacy mcp.servers alias without discarding sibling values", () => {
    store.replace({ mcp: { servers: { demo: { command: "test-command" } }, allowedTools: ["mcp__demo__*"] } });
    const propose = () => web.previewMcp({ revision: store.read().revision, name: "demo", operation: "enable", enabled: false }, "browser");
    expect(propose).not.toThrow(); const p = propose();
    web.apply({ id: p.id }, "browser"); expect(store.read().value).toMatchObject({ mcp: { allowedTools: ["mcp__demo__*"], servers: { demo: { enabled: false } } } });
    expect(store.read().value.mcpServers).toBeUndefined();
  });
  it("rejects an incomplete active server without reflecting the input", () => {
    expect(() => web.previewMcp({ revision: store.read().revision, name: "new-server", operation: "save", values: { type: "http", headers: { Authorization: secret } } }, "browser")).toThrow("invalid_config");
  });
});
it("reads real SDK states without configuration, credentials, or raw errors", async () => {
  const read = vi.fn(async () => [{ name: "example", status: "failed", error: secret, config: { url: secret } }]);
  await expect(new McpLiveStatus({ mcpServerStatus: read }).read()).resolves.toEqual([{ name: "example", status: "failed" }]);
  expect(read).toHaveBeenCalledOnce(); await expect(new McpLiveStatus({}).read()).resolves.toBeNull();
});
it("bounds a hung status query without stacking new SDK requests", async () => {
  const read = vi.fn(() => new Promise<never>(() => {})); const status = new McpLiveStatus({ mcpServerStatus: read });
  await expect(status.read(10)).resolves.toBeNull(); await expect(status.read(10)).resolves.toBeNull(); expect(read).toHaveBeenCalledOnce();
});
it("restarts using the existing CLI with a reason and without turn deferral markers", () => {
  const result = restartArguments("Apply reviewed settings", { [TOMO_DAEMON_PID_ENV]: "999", [TOMO_SESSION_KEY_ENV]: "dm:owner", PATH: "/example/bin" });
  expect(result.args.slice(-3)).toEqual(["restart", "--reason", "Apply reviewed settings"]);
  expect(result.env).toEqual({ PATH: "/example/bin" });
});

it.each(["mcpServers", "mcp"])("repairs legacy MCP fields incrementally without blocking unrelated config saves (%s)", (key) => {
  const servers = { example: { command: "node", enabled: "true", timeout: 0, env: { BAD: null }, oauth: { scopes: ["a", 1] } } };
  const store = new ConfigStore(join(root, "config.json"));
  store.replace({ model: "before", [key]: key === "mcp" ? { servers } : servers });
  const web = new WebManagement(root);
  let proposal!: ReturnType<WebManagement["previewConfig"]>;
  expect(() => { proposal = web.previewConfig({ revision: web.config().revision, changes: [{ path: ["model"], value: "after" }] }, "browser"); }).not.toThrow();
  web.apply({ id: proposal.id }, "browser");
  expect(store.read().value.model).toBe("after");
  expect(() => web.previewMcp({ revision: web.config().revision, name: "example", operation: "save", values: { timeout: -1 } }, "browser")).toThrow("invalid_config");
  proposal = web.previewMcp({ revision: web.config().revision, name: "example", operation: "save", values: { timeout: 1000 } }, "browser");
  web.apply({ id: proposal.id }, "browser");
  const raw = store.read().value; const saved = (key === "mcp" ? (raw.mcp as { servers: typeof servers }).servers : raw.mcpServers) as typeof servers;
  expect(saved.example).toEqual({ ...servers.example, timeout: 1000 });
});
it("hides malformed legacy MCP values when previewing their repair", () => {
  store.replace({ mcpServers: { example: { command: "node", timeout: { credential: secret } } } });
  const proposal = web.previewMcp({ revision: web.config().revision, name: "example", operation: "save", values: { timeout: 1000 } }, "browser");
  expect(JSON.stringify(proposal)).not.toContain(secret);
  expect(proposal.diff[0]).toMatchObject({ secret: true, before: "Set", after: "Replacement supplied" });
});
