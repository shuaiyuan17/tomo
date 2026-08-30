import { Bot, GrammyError, type Context } from "grammy";
import type { ReactionType, ReactionTypeEmoji } from "grammy/types";
import type { Channel, IncomingMessage, OutgoingMessage, MessageHandler, CommandHandler, ImageAttachment, DocumentAttachment, MessageReaction, RecentChatMessage } from "./types.js";
import { formatImageMarker } from "./imageStore.js";
import { formatDocumentMarker, isSupportedDocumentMime } from "./documentStore.js";
import {
  buildDocumentAttachment,
  buildImageAttachment,
  isDeclaredDocumentTooLarge,
  readDocumentResponseWithCap,
} from "./attachments.js";
import { log } from "../logger.js";
import { splitText } from "./text-utils.js";
import { formatMimeToken, sanitizeAttachmentFilename } from "./fileStore.js";

/**
 * A Bot API 400 whose description names an entity-parsing failure — the one
 * error that proves the message was refused for its Markdown and can be
 * resent plain without risking a duplicate.
 */
export function isMarkdownParseError(err: unknown): boolean {
  return err instanceof GrammyError
    && err.error_code === 400
    && /can't parse entities|can't find end of the entity|parse entities/i.test(err.description);
}

/** Telegram rejects sendMessage/editMessageText beyond 4096 chars. */
const TELEGRAM_TEXT_LIMIT = 4096;
/** Telegram rejects sendPhoto captions beyond 1024 chars. */
const TELEGRAM_CAPTION_LIMIT = 1024;
/** Per-chat window of recent messages kept for substring targeting. */
const RECENT_MESSAGES_PER_CHAT = 50;

/** First restart delay after polling exits. */
export const POLLING_RESTART_MIN_MS = 3000;
/** Backoff ceiling for repeated rapid polling failures. */
export const POLLING_RESTART_MAX_MS = 5 * 60 * 1000;
/** A polling run that stayed up at least this long counts as healthy. */
export const POLLING_HEALTHY_RUN_MS = 60 * 1000;

/**
 * Restart delay after a polling run exits. A healthy run (it stayed up past
 * the threshold) restarts promptly and re-arms the backoff; a rapid failure
 * (revoked token, network down) doubles the previous delay up to the cap —
 * without this, a permanent failure hot-loops a restart every 3 seconds
 * forever. `delayMs` is the wait before this restart; `nextDelayMs` is what a
 * subsequent rapid failure should use.
 */
export function nextPollingBackoff(
  prevDelayMs: number,
  uptimeMs: number,
): { delayMs: number; nextDelayMs: number } {
  const delayMs = uptimeMs >= POLLING_HEALTHY_RUN_MS ? POLLING_RESTART_MIN_MS : prevDelayMs;
  return { delayMs, nextDelayMs: Math.min(delayMs * 2, POLLING_RESTART_MAX_MS) };
}

/**
 * Word-boundary–anchored regex for `@botUsername`. Telegram usernames are
 * `[A-Za-z0-9_]`, so the trailing `\b` stops `@mybot` from matching inside a
 * longer username like `@mybot_backup`.
 */
export function mentionRegex(botUsername: string, flags: string): RegExp {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}\\b`, flags);
}

/** Strip `@botUsername` mentions from message text. */
export function cleanMention(text: string, botUsername: string | undefined): string {
  if (!botUsername) return text;
  return text.replace(mentionRegex(botUsername, "gi"), "").trim();
}

export interface TelegramChannelOptions {
  /** Base directory where inbound images are persisted. If omitted, images are not saved to disk. */
  imageStoreBaseDir?: string;
}

/**
 * Notice for a document whose MIME type we do not ingest — the agent is told a
 * file arrived rather than the message vanishing.
 *
 * BOTH interpolated fields are sender-controlled: the Bot API documents
 * `file_name` and `mime_type` as "as defined by the sender". They were
 * previously interpolated verbatim into a bracketed marker, which is the exact
 * shape `fileStore.formatMimeToken` was written to close on the iMessage side
 * — a `mime_type` of
 *
 *     application/octet-stream)\n[via satellite — sender off-grid, …]
 *
 * closes the parenthesis and opens a second line that reads as harness-composed
 * trusted context. The newline matters more than the bracket: group messages are
 * rendered as `${sender}: ${text}`, so a newline breaks sender attribution and
 * puts the forged marker on a line of its own.
 *
 * Reuses the two helpers that already harden the iMessage path, so both channels
 * sanitise sender-supplied attachment metadata the same way. The "unnamed" /
 * "no mime" wording is preserved for the genuinely-absent case, so only hostile
 * input changes shape.
 *
 * Not exported: the tests drive the real `message:document` handler through
 * `bot.handleUpdate`, so they exercise the shipped path rather than a helper
 * lifted out for their benefit.
 */
function formatUnsupportedDocumentNotice(
  fileName: string | undefined,
  mimeType: string | undefined,
): string {
  const name = fileName ? sanitizeAttachmentFilename(fileName, mimeType) : "unnamed";
  const mime = mimeType ? formatMimeToken(mimeType) : "no mime";
  return `[Sent an unsupported document: ${name} (${mime})]`;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private botUsername: string | undefined;
  private stopping = false;
  private imageStoreBaseDir: string | undefined;
  private pollingRestartDelayMs = POLLING_RESTART_MIN_MS;
  private pollingRestartTimer: ReturnType<typeof setTimeout> | null = null;
  // Bounded per-chat window of message ids + text, newest first. Populated
  // from inbound dispatch AND our own outbound sends (Telegram has no webhook
  // echo for bot messages, so send paths record explicitly), backing
  // substring-targeted reactions, threaded replies, and edit/unsend.
  private recentByChat = new Map<string, RecentChatMessage[]>();
  /**
   * Updates currently inside our middleware — the download/parse work plus the
   * hand-off to the agent. grammY does not track this for us: `bot.stop()`
   * documents that it "will not wait for the middleware stack to finish", and
   * it confirms `lastTriedUpdateId + 1` regardless (bot.js sets
   * `lastTriedUpdateId` BEFORE running middleware). So Telegram considers
   * these updates delivered whatever we do with them, and this set is the only
   * thing that lets `quiesce()` give them somewhere to land.
   */
  private inFlightUpdates = new Set<Promise<void>>();

  constructor(token: string, options: TelegramChannelOptions = {}) {
    this.bot = new Bot(token);
    this.imageStoreBaseDir = options.imageStoreBaseDir;

    this.bot.catch((err) => {
      log.error({ err: err.error }, "Telegram bot error");
    });

    // Slash commands
    for (const cmd of ["new", "model", "restore", "login", "mcp", "status", "cost", "usage", "pet", "summon", "dismiss", "pause", "resume"]) {
      this.bot.command(cmd, (ctx) => this.ingest(String(ctx.chat.id), String(ctx.msg?.message_id ?? ""), async () => {
        const chatId = String(ctx.chat.id);
        const senderName = this.getSenderName(ctx);
        const senderId = ctx.from ? String(ctx.from.id) : undefined;
        const args = ctx.match as string;
        for (const handler of this.commandHandlers) {
          await handler(cmd, chatId, senderName, args, senderId);
        }
      }));
    }

    // Text messages (skip bot commands)
    this.bot.on("message:text", (ctx) => this.ingest(String(ctx.chat.id), String(ctx.message.message_id), async () => {
      if (ctx.message.text.startsWith("/")) return;

      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        senderId: this.getSenderId(ctx),
        text: this.cleanMention(ctx.message.text),
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    }));

    // Photo messages
    this.bot.on("message:photo", (ctx) => this.ingest(String(ctx.chat.id), String(ctx.message.message_id), async () => {
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
        senderId: this.getSenderId(ctx),
        text,
        images: image ? [image] : undefined,
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    }));

    // Document messages (PDFs and other supported document types). Telegram
    // exposes generic file attachments under `message:document`; we ingest
    // only the MIME types Anthropic accepts as document content blocks.
    this.bot.on("message:document", (ctx) => this.ingest(String(ctx.chat.id), String(ctx.message.message_id), async () => {
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);
      const doc = ctx.message.document;

      // Skip silently if it's not a supported document MIME — emit a plain
      // text message so the agent can still see "user sent some unsupported
      // file" rather than the message disappearing entirely.
      if (!isSupportedDocumentMime(doc.mime_type)) {
        const caption = this.cleanMention(ctx.message.caption ?? "");
        const note = formatUnsupportedDocumentNotice(doc.file_name, doc.mime_type);
        this.dispatch({
          id: String(ctx.message.message_id),
          chatId: String(ctx.chat.id),
          senderName: this.getSenderName(ctx),
          senderId: this.getSenderId(ctx),
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
        senderId: this.getSenderId(ctx),
        text,
        documents: document ? [document] : undefined,
        timestamp: ctx.message.date * 1000,
        isGroup,
        isMentioned,
        chatTitle: isGroup ? ("title" in ctx.chat ? ctx.chat.title : undefined) : undefined,
      });
    }));

    // Sticker messages. We do not download sticker artwork here; the file_id
    // is enough for Tomo to understand and resend it later via STICKER:<id>.
    this.bot.on("message:sticker", (ctx) => this.ingest(String(ctx.chat.id), String(ctx.message.message_id), async () => {
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const isMentioned = this.checkMentioned(ctx);
      const sticker = ctx.message.sticker;

      this.dispatch({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        senderName: this.getSenderName(ctx),
        senderId: this.getSenderId(ctx),
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
    }));
  }

  /**
   * Run one update's middleware under the entry guard and the in-flight
   * ledger.
   *
   * The guard is checked ONCE, here, before any work starts: an update that
   * arrives after `closeIngestion()` is declined outright. Once the work has
   * begun it is never revoked — Telegram has already recorded the update as
   * delivered, so abandoning it half-parsed loses it for good. It runs to
   * completion instead, and `quiesce()` is what holds the shutdown open long
   * enough for it to reach the batcher.
   */
  private ingest(chatId: string, updateId: string, work: () => Promise<void>): Promise<void> {
    if (this.stopping) {
      log.warn({ chatId, messageId: updateId }, "Telegram update refused: ingestion closed");
      return Promise.resolve();
    }
    const done = work()
      .catch((err) => log.error({ err: this.redactToken(err), chatId }, "Telegram update handling failed"))
      .finally(() => { this.inFlightUpdates.delete(done); });
    this.inFlightUpdates.add(done);
    return done;
  }

  private getSenderName(ctx: Context): string {
    const from = ctx.from!;
    return from.first_name + (from.last_name ? ` ${from.last_name}` : "");
  }

  private getSenderId(ctx: Context): string | undefined {
    return ctx.from ? String(ctx.from.id) : undefined;
  }

  private checkMentioned(ctx: Context): boolean {
    if (!this.botUsername) return false;
    const msg = ctx.message!;

    // Replied to the bot
    if (msg.reply_to_message?.from?.id === this.bot.botInfo.id) return true;

    // @mentioned in text (word-boundary match so "@mybot" doesn't match
    // inside a longer username like "@mybot_backup")
    const text = ("text" in msg ? msg.text : msg.caption) ?? "";
    if (mentionRegex(this.botUsername, "i").test(text)) return true;

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
    return cleanMention(text, this.botUsername);
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
    if (msg.id && msg.text.trim()) {
      this.recordRecentMessage(msg.chatId, {
        id: msg.id,
        text: msg.text,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
        fromMe: false,
      });
    }

    // No shutdown guard here. It lives at the entry to the update (`ingest`),
    // and repeating it at the hand-off would be actively harmful: by this
    // point the update has been through the middleware, and refusing it now
    // would LOSE it. Telegram already counts it as delivered — grammY records
    // `lastTriedUpdateId` before running middleware and `bot.stop()` confirms
    // `lastTriedUpdateId + 1` without waiting for the middleware to finish —
    // so there is no redelivery to fall back on. It goes to the batcher, and
    // `quiesce()` is what keeps the batcher open until it gets there.
    //
    // Fire-and-forget for ORDERING (awaiting here would let grammy serialize
    // updates against the SDK turn, preventing rapid messages from piling up
    // for the queue to coalesce), but tracked, so shutdown can still wait for
    // it. Untracked fire-and-forget is a message with no owner.
    for (const handler of this.handlers) {
      const done = handler(msg)
        .then((accepted) => {
          // The one case Telegram cannot recover from. Logged as an error, not
          // a warning: the update is acknowledged upstream and refused here,
          // so this is a genuine loss, and it should be unreachable — the
          // entry guard plus quiesce exist precisely to make it so.
          if (!accepted) {
            log.error(
              { chatId: msg.chatId, messageId: msg.id },
              "Telegram message refused by the agent after Telegram already acknowledged the update; it is lost, not replayed",
            );
          }
        })
        .catch((err) => log.error({ err }, "Telegram message handler failed"))
        .finally(() => { this.inFlightUpdates.delete(done); });
      this.inFlightUpdates.add(done);
    }
  }

  private recordRecentMessage(chatId: string, message: RecentChatMessage): void {
    const ring = this.recentByChat.get(chatId) ?? [];
    if (ring.some((m) => m.id === message.id)) return;
    ring.unshift(message); // newest first
    if (ring.length > RECENT_MESSAGES_PER_CHAT) ring.pop();
    this.recentByChat.set(chatId, ring);
  }

  private recordOwnMessage(chatId: string, messageId: number, text: string): void {
    if (!text.trim()) return;
    this.recordRecentMessage(chatId, {
      id: String(messageId),
      text,
      timestamp: Date.now(),
      fromMe: true,
    });
  }

  /** Drop a previously recorded own message from the recent ring (retraction). */
  private forgetOwnMessage(chatId: string, messageId: number): void {
    const ring = this.recentByChat.get(chatId);
    if (!ring) return;
    const idx = ring.findIndex((m) => m.id === String(messageId));
    if (idx !== -1) ring.splice(idx, 1);
  }

  recentMessages(chatId: string): RecentChatMessage[] {
    return [...(this.recentByChat.get(chatId) ?? [])];
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

  async send(message: OutgoingMessage): Promise<void> {
    const replyParams = message.replyTo
      ? { reply_parameters: { message_id: Number(message.replyTo) } }
      : {};

    // Send photo if provided
    if (message.photo) {
      const { InputFile } = await import("grammy");
      const caption = message.text || undefined;
      // Telegram rejects captions over 1024 chars outright, which would lose
      // the photo AND the text. Ship the photo captionless and follow up with
      // the text as its own (chunked) message instead.
      const fitsCaption = !caption || caption.length <= TELEGRAM_CAPTION_LIMIT;
      const sent = await this.bot.api.sendPhoto(message.chatId, new InputFile(message.photo), {
        ...replyParams,
        caption: fitsCaption ? caption : undefined,
      });
      if (fitsCaption && caption) {
        // A captioned photo is the visible form of a text reply (the delivery
        // pipeline ships assistant text as the first photo's caption) — it
        // must be targetable by edit/unsend like any other own message.
        this.recordOwnMessage(message.chatId, sent.message_id, caption);
      }
      if (!fitsCaption) {
        await this.send({ chatId: message.chatId, text: message.text });
      }
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
      let sent;
      try {
        sent = await this.bot.api.sendMessage(message.chatId, chunk, {
          ...params,
          parse_mode: "Markdown",
        });
      } catch (err) {
        // Resend as plain text ONLY on a definite Markdown rejection: Telegram
        // answered 400 "can't parse entities", so nothing was sent. Anything
        // else propagates — a timeout or dropped connection may have landed
        // the message already (a retry would double-send), and a 429 / chat
        // not found / blocked bot would fail identically the second time
        // while burying the real error under the fallback's.
        if (!isMarkdownParseError(err)) throw err;
        log.debug({ chatId: message.chatId, err }, "Telegram rejected Markdown; resending as plain text");
        sent = await this.bot.api.sendMessage(message.chatId, chunk, params);
      }
      this.recordOwnMessage(message.chatId, sent.message_id, chunk);
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

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Edited message text cannot be empty");
    // editMessageText cannot split into multiple messages the way send() can —
    // reject outright instead of losing the tail.
    if (text.length > TELEGRAM_TEXT_LIMIT) {
      throw new Error(`Edited text exceeds Telegram's ${TELEGRAM_TEXT_LIMIT}-character message limit`);
    }
    // Keep substring targeting working against what's actually on screen.
    // "message is not modified" counts: the content already equals `text`.
    const recordEditedText = () => {
      const entry = this.recentByChat.get(chatId)?.find((m) => m.id === messageId);
      if (entry) entry.text = text;
    };
    const isNotModified = (err: unknown) => err instanceof Error && /not modified/i.test(err.message);
    // Media messages (captioned photos) carry their text as a caption —
    // editMessageText rejects them with this error and editMessageCaption is
    // the right surface.
    const isMediaMessage = (err: unknown) => err instanceof Error && /no text in the message to edit/i.test(err.message);

    // Try Markdown first then plain, mirroring send(). Returns "media" when
    // Telegram says the target has no text to edit, so the caller can retry
    // via the caption API.
    const attempt = async (edit: (parseMode?: "Markdown") => Promise<unknown>): Promise<"ok" | "media"> => {
      try {
        await edit("Markdown");
        return "ok";
      } catch (err) {
        if (isNotModified(err)) return "ok";
        if (isMediaMessage(err)) return "media";
        try {
          await edit(undefined);
          return "ok";
        } catch (plainErr) {
          if (isNotModified(plainErr)) return "ok";
          if (isMediaMessage(plainErr)) return "media";
          if (plainErr instanceof Error && /can't be edited|message to edit not found/i.test(plainErr.message)) {
            throw new Error("Telegram refused the edit — bots can only edit their own messages, within ~48 hours of sending", { cause: plainErr });
          }
          throw plainErr;
        }
      }
    };

    const asText = await attempt((parseMode) =>
      this.bot.api.editMessageText(chatId, Number(messageId), text, parseMode ? { parse_mode: parseMode } : undefined),
    );
    if (asText === "media") {
      if (text.length > TELEGRAM_CAPTION_LIMIT) {
        throw new Error(`This message is a captioned photo, and the edited text exceeds Telegram's ${TELEGRAM_CAPTION_LIMIT}-character caption limit`);
      }
      await attempt((parseMode) =>
        this.bot.api.editMessageCaption(chatId, Number(messageId), { caption: text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
      );
    }
    recordEditedText();
  }

  async unsendMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.bot.api.deleteMessage(chatId, Number(messageId));
    } catch (err) {
      if (err instanceof Error && /message can't be deleted|message to delete not found/i.test(err.message)) {
        throw new Error("Telegram refused the delete — bots can only delete messages within ~48 hours of sending", { cause: err });
      }
      throw err;
    }
    const ring = this.recentByChat.get(chatId);
    const idx = ring?.findIndex((m) => m.id === messageId) ?? -1;
    if (ring && idx !== -1) ring.splice(idx, 1);
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
      { command: "mcp", description: "Inspect or re-authenticate external MCP servers" },
      { command: "status", description: "Show current session status" },
      { command: "cost", description: "Show current session costs" },
      { command: "usage", description: "Show Claude subscription usage limits" },
      { command: "pet", description: "Check on Tomo's pet" },
      { command: "summon", description: "Pull your main Tomo session into this group" },
      { command: "dismiss", description: "Hand this group back to its own Tomo session" },
      { command: "pause", description: "Pause Tomo in this group (messages ignored until /resume)" },
      { command: "resume", description: "Resume Tomo in this group after /pause" },
    ]);

    this.startPolling();
  }

  private startPolling(): void {
    if (this.stopping) return;
    const startedAt = Date.now();

    const scheduleRestart = (err?: unknown) => {
      if (this.stopping) return;
      const { delayMs, nextDelayMs } = nextPollingBackoff(this.pollingRestartDelayMs, Date.now() - startedAt);
      this.pollingRestartDelayMs = nextDelayMs;
      if (err) {
        log.error({ err, delayMs }, "Telegram polling failed, restarting in %ds", Math.round(delayMs / 1000));
      } else {
        log.warn({ delayMs }, "Telegram polling ended unexpectedly, restarting in %ds", Math.round(delayMs / 1000));
      }
      this.pollingRestartTimer = setTimeout(() => {
        this.pollingRestartTimer = null;
        this.startPolling();
      }, delayMs);
    };

    this.bot.start().then(() => scheduleRestart(), (err) => scheduleRestart(err));
  }

  /**
   * Phase 1 — shut the inbound door. Synchronous and I/O-free.
   *
   * `stopping` also stops `startPolling` from rearming itself. It does NOT
   * stop grammY's current `getUpdates` loop (that needs `bot.stop()`, which is
   * network work and belongs in `teardown()`), so updates may still arrive
   * after this — `ingest` declines them at the entry.
   */
  closeIngestion(): void {
    log.info("Telegram bot: closing ingestion");
    this.stopping = true;
    if (this.pollingRestartTimer) {
      clearTimeout(this.pollingRestartTimer);
      this.pollingRestartTimer = null;
    }
  }

  /**
   * Phase 2 — wait for updates already inside our middleware.
   *
   * grammY offers nothing for this: `bot.stop()` is explicit that it "will not
   * wait for the middleware stack to finish", and it has already committed the
   * offset past these updates. Re-snapshots until the ledger is empty, because
   * an update mid-download can still add its hand-off promise while we wait.
   * Errors are swallowed inside `ingest`/`dispatch`, so this settles.
   */
  async quiesce(): Promise<void> {
    while (this.inFlightUpdates.size > 0) {
      await Promise.allSettled([...this.inFlightUpdates]);
    }
  }

  /**
   * Phase 3 — physical teardown. `bot.stop()` ends the polling loop and makes
   * one final `getUpdates` to confirm the offset; that request rides grammY's
   * default 500 s client timeout, which is exactly why nothing durable is
   * allowed to wait behind it.
   */
  async teardown(): Promise<void> {
    log.info("Telegram bot stopping");
    this.stopping = true;
    await this.bot.stop();
  }

  /** Full shutdown for a standalone caller. `Agent.stop()` drives the phases itself. */
  async stop(): Promise<void> {
    this.closeIngestion();
    await this.quiesce();
    await this.teardown();
  }
}
