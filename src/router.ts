import type { ReplyTarget } from "./sessions/types.js";
import type { SessionStore } from "./sessions/store.js";
import { extractImessageIdentifier, isGroupSessionKey, legacySessionKeysForBinding } from "./sessions/keys.js";
import { SummonStore } from "./sessions/summon-store.js";
import { log } from "./logger.js";
import { isOwnerHandle, ownerBindings, ownerSessionKey, OWNER_CHANNELS, type OwnerConfig } from "./owner.js";

export interface SessionResolution {
  sessionKey: string;
  replyTarget: ReplyTarget;
  /** The owner's name when the message routed to the owner's dm: session. */
  identityName?: string;
}

/**
 * Admission and session routing for a single owner.
 *
 * - Every owner DM, on every channel (and the web UI), routes to ONE session:
 *   `dm:<owner.name lowercased>` — the same key the old single identity used,
 *   so an upgraded install keeps its session untouched.
 * - Admission fails closed: a DM is admitted only from an owner handle; a
 *   group only when it is in the channel's (group) allowlist.
 * - Replies go to the channel the owner last wrote from.
 */
export class OwnerRouter {
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
    private readonly ownerConfig: OwnerConfig | undefined,
    private sessions: SessionStore,
    channelAllowlists: Record<string, string[]>,
    // Groups temporarily routed to the owner's dm: session via /summon, keyed
    // by raw "<channel>:<chatId>". Defaults to in-memory (tests).
    private summons: SummonStore = new SummonStore(null),
  ) {
    // Group allowlists. DM entries are kept in the set but never consulted:
    // only the owner's DMs are answered (see isAllowed).
    this.allowlists = {};
    for (const [ch, list] of Object.entries(channelAllowlists)) {
      this.allowlists[ch] = new Set(list);
    }
  }

  /** The configured owner, if any. */
  owner(): OwnerConfig | undefined {
    return this.ownerConfig;
  }

  /** The owner's session key (`dm:<name>`), or undefined with no owner. */
  ownerSessionKey(): string | undefined {
    return this.ownerConfig ? ownerSessionKey(this.ownerConfig) : undefined;
  }

  /** True when this channel has an explicit (group) allowlist in config. */
  hasAllowlist(channelName: string): boolean {
    return this.allowlists[channelName] !== undefined;
  }

  /**
   * Admission for an inbound (channel, chatId). FAILS CLOSED:
   *
   * - **DM** (not a group key): only from one of the owner's handles on this
   *   channel. DM entries in a channel allowlist are ignored — there are no
   *   guest DMs (they used to get their own session with owner-grade tools).
   * - **Group**: only when listed in the channel's allowlist (the group
   *   secret adds it). No allowlist = no active groups.
   * - **web**: only the authenticated owner pseudo-chat, with an owner.
   */
  isAllowed(channelName: string, chatId: string): boolean {
    if (channelName === "web") return chatId === "owner" && this.ownerConfig !== undefined;
    if (isGroupSessionKey(`${channelName}:${chatId}`)) {
      const allowlist = this.allowlists[channelName];
      if (!allowlist) return false;
      if (allowlist.has(chatId)) return true;
      // iMessage: a bare group identifier ("chat123…") matches the group under
      // any service prefix, as before.
      if (channelName === "imessage") {
        const identifier = extractImessageIdentifier(chatId);
        if (identifier && allowlist.has(identifier)) return true;
      }
      return false;
    }
    return isOwnerHandle(this.ownerConfig, channelName, chatId);
  }

  /** Add a chatId to a channel's in-memory allowlist (after persisting to config). */
  addToAllowlist(channelName: string, chatId: string): void {
    let allowlist = this.allowlists[channelName];
    if (!allowlist) {
      allowlist = new Set();
      this.allowlists[channelName] = allowlist;
    }
    allowlist.add(chatId);
  }

  /** True when the owner has a handle bound on this channel. */
  hasBoundOwner(channelName: string): boolean {
    return ownerBindings(this.ownerConfig, channelName).length > 0;
  }

  /** Is this sender the owner on this channel? FAILS CLOSED (no owner → false).
   *  The single check behind /login, /usage, /mcp, /model, /restore, /rewind,
   *  /summon and the pasted-OAuth-callback path. */
  isOwnerSender(channelName: string, senderId: string | undefined): boolean {
    return isOwnerHandle(this.ownerConfig, channelName, senderId);
  }

  /** Mark a group as summoned: its messages route to the owner's dm: session until dismissed. */
  summonGroup(channelName: string, chatId: string): void {
    if (!this.ownerConfig) return;
    // The store keeps the lowercased owner name — the same value it always
    // held for an identity, so a summon persisted before the upgrade resolves.
    this.summons.set(`${channelName}:${chatId}`, this.ownerConfig.name.toLowerCase());
    log.info({ channel: channelName, chatId }, "Group summoned to main session");
  }

  /** Hand a summoned group back to its own session. Returns false if it wasn't summoned. */
  dismissGroup(channelName: string, chatId: string): boolean {
    const dismissed = this.summons.delete(`${channelName}:${chatId}`);
    if (dismissed) log.info({ channel: channelName, chatId }, "Group dismissed back to group session");
    return dismissed;
  }

  /** The (lowercased) name whose main session currently owns this group, if summoned. */
  getSummonedIdentity(channelName: string, chatId: string): string | undefined {
    return this.resolveSummon(channelName, chatId, false);
  }

  /** Active summon for a group, handling lazy inactivity expiry.
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
    const owner = this.ownerConfig;
    if (channelName === "web") {
      if (!owner || chatId !== "owner" || isGroup) throw new Error("Web messages require the configured owner DM");
      return {
        sessionKey: this.maybeMigrate(owner),
        replyTarget: { channelName: "web", chatId: "owner" },
        identityName: owner.name,
      };
    }
    // Group chats: always separate sessions — unless summoned, in which case
    // the turn runs on the owner's dm: session. The reply target stays the
    // owner's PRIVATE DM: direct turn output is a side-note to the owner (or
    // NO_REPLY), and group-facing replies happen only via an explicit
    // send_message tool call. Nothing auto-posts to the group.
    if (isGroup) {
      const summoned = this.resolveSummon(channelName, chatId, true);
      if (summoned) {
        const isOwners = owner !== undefined && summoned === owner.name.toLowerCase();
        const replyTarget = isOwners
          ? this.sessions.getReplyTarget(ownerSessionKey(owner)) ?? this.deriveReplyTargetFromConfig(summoned)
          : undefined;
        if (isOwners && replyTarget) {
          // /summon may be the owner's first interaction after an upgrade —
          // run the same one-time adoption as the DM path, or the summon would
          // capture a fresh empty dm: session.
          return { sessionKey: this.maybeMigrate(owner), replyTarget, identityName: summoned };
        }
        // Stale summon: it names someone who is no longer the owner, or the
        // owner has no private DM target. Falling back to the group would
        // route dm-session output (which the prompt promises is private) into
        // the group — drop the summon and route to the group's own session.
        this.summons.delete(`${channelName}:${chatId}`);
        log.warn({ channel: channelName, chatId, identity: summoned }, "Dropped stale summon: no owner private reply target for it");
      }
      return {
        sessionKey: `${channelName}:${chatId}`,
        replyTarget: { channelName, chatId },
      };
    }

    if (!owner || !isOwnerHandle(owner, channelName, chatId)) {
      // Not reachable through the gates (isAllowed refuses non-owner DMs);
      // kept total so a caller that skips admission still gets a raw key
      // rather than the owner's session.
      return {
        sessionKey: `${channelName}:${chatId}`,
        replyTarget: { channelName, chatId },
      };
    }

    const sessionKey = ownerSessionKey(owner);
    // One-time adoption of a legacy per-channel session (see maybeMigrate).
    // If the adoption cannot be persisted right now, this is the legacy key:
    // the message still reaches its conversation, and it is retried later.
    const routedKey = this.maybeMigrate(owner);
    // Replies follow the owner: the channel they last wrote from.
    const replyTarget: ReplyTarget = { channelName, chatId };
    this.sessions.setReplyTarget(sessionKey, replyTarget);
    return { sessionKey: routedKey, replyTarget, identityName: owner.name };
  }

  /** Get the current reply target for a session key (used by cron/continuity) */
  getReplyTarget(sessionKey: string): ReplyTarget | undefined {
    return this.sessions.getReplyTarget(sessionKey);
  }

  /**
   * Read-only fallback reply target for the owner's dm: session when it has
   * no persisted one yet (a cron fires before the owner ever wrote): the
   * owner's first Telegram id, else first iMessage handle. Undefined for any
   * name that is not the owner. Does not touch the session registry.
   */
  deriveReplyTargetFromConfig(identityName: string): ReplyTarget | undefined {
    const owner = this.ownerConfig;
    if (!owner || owner.name.toLowerCase() !== identityName.toLowerCase()) return undefined;
    for (const channelName of OWNER_CHANNELS) {
      const first = ownerBindings(owner, channelName)[0];
      if (first) return { channelName, chatId: first };
    }
    return undefined;
  }

  /**
   * Run the one-time legacy adoption now and make sure the owner's session
   * entry exists, so every channel added later binds to that one session.
   * Called once at daemon start. Writes nothing when the owner already has a
   * linked session (the common, upgraded case) — not even a timestamp.
   */
  prepareOwnerSession(): string | undefined {
    const owner = this.ownerConfig;
    if (!owner) return undefined;
    const key = ownerSessionKey(owner);
    if (this.sessions.getSdkSessionId(key)) return key;
    const routed = this.maybeMigrate(owner);
    if (routed !== key) return routed;
    try {
      this.sessions.ensureEntry(key);
    } catch (err) {
      log.warn({ err, key }, "Could not pre-create the owner session entry; it is created on the first message instead");
    }
    return key;
  }

  /**
   * One-time adoption of a legacy channel-scoped session into the owner's
   * `dm:` key. Returns the key the message should be routed to: the owner key,
   * or — when an adoption was due but could not be persisted — the legacy key.
   *
   * Adoption happens ONLY while the owner key has no SDK session: once it has
   * one, nothing is ever re-keyed into it, so it cannot fork. With more than
   * one candidate nothing is guessed. A metadata-only stub under the owner key
   * (the entry pre-created at init/first start) is folded into the adopted
   * entry by the store, so there is never a second active owner entry.
   *
   * Best-effort on purpose: this runs on the inbound path, and
   * `migrateSessionKey` refuses with `SessionRegistryReadError` while the
   * registry file cannot be read. Routing to the legacy key keeps the
   * conversation reachable; falling through to the owner key would cold-start
   * a `dm:` session and block the adoption forever.
   */
  private maybeMigrate(owner: OwnerConfig): string {
    const sessionKey = ownerSessionKey(owner);
    if (this.sessions.getSdkSessionId(sessionKey)) return sessionKey;

    // Matched against the live registry rather than rebuilt from the config
    // value: an iMessage binding is a handle ("+15551234567") while the
    // session it routed to is keyed by chat GUID ("imessage:any;-;+1555…").
    const activeKeys = this.sessions.listSdkSessionIds().map(([key]) => key);
    const candidates = new Set<string>();
    for (const channelName of OWNER_CHANNELS) {
      for (const bound of ownerBindings(owner, channelName)) {
        for (const key of legacySessionKeysForBinding(activeKeys, channelName, bound)) candidates.add(key);
      }
    }
    const list = [...candidates];
    if (list.length === 0) return sessionKey;

    if (list.length === 1) {
      try {
        this.sessions.migrateSessionKey(list[0], sessionKey);
      } catch (err) {
        log.warn(
          { err, from: list[0], to: sessionKey },
          "Session adoption could not be persisted; routing to the existing channel-scoped session and retrying on the next message",
        );
        return list[0];
      }
      log.info({ from: list[0], to: sessionKey }, "Adopted the owner's earlier per-channel session");
      return sessionKey;
    }

    log.warn(
      { candidates: list, ownerKey: sessionKey },
      "Several earlier per-channel sessions belong to the owner; refusing to guess which to adopt. They stay on disk and searchable; the owner session starts fresh.",
    );
    return sessionKey;
  }
}
