import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFields, mcpServers, WebConfigReader } from "../src/web/config-view.js";
import { McpLiveStatus } from "../src/mcp/live-status.js";

/** The Study's Config and MCP tabs: what of config.json is shown, and the live MCP state. */
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-config-view-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
  it("shows legacy iMessage session keys and effort levels in per-session overrides", () => {
    const key = "imessage:any;+;chat0000000001";
    const { fields } = configFields({ effort: "high", sessionModelOverrides: { [key]: "claude-opus-5-5" }, sessionEffortOverrides: { [key]: "low", "dm:owner": "turbo-ish" } });
    const at = (path: string) => fields.find((f) => f.path.join(".") === path);
    expect(at("effort")).toMatchObject({ secret: false, value: "high" });
    expect(at(`sessionModelOverrides.${key}`)).toMatchObject({ secret: false, value: "claude-opus-5-5" });
    expect(at(`sessionEffortOverrides.${key}`)).toMatchObject({ secret: false, value: "low" });
    expect(at("sessionEffortOverrides.dm:owner")).toMatchObject({ secret: true });
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
