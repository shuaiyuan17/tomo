import { formatTomoEvent } from "../tomo-event.js";

/** Audience identifier for an inbound message on a unified dm: session —
 *  "dm" for private messages, the raw "<channel>:<chatId>" key for (summoned)
 *  group messages. */
export function audienceOf(channelName: string, message: { isGroup?: boolean; chatId: string }): string {
  return message.isGroup ? `${channelName}:${message.chatId}` : "dm";
}

/**
 * Note injected when a dm session's inbound audience changes (private DM ↔
 * summoned group, or between two summoned groups). The per-message
 * [group ...] tags say where each message came FROM; this says the audience
 * CHANGED — the moment when tone or private context is most likely to be
 * carried across by mistake. Returns "" when nothing changed.
 *
 * `audiences` lists this turn's inbound audiences in order (one entry for a
 * single message; several for a coalesced batch, which can mix audiences).
 */
export function audienceSwitchNote(
  prev: string | undefined,
  audiences: string[],
  label: (audience: string) => string,
): string {
  if (audiences.length === 0) return "";
  const distinct = [...new Set(audiences)];
  if (distinct.length > 1) {
    return formatTomoEvent(
      "audience",
      `Audience check — the messages below span ${distinct.map(label).join(" and ")}. Mind each message's tag when replying; group replies only via send_message.`,
      { name: "check" },
    );
  }
  if (prev === undefined || distinct[0] === prev) return "";
  return formatTomoEvent(
    "audience",
    `Audience switched — the previous message in this session was from ${label(prev)}; this one is from ${label(distinct[0])}. Re-anchor tone and privacy to the new audience.`,
    { name: "switch" },
  );
}

/**
 * Stand-in caller key for a turn whose inbound messages span more than one
 * audience (a coalesced batch mixing the owner's DM with a summoned group, or
 * two summoned groups). It matches no session and no job, so every
 * session-scoped tool refuses rather than picking one of the audiences and
 * granting the widest scope on the riskiest turn.
 *
 * Not a valid session key by construction — the leading NUL cannot occur in a
 * channel name or a chat id.
 */
export const MIXED_AUDIENCE_KEY = "\u0000mixed-audience";

/**
 * The session key a session-scoped tool should be judged against, given the
 * session a turn runs on and that turn's inbound audiences.
 *
 * Normally the session key. NOT for a summoned group: its messages run on the
 * owner's `dm:` session, so every participant is steering a session whose key
 * says "the owner's private DM", and handing that key to a scoped tool gives
 * the group the owner's own scope.
 *
 * - non-`dm:` session → itself, unchanged.
 * - no audiences → the session. A cron, LCM or other background turn the
 *   owner owns outright.
 * - one audience → `dm` means the owner; a group key means that group.
 * - more than one → fail closed. A coalesced batch can mix the owner's DM
 *   with several summoned groups, and no single key is right for all of them;
 *   picking one would grant the WIDEST scope on exactly the turn where a
 *   group's text is in the prompt.
 */
export function scopedCallerKeyFor(sessionKey: string, audiences: readonly string[] | undefined): string {
  if (!sessionKey.startsWith("dm:")) return sessionKey;
  if (!audiences || audiences.length === 0) return sessionKey;
  const distinct = [...new Set(audiences)];
  if (distinct.length > 1) return MIXED_AUDIENCE_KEY;
  return distinct[0] === "dm" ? sessionKey : distinct[0];
}
