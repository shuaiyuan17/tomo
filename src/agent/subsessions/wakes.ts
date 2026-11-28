import { ownerT, type OwnerText } from "../../i18n/index.js";
import { log } from "../../logger.js";
import { isTaskSessionKey } from "../../sessions/keys.js";
import { appendToTomoEventBody, formatTomoEvent } from "../../tomo-event.js";
import { CONTINUITY_DELIVERY_NOTE } from "../../continuity-defaults.js";
import { CoalescedWake } from "../coalesced-wake.js";
import { KeyedBackoff } from "../keyed-backoff.js";
import type { MirrorTicket } from "../turn-runner.js";
import type { SubsessionService } from "./service.js";

/**
 * A task-message wake whose turn left the note unread is tried again after
 * MESSAGE_WAKE_RETRY_BASE_MS, doubling per attempt up to
 * MESSAGE_WAKE_RETRY_CAP_MS, with no attempt limit (see retryMessage).
 * The base is long enough not to hammer an API that just failed and short
 * enough that a blip costs seconds; the first five retries span about the
 * five minutes the old fixed retries did, and past that a quiet session
 * still reads the note within the cap.
 */
export const MESSAGE_WAKE_RETRY_BASE_MS = 10_000;
export const MESSAGE_WAKE_RETRY_CAP_MS = 5 * 60_000;

/** What the wakes need from the Agent; every call is made when a wake needs it, never cached. */
export interface SubsessionWakesDeps {
  /** The session's turn queue (Agent.enqueueForSession). */
  enqueue(key: string, task: () => Promise<void>): Promise<unknown>;
  /** The sub-session service; undefined while `subsessions.enabled` is off. */
  subsessions(): SubsessionService | undefined;
  /** The Agent is shutting down. */
  isStopping(): boolean;
  /** A turn on `key` is of the session's own audience. */
  isOwnAudienceTurn(key: string): boolean;
  /** The registry's active entries (SessionStore.listActiveEntries). */
  listActiveEntries(): Array<{ channelKey: string }>;
  /** A silent `task-relay` continuity turn on `key` (Agent.processContinuity). */
  runRelayTurn(prompt: string, key: string, turnKind: OwnerText): Promise<void>;
}

/**
 * The owning session's side of sub-session notes: the mirror note a turn
 * carries, and the silent turns that wake a session for a mirror round or
 * for the messages its tasks handed it (with their retry backoff).
 */
export class SubsessionWakes {
  /** Sessions with a sub-session mirror note in flight: one at a time (see takeMirrorNote). */
  private readonly mirrorInFlight = new Set<string>();
  /** Sessions with a mirror wake turn queued: later rounds ride on it. */
  private readonly mirrorWakes: CoalescedWake;
  /** Sessions with a task-message wake turn queued (subsessions.ownerMessages "via-main"). */
  private readonly messageWakes: CoalescedWake;
  /** Message wake retries per session, after turns that left the note unread: one timer per session. */
  private readonly retry: KeyedBackoff;

  constructor(private readonly deps: SubsessionWakesDeps) {
    this.mirrorWakes = new CoalescedWake((key, task) => this.deps.enqueue(key, task));
    this.messageWakes = new CoalescedWake((key, task) => this.deps.enqueue(key, task));
    this.retry = new KeyedBackoff(MESSAGE_WAKE_RETRY_BASE_MS, MESSAGE_WAKE_RETRY_CAP_MS, (key) => this.message(key));
  }

  private get subsessions(): SubsessionService | undefined {
    return this.deps.subsessions();
  }

  /**
   * The sub-session mirror note for a turn on `key`: only a turn of the
   * session's own audience (a summoned group's turn on the owner's session
   * gets none), and one at a time per session, so two overlapping turns never
   * both claim the same lines.
   */
  takeMirrorNote(key: string): MirrorTicket | undefined {
    if (!this.subsessions || this.mirrorInFlight.has(key) || !this.deps.isOwnAudienceTurn(key)) return undefined;
    const note = this.subsessions.mirrorNote(key);
    if (!note) return undefined;
    this.mirrorInFlight.add(key);
    return { key, prefix: `${note.text}\n\n`, upTo: note.upTo };
  }

  /**
   * mirror "turn": a silent turn on the owning session so it sees a round of
   * a task's conversation with the owner. One queued at a time; when it runs
   * it carries everything unseen by then (rounds merge), and it does not run
   * at all if another turn has already shown it.
   */
  mirror(parentKey: string): void {
    if (this.mirrorWakes.isQueued(parentKey)) return;
    const prompt = appendToTomoEventBody(formatTomoEvent("subsession-activity",
      "A sub-session conversation is shown above. Take it in; nothing you write here is sent. If nothing needs doing, end with NO_REPLY.",
      { name: "check" }), CONTINUITY_DELIVERY_NOTE);
    this.mirrorWakes.schedule(parentKey, async () => {
      // Only for words the owner wrote (another turn may have shown them meanwhile).
      if (this.deps.isStopping() || !this.subsessions?.hasUnseenOwnerWords(parentKey)) return;
      // Asked again here: the quota window can fill while the wake waits.
      if (!this.subsessions.mirrorTurnAllowed()) return;
      await this.deps.runRelayTurn(prompt, parentKey, ownerT("notices")("suppressed.turn.subsessionMirror"));
    }, (err) => {
      log.error({ err, sessionKey: parentKey }, "Sub-session mirror turn failed in queue");
    });
  }

  /**
   * A silent turn on the owning session for the messages its tasks handed it
   * (`subsession-message` notes: task_reply / task_ask with
   * ownerMessages "via-main"). The notes ride in as the turn's pending-notes
   * prefix; the turn decides whether and how the owner hears them. One
   * queued at a time per session, and it does not run when another turn has
   * already read them all. Unlike the mirror wake, not held back at the quota
   * pause: these are messages for the owner, not a look-along.
   */
  message(parentKey: string): void {
    if (this.messageWakes.isQueued(parentKey)) return;
    const prompt = appendToTomoEventBody(formatTomoEvent("subsession-message",
      "A sub-session (or the harness, about one) handed you something for the owner; it is in a note above. Pass it on as that note says (send_message), hold it for a better moment, or fold it into other news. A question waits for the owner's answer: put it to them, and pass their answer back with task_message and attach_owner_message, in the turn of their answer. A task the harness paused at a limit goes on with a task_message of your own once the owner says so (the note says which kind it is). If nothing needs doing, end with NO_REPLY.",
      { name: "check" }), CONTINUITY_DELIVERY_NOTE);
    let ran = false;
    this.messageWakes.schedule(parentKey, async () => {
      ran = true;
      if (this.deps.isStopping()) return;
      if (!this.subsessions?.hasMessageNote(parentKey)) {
        // Another turn read it: the next failure starts from the base again.
        this.retry.reset(parentKey);
        return;
      }
      try {
        await this.deps.runRelayTurn(prompt, parentKey, ownerT("notices")("suppressed.turn.subsessionMessage"));
      } finally {
        this.retryMessage(parentKey);
      }
    }, (err) => {
      log.error({ err, sessionKey: parentKey }, "Sub-session message turn failed in queue");
      // Retried by the turn's own finally when it ran.
      if (!ran) this.retryMessage(parentKey);
    });
  }

  /**
   * At start: notes a task (or the harness, about one) handed a session and
   * no turn read yet. The service wakes the scopes its table names, but a
   * table that can't be read names none, so every session with one is woken
   * here too (merged with a wake already queued; a no-op once read).
   */
  wakeUnread(): void {
    if (!this.subsessions) return;
    try {
      for (const entry of this.deps.listActiveEntries()) {
        if (!isTaskSessionKey(entry.channelKey) && this.subsessions.hasMessageNote(entry.channelKey)) this.message(entry.channelKey);
      }
    } catch (err) {
      log.warn({ err }, "Could not wake sessions for unread sub-session notes");
    }
  }

  /**
   * After a message wake: a note it did not consume (the turn failed or was
   * cut short, and the note went back to the queue) gets another wake later,
   * with exponential backoff (MESSAGE_WAKE_RETRY_BASE_MS doubling up to
   * MESSAGE_WAKE_RETRY_CAP_MS) and no attempt limit: it keeps retrying at
   * the cap while the note stays unread. One timer per session: a retry
   * already pending covers a second failed wake, and a wake already queued
   * needs none (its own turn decides again). A firing timer only asks for a
   * wake, which merges with one queued meanwhile. So a new note whose wake
   * fails while an earlier retry is still pending waits for that timer (at
   * most the cap) instead of starting from the base: a wake call alone can't
   * tell a new note from a repeated one, and a reset there would let repeated
   * sends defeat the backoff. A turn that ran consumed what it read, and a
   * note that came in during it queued its own wake, so a session that is
   * quiet again makes no retry and its backoff resets.
   * The backoff is in memory: after a restart, wakeUnread
   * wakes every session with an unread note and a failure there starts
   * from the base again. stop() drops the pending timers.
   */
  private retryMessage(parentKey: string): void {
    if (!this.subsessions?.hasMessageNote(parentKey)) {
      this.retry.reset(parentKey);
      return;
    }
    if (this.deps.isStopping() || this.messageWakes.isQueued(parentKey)) return;
    const next = this.retry.schedule(parentKey);
    if (!next) return;
    const fields = { sessionKey: parentKey, attempt: next.attempt, delayMs: next.delayMs };
    if (next.attempt === 1) log.warn(fields, "Sub-session message turn left the note unread; retrying with backoff");
    else if (next.capped) log.warn(fields, "Sub-session message turns keep failing; retrying at the longest interval while the note stays unread");
    else log.debug(fields, "Sub-session message turn retry scheduled");
  }

  /** A turn that took a mirror note is over: the session may take the next one. */
  releaseMirror(key: string): void {
    this.mirrorInFlight.delete(key);
  }

  /** Drops the pending message-wake retry timers (Agent.stop). */
  stop(): void {
    this.retry.stop();
  }
}
