export interface ImageAttachment {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g. "image/jpeg", "image/png") */
  mediaType: string;
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
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
export type CommandHandler = (command: string, chatId: string, senderName: string) => Promise<void>;

export interface Channel {
  /** Channel identifier (e.g. "telegram", "imessage") */
  readonly name: string;

  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void;

  /** Register a handler for slash commands */
  onCommand(handler: CommandHandler): void;

  /** Send a message through this channel */
  send(message: OutgoingMessage): Promise<void>;

  /** Show typing indicator. Returns a stop function. */
  startTyping(chatId: string): () => void;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;
}
