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
    // Add identity-bound chatIds to existing allowlists (don't create new ones —
    // an identity alone should not enable allowlist enforcement for a channel)
    for (const id of identities) {
      for (const [ch, chatId] of Object.entries(id.channels)) {
        if (this.allowlists[ch]) {
          this.allowlists[ch].add(chatId);
        }
      }
    }
  }

  /** Check if a chatId is allowed on a channel. Returns true if no allowlist is configured (open). */
  isAllowed(channelName: string, chatId: string): boolean {
    const allowlist = this.allowlists[channelName];
    if (!allowlist) return true; // No allowlist → open
    if (allowlist.has(chatId)) return true;
    // iMessage: match by identifier suffix (e.g. "+15551234567" matches "any;-;+15551234567")
    if (channelName === "imessage") {
      const identifier = extractImessageIdentifier(chatId);
      if (identifier && allowlist.has(identifier)) return true;
    }
    return false;
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

    const sessionKey = `dm:${identity.name.toLowerCase()}`;

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

  /**
   * Read-only derivation of a reply target from identity config + replyPolicy.
   * Used as a fallback when a dm:<identity> session has no persisted replyTarget yet
   * (e.g. cron fires before the identity has ever received a message). Does not
   * touch the session registry.
   */
  deriveReplyTargetFromConfig(identityName: string): ReplyTarget | undefined {
    const identity = this.identities.find(
      (id) => id.name.toLowerCase() === identityName.toLowerCase(),
    );
    if (!identity) return undefined;

    const channelNames = Object.keys(identity.channels);
    if (channelNames.length === 0) return undefined;

    // Fixed channel policy: use the configured channel if set
    if (identity.replyPolicy !== "last-active") {
      const fixedChatId = identity.channels[identity.replyPolicy];
      if (fixedChatId) {
        return { channelName: identity.replyPolicy, chatId: fixedChatId };
      }
    }

    // last-active (or invalid fixed policy): fall back to the first bound channel
    const first = channelNames[0];
    return { channelName: first, chatId: identity.channels[first] };
  }

  /** Find the first active dm: session key (for continuity) */
  findFirstDmSession(): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (key.startsWith("dm:")) return key;
    }
    return undefined;
  }

  private findIdentity(channelName: string, chatId: string): IdentityConfig | undefined {
    return this.identities.find((id) => {
      const configured = id.channels[channelName];
      if (!configured) return false;
      if (configured === chatId) return true;
      // iMessage: match by identifier (e.g. config has "+15551234567", chatId is "any;-;+15551234567")
      if (channelName === "imessage") {
        const identifier = extractImessageIdentifier(chatId);
        if (identifier && identifier === configured) return true;
      }
      return false;
    });
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

    // Collect all old channel-specific keys that have an active session
    const candidates: string[] = [];
    for (const [chName, chId] of Object.entries(identity.channels)) {
      const oldKey = `${chName}:${chId}`;
      if (this.sessions.getSdkSessionId(oldKey)) candidates.push(oldKey);
    }

    if (candidates.length === 0) return;

    if (candidates.length === 1) {
      this.sessions.migrateSessionKey(candidates[0], sessionKey);
      log.info({ identity: identity.name, from: candidates[0], to: sessionKey }, "Migrated session to unified identity");
      return;
    }

    // Ambiguous: multiple bound channels already have sessions. Don't silently
    // pick one — the config TUI resolves this interactively. Start fresh here.
    log.warn(
      { identity: identity.name, candidates, unifiedKey: sessionKey },
      "Multiple existing sessions found for identity; refusing to auto-migrate. Run `tomo config` → Identities to choose which session to keep.",
    );
  }
}

/** Extract the identifier from an iMessage chat GUID (e.g. "any;-;+15551234567" → "+15551234567") */
function extractImessageIdentifier(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length >= 3) return parts.slice(2).join(";");
  return null;
}
