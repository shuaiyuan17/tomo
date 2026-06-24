import type { IdentityConfig } from "./config.js";
import type { ReplyTarget } from "./sessions/types.js";
import type { SessionStore } from "./sessions/store.js";
import { SummonStore } from "./sessions/summon-store.js";
import { log } from "./logger.js";

export interface SessionResolution {
  sessionKey: string;
  replyTarget: ReplyTarget;
  identityName?: string;
}

export class IdentityRouter {
  private allowlists: Record<string, Set<string>>;
  /** Notified when a summon lapses from group inactivity, so the dm: session's
   *  "summoned" context can be cleared. Fires at most once per lapsed summon
   *  (the store drops the entry on first detection). `notifyGroup` is true only
   *  when the lapse is detected while routing a real group message — that's the
   *  one path that should also post the group-facing "handed back" notice.
   *  Guard reads (`/summon`, `/status`, `/dismiss`) pass false: they still need
   *  the dm-side state update, but must not emit a group message. */
  onSummonExpired?: (channelName: string, chatId: string, identityName: string, notifyGroup: boolean) => void;

  constructor(
    private identities: IdentityConfig[],
    private sessions: SessionStore,
    channelAllowlists: Record<string, string[]>,
    // Groups temporarily routed to a dm:<identity> session via /summon,
    // keyed by raw "<channel>:<chatId>". Defaults to in-memory (tests).
    private summons: SummonStore = new SummonStore(null),
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

  /** Mark a group as summoned: its messages route to the identity's dm: session until dismissed. */
  summonGroup(channelName: string, chatId: string, identityName: string): void {
    this.summons.set(`${channelName}:${chatId}`, identityName.toLowerCase());
    log.info({ channel: channelName, chatId, identity: identityName }, "Group summoned to main session");
  }

  /** Hand a summoned group back to its own session. Returns false if it wasn't summoned. */
  dismissGroup(channelName: string, chatId: string): boolean {
    const dismissed = this.summons.delete(`${channelName}:${chatId}`);
    if (dismissed) log.info({ channel: channelName, chatId }, "Group dismissed back to group session");
    return dismissed;
  }

  /** The identity (lowercased) whose main session currently owns this group, if summoned. */
  getSummonedIdentity(channelName: string, chatId: string): string | undefined {
    return this.resolveSummon(channelName, chatId, false);
  }

  /** Find the identity bound to a sender's id on a channel (owner check for /summon). */
  identityForSender(channelName: string, senderId: string): IdentityConfig | undefined {
    return this.findIdentity(channelName, senderId);
  }

  /** Active summoned identity for a group, handling lazy inactivity expiry.
   *  `touch` resets the expiry clock and marks this as real group traffic —
   *  pass true only when routing an actual group message. On lapse the store
   *  drops the entry and `onSummonExpired` always fires so the dm: session's
   *  stale "summoned" context gets cleared; the group-facing handback notice,
   *  though, only goes out on the routing path (`notifyGroup` = `touch`), so a
   *  guard read from `/summon`/`/status`/`/dismiss` never emits a spurious
   *  "expired — handed back" message to the group. */
  private resolveSummon(channelName: string, chatId: string, touch: boolean): string | undefined {
    const rawKey = `${channelName}:${chatId}`;
    const { entry, expired } = this.summons.get(rawKey);
    if (expired) {
      log.info({ channel: channelName, chatId, identity: expired.identity }, "Summon expired after inactivity");
      this.onSummonExpired?.(channelName, chatId, expired.identity, touch);
      return undefined;
    }
    if (!entry) return undefined;
    if (touch) this.summons.touch(rawKey);
    return entry.identity;
  }

  /** Resolve a (channel, chatId, isGroup) to a session key and reply target */
  resolve(channelName: string, chatId: string, isGroup: boolean): SessionResolution {
    // Group chats: always separate sessions — unless summoned, in which case
    // the turn runs on the unified dm: session. The reply target stays the
    // identity's PRIVATE DM: direct turn output is a side-note to the owner
    // (or NO_REPLY), and group-facing replies happen only via an explicit
    // send_message tool call. Nothing auto-posts to the group.
    if (isGroup) {
      const summoned = this.resolveSummon(channelName, chatId, true);
      if (summoned) {
        const dmKey = `dm:${summoned}`;
        // /summon may be the identity's first interaction after upgrading to
        // unified dm: keys — run the same one-time migration as the DM path,
        // or the summon would capture a fresh empty dm: session and block the
        // old channel-scoped session from ever migrating.
        const identity = this.identities.find((id) => id.name.toLowerCase() === summoned);
        if (identity) this.maybeMigrate(identity, dmKey);
        const replyTarget = this.sessions.getReplyTarget(dmKey)
          ?? this.deriveReplyTargetFromConfig(summoned);
        if (replyTarget) {
          return { sessionKey: dmKey, replyTarget, identityName: summoned };
        }
        // Stale summon: the identity was renamed/removed since summons.json
        // was written, so there is no private DM target. Falling back to the
        // group would route dm-session output (which the prompt promises is
        // private) into the group — drop the summon instead and route the
        // message to the group's own session.
        this.summons.delete(`${channelName}:${chatId}`);
        log.warn(
          { channel: channelName, chatId, identity: summoned },
          "Dropped stale summon: no private reply target for identity",
        );
      }
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
