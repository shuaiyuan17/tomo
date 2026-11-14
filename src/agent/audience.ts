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
 * The audience a turn STARTED on one session must carry when it is dispatched
 * onto ANOTHER session — `send_message(mode: "delegate")`, and the handoff of
 * a group's background turn into the summoning `dm:` session.
 *
 * A delegated turn runs with `source: "cron"` on the target session, so
 * without this it registered nothing and every session-scoped tool it called
 * resolved against the TARGET's session key. A participant in a summoned group
 * could therefore say "ask your other conversation to list and remove the
 * clinic reminders": the group turn is scoped to the group, but the turn it
 * spawns on `dm:<owner>` was the owner. The scope has to travel with the
 * request, not be re-derived from wherever it lands.
 *
 * Returns the audience list to register for the dispatched turn, or
 * `undefined` when the caller's own audience is unattributable (MIXED) — the
 * delegate is refused rather than run under a guessed one, same fail-closed
 * rule as `scopedCallerKeyFor`.
 *
 * - caller is a `dm:` session speaking privately → `["dm"]`: the owner, who
 *   keeps their own scope wherever the turn lands.
 * - caller is a `dm:` session carrying a summoned group → `[<group key>]`:
 *   the group travels with the request, so the delegated turn stays
 *   group-scoped even on the owner's own session key.
 * - caller IS a raw group/chat session → `[<its own key>]`, for the same
 *   reason: any participant can steer it.
 */
export function originAudienceFor(
  callerSessionKey: string,
  audiences: readonly string[] | undefined,
): string[] | undefined {
  const scoped = scopedCallerKeyFor(callerSessionKey, audiences);
  if (scoped === MIXED_AUDIENCE_KEY) return undefined;
  // `scoped === callerSessionKey` means "no narrowing happened" — which on a
  // `dm:` key is the owner's private audience, and on a raw key is the chat
  // itself. The distinction matters: registering "dm" for a raw group caller
  // would hand the group the target session's own scope.
  return [scoped === callerSessionKey && callerSessionKey.startsWith("dm:") ? "dm" : scoped];
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
    // A REGISTERED turn whose audience is unknown must not read as "nothing is
    // running" — that is the fail-OPEN case. Record it as unattributable.
    //
    // Only `runUserTurn` registers, so a background turn (cron, continuity,
    // watch chat) contributes nothing and, when it runs alone, resolves to the
    // session key — which is right, it is the owner's. When one overlaps a
    // live summoned-group turn it inherits that group's scope instead. That is
    // narrower than its due, never wider, so it fails safe; `Agent
    // .scopedCallerKey` logs it at debug so the effect is visible.
    turns.set(id, audiences?.length ? [...audiences] : [MIXED_AUDIENCE_KEY]);
    return id;
  }

  end(sessionKey: string, id: number): void {
    const turns = this.live.get(sessionKey);
    if (!turns) return;
    turns.delete(id);
    if (turns.size === 0) this.live.delete(sessionKey);
  }

  /** The audiences of every turn live on this session right now, or
   *  undefined when none is. */
  liveAudiences(sessionKey: string): string[] | undefined {
    const turns = this.live.get(sessionKey);
    if (!turns || turns.size === 0) return undefined;
    return [...new Set([...turns.values()].flat())];
  }

  /** The audience a turn dispatched FROM this session onto another one must
   *  carry. Undefined when this session's live turns are unattributable —
   *  see `originAudienceFor`. */
  originAudience(sessionKey: string): string[] | undefined {
    return originAudienceFor(sessionKey, this.liveAudiences(sessionKey));
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

  /**
   * May a tool read this session's OWN private surfaces right now — the
   * private people subtree, the session transcript?
   *
   * `isOwnAudienceTurn` over the same resolution as `scopedCallerKey`, so
   * there is one rule and one fail-closed path, not two. False while a
   * summoned group is steering the session, and false when concurrent turns
   * disagree about who is.
   */
  isOwnAudienceTurn(sessionKey: string): boolean {
    return this.scopedCallerKey(sessionKey) === sessionKey;
  }
}

/**
 * Does a turn with these audiences belong to the session it runs on?
 *
 * True for an ordinary turn — a group session's own messages, the owner's own
 * DM messages, and background turns (cron, LCM) that record no audience.
 *
 * False exactly when the session key overstates the turn's audience: a
 * summoned group's messages running on the owner's `dm:` session, and a
 * mixed or unattributable batch (which fails closed via `scopedCallerKeyFor`).
 * Those are the turns where the session's own private surfaces — the private
 * people subtree and the DM transcript — must not be readable, because the
 * text steering the turn came from a group.
 */
export function isOwnAudienceTurn(sessionKey: string, audiences: readonly string[] | undefined): boolean {
  return scopedCallerKeyFor(sessionKey, audiences) === sessionKey;
}

/**
 * Who each piece of BACKGROUND work on a session belongs to — per task id.
 *
 * A turn ending is not its work ending. `Agent { run_in_background: true }`, a
 * background shell or a Monitor returns at once and the turn resolves; the
 * subagent's later tool calls still reach the session's PreToolUse hook
 * (carrying `agent_id` = the task id), and the CLI then runs an SDK-initiated
 * REPORT turn for it. None of that runs inside the turn that started it, so the
 * per-turn {@link TurnAudienceRegistry} has nothing registered for it — and on
 * a `dm:` session "nothing registered" resolves to the owner. A summoned
 * group's background agent therefore read `memory/private/` unbarred.
 *
 * So the audience is recorded PER TASK, at the moment the task appears, and
 * travels with it:
 *
 * - a task's ORIGIN is the audience of the turn running when it appeared (or
 *   its parent task's origin, for a task a subagent launched). A harness-owned
 *   turn (cron, LCM) with no registered audience is the owner's: `["dm"]`.
 * - a subagent's tool calls are judged by its task's origin (`originOf`).
 * - when a task finishes (its `task_notification`, or leaving the live set) its
 *   origin is queued for the report turn; the next SDK-initiated turn takes
 *   everything queued (`claimReportTurn`). Several queued reports → their
 *   union, which fails closed if they disagree.
 * - a report turn that cannot be attributed — nothing queued — takes the
 *   union of the still-live tasks' origins, and with none of those it is
 *   UNATTRIBUTABLE and fails closed as {@link MIXED_AUDIENCE_KEY}. No timeout
 *   ever turns an unattributed turn back into the owner's.
 *
 * Pure bookkeeping: LiveSession feeds it the SDK's task events.
 */
export class BackgroundAudienceLedger {
  /** Live background task id → origin audiences. */
  private origins = new Map<string, string[]>();
  /** Tasks whose origin was already queued for a report (notification seen). */
  private reported = new Set<string>();
  /** Origins of finished tasks whose report turn has not been claimed yet. */
  private pending: string[] = [];
  /** The audience of the SDK-initiated turn in flight, if any. */
  private reportTurn: string[] | null = null;

  /**
   * Replace the live set (`background_tasks_changed` has REPLACE semantics).
   * `now` is the audience of whatever turn is running at this instant.
   */
  setLiveTasks(
    tasks: ReadonlyArray<{ task_id: string; parent_task_id?: string }>,
    now: () => readonly string[] | undefined,
  ): void {
    const live = new Set(tasks.map((t) => t.task_id));
    for (const [id, origin] of this.origins) {
      if (live.has(id)) continue;
      if (!this.reported.has(id)) this.pending.push(...origin);
      this.origins.delete(id);
      this.reported.delete(id);
    }
    for (const t of tasks) {
      if (this.origins.has(t.task_id)) continue;
      const parent = t.parent_task_id ? this.origins.get(t.parent_task_id) : undefined;
      this.origins.set(t.task_id, parent ? [...parent] : this.currentAudience(now));
    }
  }

  /** A task's `task_notification`: queue its origin for the report turn now. */
  taskFinished(taskId: string): void {
    const origin = this.origins.get(taskId);
    if (!origin || this.reported.has(taskId)) return;
    this.reported.add(taskId);
    this.pending.push(...origin);
  }

  /** An SDK-initiated turn has started. Returns the audience it runs under. */
  claimReportTurn(): string[] {
    if (this.reportTurn) return this.reportTurn;
    let audience: string[];
    if (this.pending.length > 0) audience = [...new Set(this.pending)];
    else if (this.origins.size > 0) audience = [...new Set([...this.origins.values()].flat())];
    else audience = [MIXED_AUDIENCE_KEY];
    this.pending = [];
    this.reportTurn = audience;
    return audience;
  }

  /** The SDK-initiated turn in flight has ended. */
  endReportTurn(): void {
    this.reportTurn = null;
  }

  /** The audience of the SDK-initiated turn in flight, or null. */
  reportTurnAudience(): string[] | null {
    return this.reportTurn ? [...this.reportTurn] : null;
  }

  /** The origin of a live background task, by its id (= a subagent's `agent_id`). */
  originOf(taskId: string): string[] | undefined {
    const o = this.origins.get(taskId);
    return o ? [...o] : undefined;
  }

  /** Union of every live background task's origin. Empty when none is live. */
  liveOrigins(): string[] {
    return [...new Set([...this.origins.values()].flat())];
  }

  /** The session is gone: nothing it tracked can run any more. */
  clear(): void {
    this.origins.clear();
    this.reported.clear();
    this.pending = [];
    this.reportTurn = null;
  }

  private currentAudience(now: () => readonly string[] | undefined): string[] {
    const registered = now() ?? [];
    const all = [...registered, ...(this.reportTurn ?? [])];
    // Nothing registered and no report turn: a harness-owned turn (cron, LCM),
    // which is the owner's.
    return all.length > 0 ? [...new Set(all)] : ["dm"];
  }
}
