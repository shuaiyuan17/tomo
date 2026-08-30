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

/**
 * Which turns are live on which session, and therefore what a session-scoped
 * MCP tool should be judged against right now.
 *
 * Per TURN, not per session key. With `steering` on (the default)
 * `InboundBatcher` dispatches a drain outside the per-session queue whenever a
 * live session is busy, so two `runUserTurn` calls run concurrently on one
 * key. A single slot per key let the second turn's cleanup clear the first
 * turn's audience, after which the resolver fell back to the session key —
 * handing a summoned group the owner's DM scope, the exact hole the scoping
 * exists to close.
 *
 * Deliberately NOT `AsyncLocalStorage`. Tool handlers are invoked by the SDK
 * across a transport boundary, so the async context of the caller that started
 * the turn is not guaranteed to reach them; a scheme whose safety depends on
 * that propagation is a scheme that fails open when it stops holding. Taking
 * the union of every live turn's audiences needs no attribution at all: when
 * concurrent turns agree the answer is unambiguous, and when they disagree
 * `scopedCallerKeyFor` already fails closed.
 */
export class TurnAudienceRegistry {
  private live = new Map<string, Map<number, string[]>>();
  private nextId = 1;

  /** Register a turn. Returns the id to pass to `end`. */
  begin(sessionKey: string, audiences: readonly string[] | undefined): number {
    const id = this.nextId++;
    let turns = this.live.get(sessionKey);
    if (!turns) {
      turns = new Map();
      this.live.set(sessionKey, turns);
    }
    // A live turn whose audience is unknown must not read as "nothing is
    // running" — that is the fail-OPEN case. Record it as unattributable.
    turns.set(id, audiences?.length ? [...audiences] : [MIXED_AUDIENCE_KEY]);
    return id;
  }

  end(sessionKey: string, id: number): void {
    const turns = this.live.get(sessionKey);
    if (!turns) return;
    turns.delete(id);
    if (turns.size === 0) this.live.delete(sessionKey);
  }

  /** The key a session-scoped tool should be judged against, right now. */
  scopedCallerKey(sessionKey: string): string {
    const turns = this.live.get(sessionKey);
    // No live turn: a cron, LCM or other background turn the owner owns
    // outright.
    if (!turns || turns.size === 0) return scopedCallerKeyFor(sessionKey, undefined);
    // The union of every live turn. A tool call cannot be attributed to one of
    // several concurrent turns, so if they disagree, `scopedCallerKeyFor`
    // fails closed for us — one rule, not two.
    return scopedCallerKeyFor(sessionKey, [...turns.values()].flat());
  }
}
