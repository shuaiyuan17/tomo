import type { ReplyTarget } from "./types.js";

export interface ParsedSessionKey {
  channelName: string;
  chatId: string;
}

export function isDmSessionKey(key: string): boolean {
  return key.startsWith("dm:");
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
  migratedFrom?: string;
  replyTarget?: ReplyTarget;
}

/**
 * The raw session key to hand a `dm:` session's cron jobs back to when the
 * identity is removed — the key inbound traffic for that binding actually
 * uses. For Telegram that is the literal `<channel>:<binding>`; for iMessage
 * it is GUID-shaped and cannot be rebuilt from the configured handle (the
 * service prefix varies), so it is recovered from what the registry
 * remembers, in order of trust:
 *
 * 1. `migratedFrom` on an entry — the raw key the unified session was
 *    re-keyed from (the common one-candidate migration leaves no raw entry
 *    behind, only this).
 * 2. A persisted `replyTarget` for that channel whose chatId matches the
 *    binding — the live GUID the router last routed a reply to.
 * 3. A raw entry still in the registry matching the binding (linked or not).
 * 4. The literal `<channel>:<binding>` form, when no conversation with that
 *    binding was ever seen.
 */
export function rawSessionKeyForBinding(channelName: string, bound: string, entries: Iterable<BindingEvidence>): string {
  const all = [...entries];
  const migrated = all
    .map((e) => e.migratedFrom)
    .filter((k): k is string => typeof k === "string");
  const fromMigration = legacySessionKeysForBinding(migrated, channelName, bound)[0];
  if (fromMigration) return fromMigration;

  for (const e of all) {
    const t = e.replyTarget;
    if (!t || t.channelName !== channelName) continue;
    const key = `${channelName}:${t.chatId}`;
    if (!isGroupSessionKey(key) && matchesChannelBinding(channelName, t.chatId, bound)) return key;
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
