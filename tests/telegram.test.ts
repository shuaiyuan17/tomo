import { describe, it, expect, vi } from "vitest";
import { TelegramChannel } from "../src/channels/telegram.js";

// Test @mention cleaning (extracted from TelegramChannel.cleanMention)
function cleanMention(text: string, botUsername: string | undefined): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
}

describe("cleanMention", () => {
  it("strips bot mention from text", () => {
    expect(cleanMention("@mybot hello", "mybot")).toBe("hello");
  });

  it("strips mention case-insensitively", () => {
    expect(cleanMention("@MyBot hello", "mybot")).toBe("hello");
  });

  it("strips mention from middle of text", () => {
    expect(cleanMention("hey @mybot what's up", "mybot")).toBe("hey  what's up");
  });

  it("returns text unchanged when no botUsername", () => {
    expect(cleanMention("@mybot hello", undefined)).toBe("@mybot hello");
  });

  it("returns text unchanged when no mention present", () => {
    expect(cleanMention("hello world", "mybot")).toBe("hello world");
  });

  it("strips multiple mentions", () => {
    expect(cleanMention("@mybot hey @mybot", "mybot")).toBe("hey");
  });
});

// Test sender name extraction (extracted from TelegramChannel.getSenderName)
function getSenderName(from: { first_name: string; last_name?: string }): string {
  return from.first_name + (from.last_name ? ` ${from.last_name}` : "");
}

describe("getSenderName", () => {
  it("returns first name only", () => {
    expect(getSenderName({ first_name: "John" })).toBe("John");
  });

  it("combines first and last name", () => {
    expect(getSenderName({ first_name: "John", last_name: "Doe" })).toBe("John Doe");
  });

  it("handles empty last name", () => {
    expect(getSenderName({ first_name: "Alice", last_name: "" })).toBe("Alice");
  });
});

// Test group chat detection (extracted from Telegram bot handler)
function isGroupChat(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

describe("isGroupChat", () => {
  it("detects group", () => {
    expect(isGroupChat("group")).toBe(true);
  });

  it("detects supergroup", () => {
    expect(isGroupChat("supergroup")).toBe(true);
  });

  it("rejects private chat", () => {
    expect(isGroupChat("private")).toBe(false);
  });

  it("rejects channel", () => {
    expect(isGroupChat("channel")).toBe(false);
  });
});

function describeSticker(sticker: {
  fileId: string;
  emoji?: string;
  setName?: string;
  type?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
}): string {
  const parts = [
    `file_id=${sticker.fileId}`,
    sticker.emoji ? `emoji=${sticker.emoji}` : undefined,
    sticker.setName ? `set=${sticker.setName}` : undefined,
    sticker.type ? `type=${sticker.type}` : undefined,
    sticker.isAnimated ? "animated=true" : undefined,
    sticker.isVideo ? "video=true" : undefined,
  ].filter(Boolean);
  return `[Sent a Telegram sticker: ${parts.join(", ")}; resend=STICKER:${sticker.fileId}]`;
}

describe("describeSticker", () => {
  it("includes file_id and resend instruction", () => {
    expect(describeSticker({ fileId: "CAAC123" })).toBe(
      "[Sent a Telegram sticker: file_id=CAAC123; resend=STICKER:CAAC123]",
    );
  });

  it("includes optional sticker metadata", () => {
    expect(describeSticker({
      fileId: "CAAC456",
      emoji: "😂",
      setName: "funny_pack",
      type: "regular",
      isAnimated: true,
      isVideo: false,
    })).toBe(
      "[Sent a Telegram sticker: file_id=CAAC456, emoji=😂, set=funny_pack, type=regular, animated=true; resend=STICKER:CAAC456]",
    );
  });
});

// Test streaming message flush serialization logic
describe("streaming message flush serialization", () => {
  it("serializes concurrent flushes to prevent duplicate sends", async () => {
    const calls: Array<{ action: string; text: string }> = [];
    let messageId: number | null = null;

    // Simulate the fixed flush implementation with serialization
    let flushPending = Promise.resolve();
    let buffer = "";
    let lastSent = "";

    const flush = () => {
      flushPending = flushPending.then(async () => {
        if (buffer === lastSent || !buffer) return;
        const text = buffer;
        lastSent = text;

        if (!messageId) {
          // Simulate API delay
          await new Promise((r) => setTimeout(r, 10));
          messageId = 42;
          calls.push({ action: "send", text });
        } else {
          calls.push({ action: "edit", text });
        }
      });
      return flushPending;
    };

    // First update + flush — sends "Hello"
    buffer = "Hello";
    flush();
    // Wait for first flush to complete so messageId is set
    await flushPending;

    // Second update + flush — now messageId exists, should edit
    buffer = "Hello world";
    flush();
    await flushPending;

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ action: "send", text: "Hello" });
    expect(calls[1]).toEqual({ action: "edit", text: "Hello world" });
    expect(messageId).toBe(42);
  });

  it("skips flush when buffer unchanged", async () => {
    const calls: string[] = [];
    let messageId: number | null = null;
    let flushPending = Promise.resolve();
    let buffer = "";
    let lastSent = "";

    const flush = () => {
      flushPending = flushPending.then(async () => {
        if (buffer === lastSent || !buffer) return;
        const text = buffer;
        lastSent = text;
        if (!messageId) {
          messageId = 1;
          calls.push("send");
        } else {
          calls.push("edit");
        }
      });
      return flushPending;
    };

    buffer = "Hello";
    flush();
    flush(); // Same buffer — should be skipped

    await flushPending;
    expect(calls).toEqual(["send"]);
  });
});

// NO_REPLY suppression in the streaming flush. The regex is duplicated here
// to keep the test self-contained — it must match the one in
// src/channels/telegram.ts:createStreamingMessage.
describe("streaming message NO_REPLY prefix suppression", () => {
  const NO_REPLY_PREFIX_RE = /^\s*(N(O(_(R(E(P(L(Y)?)?)?)?)?)?)?)?\s*$/i;

  it("matches every prefix of NO_REPLY (including empty)", () => {
    for (const s of ["", "N", "NO", "NO_", "NO_R", "NO_RE", "NO_REP", "NO_REPL", "NO_REPLY"]) {
      expect(NO_REPLY_PREFIX_RE.test(s)).toBe(true);
    }
  });

  it("matches case-insensitively and tolerates surrounding whitespace", () => {
    expect(NO_REPLY_PREFIX_RE.test("no_reply")).toBe(true);
    expect(NO_REPLY_PREFIX_RE.test("No_Reply")).toBe(true);
    expect(NO_REPLY_PREFIX_RE.test("  NO_REPLY  ")).toBe(true);
    expect(NO_REPLY_PREFIX_RE.test("\nNO_REPLY\n")).toBe(true);
  });

  it("does not match real replies that diverge from the NO_REPLY prefix", () => {
    expect(NO_REPLY_PREFIX_RE.test("Hello")).toBe(false);
    expect(NO_REPLY_PREFIX_RE.test("Hi")).toBe(false);
    expect(NO_REPLY_PREFIX_RE.test("NX")).toBe(false);
    expect(NO_REPLY_PREFIX_RE.test("NO_REPLY plus more text")).toBe(false);
    expect(NO_REPLY_PREFIX_RE.test("Sure thing")).toBe(false);
  });

  it("flush is suppressed while buffer is a NO_REPLY prefix, then resumes if content diverges", async () => {
    const calls: string[] = [];
    let messageId: number | null = null;
    let flushPending = Promise.resolve();
    let buffer = "";
    let lastSent = "";

    const flush = () => {
      flushPending = flushPending.then(async () => {
        if (buffer === lastSent || !buffer) return;
        if (NO_REPLY_PREFIX_RE.test(buffer)) return;
        lastSent = buffer;
        if (!messageId) {
          messageId = 1;
          calls.push(`send:${buffer}`);
        } else {
          calls.push(`edit:${buffer}`);
        }
      });
      return flushPending;
    };

    // Simulate the buffer growing as the model streams "NO" → "NO_REPLY"
    buffer = "NO";
    await (flush(), flushPending);
    buffer = "NO_REPLY";
    await (flush(), flushPending);

    // No flush has happened — buffer is still a NO_REPLY prefix the entire time.
    expect(calls).toEqual([]);
    expect(messageId).toBeNull();

    // Now the model "changes its mind" and writes a real reply.
    buffer = "NO_REPLY just kidding, here's the answer";
    await (flush(), flushPending);

    expect(calls).toEqual(["send:NO_REPLY just kidding, here's the answer"]);
    expect(messageId).toBe(1);
  });
});

function makeTelegramChannel(api: Record<string, unknown>, options: { draftStreaming?: boolean } = {}): TelegramChannel {
  const channel = new TelegramChannel("123:test", options) as unknown as TelegramChannel & {
    bot: { api: Record<string, unknown>; token: string; botInfo: { id: number } };
  };
  channel.bot = { api, token: "123:test", botInfo: { id: 123 } };
  return channel;
}

describe("Telegram draft streaming", () => {
  it("leaves draft streaming off by default", async () => {
    const api = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const channel = makeTelegramChannel(api);

    const stream = channel.createStreamingMessage("12345", undefined, { draftId: 99 });
    stream.update("Hello");
    await stream.finish();

    expect(api.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith("12345", "Hello", {});
  });

  it("streams private replies through drafts and persists the final text", async () => {
    const api = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const channel = makeTelegramChannel(api, { draftStreaming: true });

    const stream = channel.createStreamingMessage("12345", undefined, { draftId: 99 });
    stream.update("Hello");
    await stream.finish();

    expect(api.sendMessageDraft).toHaveBeenNthCalledWith(1, 12345, 99, "");
    expect(api.sendMessageDraft).toHaveBeenNthCalledWith(2, 12345, 99, "Hello");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith("12345", "Hello", { parse_mode: "Markdown" });
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("keeps group chats on the existing visible edit stream", async () => {
    const api = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const channel = makeTelegramChannel(api, { draftStreaming: true });

    const stream = channel.createStreamingMessage("-100123", undefined, { draftId: 99 });
    stream.update("Hello group");
    await stream.finish();

    expect(api.sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith("-100123", "Hello group", {});
  });

  it("falls back to visible streaming if the draft API fails", async () => {
    const api = {
      sendMessageDraft: vi.fn().mockRejectedValue(new Error("unsupported")),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const channel = makeTelegramChannel(api, { draftStreaming: true });

    const stream = channel.createStreamingMessage("12345", undefined, { draftId: 99 });
    stream.update("Hello fallback");
    await stream.finish();

    expect(api.sendMessageDraft).toHaveBeenCalledWith(12345, 99, "");
    expect(api.sendMessage).toHaveBeenCalledWith("12345", "Hello fallback", {});
  });

  it("does not persist a NO_REPLY-only draft stream", async () => {
    const api = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const channel = makeTelegramChannel(api, { draftStreaming: true });

    const stream = channel.createStreamingMessage("12345", undefined, { draftId: 99 });
    stream.update("NO_REPLY");
    await stream.finish();

    expect(api.sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(api.sendMessageDraft).toHaveBeenCalledWith(12345, 99, "");
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
