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
  /**
   * True when this image arrived as HEIC and the `sips` conversion failed —
   * including the case it was killed at its deadline. `data` then holds the
   * ORIGINAL (probably undisplayable) bytes, so the channel appends a note to
   * the inline marker rather than handing the agent an invisible image.
   */
  conversionFailed?: boolean;
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
/**
 * PROVABLY UNDELIVERED. A send can fail in two very different ways, and the
 * difference decides whether the caller may try again by another route.
 *
 *  - DEFINITE: the channel can prove nothing reached the owner — the file
 *    could not even be read, or the provider answered and the answer was no
 *    (a Bot API error response, an imsg RPC error response). Retrying the
 *    text by another route is safe.
 *  - AMBIGUOUS: a timeout, a dead child, a dropped connection. The message
 *    may already be on the phone; a retry is the duplicate both channels
 *    already refuse to risk on their own fallbacks.
 *
 * Channels attach this marker to the errors they can vouch for; the delivery
 * pipeline (`provablyUndelivered`) reads it to decide whether a caption whose
 * picture failed may go out as text. Anything unmarked is ambiguous. A
 * registered symbol, so the marker survives a module-graph reset (tests) and
 * never depends on `instanceof` across bundles.
 */
const DEFINITE_FAILURE = Symbol.for("tomo.channel.definiteSendFailure");

/** Mark `err` as a failure the channel can prove delivered nothing. */
export function markDefiniteFailure<T>(err: T): T {
  if (err !== null && typeof err === "object") {
    Object.defineProperty(err, DEFINITE_FAILURE, { value: true, enumerable: false });
  }
  return err;
}

/** Was `err` marked by a channel as provably undelivered? (Does not walk causes.) */
export function isDefiniteFailure(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as Record<symbol, unknown>)[DEFINITE_FAILURE] === true;
}

/**
 * Thrown by a channel that found an attachment file unreadable BEFORE any
 * request went out. Definite by construction (see `markDefiniteFailure`).
 */
export class AttachmentUnreadableError extends Error {
  readonly code = "ENOENT";
  /** `message` overrides the default for a value that is unreadable for a
   *  reason other than "not on disk" — a channel-bound sticker id handed to
   *  a channel that can only send files, say, where "Attachment file not
   *  found: CAACAgQ…" reads as a missing path and sends the reader hunting
   *  for a file that was never named. */
  constructor(readonly path: string, message?: string) {
    super(message ?? `Attachment file not found: ${path}`);
    this.name = "AttachmentUnreadableError";
    markDefiniteFailure(this);
  }
}

/**
 * Thrown by a channel whose captioned-picture send is TWO provider calls
 * (imsg: the attachment, then its caption; Telegram: a photo, then an
 * over-limit caption as text) and failed on the second after the first had
 * resolved. `shipped` says what is known delivered; `failure` is the second
 * call's error, with its own definite/ambiguous character intact.
 */
export class PartialSendError extends Error {
  constructor(readonly failure: unknown, readonly shipped: { photo: boolean }) {
    super(`Send partly delivered: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
    this.name = "PartialSendError";
  }
}

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

/**
 * Inbound hand-off. Resolves to whether the agent ACCEPTED custody of the
 * message — `true` means "it is now the agent's problem: it will be processed,
 * or recorded in the transcript as deliberately not processed". `false` means
 * the agent refused it (shutdown drain already past), so nothing downstream
 * remembers it and the channel must NOT acknowledge it: no dedupe record, no
 * cursor advance. A channel that ignores the answer turns a refusal into a
 * silent drop, which is the exact failure this signature exists to prevent.
 *
 * A throw is a different, harder failure (the hand-off itself broke) and stays
 * a throw — channels treat it as "row not handled" and replay.
 */
export type MessageHandler = (message: IncomingMessage) => Promise<boolean>;
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

  /**
   * Shut the inbound door. SYNCHRONOUS and I/O-free by contract: it may only
   * flip an in-memory flag and clear timers. The Agent calls it on every
   * channel before it does anything else, so "no new work can enter" is true
   * for the whole fleet in one turn of the event loop, with nothing that can
   * stall or reject in between.
   *
   * It refuses only work that has NOT STARTED. Anything already inside the
   * channel's parse path keeps going — see quiesce().
   *
   * Outbound must keep working: the agent is still draining turns whose blocks
   * have to reach the user. Physical teardown belongs in teardown().
   */
  closeIngestion(): void;

  /**
   * Wait for work already inside the parse path (attachment download, HEIC
   * conversion, middleware) to finish handing itself to the agent.
   *
   * This is the half of shutdown that `closeIngestion` cannot cover: a row
   * that passed the entry guard a moment before stop() landed is mid-parse,
   * and neither refusing it later (it may already be acknowledged) nor
   * abandoning it (it is gone) is acceptable. Letting it complete INTO the
   * batcher, before the batcher is drained, is what makes it recoverable.
   *
   * Bounded by the caller, and must not throw for ordinary in-flight failures.
   */
  quiesce(): Promise<void>;

  /**
   * Release the physical resources: kill the child process, end the polling
   * connection, close file handles.
   *
   * Slow and fallible by nature (grammY's final `getUpdates` rides a 500 s
   * client timeout), which is exactly why it is last: nothing durable may wait
   * behind it. After this the channel can no longer send, so it runs only once
   * the agent has finished draining.
   */
  teardown(): Promise<void>;

  /**
   * The whole sequence, for callers shutting one channel down on its own
   * (tests, scripts). `Agent.stop()` does NOT call this — it interleaves the
   * phases across all channels, with the batcher drain and the manager stop
   * sandwiched between quiesce and teardown.
   */
  stop(): Promise<void>;
}
