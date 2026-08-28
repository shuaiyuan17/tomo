import { describe, it, expect, vi } from "vitest";
import { GrammyError } from "grammy";
import {
  isMarkdownParseError,
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

/**
 * Telegram's counterpart to the iMessage P2 (#292 review): unlike imsg, the
 * Bot API threads every send kind with the same `reply_parameters`, and this
 * channel already forwards them to sendPhoto and sendSticker. Pinned so the
 * asymmetry stays deliberate — imsg reports a dropped target BECAUSE it must,
 * and Telegram never has to.
 */
describe("TelegramChannel.send threads photos and stickers", () => {
  function makeChannel() {
    const channel = new TelegramChannel("000000:test-token");
    type Opts = { caption?: string; reply_parameters?: { message_id: number } };
    const calls: Array<{ kind: string; replyToId?: number; caption?: string }> = [];
    let nextId = 100;
    (channel as unknown as { bot: { api: unknown } }).bot.api = {
      sendPhoto: async (_chatId: string | number, _file: unknown, opts?: Opts) => {
        calls.push({ kind: "photo", replyToId: opts?.reply_parameters?.message_id, caption: opts?.caption });
        return { message_id: nextId++ };
      },
      sendSticker: async (_chatId: string | number, _sticker: unknown, opts?: Opts) => {
        calls.push({ kind: "sticker", replyToId: opts?.reply_parameters?.message_id });
        return { message_id: nextId++ };
      },
      sendMessage: async (_chatId: string | number, _text: string, opts?: Opts) => {
        calls.push({ kind: "text", replyToId: opts?.reply_parameters?.message_id });
        return { message_id: nextId++ };
      },
    };
    return { channel, calls };
  }

  it("forwards replyTo to sendPhoto and consumes the target", async () => {
    const { channel, calls } = makeChannel();
    const result = await channel.send({ chatId: "1", text: "cap", photo: "/tmp/pic.png", replyTo: "42" });
    expect(calls).toEqual([{ kind: "photo", replyToId: 42, caption: "cap" }]);
    // Nothing to report: the target really was applied.
    expect(result?.threaded).not.toBe(false);
  });

  it("forwards replyTo to sendSticker", async () => {
    const { channel, calls } = makeChannel();
    const result = await channel.send({ chatId: "1", text: "", sticker: "CAACAgIAAxkBAAIBOWX1", replyTo: "42" });
    expect(calls).toEqual([{ kind: "sticker", replyToId: 42 }]);
    expect(result?.threaded).not.toBe(false);
  });

  it("threads the photo, not the overflow caption, when the caption is too long", async () => {
    const { channel, calls } = makeChannel();
    await channel.send({ chatId: "1", text: "x".repeat(2000), photo: "/tmp/pic.png", replyTo: "42" });
    expect(calls[0]).toMatchObject({ kind: "photo", replyToId: 42 });
    expect(calls.slice(1).every((c) => c.replyToId === undefined)).toBe(true);
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

  it("records sent messages so they are targetable for edit/unsend", async () => {
    const { channel } = makeChannel();

    await channel.send({ chatId: "1", text: "first message" });
    await channel.send({ chatId: "1", text: "second message" });

    const recent = channel.recentMessages("1");
    expect(recent.map((m) => ({ text: m.text, fromMe: m.fromMe }))).toEqual([
      { text: "second message", fromMe: true },
      { text: "first message", fromMe: true },
    ]);
  });

  it("chunks an over-limit send instead of truncating it", async () => {
    const { channel, sent } = makeChannel();

    const long = "x".repeat(5000);
    await channel.send({ chatId: "1", text: long });

    const texts = sent.map((m) => m.text);
    expect(texts).toHaveLength(2);
    expect(texts.join("")).toBe(long);
    for (const part of texts) expect(part.length).toBeLessThanOrEqual(4096);
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

/**
 * SHUTDOWN — where the refusal guard may and may not sit.
 *
 * grammY acknowledges an update BEFORE our middleware runs: `handleUpdates`
 * sets `lastTriedUpdateId` and only then calls the middleware, and `bot.stop()`
 * confirms `lastTriedUpdateId + 1` with a final `getUpdates` without waiting for
 * the middleware stack (grammy 1.45.1, out/bot.js). So there is no such thing
 * as declining an update back to Telegram: an update refused half-way through
 * a photo download is LOST, not replayed. The guard therefore sits at the
 * ENTRY, and anything already inside the middleware has to be allowed to
 * finish into the agent — which is what `quiesce()` waits for.
 */
describe("TelegramChannel shutdown phases", () => {
  interface BotInternals {
    botInfo: unknown;
    api: Record<string, unknown>;
    handleUpdate: (update: unknown) => Promise<void>;
  }

  function makeChannel() {
    const channel = new TelegramChannel("000000:test-token");
    const bot = (channel as unknown as { bot: BotInternals }).bot;
    // handleUpdate refuses to run before the bot knows who it is.
    bot.botInfo = {
      id: 1, is_bot: true, first_name: "Tomo", username: "mybot",
      can_join_groups: true, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business_account: false,
      has_main_web_app: false,
    };
    return { channel, bot };
  }

  const chat = { id: 42, type: "private" as const, first_name: "Alice" };
  const from = { id: 7, is_bot: false, first_name: "Alice" };

  const textUpdate = (updateId: number, text: string) => ({
    update_id: updateId,
    message: { message_id: updateId, date: 1_700_000_000, chat, from, text },
  });

  const photoUpdate = (updateId: number) => ({
    update_id: updateId,
    message: {
      message_id: updateId, date: 1_700_000_000, chat, from,
      photo: [{ file_id: "file-1", file_unique_id: "u1", width: 10, height: 10 }],
      caption: "mid-download",
    },
  });

  it("lets an update already mid-download finish into the agent, and quiesces until it does", async () => {
    const { channel, bot } = makeChannel();

    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    let downloadStarted = false;
    bot.api.getFile = async () => {
      downloadStarted = true;
      await downloadGate;
      return {}; // no file_path: the photo is skipped, no network is touched
    };

    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text); return true; });

    void bot.handleUpdate(photoUpdate(1));
    await vi.waitFor(() => expect(downloadStarted).toBe(true));

    // SIGTERM lands with the update parked inside the middleware.
    channel.closeIngestion();

    let quiesced = false;
    const quiescing = channel.quiesce().then(() => { quiesced = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(quiesced).toBe(false);
    expect(seen).toEqual([]);

    releaseDownload();
    await quiescing;

    // It reached the agent instead of being dropped. Telegram had already
    // acknowledged it, so this is the only outcome that is not a loss.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("mid-download");
  });

  it("refuses an update that had not started when ingestion closed", async () => {
    const { channel, bot } = makeChannel();
    const seen: string[] = [];
    channel.onMessage(async (msg) => { seen.push(msg.text); return true; });

    channel.closeIngestion();
    await bot.handleUpdate(textUpdate(2, "after the door closed"));
    await channel.quiesce();

    expect(seen).toEqual([]);
  });

  it("keeps sending while ingestion is closed, and only teardown ends the bot", async () => {
    const { channel, bot } = makeChannel();
    const sent: string[] = [];
    bot.api.sendMessage = async (_chatId: unknown, text: string) => {
      sent.push(text);
      return { message_id: 1 };
    };
    let stopped = false;
    (bot as unknown as { stop: () => Promise<void> }).stop = async () => { stopped = true; };

    channel.closeIngestion();
    // The agent is still draining turns here; outbound must survive it.
    await channel.send({ chatId: "42", text: "delivered during the drain" });
    expect(sent).toEqual(["delivered during the drain"]);
    expect(stopped).toBe(false);

    await channel.teardown();
    expect(stopped).toBe(true);
  });
});

// Markdown fallback. Telegram's Bot API answers a malformed Markdown body with
// 400 "can't parse entities"; that is the ONLY failure that proves the message
// was refused and can be resent plain. Retrying on anything else risks a
// duplicate (a timeout after Telegram accepted the send) or just buries the
// real error under a second identical failure.
describe("TelegramChannel Markdown fallback", () => {
  const parseError = () => new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 3" },
    "sendMessage",
    {},
  );

  function makeChannel(failWith: (attempt: number) => Error | null) {
    const channel = new TelegramChannel("000000:test-token");
    const calls: Array<{ text: string; parseMode?: string }> = [];
    let attempt = 0;
    (channel as unknown as { bot: { api: unknown } }).bot.api = {
      sendMessage: async (_chatId: string | number, text: string, opts?: { parse_mode?: string }) => {
        calls.push({ text, parseMode: opts?.parse_mode });
        const err = failWith(attempt++);
        if (err) throw err;
        return { message_id: 100 + attempt };
      },
    };
    return { channel, calls };
  }

  it("classifies only a 400 entity-parsing GrammyError as a Markdown rejection", () => {
    expect(isMarkdownParseError(parseError())).toBe(true);
    expect(isMarkdownParseError(new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "sendMessage", {}))).toBe(false);
    expect(isMarkdownParseError(new GrammyError("x", { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }, "sendMessage", {}))).toBe(false);
    expect(isMarkdownParseError(new Error("Network request for 'sendMessage' failed!"))).toBe(false);
  });

  it("resends as plain text after a definite Markdown rejection", async () => {
    const { channel, calls } = makeChannel((attempt) => (attempt === 0 ? parseError() : null));
    await channel.send({ chatId: "1", text: "_broken" });
    expect(calls).toEqual([
      { text: "_broken", parseMode: "Markdown" },
      { text: "_broken", parseMode: undefined },
    ]);
  });

  it("propagates a timeout / transport failure without a second send", async () => {
    const { channel, calls } = makeChannel(() => new Error("Request to 'sendMessage' timed out after 500 seconds"));
    await expect(channel.send({ chatId: "1", text: "hello" })).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(1);
  });

  it("propagates other Bot API errors without a second send", async () => {
    const { channel, calls } = makeChannel(() => new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      {},
    ));
    await expect(channel.send({ chatId: "1", text: "hello" })).rejects.toThrow(/blocked/);
    expect(calls).toHaveLength(1);
  });
});
