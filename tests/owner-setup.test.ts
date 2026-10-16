import { describe, expect, it } from "vitest";
import {
  addOwnerHandles,
  checkImessageOwnerHandle,
  checkTelegramUserId,
  convertLegacyIdentities,
  currentOwner,
  deriveOwnerName,
  enableImessageWithOwner,
  ensureOwnerBlock,
  promptImessageOwnerHandles,
  removeOwnerHandle,
  setOwnerDisplayName,
  type PromptPort,
} from "../src/cli/config/owner-setup.js";
import { isGroupAllowlistEntry } from "../src/cli/config/channels.js";

const CANCEL = Symbol("cancel");

/** A scripted PromptPort: answers are consumed in order, per prompt kind. */
function scripted(answers: { text?: Array<string | symbol>; confirm?: Array<boolean | symbol>; select?: Array<string | symbol> }) {
  const asked: string[] = [];
  const logs: string[] = [];
  const queue = { text: [...(answers.text ?? [])], confirm: [...(answers.confirm ?? [])], select: [...(answers.select ?? [])] };
  const next = <T>(kind: keyof typeof queue, message: string): T => {
    asked.push(`${kind}: ${message}`);
    if (queue[kind].length === 0) throw new Error(`unexpected ${kind} prompt: ${message}`);
    return queue[kind].shift() as T;
  };
  const port: PromptPort = {
    text: async ({ message }) => next("text", message),
    confirm: async ({ message }) => next("confirm", message),
    select: async ({ message }) => next("select", message),
    isCancel: (v: unknown): v is symbol => v === CANCEL,
    log: {
      info: (m) => { logs.push(`info: ${m}`); },
      warn: (m) => { logs.push(`warn: ${m}`); },
      success: (m) => { logs.push(`success: ${m}`); },
    },
  };
  return { port, asked, logs, remaining: queue };
}

describe("checkImessageOwnerHandle (validation table)", () => {
  it.each([
    ["+1 (555) 555-0123", { kind: "ok", handle: "+15555550123" }],
    ["+15555550123", { kind: "ok", handle: "+15555550123" }],
    ["+44 20 7946 0000", { kind: "ok", handle: "+442079460000" }],
    ["Alex@Example.com", { kind: "ok", handle: "alex@example.com" }],
    ["  alex@example.com ", { kind: "ok", handle: "alex@example.com" }],
  ])("accepts %s", (input, expected) => {
    expect(checkImessageOwnerHandle(input)).toMatchObject(expected);
  });

  it.each([
    // [input, expected]  — CN, UK and US, with and without "+"
    ["+86 150 1234 5678", { kind: "ok", handle: "+8615012345678" }],
    ["150 1234 5678", { kind: "confirm", handle: "+15012345678" }],
    ["15012345678", { kind: "confirm", handle: "+15012345678" }],
    ["+44 20 7946 0000", { kind: "ok", handle: "+442079460000" }],
    ["020 7946 0000", { kind: "error" }],
    ["+44 7700 900123", { kind: "ok", handle: "+447700900123" }],
    ["07700 900123", { kind: "error" }],
    ["+1 555 555 0123", { kind: "ok", handle: "+15555550123" }],
    ["1 555 555 0123", { kind: "confirm", handle: "+15555550123" }],
    ["(555) 555-0123", { kind: "confirm", handle: "+15555550123" }],
  ])("country table: %s", (input, expected) => {
    expect(checkImessageOwnerHandle(input)).toMatchObject(expected);
  });

  it("the +1 question for an 11-digit number starting with 1 defaults to NO; the 10-digit one to yes", async () => {
    const seen: Array<{ message: string; initialValue?: boolean }> = [];
    const answers = ["13812345678", "+86 138 1234 5678", "5555550123"];
    const port: PromptPort = {
      text: async () => answers.shift() ?? "",
      confirm: async (o) => { seen.push(o); return false; },
      select: async () => "",
      isCancel: (_v: unknown): _v is symbol => false,
      log: { info: () => {}, warn: () => {}, success: () => {} },
    };
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "handles", handles: ["+8613812345678"] });
    expect(seen.map((o) => o.initialValue)).toEqual([false]);
    expect(checkImessageOwnerHandle("13812345678")).toMatchObject({ kind: "confirm", defaultYes: false });
    expect(checkImessageOwnerHandle("5555550123")).toMatchObject({ kind: "confirm", defaultYes: true });
  });

  it("never silently turns an 11-digit number starting with 1 into a US number", async () => {
    // A Chinese mobile typed without "+": declining the +1 question re-asks.
    const { port } = scripted({ text: ["150 1234 5678", "+86 150 1234 5678"], confirm: [false] });
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "handles", handles: ["+8615012345678"] });
  });

  it("asks before assuming +1 for a 10-digit number", () => {
    expect(checkImessageOwnerHandle("(555) 555-0123")).toEqual({
      kind: "confirm",
      handle: "+15555550123",
      question: expect.stringContaining("+15555550123"),
      defaultYes: true,
    });
  });

  it("reduces a pasted DM chat GUID to its handle and says so", () => {
    for (const guid of ["any;-;+15555550123", "iMessage;-;+15555550123", "SMS;-;+15555550123"]) {
      const check = checkImessageOwnerHandle(guid);
      expect(check).toMatchObject({ kind: "ok", handle: "+15555550123" });
      expect(check.kind === "ok" && check.note).toContain("+15555550123");
    }
    expect(checkImessageOwnerHandle("any;-;Alex@Example.com")).toMatchObject({ kind: "ok", handle: "alex@example.com" });
  });

  it.each([
    [""],
    ["   "],
    ["any;+;chat0123456789"],
    ["not-an-email@"],
    ["alex@example"],
    ["12345"],
    ["+1555555012300000"],
    ["555-CALL-NOW"],
    ["5550123456789"],
  ])("rejects %j", (input) => {
    expect(checkImessageOwnerHandle(input).kind).toBe("error");
  });
});

describe("promptImessageOwnerHandles", () => {
  it("re-asks after an invalid answer, then returns the normalized handles", async () => {
    const { port, logs } = scripted({ text: ["any;+;chat1", "+1 (555) 555-0123, Alex@Example.com"] });
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "handles", handles: ["+15555550123", "alex@example.com"] });
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("group chat"))).toBe(true);
  });

  it("a blank answer alone does not skip: it needs an explicit confirm", async () => {
    const { port, asked } = scripted({ text: ["", "alex@example.com"], confirm: [false] });
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "handles", handles: ["alex@example.com"] });
    expect(asked.filter((a) => a.startsWith("confirm:"))).toHaveLength(1);
  });

  it("skips only after the user confirms leaving DMs ignored", async () => {
    const { port } = scripted({ text: [""], confirm: [true] });
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "skipped" });
  });

  it("re-asks when a +1 assumption is declined", async () => {
    const { port } = scripted({ text: ["5555550123", "+445555550123"], confirm: [false] });
    await expect(promptImessageOwnerHandles(port)).resolves.toEqual({ kind: "handles", handles: ["+445555550123"] });
  });
});

describe("checkTelegramUserId / deriveOwnerName / group entries", () => {
  it("validates a Telegram user id", () => {
    expect(checkTelegramUserId(" 123456789 ")).toEqual({ kind: "ok", id: "123456789" });
    expect(checkTelegramUserId("-1001234").kind).toBe("error");
    expect(checkTelegramUserId("abc").kind).toBe("error");
    expect(checkTelegramUserId("").kind).toBe("error");
  });

  it("derives the session-id name the way init always has", () => {
    expect(deriveOwnerName("Alex Example")).toBe("alex");
    expect(deriveOwnerName("   ")).toBe("owner");
    expect(deriveOwnerName("小明")).toBe("小明");
  });

  it("the Groups editor only takes group ids", () => {
    expect(isGroupAllowlistEntry("telegram", "-1001234567890")).toBe(true);
    expect(isGroupAllowlistEntry("telegram", "123456789")).toBe(false);
    expect(isGroupAllowlistEntry("imessage", "any;+;chat0123456789")).toBe(true);
    expect(isGroupAllowlistEntry("imessage", "chat0123456789")).toBe(true);
    expect(isGroupAllowlistEntry("imessage", "+15555550123")).toBe(false);
  });
});

describe("owner config edits (never write identities, never move the session)", () => {
  const LEGACY = { name: "Alex", channels: { telegram: "123456789", imessage: "+15555550123" }, replyPolicy: "last-active" };

  it("a legacy single identity is written out as the SAME owner (same name, same dm: key); identities stay until converted", () => {
    const cfg: Record<string, unknown> = { identities: [LEGACY] };
    const owner = ensureOwnerBlock(cfg, "ignored");
    expect(owner).toEqual({ name: "Alex", telegram: ["123456789"], imessage: ["+15555550123"] });
    expect(cfg.owner).toEqual({ name: "Alex", telegram: ["123456789"], imessage: ["+15555550123"] });
    expect(cfg.identities).toEqual([LEGACY]);
  });

  it("convert writes owner and removes identities, reporting the other identities' keys without touching them", () => {
    const cfg: Record<string, unknown> = {
      identities: [LEGACY, { name: "Sam", channels: { telegram: "222" }, replyPolicy: "telegram" }],
      web: { ownerIdentity: "alex" },
    };
    const result = convertLegacyIdentities(cfg);
    expect(result).toEqual({ owner: { name: "Alex", telegram: ["123456789"], imessage: ["+15555550123"] }, otherKeys: ["dm:sam"] });
    expect(cfg.identities).toBeUndefined();
    expect(currentOwner(cfg)).toEqual({ owner: { name: "Alex", telegram: ["123456789"], imessage: ["+15555550123"] }, fromLegacy: false });
    expect(convertLegacyIdentities({})).toBeUndefined();
  });

  it("adds and removes handles, normalizing iMessage, and keeps the name", () => {
    const cfg: Record<string, unknown> = { owner: { name: "alex", telegram: ["1"], imessage: [] } };
    addOwnerHandles(cfg, "imessage", ["+1 (555) 555-0123", "+15555550123"]);
    addOwnerHandles(cfg, "telegram", ["2"]);
    expect(cfg.owner).toEqual({ name: "alex", telegram: ["1", "2"], imessage: ["+15555550123"] });
    removeOwnerHandle(cfg, "telegram", "1");
    setOwnerDisplayName(cfg, "Alex");
    expect(cfg.owner).toEqual({ name: "alex", displayName: "Alex", telegram: ["2"], imessage: ["+15555550123"] });
    setOwnerDisplayName(cfg, " ");
    expect((cfg.owner as { displayName?: string }).displayName).toBeUndefined();
  });
});

describe("review #426: CLI flows write the owner the daemon actually uses", () => {
  it("pre-July install (owner only in the Telegram allowlist): enabling iMessage keeps that Telegram owner, writes no identities", async () => {
    const cfg: Record<string, unknown> = { channels: { telegram: { token: "t", allowlist: ["123456789"] } } };
    const { port } = scripted({ text: ["+15555550123"] });
    await enableImessageWithOwner(cfg, port);
    expect(cfg.owner).toEqual({ name: "owner", telegram: ["123456789"], imessage: ["+15555550123"] });
    expect(cfg).not.toHaveProperty("identities");
  });

  it("owner-block config: the handle goes into owner.imessage", async () => {
    const cfg: Record<string, unknown> = { owner: { name: "alex", telegram: ["1"], imessage: [] } };
    const { port } = scripted({ text: ["alex@example.com"] });
    await enableImessageWithOwner(cfg, port);
    expect(cfg.owner).toEqual({ name: "alex", telegram: ["1"], imessage: ["alex@example.com"] });
    expect(cfg).not.toHaveProperty("identities");
  });

  it("multi-identity config: binds and reports the owner the daemon resolves (web.ownerIdentity), not another identity", async () => {
    const cfg: Record<string, unknown> = {
      identities: [
        { name: "sam", channels: { telegram: "222" }, replyPolicy: "last-active" },
        { name: "alex", channels: { telegram: "111" }, replyPolicy: "last-active" },
      ],
      web: { ownerIdentity: "alex" },
    };
    const { port, logs } = scripted({ text: ["+15555550123"] });
    await enableImessageWithOwner(cfg, port);
    expect(cfg.owner).toEqual({ name: "alex", telegram: ["111"], imessage: ["+15555550123"] });
    expect(logs.find((l) => l.startsWith("success:"))).toContain('owner "alex"');
    expect((cfg.identities as Array<{ channels: Record<string, string> }>).every((id) => id.channels.imessage === undefined)).toBe(true);
  });
});

describe("enableImessageWithOwner (Channels → iMessage → Enable)", () => {
  it("adds the handle to the owner derived from a legacy identity (same name), never writing identities", async () => {
    const cfg: Record<string, unknown> = {
      channels: { telegram: { token: "t" } },
      identities: [{ name: "alex", channels: { telegram: "123456789" }, replyPolicy: "last-active" }],
    };
    const { port } = scripted({ text: ["+1 555 555 0123"] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(cfg.owner).toEqual({ name: "alex", telegram: ["123456789"], imessage: ["+15555550123"] });
    expect(cfg.identities).toEqual([{ name: "alex", channels: { telegram: "123456789" }, replyPolicy: "last-active" }]);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
  });

  it("creates an owner when there is none", async () => {
    const cfg: Record<string, unknown> = {};
    const { port } = scripted({ text: ["alex@example.com"] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(cfg.owner).toEqual({ name: "owner", telegram: [], imessage: ["alex@example.com"] });
    expect(cfg.identities).toBeUndefined();
  });

  it("does not finish without a handle unless the user explicitly confirms", async () => {
    const cfg: Record<string, unknown> = { owner: { name: "alex", telegram: ["1"] } };
    const { port, logs } = scripted({ text: [""], confirm: [true] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
    expect(cfg.owner).toEqual({ name: "alex", telegram: ["1"] });
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("ignored"))).toBe(true);
  });

  it("changes nothing when cancelled", async () => {
    const cfg: Record<string, unknown> = { owner: { name: "alex" } };
    const { port } = scripted({ text: [CANCEL] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(false);
    expect(cfg).toEqual({ owner: { name: "alex" } });

    const cfg2: Record<string, unknown> = {};
    const s2 = scripted({ text: [""], confirm: [CANCEL] });
    await expect(enableImessageWithOwner(cfg2, s2.port)).resolves.toBe(false);
    expect(cfg2).toEqual({});
  });

  it("does not ask again when the owner already has an iMessage handle", async () => {
    const cfg: Record<string, unknown> = { owner: { name: "alex", imessage: ["+15555550123"] } };
    const { port, asked } = scripted({});
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(asked).toEqual([]);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
  });
});
