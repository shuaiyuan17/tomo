import {
  dmSessionKeyForIdentity,
  isDmSessionKey,
  isGroupSessionKey,
  matchesChannelBinding,
} from "../sessions/keys.js";

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
 * - **Identity name** (no colon): case-insensitive lookup against the
 *   identities config. Returns `dm:<lowercased name>` so the result matches
 *   the inbound DM key built in `router.ts` (which lowercases there too).
 *   Returns `null` if no identity matches.
 * - **`dm:<name>` key**: lowercases the name part. Caller passing
 *   `dm:Shuai` lands on the same `dm:shuai` session as the inbound path,
 *   preventing a duplicate-cased shadow session from being created.
 * - **`<channel>:<chatId>` key**: if the chat is an identity's bound DM chat,
 *   canonicalized to that identity's `dm:` key — inbound traffic for the chat
 *   lives on the dm session, so recording or delegating under the raw key
 *   would split the conversation's history across two transcripts and hide
 *   the sent message from `recall_conversation` (#203). Other raw keys
 *   (groups, unbound chats) are returned unchanged.
 */
export function normalizeSendTarget(
  target: string,
  identities: ReadonlyArray<{ name: string; channels?: Record<string, string> }>,
): NormalizedSendTarget | null {
  if (!target.includes(":")) {
    const identity = identities.find(
      (i) => i.name.toLowerCase() === target.toLowerCase(),
    );
    if (!identity) return null;
    return {
      sessionKey: dmSessionKeyForIdentity(identity.name),
      identityName: identity.name,
    };
  }
  if (isDmSessionKey(target)) {
    return { sessionKey: dmSessionKeyForIdentity(target.slice(3)) };
  }

  const sep = target.indexOf(":");
  const channelName = target.slice(0, sep);
  const chatId = target.slice(sep + 1);
  if (!isGroupSessionKey(target)) {
    const identity = identities.find((i) => matchesChannelBinding(channelName, chatId, i.channels?.[channelName]));
    if (identity) {
      return {
        sessionKey: dmSessionKeyForIdentity(identity.name),
        identityName: identity.name,
        rawReplyTarget: { channelName, chatId },
      };
    }
  }

  return { sessionKey: target };
}

