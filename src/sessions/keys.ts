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
