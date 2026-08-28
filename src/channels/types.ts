export interface ImageAttachment {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g. "image/jpeg", "image/png") */
  mediaType: string;
  /** Absolute path on disk if the channel persisted the image (saveInboundImages). */
  savedPath?: string;
  /**
   * True when the source channel marked this image as a sticker (iMessage
   * chat.db `attachment.is_sticker`). Stickers get their own inline marker so
   * the agent knows a sticker arrived — and can resend the saved copy as one —
   * instead of seeing an indistinguishable "image".
   */
  isSticker?: boolean;
}

export interface DocumentAttachment {
  /** Base64-encoded document data */
  data: string;
  /** MIME type (e.g. "application/pdf") */
  mediaType: string;
  /** Original filename if the channel exposed one (Telegram document, etc.). */
  filename?: string;
  /** Absolute path on disk if the channel persisted the document. */
  savedPath?: string;
}

export interface IncomingMessage {
  /** Unique message ID from the source channel */
  id: string;
  /** Channel-specific chat/conversation ID */
  chatId: string;
  /** Display name of the sender */
  senderName: string;
  /**
   * Provider-verified stable sender identifier (Telegram user id, normalized
   * iMessage handle address). Unlike `senderName` it survives profile renames
   * and is safe to key identity resolution on. Absent when the provider did
   * not expose a sender handle.
   */
  senderId?: string;
  /** Message text content */
  text: string;
  /** Optional image attachments */
  images?: ImageAttachment[];
  /** Optional document attachments (PDFs, etc.) */
  documents?: DocumentAttachment[];
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Whether this message is from a group chat */
  isGroup?: boolean;
  /** Whether the bot was mentioned or replied to */
  isMentioned?: boolean;
  /** Group chat title */
  chatTitle?: string;
}

export interface OutgoingMessage {
  /** Chat/conversation to send to */
  chatId: string;
  /** Message text content */
  text: string;
  /** Optional: message ID to reply to */
  replyTo?: string;
  /** Optional: file path to send as photo */
  photo?: string;
  /**
   * Optional: sticker to send. The value is channel-bound and discriminated
   * by shape at the channel layer: a Telegram `file_id` (URL-safe-base64-ish,
   * never starts with `/` or `~`) resends a sticker Telegram already hosts; a
   * local image path (always starts with `/` or `~`) sends a native iMessage
   * sticker. Each channel routes its own shape and drops the other — a
   * file_id is only meaningful on the channel it came from.
   */
  sticker?: string;
  /**
   * Optional: iMessage expressive-send effect for this message's text (one of
   * IMESSAGE_SEND_EFFECTS). A delivery property, not a payload — channels that
   * cannot render effects (Telegram, the AppleScript fallback) ignore the
   * field entirely; it must never be rendered into visible message text.
   */
  effect?: string;
}

/**
 * Expressive-send effect names accepted by OutgoingMessage.effect — the
 * friendly names imsg's `send.rich` expands to Apple effect bundle ids
 * (imsg ExpressiveSendEffect.expand). The first four are bubble effects
 * (rendered on the bubble itself); the rest are full-screen effects.
 */
export const IMESSAGE_SEND_EFFECTS = [
  "impact", "loud", "gentle", "invisibleink",
  "confetti", "lasers", "fireworks", "balloons", "sparkles",
  "spotlight", "echo", "love", "celebration",
] as const;

/**
 * What a channel reports back about a send the caller cannot otherwise see.
 *
 * Only `replyTo` needs reporting today. Threading support is per message KIND,
 * not per channel: iMessage can thread text (`send.rich`) and attachments
 * (`send.attachment`), both bridge-only, but stickers never (`send.sticker`
 * takes no `reply_to`, and the bridge's `stickerReplyTo` selector is absent).
 * A channel that silently drops the target strands the whole turn unthreaded,
 * because the delivery pipeline attaches it to exactly one message and would
 * consider it spent.
 */
export interface SendResult {
  /**
   * Whether the requested `replyTo` was actually applied to a message that
   * shipped. Set it to `false` — and only then — when the caller asked to
   * thread and this send could not (unsupported kind, bridge down, nothing
   * shipped at all); the pipeline then keeps the target for the next send.
   * Omit the field (or return nothing) when the target was honoured, when no
   * `replyTo` was requested, or when threading is not a concept here.
   */
  threaded?: boolean;
}

export type MessageReaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

/**
 * A recently seen message in a chat, tracked by channels that support
 * targeted reactions and threaded replies (see Channel.recentMessages).
 */
export interface RecentChatMessage {
  /** Provider message id/GUID. */
  id: string;
  /** Plain text content. */
  text: string;
  /** Display name of the sender (absent for our own messages). */
  senderName?: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Whether the message was sent by us. */
  fromMe: boolean;
}
export interface StopTypingOptions {
  /** Clear the remote typing indicator immediately when the channel supports it. */
  clear?: boolean;
}

export type StopTyping = (options?: StopTypingOptions) => void | Promise<void>;

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
/**
 * Slash command handler. `senderId` is the channel's provider-verified sender
 * identifier (Telegram user id, iMessage handle address) — unlike
 * `senderName` (a display name), it is safe to use for owner checks.
 */
export type CommandHandler = (command: string, chatId: string, senderName: string, args?: string, senderId?: string) => Promise<void>;

export interface Channel {
  /** Channel identifier (e.g. "telegram", "imessage") */
  readonly name: string;

  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void;

  /** Register a handler for slash commands */
  onCommand(handler: CommandHandler): void;

  /**
   * Send a message through this channel.
   *
   * Returning nothing means "delivered as asked" — the common case. Return a
   * SendResult only to report something the caller cannot see, currently just
   * a `replyTo` the channel could not honour (see SendResult.threaded).
   */
  send(message: OutgoingMessage): Promise<SendResult | void>;

  /** Rename a group chat/conversation, if supported by the channel. */
  setChatTitle?(chatId: string, title: string): Promise<void>;

  /** React/tapback to a specific provider message, if supported by the channel. */
  reactToMessage?(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean): Promise<void>;

  /**
   * Edit the text of a message we previously sent, if supported by the
   * channel. The time windows are the provider's own: Telegram ~48h for bot
   * messages; iMessage 15 minutes, which is Apple's limit and applies however
   * the edit is delivered.
   *
   * Declaring the method is not the same as the edit landing. The iMessage
   * implementation drives Apple's IMCore through the imsg bridge (`imsg
   * launch`) and gates every call on a startup selector probe: Apple removed
   * both edit selectors OS-wide in macOS 26, so there the channel refuses with
   * an explicit error instead of calling IMCore blindly. Implementers should
   * do the same — surface an unsupported edit as a thrown error the caller can
   * report, never a silent no-op.
   */
  editMessage?(chatId: string, messageId: string, text: string): Promise<void>;

  /**
   * Unsend/delete a message we previously sent, if supported by the channel.
   * The time windows are the provider's own: Telegram ~48h for bot messages;
   * iMessage 2 minutes, which is Apple's limit. Visibility differs too —
   * Telegram deletion is silent, while iMessage shows recipients a "message
   * was unsent" notice.
   *
   * The iMessage implementation needs the imsg IMCore bridge (`imsg launch`)
   * for this; unlike edit it is not blocked on macOS 26.
   */
  unsendMessage?(chatId: string, messageId: string): Promise<void>;

  /**
   * Recently seen messages in a chat, newest first (bounded window), if the
   * channel tracks them. Backs substring targeting for reactions
   * (react_to_message `match`) and threaded replies (send_message `reply_to`).
   */
  recentMessages?(chatId: string): RecentChatMessage[];

  /** Show typing indicator. Returns a stop function. */
  startTyping(chatId: string): StopTyping;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;
}
