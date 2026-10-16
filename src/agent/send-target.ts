import { dmSessionKeyForIdentity, isDmSessionKey } from "../sessions/keys.js";
import { isOwnerHandle, ownerSessionKey, type OwnerConfig } from "../owner.js";

/**
 * Pure helpers for `send_message` target resolution. No I/O, no config, no
 * channel imports — safe to import from tests without triggering the rest of
 * the agent's startup graph.
 */

export interface NormalizedSendTarget {
  sessionKey: string;
  identityName?: string;
  /** Set when a raw `<channel>:<chatId>` target was canonicalized to a dm:
   *  key — the caller named a specific channel, so delivery should stay
   *  pinned there even though the record belongs to the dm session. */
  rawReplyTarget?: { channelName: string; chatId: string };
}

/**
 * Canonicalize a `send_message` target to its session key form.
 *
 * - **A bare name** (no colon): the owner's `name` or `displayName`
 *   (case-insensitive), or the literal `"owner"`. Returns `dm:<lowercased
 *   name>` so the result matches the inbound DM key built in `router.ts`.
 *   Returns `null` for any other name.
 * - **`dm:<name>` key**: lowercases the name part. Caller passing
 *   `dm:Alex` lands on the same `dm:alex` session as the inbound path,
 *   preventing a duplicate-cased shadow session from being created.
 * - **`<channel>:<chatId>` key**: if the chat is one of the owner's DM
 *   handles, canonicalized to the owner's `dm:` key — inbound traffic for the
 *   chat lives on the dm session, so recording or delegating under the raw
 *   key would split the conversation's history across two transcripts and
 *   hide the sent message from `recall_conversation` (#203). Other raw keys
 *   (groups, other chats) are returned unchanged.
 */
export function normalizeSendTarget(
  target: string,
  owner: OwnerConfig | undefined,
): NormalizedSendTarget | null {
  if (!target.includes(":")) {
    const wanted = target.trim().toLowerCase();
    if (!owner) return null;
    const names = [owner.name, owner.displayName, "owner"].filter((n): n is string => typeof n === "string");
    if (!names.some((n) => n.toLowerCase() === wanted)) return null;
    return { sessionKey: ownerSessionKey(owner), identityName: owner.name };
  }
  if (isDmSessionKey(target)) {
    return { sessionKey: dmSessionKeyForIdentity(target.slice(3)) };
  }

  const sep = target.indexOf(":");
  const channelName = target.slice(0, sep);
  const chatId = target.slice(sep + 1);
  if (owner && isOwnerHandle(owner, channelName, chatId)) {
    return {
      sessionKey: ownerSessionKey(owner),
      identityName: owner.name,
      rawReplyTarget: { channelName, chatId },
    };
  }

  return { sessionKey: target };
}
