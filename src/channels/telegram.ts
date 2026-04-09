import { Bot, type Context } from "grammy";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, ImageAttachment, StreamingMessage } from "./types.js";
import { log } from "../logger.js";

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private botUsername: string | undefined;
  private stopping = false;

  constructor(token: string) {
    this.bot = new Bot(token);

    this.bot.catch((err) => {
      log.error({ err: err.error }, "Telegram bot error");
    });

    // Slash commands
    for (const cmd of ["new", "model"]) {
      this.bot.command(cmd, async (ctx) => {
        const chatId = String(ctx.chat.id);
        const senderName = this.getSenderName(ctx);
        const args = ctx.match as string;
        for (const handler of this.commandHandlers) {
          await handler(cmd, chatId, senderName, args);
        }
      });
    }

    // Text messages (skip bot commands)
    this.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;

      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);

      await this.dispatch({
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
      const image = await this.downloadPhoto(largest.file_id);

      await this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        text: this.cleanMention(ctx.message.caption ?? "[Sent an image]"),
        images: image ? [image] : undefined,
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
    return text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
  }

  private async downloadPhoto(fileId: string): Promise<ImageAttachment | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return undefined;

      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return undefined;

      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = file.file_path.split(".").pop()?.toLowerCase();
      const mediaType = ext === "png" ? "image/png" : "image/jpeg";

      return { data: buffer.toString("base64"), mediaType };
    } catch (err) {
      log.error({ err }, "Failed to download photo");
      return undefined;
    }
  }

  private async dispatch(msg: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(msg);
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
    let messageId: number | null = null;
    let buffer = "";
    let lastSent = "";
    let editTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;
    let flushPending: Promise<void> = Promise.resolve();

    const flush = () => {
      flushPending = flushPending.then(async () => {
        if (buffer === lastSent || !buffer) return;
        const text = buffer;
        lastSent = text;

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
        } catch {
          // Telegram may reject edits if content unchanged or too fast
        }
      });
      return flushPending;
    };

    return {
      update: (text: string) => {
        buffer = text;
        if (!editTimer && !finished) {
          // First chunk — send immediately
          flush();
          editTimer = setInterval(flush, EDIT_INTERVAL_MS);
        }
      },
      finish: async () => {
        finished = true;
        if (editTimer) clearInterval(editTimer);
        await flush();
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

    try {
      await this.bot.api.sendMessage(message.chatId, message.text, {
        ...replyParams,
        parse_mode: "Markdown",
      });
    } catch {
      // Fallback to plain text if Markdown parsing fails
      await this.bot.api.sendMessage(message.chatId, message.text, replyParams);
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
      { command: "model", description: "Switch model (sonnet/opus/haiku)" },
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
