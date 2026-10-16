import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { precreateOwnerSession } from "../src/cli/init.js";
import {
  buildInitConfig,
  checkClaudeRuntime,
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

describe("precreateOwnerSession", () => {
  it("creates the owner's dm: entry once, with no SDK session yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-init-owner-"));
    try {
      precreateOwnerSession("alex", join(dir, "sessions"), join(dir, "sdk"));
      precreateOwnerSession("alex", join(dir, "sessions"), join(dir, "sdk"));
      const store = new SessionStore(join(dir, "sessions"), 20, join(dir, "sdk"));
      expect(store.listAllSessions().map((e) => [e.channelKey, e.sdkSessionId])).toEqual([["dm:alex", ""]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
