export interface ImageAttachment {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g. "image/jpeg", "image/png") */
  mediaType: string;
  /** Absolute path on disk if the channel persisted the image (saveInboundImages). */
  savedPath?: string;
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
  /** Provider-specific draft/preview id for ephemeral streaming, if supported. */
  streamingDraftId?: number;
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
  /** Optional: Telegram sticker file_id to send */
  sticker?: string;
}

export type MessageReaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
export interface StopTypingOptions {
  /** Clear the remote typing indicator immediately when the channel supports it. */
  clear?: boolean;
}

export type StopTyping = (options?: StopTypingOptions) => void | Promise<void>;

export interface StreamingMessage {
  /** Append text to the streaming message */
  update(text: string): void;
  /** Finalize the message (flush remaining content) */
  finish(): Promise<void>;
  /**
   * Cancel the streaming message. If a message has already been sent
   * (e.g. via Telegram's incremental edit flow), it is deleted. Implementations
   * that buffer until finish (e.g. iMessage) can no-op.
   */
  cancel(): Promise<void>;
  /**
   * Seal the current text block and reset state for the next block in the
   * same turn. Called between text blocks of a multi-block assistant turn
   * (text → tool → text). Channels that ship text per block (Telegram,
   * iMessage) finalize the in-flight message and start fresh on the next
   * `update()`. No-op when nothing has been buffered.
   */
  commitBlock(): Promise<void>;
}

export interface StreamingMessageOptions {
  /** Provider-specific draft/preview id for ephemeral streaming, if supported. */
  draftId?: number;
}

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

  /** Send a message through this channel */
  send(message: OutgoingMessage): Promise<void>;

  /** Rename a group chat/conversation, if supported by the channel. */
  setChatTitle?(chatId: string, title: string): Promise<void>;

  /** React/tapback to a specific provider message, if supported by the channel. */
  reactToMessage?(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean): Promise<void>;

  /** Create a streaming message that can be updated incrementally */
  createStreamingMessage(chatId: string, replyTo?: string, options?: StreamingMessageOptions): StreamingMessage;

  /** Show typing indicator. Returns a stop function. */
  startTyping(chatId: string): StopTyping;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;
}
