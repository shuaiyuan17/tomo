import { Bot, type Context } from "grammy";
import type { ReactionType, ReactionTypeEmoji } from "grammy/types";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, ImageAttachment, DocumentAttachment, StreamingMessage, MessageReaction } from "./types.js";
import { formatImageMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime } from "./documentStore.js";
import {
  buildDocumentAttachment,
  buildImageAttachment,
  isDeclaredDocumentTooLarge,
  readDocumentResponseWithCap,
} from "./attachments.js";
import { log } from "../logger.js";
import { deliverTextParts } from "./delivery.js";
import { LITERAL_NEWLINE_TOKEN, splitOutboundMessageText, splitText } from "./text-utils.js";

/** Telegram rejects sendMessage/editMessageText beyond 4096 chars. */
const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramChannelOptions {
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private botUsername: string | undefined;
  private stopping = false;
  private imageStoreBaseDir: string | undefined;

  constructor(token: string, options: TelegramChannelOptions = {}) {
    this.bot = new Bot(token);
    this.imageStoreBaseDir = options.imageStoreBaseDir;

    this.bot.catch((err) => {
      log.error({ err: err.error }, "Telegram bot error");
    });

    // Slash commands
    for (const cmd of ["new", "model", "restore", "login", "status", "cost", "pet", "summon", "dismiss"]) {
      this.bot.command(cmd, async (ctx) => {
        const chatId = String(ctx.chat.id);
        const senderName = this.getSenderName(ctx);
        const senderId = ctx.from ? String(ctx.from.id) : undefined;
        const args = ctx.match as string;
        for (const handler of this.commandHandlers) {
          await handler(cmd, chatId, senderName, args, senderId);
        }
      });
    }

    // Text messages (skip bot commands)
    this.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;

      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        text: this.cleanMention(ctx.message.text),
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    });

    // Photo messages
    this.bot.on("message:photo", async (ctx) => {
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const image = await this.downloadPhoto(largest.file_id, String(ctx.chat.id));

      const caption = this.cleanMention(ctx.message.caption ?? "");
      const savedPaths = image?.savedPath ? [image.savedPath] : [];
      const marker = formatImageMarker(1, savedPaths);
      const text = caption ? `${marker} ${caption}` : marker;

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        text,
        images: image ? [image] : undefined,
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    });

    // Document messages (PDFs and other supported document types). Telegram
    // exposes generic file attachments under `message:document`; we ingest
    // only the MIME types Anthropic accepts as document content blocks.
    this.bot.on("message:document", async (ctx) => {
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);
      const doc = ctx.message.document;

      // Skip silently if it's not a supported document MIME — emit a plain
      // text message so the agent can still see "user sent some unsupported
      // file" rather than the message disappearing entirely.
      if (!isSupportedDocumentMime(doc.mime_type)) {
        const caption = this.cleanMention(ctx.message.caption ?? "");
        const note = `[Sent an unsupported document: ${doc.file_name ?? "unnamed"} (${doc.mime_type ?? "no mime"})]`;
        this.dispatch({
          id: String(ctx.message.message_id),
          chatId: String(ctx.chat.id),
          senderName: this.getSenderName(ctx),
          text: caption ? `${note} ${caption}` : note,
          timestamp: ctx.message.date * 1000,
          isGroup,
          isMentioned,
          chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
        });
        return;
      }

      const document = await this.downloadDocument(
        doc.file_id,
        doc.mime_type as string,
        doc.file_name,
        doc.file_size,
        String(ctx.chat.id),
      );

      const caption = this.cleanMention(ctx.message.caption ?? "");
      const savedPaths = document?.savedPath ? [document.savedPath] : [];
      const marker = formatDocumentMarker(1, savedPaths);
      const text = caption ? `${marker} ${caption}` : marker;

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        text,
        documents: document ? [document] : undefined,
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    });

    // Sticker messages. We do not download sticker artwork here; the file_id
    // is enough for Tomo to understand and resend it later via STICKER:<id>.
    this.bot.on("message:sticker", async (ctx) => {
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);
      const sticker = ctx.message.sticker;

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        text: this.describeSticker({
          fileId: sticker.file_id,
          emoji: sticker.emoji,
          setName: sticker.set_name,
          type: sticker.type,
          isAnimated: sticker.is_animated,
          isVideo: sticker.is_video,
        }),
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    });
  }

  private getSenderName(ctx: Context): string {
    const from = ctx.from!;
    return from.first_name + (from.last_name ? ` ${from.last_name}` : "");
  }

  private checkMentioned(ctx: Context): boolean {
    if (!this.botUsername) return false;
    const msg = ctx.message!;

    // Replied to the bot
    if (msg.reply_to_message?.from?.id === this.bot.botInfo.id) return true;

    // @mentioned in text
    const text = ("text" in msg ? msg.text : msg.caption) ?? "";
    if (text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`)) return true;

    // Mentioned via entities
    const entities = ("entities" in msg ? msg.entities : msg.caption_entities) ?? [];
    for (const e of entities) {
      if (e.type === "mention") {
        const mention = text.slice(e.offset, e.offset + e.length);
        if (mention.toLowerCase() === `@${this.botUsername.toLowerCase()}`) return true;
      }
    }

    return false;
  }

  /** Strip @botname from the message text */
  private cleanMention(text: string): string {
    if (!this.botUsername) return text;
    const escaped = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`@${escaped}`, "gi"), "").trim();
  }

  /** Error detail safe to log — file-download URLs embed the bot token. */
  private redactToken(err: unknown): string {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    return this.bot.token ? detail.replaceAll(this.bot.token, "<bot-token>") : detail;
  }

  private describeSticker(sticker: {
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

  private async downloadDocument(
    fileId: string,
    mediaType: string,
    filename: string | undefined,
    declaredFileSize: number | undefined,
    chatId?: string,
  ): Promise<DocumentAttachment | undefined> {
    // Pre-check declared file_size before any HTTP work. Telegram's Document
    // object reliably includes file_size; if it's already over the cap we
    // skip getFile + download entirely.
    if (isDeclaredDocumentTooLarge(declaredFileSize, { fileId, mediaType, declaredFileSize })) {
      return undefined;
    }

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return undefined;

      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return undefined;

      const buffer = await readDocumentResponseWithCap(res, { fileId, mediaType });
      if (!buffer) return undefined;

      return await buildDocumentAttachment(
        buffer,
        mediaType,
        {
          sessionKey: chatId ? `telegram_${chatId}` : "telegram",
          guid: fileId,
          filename,
        },
        this.imageStoreBaseDir,
      );
    } catch (err) {
      log.error({ err: this.redactToken(err), fileId }, "Failed to download document");
      return undefined;
    }
  }

  private async downloadPhoto(fileId: string, chatId?: string): Promise<ImageAttachment | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return undefined;

      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return undefined;

      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = file.file_path.split(".").pop()?.toLowerCase();
      const mediaType = ext === "png" ? "image/png" : "image/jpeg";

      return await buildImageAttachment(
        buffer,
        mediaType,
        {
          sessionKey: chatId ? `telegram_${chatId}` : "telegram",
          guid: fileId,
        },
        this.imageStoreBaseDir,
      );
    } catch (err) {
      log.error({ err: this.redactToken(err), fileId }, "Failed to download photo");
      return undefined;
    }
  }

  private dispatch(msg: IncomingMessage): void {
    // Fire-and-forget: the agent's per-session queue handles ordering.
    // Awaiting here would let grammy serialize updates against the SDK turn,
    // preventing rapid messages from piling up for the queue to coalesce.
    for (const handler of this.handlers) {
      handler(msg).catch((err) => log.error({ err }, "Telegram message handler failed"));
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  startTyping(chatId: string): () => void {
    let sealed = false;
    let consecutiveErrors = 0;
    let interval: ReturnType<typeof setInterval> | null = null;

    const MAX_ERRORS = 10;
    const INTERVAL_MS = 6000;
    const TTL_MS = 2 * 60 * 1000;

    const send = async () => {
      if (sealed) return;
      if (consecutiveErrors >= MAX_ERRORS) {
        log.warn({ chatId }, "Typing suspended after %d consecutive errors", MAX_ERRORS);
        cleanup();
        return;
      }
      try {
        await this.bot.api.sendChatAction(chatId, "typing");
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors++;
      }
    };

    const cleanup = () => {
      if (sealed) return;
      sealed = true;
      if (interval) clearInterval(interval);
      if (ttlTimeout) clearTimeout(ttlTimeout);
    };

    send();
    interval = setInterval(send, INTERVAL_MS);
    const ttlTimeout = setTimeout(cleanup, TTL_MS);

    return cleanup;
  }

  createStreamingMessage(chatId: string, replyTo?: string): StreamingMessage {
    const EDIT_INTERVAL_MS = 1500;
    // Suppress flushing while the buffer looks like it might resolve to a
    // bare NO_REPLY. Once content grows past this prefix or diverges, we know
    // it's a real reply and proceed normally.
    const NO_REPLY_PREFIX_RE = /^\s*(N(O(_(R(E(P(L(Y)?)?)?)?)?)?)?)?\s*$/i;
    let messageId: number | null = null;
    let buffer = "";
    // Chars of `buffer` already finalized into earlier messages when a block
    // overflowed Telegram's per-message limit.
    let offset = 0;
    let lastSent = "";
    let editTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;
    let canceled = false;
    let flushPending: Promise<void> = Promise.resolve();

    const deleteCurrentMessage = async (): Promise<void> => {
      if (messageId === null) return;
      const id = messageId;
      messageId = null;
      lastSent = "";
      try {
        await this.bot.api.deleteMessage(chatId, id);
      } catch {
        // Best-effort — message may already be gone or too old to delete.
      }
    };

    // Send or edit the current message. Throws on failure so callers don't
    // mark unsent content as delivered; "message is not modified" is a
    // success (content is already on screen).
    const sendOrEdit = async (text: string): Promise<void> => {
      try {
        if (!messageId) {
          const replyParams = replyTo
            ? { reply_parameters: { message_id: Number(replyTo) } }
            : {};
          const sent = await this.bot.api.sendMessage(chatId, text, replyParams);
          messageId = sent.message_id;
        } else {
          await this.bot.api.editMessageText(chatId, messageId, text);
        }
      } catch (err) {
        if (err instanceof Error && /not modified/i.test(err.message)) return;
        throw err;
      }
    };

    const flush = () => {
      flushPending = flushPending.then(async () => {
        try {
          while (!canceled) {
            const pending = buffer.slice(offset);
            if (pending === lastSent || !pending) return;
            // Don't send while the buffer might still resolve to a NO_REPLY token —
            // the agent uses NO_REPLY to suppress delivery, and Telegram's
            // first-frame send would race ahead and surface it before suppression.
            if (offset === 0 && NO_REPLY_PREFIX_RE.test(pending)) return;
            const messageParts = splitOutboundMessageText(pending);
            if (messageParts.length !== 1 || pending.includes(LITERAL_NEWLINE_TOKEN)) {
              await deleteCurrentMessage();
              return;
            }
            const visiblePending = messageParts[0];
            if (visiblePending.length <= TELEGRAM_TEXT_LIMIT) {
              await sendOrEdit(visiblePending);
              lastSent = visiblePending;
              return;
            }
            // Over Telegram's limit: finalize the current message with the
            // first chunk, then roll the remainder into a fresh message.
            const head = splitText(visiblePending, TELEGRAM_TEXT_LIMIT)[0];
            await sendOrEdit(head);
            offset += head.length;
            messageId = null;
            lastSent = "";
          }
        } catch (err) {
          // Transient failure (rate limit, network): state was not advanced,
          // so the next timer tick or commit retries the same content.
          log.warn({ err, chatId }, "Telegram streaming flush failed; will retry");
        }
      });
      return flushPending;
    };

    /**
     * Stop the edit timer and wait for any in-flight flush so the per-block
     * state (messageId, lastSent, buffer) reflects what's actually on screen.
     */
    const stopAndDrain = async () => {
      if (editTimer) {
        clearInterval(editTimer);
        editTimer = null;
      }
      await flushPending;
    };

    /**
     * Final flush for commitBlock/finish. The edit timer is stopped by then,
     * so a swallowed flush failure has no later tick to retry it — retry here
     * with backoff, and log loudly if the tail content is truly lost.
     */
    const finalFlush = async () => {
      const parts = splitOutboundMessageText(buffer);
      if (parts.length !== 1 || buffer.includes(LITERAL_NEWLINE_TOKEN)) {
        await deleteCurrentMessage();
        await deliverTextParts(this, chatId, buffer, { replyTo });
        buffer = "";
        offset = 0;
        lastSent = "";
        return;
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (canceled) return;
        await flush();
        const pending = buffer.slice(offset);
        if (!pending || pending === lastSent) return;
        if (offset === 0 && NO_REPLY_PREFIX_RE.test(pending)) return;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      log.error({ chatId }, "Telegram final flush failed after retries; trailing content was not delivered");
    };

    return {
      update: (text: string) => {
        if (canceled || finished) return;
        buffer = text;
        if (!editTimer) {
          // First delta of this block — try to send immediately (flush will
          // suppress if buffer still looks like a NO_REPLY prefix). After
          // commitBlock the timer is cleared, so the next block re-enters
          // here and gets its own immediate first send.
          flush();
          editTimer = setInterval(flush, EDIT_INTERVAL_MS);
        }
      },
      commitBlock: async () => {
        if (canceled || finished) return;
        // Final flush for this block, then reset state so the next update()
        // starts a fresh sendMessage instead of editing the previous block.
        await stopAndDrain();
        await finalFlush();
        messageId = null;
        lastSent = "";
        buffer = "";
        offset = 0;
      },
      finish: async () => {
        if (finished) return;
        finished = true;
        await stopAndDrain();
        await finalFlush();
      },
      cancel: async () => {
        canceled = true;
        if (editTimer) {
          clearInterval(editTimer);
          editTimer = null;
        }
        // Wait for any in-flight flush so we know whether messageId got set.
        await flushPending;
        await deleteCurrentMessage();
      },
      discardBlock: async () => {
        if (canceled || finished) return;
        await stopAndDrain();
        await deleteCurrentMessage();
        buffer = "";
        offset = 0;
        lastSent = "";
      },
    };
  }

  async send(message: OutgoingMessage): Promise<void> {
    const replyParams = message.replyTo
      ? { reply_parameters: { message_id: Number(message.replyTo) } }
      : {};

    // Send photo if provided
    if (message.photo) {
      const { InputFile } = await import("grammy");
      await this.bot.api.sendPhoto(message.chatId, new InputFile(message.photo), {
        ...replyParams,
        caption: message.text || undefined,
      });
      return;
    }

    if (message.sticker) {
      await this.bot.api.sendSticker(message.chatId, message.sticker, replyParams);
      return;
    }

    // Telegram caps messages at 4096 chars; oversized sends are rejected
    // outright, so chunk like the iMessage channel does. Only the first
    // chunk carries the reply reference.
    const chunks = splitText(message.text, TELEGRAM_TEXT_LIMIT);
    for (const [i, chunk] of chunks.entries()) {
      const params = i === 0 ? replyParams : {};
      try {
        await this.bot.api.sendMessage(message.chatId, chunk, {
          ...params,
          parse_mode: "Markdown",
        });
      } catch {
        // Fallback to plain text if Markdown parsing fails
        await this.bot.api.sendMessage(message.chatId, chunk, params);
      }
    }
  }

  async setChatTitle(chatId: string, title: string): Promise<void> {
    await this.bot.api.setChatTitle(chatId, title);
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove = false): Promise<void> {
    const emojiByReaction = {
      love: "\u2764",
      like: "\u{1F44D}",
      dislike: "\u{1F44E}",
      laugh: "\u{1F923}",
      emphasize: "\u{1F92F}",
      question: "\u{1F914}",
    } satisfies Record<MessageReaction, ReactionTypeEmoji["emoji"]>;
    const reactions = remove ? [] : [{ type: "emoji" as const, emoji: emojiByReaction[reaction] }];
    try {
      await this.bot.api.setMessageReaction(chatId, Number(messageId), reactions satisfies ReactionType[]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/REACTION_INVALID/i.test(detail)) {
        throw new Error("Telegram rejected that reaction; this chat may not allow it", { cause: err });
      }
      throw err;
    }
  }

  async start(): Promise<void> {
    log.info("Telegram bot starting");
    await this.bot.init();
    this.botUsername = this.bot.botInfo.username;
    log.info({ username: this.botUsername }, "Bot identity loaded");

    // Register commands with Telegram so they show in the menu
    await this.bot.api.setMyCommands([
      { command: "new", description: "Start a new conversation" },
      { command: "model", description: "Switch model (Claude aliases or LiteLLM provider/model)" },
      { command: "restore", description: "Restore config from backup and restart" },
      { command: "login", description: "Refresh Claude login (owner DM only)" },
      { command: "status", description: "Show current session status" },
      { command: "cost", description: "Show current session costs" },
      { command: "pet", description: "Check on Tomo's pet" },
      { command: "summon", description: "Pull your main Tomo session into this group" },
      { command: "dismiss", description: "Hand this group back to its own Tomo session" },
    ]);

    this.startPolling();
  }

  private startPolling(): void {
    if (this.stopping) return;
    this.bot.start().then(() => {
      if (!this.stopping) {
        log.warn("Telegram polling ended unexpectedly, restarting in 3s");
        setTimeout(() => this.startPolling(), 3000);
      }
    }).catch((err) => {
      if (!this.stopping) {
        log.error({ err }, "Telegram polling failed, restarting in 3s");
        setTimeout(() => this.startPolling(), 3000);
      }
    });
  }

  async stop(): Promise<void> {
    log.info("Telegram bot stopping");
    this.stopping = true;
    await this.bot.stop();
  }
}
