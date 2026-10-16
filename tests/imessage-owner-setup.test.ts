import { describe, expect, it } from "vitest";
import {
  checkImessageOwnerHandle,
  enableImessageWithOwner,
  promptImessageOwnerHandle,
  type PromptPort,
} from "../src/cli/config/imessage-owner.js";

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
    ["15555550123", { kind: "ok", handle: "+15555550123" }],
    ["Alex@Example.com", { kind: "ok", handle: "alex@example.com" }],
    ["  alex@example.com ", { kind: "ok", handle: "alex@example.com" }],
  ])("accepts %s", (input, expected) => {
    expect(checkImessageOwnerHandle(input)).toMatchObject(expected);
  });

  it("asks before assuming +1 for a 10-digit number", () => {
    expect(checkImessageOwnerHandle("(555) 555-0123")).toEqual({
      kind: "confirm",
      handle: "+15555550123",
      question: expect.stringContaining("+15555550123"),
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

describe("promptImessageOwnerHandle", () => {
  it("re-asks after an invalid answer, then returns the normalized handle", async () => {
    const { port, logs } = scripted({ text: ["any;+;chat1", "+1 (555) 555-0123"] });
    await expect(promptImessageOwnerHandle(port)).resolves.toEqual({ kind: "handle", handle: "+15555550123" });
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("group chat"))).toBe(true);
  });

  it("a blank answer alone does not skip: it needs an explicit confirm", async () => {
    const { port, asked } = scripted({ text: ["", "alex@example.com"], confirm: [false] });
    await expect(promptImessageOwnerHandle(port)).resolves.toEqual({ kind: "handle", handle: "alex@example.com" });
    expect(asked.filter((a) => a.startsWith("confirm:"))).toHaveLength(1);
  });

  it("skips only after the user confirms leaving DMs ignored", async () => {
    const { port } = scripted({ text: [""], confirm: [true] });
    await expect(promptImessageOwnerHandle(port)).resolves.toEqual({ kind: "skipped" });
  });

  it("re-asks when a +1 assumption is declined", async () => {
    const { port } = scripted({ text: ["5555550123", "+445555550123"], confirm: [false] });
    await expect(promptImessageOwnerHandle(port)).resolves.toEqual({ kind: "handle", handle: "+445555550123" });
  });
});

describe("enableImessageWithOwner (Channels → iMessage → Enable)", () => {
  it("binds the handle to the single existing identity", async () => {
    const cfg: Record<string, unknown> = {
      channels: { telegram: { token: "t", allowlist: ["123456789"] } },
      identities: [{ name: "alex", channels: { telegram: "123456789" }, replyPolicy: "last-active" }],
    };
    const { port } = scripted({ text: ["+1 555 555 0123"] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(cfg.identities).toEqual([{ name: "alex", channels: { telegram: "123456789", imessage: "+15555550123" }, replyPolicy: "last-active" }]);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
  });

  it("creates an owner identity when there is none", async () => {
    const cfg: Record<string, unknown> = {};
    const { port } = scripted({ text: ["alex@example.com"] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(cfg.identities).toEqual([{ name: "owner", channels: { imessage: "alex@example.com" }, replyPolicy: "last-active" }]);
  });

  it("does not finish without a handle unless the user explicitly confirms", async () => {
    const cfg: Record<string, unknown> = { identities: [] };
    const { port, logs } = scripted({ text: [""], confirm: [true] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
    expect(cfg.identities).toEqual([]);
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("ignored"))).toBe(true);
  });

  it("changes nothing when cancelled", async () => {
    const cfg: Record<string, unknown> = { identities: [] };
    const { port } = scripted({ text: [CANCEL] });
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(false);
    expect(cfg).toEqual({ identities: [] });

    const cfg2: Record<string, unknown> = {};
    const s2 = scripted({ text: [""], confirm: [CANCEL] });
    await expect(enableImessageWithOwner(cfg2, s2.port)).resolves.toBe(false);
    expect(cfg2).toEqual({});
  });

  it("does not ask again when an identity already binds iMessage", async () => {
    const cfg: Record<string, unknown> = {
      identities: [{ name: "alex", channels: { imessage: "+15555550123" }, replyPolicy: "last-active" }],
    };
    const { port, asked } = scripted({});
    await expect(enableImessageWithOwner(cfg, port)).resolves.toBe(true);
    expect(asked).toEqual([]);
    expect((cfg.channels as Record<string, Record<string, unknown>>).imessage).toEqual({ provider: "imsg" });
  });

  it("asks which identity is the owner when there are several", async () => {
    const cfg: Record<string, unknown> = {
      identities: [
        { name: "alex", channels: { telegram: "1" }, replyPolicy: "last-active" },
        { name: "sam", channels: { telegram: "2" }, replyPolicy: "last-active" },
      ],
    };
    const { port } = scripted({ select: ["1"], text: ["+15555550123"] });
    await enableImessageWithOwner(cfg, port);
    const ids = cfg.identities as Array<{ name: string; channels: Record<string, string> }>;
    expect(ids[0].channels).toEqual({ telegram: "1" });
    expect(ids[1].channels).toEqual({ telegram: "2", imessage: "+15555550123" });
  });
});
