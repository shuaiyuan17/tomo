import type { ReplyTarget } from "./types.js";

export interface ParsedSessionKey {
  channelName: string;
  chatId: string;
}

export function isDmSessionKey(key: string): boolean {
  return key.startsWith("dm:");
}

/** Canonical dm key: `dm:` + a slug. Deliberately narrow — see below. */
const CANONICAL_DM_KEY_RE = /^dm:[a-z0-9_-]+$/;

/**
 * Strict form of `isDmSessionKey` for decisions where a `dm:` prefix grants
 * *authority* rather than just routing — a caller that may administer another
 * session's records, for instance (see `canManageJob`).
 *
 * `isDmSessionKey` itself stays a prefix test on purpose. Identity names are
 * only validated as a non-empty string (`identitySchema` in src/config.ts) and
 * `dmSessionKeyForIdentity` merely lowercases them, so a live install can
 * legitimately hold `dm:shuai yuan`. Tightening the shared predicate would
 * silently reclassify that session everywhere it decides routing, audience,
 * summon handling and private-record visibility — a much larger blast radius
 * than the check it would harden. So the strict test is opt-in, and callers
 * that use it must fail CLOSED (deny the extra authority) rather than treat a
 * non-canonical key as "not a DM".
 */
export function isCanonicalDmSessionKey(key: string): boolean {
  return CANONICAL_DM_KEY_RE.test(key.trim().toLowerCase());
}

export function dmIdentityFromSessionKey(key: string): string | undefined {
  return isDmSessionKey(key) ? key.slice(3) : undefined;
}

export function dmSessionKeyForIdentity(identityName: string): string {
  return `dm:${identityName.toLowerCase()}`;
}

/** Parse a raw "<channel>:<chatId>" session key. Returns undefined for dm: keys. */
export function parseRawSessionKey(key: string): ParsedSessionKey | undefined {
  if (isDmSessionKey(key)) return undefined;
  const colonIdx = key.indexOf(":");
  if (colonIdx < 0) return undefined;
  const channelName = key.slice(0, colonIdx);
  const chatId = key.slice(colonIdx + 1);
  if (!channelName || !chatId) return undefined;
  return { channelName, chatId };
}

/** Build a ReplyTarget from any explicit raw session key, including groups. */
export function replyTargetFromRawSessionKey(key: string): ReplyTarget | undefined {
  const parsed = parseRawSessionKey(key);
  return parsed ? { channelName: parsed.channelName, chatId: parsed.chatId } : undefined;
}

/**
 * Build a ReplyTarget for private notification fallback paths.
 * Group chats are deliberately excluded.
 */
export function privateReplyTargetFromSessionKey(key: string): ReplyTarget | undefined {
  const parsed = parseRawSessionKey(key);
  if (!parsed) return undefined;
  if (isGroupSessionKey(key)) return undefined;
  return { channelName: parsed.channelName, chatId: parsed.chatId };
}

/**
 * Does a raw chatId belong to an identity's binding for that channel?
 * Exact match, plus iMessage chat GUIDs matched by their identifier: config
 * binds the handle ("+15551234567") while the provider keys sessions by chat
 * GUID ("any;-;+15551234567"). Every place that compares a configured binding
 * against a live chatId (inbound routing, send_message targets, session
 * migration) must use this — a bare `===` silently misses iMessage.
 */
export function matchesChannelBinding(channelName: string, chatId: string, bound: string | undefined): boolean {
  if (bound === undefined) return false;
  if (bound === chatId) return true;
  if (channelName === "imessage") {
    const identifier = extractImessageIdentifier(chatId);
    if (identifier !== null && identifier === bound) return true;
  }
  return false;
}

/**
 * The raw `<channel>:<chatId>` session keys among `keys` that an identity's
 * (channel, binding) pair would have routed to before the identity existed —
 * the legacy per-channel sessions a new `dm:` session should adopt. Groups
 * are never candidates.
 */
export function legacySessionKeysForBinding(keys: Iterable<string>, channelName: string, bound: string): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const parsed = parseRawSessionKey(key);
    if (!parsed || parsed.channelName !== channelName) continue;
    if (isGroupSessionKey(key)) continue;
    if (matchesChannelBinding(channelName, parsed.chatId, bound)) out.push(key);
  }
  return out;
}

/** The slice of a registry entry `rawSessionKeyForBinding` reads. */
export interface BindingEvidence {
  channelKey: string;
  /** `null` (or absent) for the active entry; retired copies carry a timestamp. */
  unlinkedAt?: number | null;
  migratedFrom?: string;
  replyTarget?: ReplyTarget;
}

/**
 * The raw session key to hand a `dm:` session's cron jobs back to when the
 * identity is removed — the key inbound traffic for that binding actually
 * uses. For Telegram that is the literal `<channel>:<binding>`; for iMessage
 * it is GUID-shaped and cannot be rebuilt from the configured handle (the
 * service prefix varies), so it is recovered from what the registry
 * remembers. Evidence belonging to the identity's OWN entries (`ownerKey`,
 * its `dm:` key) is trusted first: a binding removed from one identity and
 * reused under another leaves the old `dm:` entry in the registry, and its
 * GUID may not be the one the newer session has been replying to. Within
 * the owner, the LIVE routing state outranks history: the conversation can
 * move between GUIDs for the same handle (SMS ↔ iMessage), and the router
 * keeps `replyTarget` current while `migratedFrom` only says where the
 * session came from. In order:
 *
 * 1. The owner's ACTIVE entry's persisted `replyTarget` for that channel when
 *    it is a concrete chat id (GUID-shaped, not the bare configured handle)
 *    matching the binding — the GUID the router last routed a reply to.
 * 2. The owner entries' `migratedFrom` — the raw key the unified session was
 *    re-keyed from (the common one-candidate migration leaves no raw entry
 *    behind, only this). Active entry first, then retired copies.
 * 3. Retired owner copies' concrete `replyTarget`, when the active entry
 *    has none.
 * 4. The same, from any other entry in the registry.
 * 5. A raw entry still in the registry matching the binding (linked or not).
 * 6. The literal `<channel>:<binding>` form, when no conversation with that
 *    binding was ever seen.
 */
export function rawSessionKeyForBinding(
  channelName: string,
  bound: string,
  entries: Iterable<BindingEvidence>,
  ownerKey?: string,
): string {
  const all = [...entries];
  const owned = ownerKey ? all.filter((e) => e.channelKey === ownerKey) : [];
  const others = ownerKey ? all.filter((e) => e.channelKey !== ownerKey) : all;
  const isActive = (e: BindingEvidence) => e.unlinkedAt === null || e.unlinkedAt === undefined;

  // A reply target that names a real conversation (not the bare handle the
  // config binds — that is only ever the literal fallback) for this binding.
  const concreteReplyKey = (e: BindingEvidence): string | undefined => {
    const t = e.replyTarget;
    if (!t || t.channelName !== channelName || t.chatId === bound) return undefined;
    const key = `${channelName}:${t.chatId}`;
    return !isGroupSessionKey(key) && matchesChannelBinding(channelName, t.chatId, bound) ? key : undefined;
  };
  const migratedKey = (group: BindingEvidence[]): string | undefined => legacySessionKeysForBinding(
    group.map((e) => e.migratedFrom).filter((k): k is string => typeof k === "string"),
    channelName,
    bound,
  )[0];
  const firstReplyKey = (group: BindingEvidence[]): string | undefined => {
    for (const e of group) {
      const key = concreteReplyKey(e);
      if (key) return key;
    }
    return undefined;
  };

  for (const group of [owned, others]) {
    const active = group.filter(isActive);
    const retired = group.filter((e) => !isActive(e));
    const found = firstReplyKey(active)
      ?? migratedKey(active)
      ?? migratedKey(retired)
      ?? firstReplyKey(retired);
    if (found) return found;
  }

  return legacySessionKeysForBinding(all.map((e) => e.channelKey), channelName, bound)[0]
    ?? `${channelName}:${bound}`;
}

/** Extract the identifier from an iMessage chat GUID (e.g. "any;-;+15551234567" → "+15551234567") */
export function extractImessageIdentifier(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length >= 3) return parts.slice(2).join(";");
  return null;
}

/**
 * Identifies provider group session keys. Groups use raw channel keys rather
 * than dm:<identity> keys so their context stays isolated.
 */
export function isGroupSessionKey(key: string): boolean {
  const parsed = parseRawSessionKey(key);
  if (!parsed) return false;
  if (parsed.channelName === "telegram" && parsed.chatId.startsWith("-")) return true;
  if (parsed.channelName === "imessage" && parsed.chatId.includes(";+;")) return true;
  return false;
}
