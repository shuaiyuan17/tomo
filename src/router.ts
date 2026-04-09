import type { IdentityConfig } from "./config.js";
import type { ReplyTarget } from "./sessions/types.js";
import type { SessionStore } from "./sessions/store.js";
import { log } from "./logger.js";

export interface SessionResolution {
  sessionKey: string;
  replyTarget: ReplyTarget;
  identityName?: string;
}

export class IdentityRouter {
  private allowlists: Record<string, Set<string>>;

  constructor(
    private identities: IdentityConfig[],
    private sessions: SessionStore,
    channelAllowlists: Record<string, string[]>,
  ) {
    // Build fast lookup sets: explicit allowlist + all identity-bound chatIds per channel
    this.allowlists = {};
    for (const [ch, list] of Object.entries(channelAllowlists)) {
      this.allowlists[ch] = new Set(list);
    }
    // Add identity-bound chatIds to each channel's allowlist
    for (const id of identities) {
      for (const [ch, chatId] of Object.entries(id.channels)) {
        if (!this.allowlists[ch]) this.allowlists[ch] = new Set();
        this.allowlists[ch].add(chatId);
      }
    }
  }

  /** Check if a chatId is allowed on a channel. Returns true if no allowlist is configured (open). */
  isAllowed(channelName: string, chatId: string): boolean {
    const allowlist = this.allowlists[channelName];
    if (!allowlist) return true; // No allowlist → open
    return allowlist.has(chatId);
  }

  /** Add a chatId to a channel's in-memory allowlist (after persisting to config) */
  addToAllowlist(channelName: string, chatId: string): void {
    if (!this.allowlists[channelName]) this.allowlists[channelName] = new Set();
    this.allowlists[channelName].add(chatId);
  }

  /** Resolve a (channel, chatId, isGroup) to a session key and reply target */
  resolve(channelName: string, chatId: string, isGroup: boolean): SessionResolution {
    // Group chats: always separate sessions
    if (isGroup) {
      return {
        sessionKey: `${channelName}:${chatId}`,
        replyTarget: { channelName, chatId },
      };
    }

    // Find identity matching this channel + chatId
    const identity = this.findIdentity(channelName, chatId);
    if (!identity) {
      return {
        sessionKey: `${channelName}:${chatId}`,
        replyTarget: { channelName, chatId },
      };
    }

    const sessionKey = `dm:${identity.name}`;

    // Migrate from old channel-scoped key if needed (one-time)
    this.maybeMigrate(identity, sessionKey);

    // Determine reply target based on policy
    const replyTarget = this.resolveReplyTarget(identity, channelName, chatId);

    // Persist updated reply target
    this.sessions.setReplyTarget(sessionKey, replyTarget);

    return { sessionKey, replyTarget, identityName: identity.name };
  }

  /** Get the current reply target for a session key (used by cron/continuity) */
  getReplyTarget(sessionKey: string): ReplyTarget | undefined {
    return this.sessions.getReplyTarget(sessionKey);
  }

  /** Find the first active dm: session key (for continuity) */
  findFirstDmSession(): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (key.startsWith("dm:")) return key;
    }
    return undefined;
  }

  private findIdentity(channelName: string, chatId: string): IdentityConfig | undefined {
    return this.identities.find((id) => id.channels[channelName] === chatId);
  }

  private resolveReplyTarget(
    identity: IdentityConfig,
    channelName: string,
    chatId: string,
  ): ReplyTarget {
    if (identity.replyPolicy === "last-active") {
      return { channelName, chatId };
    }

    // Fixed channel policy: always reply on the configured channel
    const fixedChannel = identity.replyPolicy;
    const fixedChatId = identity.channels[fixedChannel];
    if (fixedChatId) {
      return { channelName: fixedChannel, chatId: fixedChatId };
    }

    // Fallback to current channel if configured default is invalid
    return { channelName, chatId };
  }

  private maybeMigrate(identity: IdentityConfig, sessionKey: string): void {
    // Already has a session under the unified key
    if (this.sessions.getSdkSessionId(sessionKey)) return;

    // Check if any old channel-specific key has an active session
    for (const [chName, chId] of Object.entries(identity.channels)) {
      const oldKey = `${chName}:${chId}`;
      if (this.sessions.getSdkSessionId(oldKey)) {
        this.sessions.migrateSessionKey(oldKey, sessionKey);
        log.info({ identity: identity.name, from: oldKey, to: sessionKey }, "Migrated session to unified identity");
        return;
      }
    }
  }
}
