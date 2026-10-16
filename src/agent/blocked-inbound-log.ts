import { log } from "../logger.js";

/** One line per (channel, chat) per hour: enough for the owner to see why a
 *  chat gets no answer, without letting a spammer flood the log. */
export const BLOCKED_INBOUND_LOG_INTERVAL_MS = 60 * 60_000;
/** Bound on remembered chats, so a flood of distinct senders cannot grow the
 *  map without limit. Oldest entries are evicted first. */
const MAX_TRACKED = 1_000;

/**
 * Only the tail of a chat id goes to the log: enough to recognise your own
 * number or a group, not enough to leak a stranger's full handle into a log
 * file that is often pasted into bug reports.
 */
export function redactChatIdForLog(chatId: string): string {
  const tail = chatId.slice(-4);
  return chatId.length > 4 ? `…${tail}` : tail;
}

/**
 * Rate-limited info log for inbound messages the admission gate refused.
 * The refusal itself is silent toward the sender (no reply, no session, no
 * registry entry); this is the owner-facing trace.
 */
export class BlockedInboundLog {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs = BLOCKED_INBOUND_LOG_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this chat has not been logged within the interval (and records it). */
  shouldLog(channelName: string, chatId: string): boolean {
    const key = `${channelName}:${chatId}`;
    const at = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && at - prev < this.intervalMs) return false;
    this.last.delete(key);
    this.last.set(key, at);
    if (this.last.size > MAX_TRACKED) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return true;
  }

  /** Log a refused inbound message, at most once per chat per interval. */
  record(channelName: string, chatId: string, isGroup: boolean, what = "message"): void {
    if (!this.shouldLog(channelName, chatId)) return;
    const fields = { channel: channelName, chat: redactChatIdForLog(chatId) };
    if (isGroup) {
      log.info(
        fields,
        `Ignored ${what} from a group that is not activated on this channel (no session, no reply). Send the group secret in that group to activate it.`,
      );
    } else {
      log.info(
        fields,
        `Ignored ${what} from a DM sender who is not the owner (no session, no reply). If this is you, bind this handle to your owner identity with \`tomo config\`.`,
      );
    }
  }
}
