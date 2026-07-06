import { describe, it, expect } from "vitest";
import {
  POLLING_HEALTHY_RUN_MS,
  POLLING_RESTART_MAX_MS,
  POLLING_RESTART_MIN_MS,
  TelegramChannel,
  cleanMention,
  mentionRegex,
  nextPollingBackoff,
} from "../src/channels/telegram.js";

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

  it("treats regex metacharacters in the username literally", () => {
    // Telegram usernames are [A-Za-z0-9_], but the RegExp must not break or
    // over-match if that ever changes.
    expect(cleanMention("@my.bot hello", "my.bot")).toBe("hello");
    expect(cleanMention("@myXbot hello", "my.bot")).toBe("@myXbot hello");
  });

  it("does not strip a longer username that starts with the bot's name", () => {
    expect(cleanMention("@mybot_backup hello", "mybot")).toBe("@mybot_backup hello");
    expect(cleanMention("@mybot2 hello", "mybot")).toBe("@mybot2 hello");
  });
});

describe("mentionRegex", () => {
  it("matches the username at word boundaries only", () => {
    expect(mentionRegex("mybot", "i").test("hey @mybot!")).toBe(true);
    expect(mentionRegex("mybot", "i").test("hey @MyBot, hello")).toBe(true);
    expect(mentionRegex("mybot", "i").test("@mybot")).toBe(true);
  });

  it("does not match longer usernames sharing the bot's prefix", () => {
    expect(mentionRegex("mybot", "i").test("hey @mybot_backup")).toBe(false);
    expect(mentionRegex("mybot", "i").test("hey @mybot2")).toBe(false);
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

// Photo caption handling: Telegram rejects captions over 1024 chars, which
// would lose both the photo and the text. Long captions must be sent as a
// separate chunked message instead.
describe("TelegramChannel.send photo captions", () => {
  function makeChannel() {
    const channel = new TelegramChannel("000000:test-token");
    const photos: Array<{ chatId: string; caption?: string }> = [];
    const messages: Array<{ chatId: string; text: string }> = [];
    let nextId = 100;
    (channel as unknown as { bot: { api: unknown } }).bot.api = {
      sendPhoto: async (chatId: string | number, _file: unknown, opts?: { caption?: string }) => {
        photos.push({ chatId: String(chatId), caption: opts?.caption });
        return { message_id: nextId++ };
      },
      sendMessage: async (chatId: string | number, text: string) => {
        messages.push({ chatId: String(chatId), text });
        return { message_id: nextId++ };
      },
    };
    return { channel, photos, messages };
  }

  it("keeps short captions on the photo", async () => {
    const { channel, photos, messages } = makeChannel();
    await channel.send({ chatId: "1", text: "short caption", photo: "/tmp/pic.png" });
    expect(photos).toEqual([{ chatId: "1", caption: "short caption" }]);
    expect(messages).toHaveLength(0);
  });

  it("ships over-limit captions as a separate text message", async () => {
    const { channel, photos, messages } = makeChannel();
    const longText = "x".repeat(2000);
    await channel.send({ chatId: "1", text: longText, photo: "/tmp/pic.png" });
    expect(photos).toEqual([{ chatId: "1", caption: undefined }]);
    expect(messages.map((m) => m.text).join("")).toBe(longText);
  });

  it("records a captioned photo as an own message so edit/unsend can target it", async () => {
    const { channel } = makeChannel();
    await channel.send({ chatId: "1", text: "earlier text" });
    await channel.send({ chatId: "1", text: "look at this", photo: "/tmp/pic.png" });

    // The captioned photo — not the earlier text — is the newest own message,
    // so a no-match unsend targets what the user actually just saw.
    const recent = channel.recentMessages("1");
    expect(recent.map((m) => ({ text: m.text, fromMe: m.fromMe }))).toEqual([
      { text: "look at this", fromMe: true },
      { text: "earlier text", fromMe: true },
    ]);
  });

  it("does not record captionless photos (no text to match on)", async () => {
    const { channel } = makeChannel();
    await channel.send({ chatId: "1", text: "", photo: "/tmp/pic.png" });
    expect(channel.recentMessages("1")).toHaveLength(0);
  });
});

// Recent-message tracking + edit/unsend of own messages. Outbound sends must
// record their provider message ids (Telegram has no webhook echo for bot
// messages) so edit_message/unsend_message can target them later.
describe("TelegramChannel recent messages and edit/unsend", () => {
  function makeChannel() {
    const channel = new TelegramChannel("000000:test-token");
    const sent: Array<{ chatId: string; text: string }> = [];
    const edited: Array<{ chatId: string; messageId: number; text: string; parseMode?: string }> = [];
    const deleted: Array<{ chatId: string; messageId: number }> = [];
    let nextId = 100;
    const editedCaptions: Array<{ chatId: string; messageId: number; caption?: string; parseMode?: string }> = [];
    const api = {
      sendMessage: async (chatId: string | number, text: string) => {
        sent.push({ chatId: String(chatId), text });
        return { message_id: nextId++ };
      },
      sendPhoto: async (_chatId: string | number, _file: unknown, _opts?: { caption?: string }) => {
        return { message_id: nextId++ };
      },
      editMessageText: async (chatId: string | number, messageId: number, text: string, opts?: { parse_mode?: string }) => {
        edited.push({ chatId: String(chatId), messageId, text, parseMode: opts?.parse_mode });
        return {};
      },
      editMessageCaption: async (chatId: string | number, messageId: number, opts?: { caption?: string; parse_mode?: string }) => {
        editedCaptions.push({ chatId: String(chatId), messageId, caption: opts?.caption, parseMode: opts?.parse_mode });
        return {};
      },
      deleteMessage: async (chatId: string | number, messageId: number) => {
        deleted.push({ chatId: String(chatId), messageId });
        return true;
      },
    };
    (channel as unknown as { bot: { api: unknown } }).bot.api = api;
    return { channel, api, sent, edited, editedCaptions, deleted };
  }

  it("records outbound sends as own messages, newest first", async () => {
    const { channel } = makeChannel();

    await channel.send({ chatId: "1", text: "first" });
    await channel.send({ chatId: "1", text: "second" });

    const recent = channel.recentMessages("1");
    expect(recent.map((m) => ({ id: m.id, text: m.text, fromMe: m.fromMe }))).toEqual([
      { id: "101", text: "second", fromMe: true },
      { id: "100", text: "first", fromMe: true },
    ]);
  });

  it("records each chunk of a long outbound send under its own message id", async () => {
    const { channel } = makeChannel();

    const longText = `${"x".repeat(4090)} ${"y".repeat(100)}`;
    await channel.send({ chatId: "1", text: longText });

    const recent = channel.recentMessages("1");
    expect(recent).toHaveLength(2);
    expect(recent.every((m) => m.fromMe)).toBe(true);
    expect(recent.map((m) => m.id)).toEqual(["101", "100"]);
  });

  it("records inbound dispatches as messages from others", async () => {
    const { channel } = makeChannel();

    (channel as unknown as { dispatch(msg: unknown): void }).dispatch({
      id: "555",
      chatId: "1",
      senderName: "Alice",
      text: "hi tomo",
      timestamp: 1,
    });

    const recent = channel.recentMessages("1");
    expect(recent).toEqual([
      { id: "555", text: "hi tomo", senderName: "Alice", timestamp: 1, fromMe: false },
    ]);
  });

  it("caps the per-chat window at 50 messages", async () => {
    const { channel } = makeChannel();

    for (let i = 0; i < 55; i++) {
      await channel.send({ chatId: "1", text: `message ${i}` });
    }

    const recent = channel.recentMessages("1");
    expect(recent).toHaveLength(50);
    expect(recent[0].text).toBe("message 54");
    expect(recent[49].text).toBe("message 5");
  });

  it("edits via editMessageText (Markdown first) and updates the recorded text", async () => {
    const { channel, edited } = makeChannel();
    await channel.send({ chatId: "1", text: "helo world" });

    await channel.editMessage("1", "100", "hello world");

    expect(edited).toEqual([
      { chatId: "1", messageId: 100, text: "hello world", parseMode: "Markdown" },
    ]);
    expect(channel.recentMessages("1")[0].text).toBe("hello world");
  });

  it("falls back to a plain-text edit when Markdown parsing fails", async () => {
    const { channel, api, edited } = makeChannel();
    await channel.send({ chatId: "1", text: "original" });

    let calls = 0;
    api.editMessageText = async (chatId: string | number, messageId: number, text: string, opts?: { parse_mode?: string }) => {
      calls++;
      if (opts?.parse_mode === "Markdown") throw new Error("Bad Request: can't parse entities");
      edited.push({ chatId: String(chatId), messageId, text, parseMode: opts?.parse_mode });
      return {};
    };

    await channel.editMessage("1", "100", "broken _markdown");

    expect(calls).toBe(2);
    expect(edited).toEqual([
      { chatId: "1", messageId: 100, text: "broken _markdown", parseMode: undefined },
    ]);
    expect(channel.recentMessages("1")[0].text).toBe("broken _markdown");
  });

  it("treats 'message is not modified' as success", async () => {
    const { channel, api } = makeChannel();
    await channel.send({ chatId: "1", text: "same text" });
    api.editMessageText = async () => {
      throw new Error("Bad Request: message is not modified");
    };

    await expect(channel.editMessage("1", "100", "same text")).resolves.toBeUndefined();
  });

  it("rejects empty and over-limit edits without calling the API", async () => {
    const { channel, edited } = makeChannel();

    await expect(channel.editMessage("1", "100", "   ")).rejects.toThrow(/cannot be empty/i);
    await expect(channel.editMessage("1", "100", "x".repeat(4097))).rejects.toThrow(/4096/);
    expect(edited).toHaveLength(0);
  });

  it("maps Telegram's edit refusal to a friendly window error", async () => {
    const { channel, api } = makeChannel();
    api.editMessageText = async () => {
      throw new Error("Bad Request: message can't be edited");
    };

    await expect(channel.editMessage("1", "100", "new text")).rejects.toThrow(/48 hours/);
  });

  it("falls back to editMessageCaption for captioned photos and updates the recorded text", async () => {
    const { channel, api, editedCaptions } = makeChannel();
    await channel.send({ chatId: "1", text: "old caption", photo: "/tmp/pic.png" });

    api.editMessageText = async () => {
      throw new Error("Bad Request: there is no text in the message to edit");
    };

    await channel.editMessage("1", "100", "new caption");

    expect(editedCaptions).toEqual([
      { chatId: "1", messageId: 100, caption: "new caption", parseMode: "Markdown" },
    ]);
    expect(channel.recentMessages("1")[0].text).toBe("new caption");
  });

  it("rejects caption edits over Telegram's 1024-char caption limit", async () => {
    const { channel, api, editedCaptions } = makeChannel();
    api.editMessageText = async () => {
      throw new Error("Bad Request: there is no text in the message to edit");
    };

    await expect(channel.editMessage("1", "100", "x".repeat(2000))).rejects.toThrow(/1024/);
    expect(editedCaptions).toHaveLength(0);
  });

  it("unsends via deleteMessage and drops the recorded row", async () => {
    const { channel, deleted } = makeChannel();
    await channel.send({ chatId: "1", text: "oops" });
    expect(channel.recentMessages("1")).toHaveLength(1);

    await channel.unsendMessage("1", "100");

    expect(deleted).toEqual([{ chatId: "1", messageId: 100 }]);
    expect(channel.recentMessages("1")).toHaveLength(0);
  });

  it("maps Telegram's delete refusal to a friendly window error", async () => {
    const { channel, api } = makeChannel();
    api.deleteMessage = async () => {
      throw new Error("Bad Request: message can't be deleted for everyone");
    };

    await expect(channel.unsendMessage("1", "100")).rejects.toThrow(/48 hours/);
  });

  it("records streamed blocks once sealed so they are targetable", async () => {
    const { channel } = makeChannel();

    const stream = channel.createStreamingMessage("1");
    stream.update("first block");
    await stream.commitBlock();
    stream.update("second block");
    await stream.finish();

    const recent = channel.recentMessages("1");
    expect(recent.map((m) => ({ text: m.text, fromMe: m.fromMe }))).toEqual([
      { text: "second block", fromMe: true },
      { text: "first block", fromMe: true },
    ]);
  });
});

// Polling restart backoff: a permanently failing bot.start() (revoked token,
// network down) must not hot-loop a restart every 3s forever.
describe("nextPollingBackoff", () => {
  it("doubles the delay on rapid failures up to the cap", () => {
    let delay = POLLING_RESTART_MIN_MS;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { delayMs, nextDelayMs } = nextPollingBackoff(delay, 100);
      seen.push(delayMs);
      delay = nextDelayMs;
    }
    expect(seen[0]).toBe(POLLING_RESTART_MIN_MS);
    expect(seen[1]).toBe(POLLING_RESTART_MIN_MS * 2);
    expect(seen[seen.length - 1]).toBe(POLLING_RESTART_MAX_MS);
    // Monotonically non-decreasing while failures stay rapid
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("resets to the minimum after a healthy run", () => {
    // Backed off to the cap, then polling stayed up past the health threshold.
    const { delayMs, nextDelayMs } = nextPollingBackoff(POLLING_RESTART_MAX_MS, POLLING_HEALTHY_RUN_MS);
    expect(delayMs).toBe(POLLING_RESTART_MIN_MS);
    expect(nextDelayMs).toBe(POLLING_RESTART_MIN_MS * 2);
  });

  it("keeps backing off when the run died just under the health threshold", () => {
    const { delayMs } = nextPollingBackoff(12_000, POLLING_HEALTHY_RUN_MS - 1);
    expect(delayMs).toBe(12_000);
  });
});
