import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInitConfig,
  checkClaudeRuntime,
  classifyVerifyFailure,
  decideOwnerName,
  envApiKeyNeedingSave,
  mergeInitConfig,
  precreateOwnerSessionUnlessAdoptable,
  runChannelSetup,
  type InitPromptPort,
} from "../src/cli/init-setup.js";
import { SessionStore } from "../src/sessions/store.js";
import { resolveOwner } from "../src/owner.js";

const CANCEL = Symbol("cancel");

function scripted(answers: {
  multiselect?: Array<string[] | symbol>;
  password?: Array<string | symbol>;
  text?: Array<string | symbol>;
  confirm?: Array<boolean | symbol>;
}) {
  const logs: string[] = [];
  const q = {
    multiselect: [...(answers.multiselect ?? [])],
    password: [...(answers.password ?? [])],
    text: [...(answers.text ?? [])],
    confirm: [...(answers.confirm ?? [])],
  };
  const next = <T>(kind: keyof typeof q, message: string): T => {
    if (q[kind].length === 0) throw new Error(`unexpected ${kind}: ${message}`);
    return q[kind].shift() as T;
  };
  const port: InitPromptPort = {
    multiselect: async ({ message }) => next("multiselect", message),
    password: async ({ message }) => next("password", message),
    text: async ({ message }) => next("text", message),
    confirm: async ({ message }) => next("confirm", message),
    select: async () => { throw new Error("unexpected select"); },
    isCancel: (v: unknown): v is symbol => v === CANCEL,
    note: (m) => { logs.push(`note: ${m}`); },
    log: { info: (m) => { logs.push(`info: ${m}`); }, warn: (m) => { logs.push(`warn: ${m}`); }, success: (m) => { logs.push(`success: ${m}`); } },
  };
  return { port, logs, q };
}

const TOKEN = "123456:ABC-test-token";

describe("buildInitConfig: tomo init writes `owner`, never `identities`", () => {
  it.each([
    [["telegram"], { name: "alex", displayName: "Alex Example", telegram: ["123456789"], imessage: [] }],
    [["imessage"], { name: "alex", displayName: "Alex Example", telegram: [], imessage: ["+15555550123"] }],
    [["telegram", "imessage"], { name: "alex", displayName: "Alex Example", telegram: ["123456789"], imessage: ["+15555550123"] }],
  ] as const)("channels %j", (channels, owner) => {
    const { config } = buildInitConfig({
      userName: "Alex Example",
      channels: [...channels],
      telegramToken: TOKEN,
      telegramUserId: "123456789",
      imessageHandles: ["+15555550123"],
      model: "claude-sonnet-5-5",
    });
    expect(config.owner).toEqual(owner);
    expect(config).not.toHaveProperty("identities");
    // Allowlists only list groups now; init writes none.
    const ch = config.channels as Record<string, Record<string, unknown>>;
    for (const entry of Object.values(ch)) expect(entry).not.toHaveProperty("allowlist");
    expect(Boolean(ch.telegram)).toBe(channels.includes("telegram"));
    expect(ch.imessage ? ch.imessage : undefined).toEqual(channels.includes("imessage") ? { provider: "imsg" } : undefined);
    // The daemon reads it back as the same owner and session.
    const resolved = resolveOwner({ owner: config.owner, identities: [] });
    expect(resolved.owner?.name).toBe("alex");
    expect(resolved.issues).toEqual([]);
  });

  it("falls back to name \"owner\" with no user name, and keeps optional settings", () => {
    const { config, owner } = buildInitConfig({ userName: "", channels: ["telegram"], telegramToken: TOKEN, telegramUserId: "1", model: "m", city: " Tokyo ", groupSecret: "tomo-abc" });
    expect(owner).toEqual({ name: "owner", telegram: ["1"], imessage: [] });
    expect(config).toMatchObject({ city: "Tokyo", groupSecret: "tomo-abc", model: "m" });
  });
});

describe("runChannelSetup (init channel step)", () => {
  it("Telegram + iMessage: asks token, user id and handles; re-asks a bad token", async () => {
    const { port, logs } = scripted({
      multiselect: [["telegram", "imessage"]],
      password: ["not-a-token", TOKEN],
      text: ["abc", "123456789", "+1 (555) 555-0123"],
    });
    const result = await runChannelSetup(port, { isMac: true, probeImsg: async () => true });
    expect(result).toEqual({
      channels: ["telegram", "imessage"],
      telegramToken: TOKEN,
      telegramUserId: "123456789",
      imessageHandles: ["+15555550123"],
    });
    expect(logs.filter((l) => l.startsWith("warn:"))).toHaveLength(2);
  });

  it("iMessage only: warns when imsg is missing; skipping the handle needs an explicit confirm", async () => {
    const { port, logs } = scripted({ multiselect: [["imessage"]], text: ["", ""], confirm: [false, true] });
    const result = await runChannelSetup(port, { isMac: true, probeImsg: async () => false });
    expect(result).toEqual({ channels: ["imessage"], imessageHandles: [] });
    expect(logs.some((l) => l.includes("imsg was not found"))).toBe(true);
    expect(logs.some((l) => l.includes("iMessage DMs are ignored"))).toBe(true);
  });

  it("drops iMessage off macOS and requires at least one channel", async () => {
    const { port, logs } = scripted({ multiselect: [["imessage"], ["telegram"]], password: [TOKEN], text: ["42"] });
    const result = await runChannelSetup(port, { isMac: false, probeImsg: async () => true });
    expect(result?.channels).toEqual(["telegram"]);
    expect(logs.some((l) => l.includes("needs macOS"))).toBe(true);
  });

  it("returns null when cancelled", async () => {
    expect(await runChannelSetup(scripted({ multiselect: [CANCEL] }).port, { isMac: true, probeImsg: async () => true })).toBeNull();
    expect(await runChannelSetup(scripted({ multiselect: [["imessage"]], text: [CANCEL] }).port, { isMac: true, probeImsg: async () => true })).toBeNull();
  });
});

describe("checkClaudeRuntime (no separately installed `claude` needed)", () => {
  const exe = () => "/bundled/claude";
  it("uses the bundled binary and reports a login", async () => {
    await expect(checkClaudeRuntime({ resolveExecutable: exe, version: async (p) => `2.1.299 (${p})`, verifyLogin: async () => {}, env: {} }))
      .resolves.toEqual({ kind: "ok", version: "2.1.299 (/bundled/claude)", auth: "logged-in" });
  });
  it("skips the login check when an API key will be used", async () => {
    await expect(checkClaudeRuntime({ resolveExecutable: exe, version: async () => "v", verifyLogin: async () => { throw new Error("no"); }, env: { ANTHROPIC_API_KEY: "sk-test" } }))
      .resolves.toEqual({ kind: "ok", version: "v", auth: "api-key" });
  });
  it("reports not-logged-in (not fatal) and missing (fatal)", async () => {
    await expect(checkClaudeRuntime({ resolveExecutable: exe, version: async () => "v", verifyLogin: async () => { throw new Error("no"); }, env: {} }))
      .resolves.toEqual({ kind: "not-logged-in", version: "v" });
    await expect(checkClaudeRuntime({ resolveExecutable: exe, version: async () => { throw new Error("ENOENT"); }, env: {} }))
      .resolves.toMatchObject({ kind: "missing" });
  });
});

describe("precreateOwnerSessionUnlessAdoptable", () => {
  function dirs() {
    const dir = mkdtempSync(join(tmpdir(), "tomo-init-owner-"));
    return { dir, sessions: join(dir, "sessions"), sdk: join(dir, "sdk") };
  }
  const owner = { name: "alex", telegram: ["123456789"], imessage: [] as string[] };

  it("creates the owner's dm: entry once, with no SDK session yet", () => {
    const d = dirs();
    try {
      expect(precreateOwnerSessionUnlessAdoptable(owner, d.sessions, d.sdk)).toBe("created");
      expect(precreateOwnerSessionUnlessAdoptable(owner, d.sessions, d.sdk)).toBe("exists");
      const store = new SessionStore(d.sessions, 20, d.sdk);
      expect(store.listAllSessions().map((e) => [e.channelKey, e.sdkSessionId])).toEqual([["dm:alex", ""]]);
    } finally {
      rmSync(d.dir, { recursive: true, force: true });
    }
  });

  it("does NOT pre-create when the owner has a legacy per-channel session with history (it would block the adoption)", () => {
    const d = dirs();
    try {
      const store = new SessionStore(d.sessions, 20, d.sdk);
      store.setSdkSessionId("telegram:123456789", "sdk-legacy");
      expect(precreateOwnerSessionUnlessAdoptable(owner, d.sessions, d.sdk)).toBe("deferred-to-adoption");
      expect(new SessionStore(d.sessions, 20, d.sdk).getEntry("dm:alex")).toBeUndefined();
    } finally {
      rmSync(d.dir, { recursive: true, force: true });
    }
  });
});

describe("tomo init --force merges onto the existing config", () => {
  const EXISTING = {
    auth: { method: "api-key", apiKey: "sk-test-existing" },
    sessionModelOverrides: { "dm:alex": "claude-opus-5-5[1m]" },
    litellm: { baseUrl: "http://localhost:4000" },
    web: { port: 9999 },
    groupSecret: "tomo-existing",
    plugins: ["./p"],
    owner: { name: "alex", displayName: "Alex", telegram: ["111"], imessage: ["+15555550123"] },
    channels: {
      telegram: { token: "old-token", allowlist: ["-100555"], passiveGroups: ["-100555"] },
      imessage: { provider: "imsg", cliPath: "/opt/homebrew/bin/imsg", allowlist: ["any;+;chat1"] },
    },
    model: "claude-sonnet-5[1m]",
  };

  it("replaces only what init re-asked; keeps every other field, and the unpicked channel's owner handles", () => {
    const { config: fresh } = buildInitConfig({
      ownerName: "alex", userName: "Alex", channels: ["telegram"], telegramToken: TOKEN, telegramUserId: "222", model: "claude-opus-5-5[1m]",
    });
    const { config, kept, replaced } = mergeInitConfig(structuredClone(EXISTING), fresh, ["telegram"]);
    expect(config).toEqual({
      ...EXISTING,
      owner: { name: "alex", displayName: "Alex", telegram: ["222"], imessage: ["+15555550123"] },
      channels: { ...EXISTING.channels, telegram: { ...EXISTING.channels.telegram, token: TOKEN } },
      model: "claude-opus-5-5[1m]",
    });
    expect(replaced.sort()).toEqual(["channels", "model", "owner"]);
    expect(kept.sort()).toEqual(["auth", "groupSecret", "litellm", "plugins", "sessionModelOverrides", "web"]);
  });

  it("a fresh install is written as built", () => {
    const { config: fresh } = buildInitConfig({ userName: "Alex", channels: ["telegram"], telegramToken: TOKEN, telegramUserId: "1", model: "m" });
    expect(mergeInitConfig(undefined, fresh, ["telegram"]).config).toEqual(fresh);
  });

  it("keeps the existing owner name unless the user explicitly picks the new one", async () => {
    const pick = (answer: string | symbol) => ({
      ...scripted({}).port,
      select: async () => answer,
    });
    expect(await decideOwnerName(pick("keep"), "alex", "sam")).toBe("alex");
    expect(await decideOwnerName(pick("new"), "alex", "sam")).toBe("sam");
    expect(await decideOwnerName(pick(CANCEL), "alex", "sam")).toBeNull();
    // Same name (any case), or no previous owner: no question.
    expect(await decideOwnerName(scripted({}).port, "Alex", "alex")).toBe("Alex");
    expect(await decideOwnerName(scripted({}).port, undefined, "sam")).toBe("sam");
  });

  it("offers to save an API key that is only in the environment (launchd won't see it)", () => {
    const apiKeyRuntime = { kind: "ok", version: "v", auth: "api-key" } as const;
    expect(envApiKeyNeedingSave(apiKeyRuntime, { ANTHROPIC_API_KEY: " sk-env " }, undefined)).toBe("sk-env");
    expect(envApiKeyNeedingSave(apiKeyRuntime, { ANTHROPIC_API_KEY: "sk-env" }, { auth: { method: "subscription" } })).toBe("sk-env");
    // Already saved, or not using a key: nothing to offer.
    expect(envApiKeyNeedingSave(apiKeyRuntime, { ANTHROPIC_API_KEY: "sk-env" }, { auth: { method: "api-key", apiKey: "sk-saved" } })).toBeUndefined();
    expect(envApiKeyNeedingSave({ kind: "ok", version: "v", auth: "logged-in" }, {}, undefined)).toBeUndefined();
  });

  it("writes an environment API key to auth only when asked to", () => {
    const withKey = buildInitConfig({ userName: "a", channels: ["telegram"], telegramToken: TOKEN, telegramUserId: "1", model: "m", auth: { method: "api-key", apiKey: "sk-test" } });
    expect(withKey.config.auth).toEqual({ method: "api-key", apiKey: "sk-test" });
    expect(buildInitConfig({ userName: "a", channels: ["telegram"], telegramToken: TOKEN, telegramUserId: "1", model: "m" }).config).not.toHaveProperty("auth");
  });
});

describe("login check failures that are not about the login", () => {
  it.each([
    [Object.assign(new Error("Claude login verification failed"), { timedOut: true }), "timeout"],
    [new Error("Claude login verification failed: API Error: 429 rate_limit_error"), "rate-limited"],
    [new Error("Claude login verification failed: 529 Overloaded"), "rate-limited"],
    [new Error("Claude login verification failed: getaddrinfo ENOTFOUND api.anthropic.com"), "network"],
    [new Error("Claude login verification failed: Invalid API key · Please run /login"), undefined],
  ])("%s → %s", (err, expected) => {
    expect(classifyVerifyFailure(err)).toBe(expected);
  });

  it("reports unverified (retry), not not-logged-in, for a rate limit", async () => {
    await expect(checkClaudeRuntime({
      resolveExecutable: () => "/bundled/claude", version: async () => "v", env: {},
      verifyLogin: async () => { throw new Error("Claude login verification failed: rate limit exceeded"); },
    })).resolves.toMatchObject({ kind: "unverified", reason: "rate-limited" });
  });
});
