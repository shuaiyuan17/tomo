import { log } from "../../logger.js";
import { ownerT, type OwnerText } from "../../i18n/index.js";
import type { SubsessionConfig } from "../../config.js";
import { isTaskSessionKey } from "../../sessions/keys.js";
import { formatTomoEvent } from "../../tomo-event.js";
import { MODEL_ALIASES } from "../../models.js";
import { SubsessionStoreError, type SubsessionStore, type TransitionOptions, type TransitionOutcome } from "./store.js";
import type { SubsessionEvent } from "./state-machine.js";
import {
  compactInstructions,
  formatContinueEvent,
  formatLostAnswerNote,
  formatPostCompactReminder,
  formatNewInputNote,
  formatRedeliveryNote,
  formatRelayEvent,
  formatOwnerMessageEvent,
  formatResumeEvent,
  formatMirrorNote,
  formatStartEvent,
} from "./prompt.js";
import { OPEN_STATUSES, PENDING_INPUT_MAX, TERMINAL_STATUSES, activeTotalMs, appendInput, lastInputSeq, type SubsessionConversationEntry, type SubsessionInput, type SubsessionRecord } from "./types.js";

const OWNER_MESSAGE_MARKER = '<tomo-event type="subsession-owner-message"';

/** How a task turn ended, as the agent's turn runner saw it. */
export interface TaskTurnOutcome {
  /** Ran to its normal result. */
  ok: boolean;
  /** The owner stopped it. */
  stopped?: boolean;
  /** Shutdown refused or cut it short: not an outcome at all. */
  shutdown?: boolean;
  /**
   * What the model wrote as plain text (kept out of chat), when it was not a
   * silent reply. Sent as a fallback when the owner's message got no answer.
   */
  response?: string;
  /**
   * Set by the service, not the runner: the turn completed, but its answer
   * to the owner could not be sent. The owner's input is kept (marked as
   * possibly seen) and the next turn answers again.
   */
  answerUndelivered?: boolean;
}

/** Where a task's outward message landed: provider ids, for reply threading. */
export interface ScopeSendResult {
  ok: boolean;
  error?: string;
  channel?: string;
  messageIds?: string[];
}

export type OwnerMessageResult =
  | { ok: true; record: SubsessionRecord; duplicate: boolean }
  /**
   * `unknown`: no such task in this scope; `ended`: cancelled, failed or
   * archived; `unreadable`: the table; `full`: PENDING_INPUT_MAX inputs are
   * already waiting (refused, never dropped: the caller sends it elsewhere).
   */
  | { ok: false; reason: "unknown" | "ended" | "unreadable" | "full" };

/**
 * The task's line on the owner's todo list (src/todos). The service says what
 * the line should say as the task moves; the link makes it so (and does
 * nothing when it already does, or the item is gone).
 */
export interface SubsessionTodoLink {
  /** Add the todo for a new task (or find the one already made); its id, or undefined when none was made. */
  open(record: SubsessionRecord): string | undefined;
  /** The task's todo if one was made, without making one. */
  find(record: SubsessionRecord): string | undefined;
  /** Who the item waits on now, and its next step. */
  set(todoId: string, waitingOn: "owner" | "external", next: string): void;
  /** The task ended without a result: drop the item. */
  close(todoId: string, reason: string): void;
}

/** The unseen part of a scope's task conversations (see SubsessionService.mirrorNote). */
export interface MirrorNote {
  text: string;
  /** Task id → the newest seq the note shows. */
  upTo: Record<string, number>;
}

export interface SubsessionServiceDeps {
  store: SubsessionStore;
  config(): SubsessionConfig;
  /**
   * Run one silent turn on a task key, queued on that key like any other
   * turn. `bare`: send the prompt exactly as given (a `/compact` command must
   * lead its message), with no pending notes or stamp in front.
   */
  runTaskTurn(key: string, prompt: string, opts: { bare: boolean }): Promise<TaskTurnOutcome>;
  /**
   * Put `text` (the task's own words, prefix included) into the owning
   * session's chat, recorded there like any direct send. `taskKey` is the
   * caller, whose audience decides which attachments may go.
   */
  sendToScope(parentKey: string, text: string, taskKey: string, noteFrom: string, harnessPrefix: string): Promise<ScopeSendResult>;
  /** Is a turn in flight on the key right now? */
  hasTurnInFlight?(key: string): boolean;
  /** Close the key's live session (idle), so its next turn is built afresh. */
  closeSession?(key: string): void;
  /** A harness notice about a task, to the owning scope's chat. */
  noticeToScope(parentKey: string, text: OwnerText): Promise<void>;
  queuePendingNote(key: string, note: string): boolean;
  hasPendingNote(key: string, predicate: (note: string) => boolean): boolean;
  /**
   * Write the session's pending notes (queued and in flight) to disk again.
   * A note whose first write failed is still held in memory, so finding it
   * there does not mean it is durable. Returns false when the write fails.
   */
  persistPendingNotes?(key: string): boolean;
  /** A harness notice to the owner's own chat (no task to attribute it to). */
  noticeOwner(text: OwnerText): Promise<void>;
  /** A silent turn on the owning session that reads the notes queued for it. */
  wakeScope(parentKey: string, prompt: string): void;
  /** The last turn's context reading on a key, if any. */
  contextUsage(key: string): { used: number; estimated: boolean } | undefined;
  /** Enabled cron jobs that deliver to `key`; undefined when the cron store cannot be read (unknown, not zero). */
  cronJobCount(key: string): number | undefined;
  removeCronJobs(key: string): void;
  /** Soft-stop the key's live session, then close it; hard close after `timeoutMs`. */
  stopSession(key: string, timeoutMs: number): Promise<void>;
  /**
   * Registry: could it be read? An unreadable registry answers from an empty
   * or stale state, so nothing it says about task sessions is acted on.
   */
  registryReadable(): boolean;
  /** Registry: does the key have an SDK session to resume? */
  hasSdkSession(key: string): boolean;
  /** The key's conversation is live in memory (a turn there needs no resume). */
  hasLiveSession?(key: string): boolean;
  ensureRegistryEntry(key: string): void;
  /** Unlink the key's registry entry (it then expires with the usual 30-day TTL). */
  unlinkRegistryEntry(key: string): void;
  /** Active registry keys that are task keys. */
  registryTaskKeys(): string[];
  isStopping(): boolean;
  /**
   * The newest reading of the subscription's 5-hour window, 0–100; undefined
   * when there is none (no quota samples yet, API-key auth). Throws when the
   * samples cannot be read: the gate then lets the turn run (fail open).
   */
  sessionQuotaPercent?(): number | undefined;
  now?(): number;
  /** The owner's todo list (config `subsessions.todos`). */
  todos?: SubsessionTodoLink;
  /**
   * mirror "turn": a silent turn on the owning session, which takes the
   * unseen conversation as its prefix. Merged while one is already queued.
   */
  mirrorWake?(parentKey: string): void;
}

export const STOP_TIMEOUT_MS = 30_000;
export const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A task parked while the cron store could not be read: how soon it is looked at again. */
export const CRON_RECHECK_MS = 60_000;
export const MAX_INTERRUPT_STREAK = 3;
export const MAX_TURNS_WITHOUT_PROGRESS = 3;
export const MAX_FAIL_STREAK = 2;
const REPORT_NOTE_EXCERPT = 600;
/** The fallback send of an unanswered owner message is cut at this length. */
const FALLBACK_MAX = 3500;
/** A report note that could not be written is retried in-process, this often, this many times. */
export const REPORT_RETRY_MS = 60_000;
export const REPORT_RETRY_MAX = 5;
/** A turn whose result could not be written: how soon the task gets its next turn. */
export const SETTLE_RETRY_MS = 60_000;
/** Turns held while the session registry cannot be read: how soon it is looked at again. */
export const REGISTRY_RECHECK_MS = 60_000;
/** At this share of the 5-hour window, a task's own turns pause for the owner. */
export const QUOTA_PAUSE_PERCENT = 80;
/** How much of each unanswered message a failure notice quotes. */
const UNANSWERED_EXCERPT = 300;
const UNANSWERED_MAX = 5;
/** How much of an undelivered message the next turn is shown. */
const LOST_ANSWER_EXCERPT = 1500;
const ACTIVITY_NOTE_EXCERPT = 1500;
/** What an owner message keeps in the conversation log. */
const CONVERSATION_TEXT_MAX = 4000;
/** While a task's turn runs, how often its `activeSeenAt` is refreshed. */
export const ACTIVE_HEARTBEAT_MS = 60_000;

/** Models a task may use: aliases opus / sonnet / fable, or any full id that is not a Haiku model. */
export function validateTaskModel(model: string): string | null {
  const name = model.trim();
  if (!name) return "model is empty";
  if (/haiku/i.test(name)) return "Haiku is not offered for sub-sessions: a sub-session means a long task, and the savings don't cover the rework. Use sonnet for routine work.";
  if (name in MODEL_ALIASES || /^claude-/.test(name)) return null;
  return `unknown model "${name}"; use opus, sonnet or fable`;
}

export type SpawnResult = { ok: true; record: SubsessionRecord } | { ok: false; error: string };

interface PlannedTurn {
  kind: "compact" | "wake" | "continue";
  prompt: string;
  /**
   * The highest input seq this turn carries (0: none). Held in memory only:
   * the inputs stay on the record until the write that records this turn's
   * result removes them.
   */
  throughSeq: number;
  /** Carries the post-compact reminder: does not count as progress or as no progress. */
  afterCompact: boolean;
  /** Carries a message from the owner: an answer is owed (fallback send). */
  fromOwner: boolean;
  resume: boolean;
  start: boolean;
}

/**
 * The sub-session state machine at work: spawn, the scheduler, the per-task
 * driver that runs turns and decides what follows each one, the task's own
 * tool calls, cron wakes, restart recovery and the startup reconcile.
 *
 * Every status change goes through `store.transition` (see state-machine.ts).
 * Runtime facts — which task has a driver running, tool calls seen in the
 * current turn, whether a "continue" is owed — live here in memory and are
 * never persisted: after a restart, the persisted lifecycle plus
 * `resumeNeeded` is all that is needed.
 */
export class SubsessionService {
  private readonly driving = new Set<string>();
  private readonly continueOwed = new Set<string>();
  private readonly toolCalls = new Map<string, number>();
  private readonly progressChanged = new Set<string>();
  /** Tasks that spoke outward (reply / notify / ask / finish) in their current turn. */
  private readonly spoke = new Set<string>();
  private readonly inFlightSends = new Map<string, Set<Promise<unknown>>>();
  /** Which task each send in flight belongs to (see `sendingTasks`). */
  private readonly sendOwners = new Map<Promise<unknown>, string>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly reportTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportAttempts = new Map<string, number>();
  /** The highest input seq the turn in flight carries, per task (runtime only). */
  private readonly inflightThrough = new Map<string, number>();
  /** Reports whose note write failed: the note may sit in memory only. */
  private readonly unpersistedReports = new Set<string>();
  private cronRecheckTimer?: NodeJS.Timeout;
  /**
   * Inputs a completed turn carried whose result could not be written: they
   * are still on the record, and the next turn in this process says they may
   * have been acted on. (After a restart, recovery marks them on disk.)
   */
  private readonly unsavedSeen = new Map<string, number>();
  /** Tasks whose last result could not be written: no turn until the retry timer. */
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Messages the task sent in the turn in flight that could not be delivered,
   * by their text: the turn's result keeps the inputs it carried (a
   * completed turn whose answer was lost is not an answered turn). Only a
   * later send of the SAME text clears one: a send of anything else answers
   * something else, and leaves the lost one lost.
   */
  private readonly undelivered = new Map<string, Set<string>>();
  /** The last turn's messages that could not be delivered: the next turn is shown them. */
  private readonly answerLost = new Map<string, string[]>();
  /** Turns held because the session registry could not be read (see mayRun). */
  private registryRecheckTimer?: NodeJS.Timeout;
  /**
   * Tasks whose turn mayRun is holding: kick() leaves them alone until the
   * recheck (a driver re-kicked at once would spin without ever yielding).
   */
  private readonly registryHeld = new Set<string>();
  private registryHoldTold = false;
  /** The quota samples could not be read last time: logged once per failing stretch. */
  private quotaReadFailing = false;
  /**
   * Startup is two steps. `recoverAtStartup()` (before any channel ingests)
   * reads the table and runs recovery, reconcile and the sweep: from then on
   * the task tools work and input can be appended. `start()` (after the
   * channels and the inbox replay) opens dispatch: nothing runs a turn or
   * takes a slot before it, so no turn can start on a table recovery has not
   * finished with.
   */
  private recovered = false;
  private started = false;
  private open = false;
  /**
   * Starts asked for past the slot cap (the owner's) while dispatch was still
   * closed, or while mayRun held them: made first, the moment dispatch opens
   * or the hold ends, so the owner never waits for a slot.
   */
  private readonly startsOwed = new Map<string, string>();
  /**
   * Tasks the owner started themselves (`/s <id> start`) whose first turn has
   * not run yet: that turn is the owner's word, so it passes the cap and the
   * quota gate like a turn carrying their message.
   */
  private readonly ownerStarted = new Set<string>();
  /** Outward effects (notices, wakes) recovery produced before start(): sent once the channels are up. */
  private live = false;
  private deferred: Array<() => void> = [];
  /**
   * The table as read at start: the primary read cleanly ("ok"), or none yet
   * ("missing"), and not marked untrusted. The precondition for any
   * destructive cleanup in this process (see mayCleanUp). False after a
   * `.bak` recovery or a lost table.
   */
  private trustedAtStart = false;
  private startState?: ReturnType<SubsessionStore["state"]>;
  /** The table could not be read at start: the feature stays off until the next start. */
  private broken = false;

  constructor(private readonly deps: SubsessionServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get store(): SubsessionStore {
    return this.deps.store;
  }

  /**
   * Usable right now: enabled, the table was readable at start, and restart
   * recovery has finished. Every entry point (the task tools, relays, cron
   * fires, background reports) checks this, so nothing reaches a task before
   * recovery is done with it.
   */
  available(): boolean {
    return this.deps.config().enabled && !this.broken && this.recovered;
  }

  get(id: string): SubsessionRecord | undefined {
    return this.store.get(id);
  }

  byKey(key: string): SubsessionRecord | undefined {
    return this.store.byKey(key);
  }

  /** The owning session of a task key, or undefined when unknown (callers fail closed). */
  parentKeyOf(key: string): string | undefined {
    if (!isTaskSessionKey(key)) return undefined;
    try {
      return (this.store.peek() ?? this.store.read()).tasks.find((t) => t.sessionKey === key)?.parentKey;
    } catch {
      return undefined;
    }
  }

  /** The model recorded for a task key, if any. */
  modelFor(key: string): string | undefined {
    const record = this.safeByKey(key);
    return record?.model ?? this.deps.config().defaultModel ?? undefined;
  }

  effortFor(key: string): string | undefined {
    return this.safeByKey(key)?.effort;
  }

  list(parentKey?: string): SubsessionRecord[] {
    const all = this.store.list();
    return parentKey === undefined ? all : all.filter((t) => t.parentKey === parentKey);
  }

  // ---------------------------------------------------------------------
  // Owning-session side (task_spawn / task_status / task_cancel / task_message)
  // ---------------------------------------------------------------------

  spawn(parentKey: string, input: { title: string; brief: string; quote?: string[]; model?: string; effort?: string }): SpawnResult {
    if (!this.available()) return { ok: false, error: "Sub-sessions are not available right now." };
    const cfg = this.deps.config();
    if (input.model !== undefined) {
      const problem = validateTaskModel(input.model);
      if (problem) return { ok: false, error: problem };
    }
    const open = this.store.list().filter((t) => OPEN_STATUSES.has(t.status)).length;
    if (open >= cfg.maxOpen) {
      return { ok: false, error: `${open} sub-sessions are already open (limit ${cfg.maxOpen}). Finish or cancel one first.` };
    }
    // A new id must not land on a task session the registry still links
    // (a lost table, say): the new task would resume that conversation's
    // history. From an unreadable registry nothing is known about those, so
    // no new id is given out at all, and the caller is told so.
    if (!this.reserveRegistryIds()) {
      return { ok: false, error: "The session registry can't be read right now, so no new sub-session can be started safely. Try again later." };
    }
    const record = this.store.create({ parentKey, ...input, ...(input.model ? { model: input.model.trim() } : {}) });
    this.deps.ensureRegistryEntry(record.sessionKey);
    if (cfg.todos && this.deps.todos) this.adoptTodo(record);
    this.schedule();
    return { ok: true, record: this.store.get(record.id) ?? record };
  }

  /**
   * Moves the next id past every task session the registry links. False when
   * the registry can't be read (or the reservation can't be written): no new
   * id may be given out then.
   */
  private reserveRegistryIds(): boolean {
    try {
      if (!this.deps.registryReadable()) return false;
      const highest = Math.max(0, ...this.deps.registryTaskKeys().map(taskNumber));
      if (highest >= this.store.read().nextId) this.store.reserveIdsThrough(highest);
      return true;
    } catch (err) {
      log.error({ err }, "Could not reserve sub-session ids past the registry's task sessions");
      return false;
    }
  }

  async cancel(id: string, reason: string): Promise<TransitionOutcome> {
    if (!this.available()) return { ok: false, from: null };
    // A live ending: the status no longer comes from a backup.
    const outcome = this.transition(id, "cancel", { reason, patch: (r) => { delete r.restored; } });
    if (!outcome.ok || !outcome.changed) return outcome;
    this.continueOwed.delete(id);
    this.safely(() => this.deps.removeCronJobs(outcome.record.sessionKey), "remove cron jobs");
    await this.deps.stopSession(outcome.record.sessionKey, STOP_TIMEOUT_MS).catch((err) => {
      log.warn({ err, id }, "Stopping a cancelled sub-session's live session failed");
    });
    this.schedule();
    return outcome;
  }

  /** The owning session passes something on. */
  relay(id: string, text: string): TransitionOutcome {
    if (!this.available()) return { ok: false, from: null };
    return this.deliverInput(id, "relay", formatRelayEvent(text), text);
  }

  /**
   * The owner wrote to a task (`/s <id> …`, or a reply to one of its
   * messages). `scope` is the session the owner wrote from: a task owned by
   * another scope is unknown here. `messageId` dedups a replayed delivery.
   * The message is on disk (the task's pendingInput) when this returns ok.
   */
  ownerMessage(scope: string, id: string, text: string, opts: { messageId?: string; files?: string[] } = {}): OwnerMessageResult {
    // Not before restart recovery is done (the caller checks available() too).
    if (!this.available()) return { ok: false, reason: "unreadable" };
    let record: SubsessionRecord | undefined;
    try {
      record = this.store.get(id);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!record || record.parentKey !== scope) return { ok: false, reason: "unknown" };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, reason: "ended" };
    if (opts.messageId && record.ownerMessageIds.includes(opts.messageId)) return { ok: true, record, duplicate: true };
    let outcome: TransitionOutcome;
    try {
      outcome = this.deliverInput(id, "owner_message", formatOwnerMessageEvent(text, opts.files), ownerWords(text, opts.files), (r) => {
        if (opts.messageId) r.ownerMessageIds.push(opts.messageId);
        pushConversation(r, { at: this.now(), from: "owner", kind: "message", text: truncate(text.trim(), CONVERSATION_TEXT_MAX),
          ...(opts.files && opts.files.length > 0 ? { files: opts.files.length } : {}) });
      });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!outcome.ok) return { ok: false, reason: outcome.refused ? "full" : "ended" };
    return { ok: true, record: outcome.record, duplicate: false };
  }

  /**
   * Sends of task messages in flight, per owning scope. The provider can show
   * a message (and the owner reply to it) before the send resolves with its
   * ids, so a reply that matches no task waits for these to settle and is
   * looked up again (see `whenSendsSettle`).
   */
  sendsInFlight(scope: string): boolean {
    return (this.inFlightSends.get(scope)?.size ?? 0) > 0;
  }

  /** The tasks with a send still in flight in `scope`, by id. */
  sendingTasks(scope: string): SubsessionRecord[] {
    const ids = new Set([...(this.inFlightSends.get(scope) ?? [])].map((p) => this.sendOwners.get(p)).filter((id): id is string => !!id));
    return [...ids].map((id) => this.safeGet(id)).filter((r): r is SubsessionRecord => !!r);
  }

  /** Resolves when every send in flight for `scope` has settled and been recorded, or after `timeoutMs`. */
  async whenSendsSettle(scope: string, timeoutMs: number): Promise<void> {
    const pending = [...(this.inFlightSends.get(scope) ?? [])];
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** The task one of whose messages the owner replied or reacted to. */
  taskForReply(scope: string, channel: string, messageId: string): SubsessionRecord | undefined {
    let tasks: SubsessionRecord[];
    try {
      tasks = this.store.list().filter((t) => t.parentKey === scope && t.status !== "archived");
    } catch {
      return undefined;
    }
    return tasks.find((t) => t.replyMap.some((m) => m.channel === channel && m.messageId === messageId));
  }

  /**
   * `/s <id> model <name>`. Refused while a turn is running (the session it
   * runs on keeps its model); otherwise the idle session is closed so the
   * next turn is built with the new model.
   */
  setModel(scope: string, id: string, model: string): { ok: true; record: SubsessionRecord } | { ok: false; error: "unknown" | "ended" | "busy" | "invalid"; detail?: string } {
    const record = this.safeGet(id);
    if (!record || record.parentKey !== scope) return { ok: false, error: "unknown" };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: "ended" };
    const problem = validateTaskModel(model);
    if (problem) return { ok: false, error: "invalid", detail: problem };
    if (this.deps.hasTurnInFlight?.(record.sessionKey) || this.driving.has(id)) return { ok: false, error: "busy" };
    const updated = this.store.update(id, (r) => { r.model = model.trim(); });
    if (!updated) return { ok: false, error: "unknown" };
    this.deps.closeSession?.(record.sessionKey);
    return { ok: true, record: updated };
  }

  // ---------------------------------------------------------------------
  // Task side (task_reply / task_notify / task_ask / task_progress / task_checkpoint / task_finish / task_reopen)
  // ---------------------------------------------------------------------

  async notify(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return this.speak(key, "notify", text);
  }

  /** task_reply: answer the owner's message. */
  async reply(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return this.speak(key, "reply", text);
  }

  /**
   * task_ask: a question only the owner can answer. Sent first, then the
   * task waits for the owner (nothing autonomous wakes it). A send that
   * failed leaves the status as it was, so the task can try again.
   */
  async ask(key: string, question: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (record.status !== "active" && record.status !== "waiting") {
      return { ok: false, error: `task_ask needs an active task; this one is ${record.status}. Use task_reply to answer the owner, or task_reopen first.` };
    }
    const sent = await this.speak(key, "ask", question);
    if (!sent.ok) return sent;
    // Input this turn does not carry — the owner's answer that arrived while
    // the question was being sent, or anything that was already waiting
    // before the ask — is pending, and its kick() found this turn running.
    // Waiting now would strand it (nothing autonomous wakes waiting(owner)),
    // so the guard, judged under the lock, keeps the task as it is and that
    // input is its next turn.
    const outcome = this.transition(record.id, "ask", {
      reason: `asked the owner: ${truncate(question.trim(), 200)}`,
      guard: (r) => (r.pendingInput.some((i) => i.seq > (this.inflightThrough.get(r.id) ?? 0))
        ? "input is pending that this turn does not carry" : undefined),
    });
    if (!outcome.ok) return { ok: true };
    this.continueOwed.delete(record.id);
    this.schedule();
    return { ok: true };
  }

  private async speak(key: string, kind: "notify" | "reply" | "ask" | "fallback", text: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: `This task is ${record.status}; nothing more is sent.` };
    const body = text.trim();
    if (!body) return { ok: false, error: "text is empty" };
    const prefix = taskPrefix(record);
    const work = (async () => {
      const result = await this.sendOut(record, `${prefix} ${body}`, prefix);
      if (result.ok) {
        if (kind !== "fallback") this.spoke.add(record.id);
        const at = this.now();
        try {
          this.store.update(record.id, (r) => {
            r.sent.push({ at, kind, text: body });
            pushConversation(r, { at, from: "task", kind, text: truncate(body, CONVERSATION_TEXT_MAX) });
            if (result.channel) {
              for (const messageId of result.messageIds ?? []) r.replyMap.push({ channel: result.channel, messageId, at });
            }
          });
        } catch (err) {
          // Out, but not in the conversation the mirror reads: the owning
          // session gets it as a note instead, so it still sees what was said.
          log.error({ err, id: record.id }, "Could not record a sub-session's sent message; the owning session gets it as a note");
          this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-activity",
            `Sub-session ${record.id} ("${record.title}") said to the owner (${kind}): ${truncate(body, ACTIVITY_NOTE_EXCERPT)}`,
            { name: record.id }));
        }
      }
      return result;
    })();
    // Settles only once the ids are recorded (see whenSendsSettle).
    const sends = this.inFlightSends.get(record.parentKey) ?? new Set<Promise<unknown>>();
    sends.add(work);
    this.sendOwners.set(work, record.id);
    this.inFlightSends.set(record.parentKey, sends);
    try {
      const result = await work;
      return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
    } finally {
      sends.delete(work);
      this.sendOwners.delete(work);
      if (sends.size === 0) this.inFlightSends.delete(record.parentKey);
    }
  }

  /**
   * EVERY send of a task's words to its owning scope goes through here. A
   * send that fails, by its result or by throwing, marks the turn's answer
   * as undelivered (part of the turn's result: the inputs it carried stay
   * owed). Only a later send of the same text that goes out clears that
   * mark (the model was told the send failed, and sent it again); a send of
   * other words, which answers something else, does not.
   */
  private async sendOut(record: SubsessionRecord, text: string, harnessPrefix: string): Promise<ScopeSendResult> {
    let result: ScopeSendResult;
    try {
      result = await this.deps.sendToScope(record.parentKey, text, record.sessionKey,
        `Your sub-session ${record.id} ("${record.title}")`, harnessPrefix);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Keyed (and later quoted) without the harness prefix: a model that
    // copies the quote back must not send the prefix twice.
    const prefix = `${taskPrefix(record)} `;
    const words = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const failed = this.undelivered.get(record.id);
    if (result.ok) {
      failed?.delete(words);
      if (failed?.size === 0) this.undelivered.delete(record.id);
    } else if (failed) {
      failed.add(words);
    } else {
      this.undelivered.set(record.id, new Set([words]));
    }
    return result;
  }

  progress(key: string, line: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    const value = line.trim().split("\n")[0].slice(0, 300);
    const updated = this.store.update(record.id, (r) => { r.progress = value; });
    if (updated && value !== record.progress) this.progressChanged.add(record.id);
    return updated;
  }

  checkpoint(key: string, summary: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    this.progressChanged.add(record.id);
    return this.store.update(record.id, (r) => { r.checkpoint = summary.trim().slice(0, 8000); });
  }

  finish(key: string, report: string): TransitionOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, from: null };
    const outcome = this.transition(record.id, "finish", {
      // A live ending: the status no longer comes from a backup.
      patch: (r) => {
        const previous = r.reportSeq ?? (r.report !== undefined ? 1 : 0);
        // A report not yet read (its note still waiting, or never written)
        // is kept beside the new one, never replaced: its note quotes only
        // the start and points to task_status for the rest.
        // Every one still unread is kept (no cap: each is bounded by an
        // unread note, or by a report that never got one); a read one goes.
        const kept = (r.earlierReports ?? []).filter((e) => e.seq !== previous && (!e.noted || this.notePending(r.parentKey, `${r.id}#${e.seq}`)));
        if (r.report !== undefined && previous > 0 && (!r.reportDelivered || this.reportNotePending({ ...r, reportSeq: previous }))) {
          kept.push({ seq: previous, text: r.report, ...(r.reportDelivered ? { noted: true } : {}) });
        }
        r.earlierReports = kept.length > 0 ? kept : undefined;
        r.reportSeq = previous + 1;
        r.report = report.trim();
        r.reportDelivered = false;
        delete r.restored;
      },
    });
    if (!outcome.ok) return outcome;
    this.continueOwed.delete(record.id);
    this.spoke.add(record.id);
    this.safely(() => this.deps.removeCronJobs(key), "remove cron jobs");
    this.deliverReport(outcome.record);
    this.schedule();
    return outcome;
  }

  reopen(key: string): TransitionOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, from: null };
    const outcome = this.transition(record.id, "reopen", { patch: (r) => { r.turnsWithoutProgress = 0; } });
    // The turn that reopened it is running now; its end decides what follows.
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Agent hooks
  // ---------------------------------------------------------------------

  /** A tool call finished on a task session. */
  noteToolUse(key: string): void {
    const record = this.safeByKey(key);
    if (!record) return;
    this.toolCalls.set(record.id, (this.toolCalls.get(record.id) ?? 0) + 1);
  }

  /** A cron job fired on a task key. Returns true when the task took it. */
  onCronFire(key: string, prompt: string): boolean {
    const record = this.safeByKey(key);
    if (!record) {
      log.warn({ key }, "Cron fired on an unknown sub-session; dropping it");
      return false;
    }
    if (!this.available()) {
      log.warn({ key }, "Cron fired on a sub-session while sub-sessions are off; dropping it");
      return false;
    }
    if (TERMINAL_STATUSES.has(record.status) || record.status === "finished") {
      if (this.mayCleanUp(record)) {
        log.info({ id: record.id, status: record.status }, "Cron fired on an ended sub-session; removing its jobs");
        this.safely(() => this.deps.removeCronJobs(key), "remove cron jobs");
      } else {
        log.warn({ id: record.id, status: record.status }, "Cron fired on a sub-session whose ending came from a backup; ignored, its jobs kept");
      }
      return false;
    }
    if (record.status === "waiting" && record.waitingOn === "owner") {
      // Only the owner wakes a task that is waiting on the owner.
      log.info({ id: record.id }, "Cron fired on a sub-session waiting for the owner; ignored");
      return false;
    }
    const outcome = this.transition(record.id, "cron_wake", {
      reason: "scheduled check-back",
      guard: inputQueueFull,
      patch: (r) => { appendInput(r, prompt); },
    });
    if (!outcome.ok) {
      if (outcome.refused) this.tellScope(record, ownerT("subsessions")("inputFull", { id: record.id, title: record.title, max: PENDING_INPUT_MAX }));
      return false;
    }
    if (outcome.record.status === "queued") this.schedule();
    else this.kick(record.id);
    return true;
  }

  /**
   * A turn the SDK started on its own (a background subagent reporting back)
   * just ended on a task key. It ran silently and could not be held; what it
   * changes is the lifecycle. A task waiting on something external is queued
   * with a "continue" owed (the scheduler gives it a slot, as for a cron
   * check-back); an active task with no driver gets one, so auto-continue
   * applies. Waiting on the owner, or finished: nothing changes.
   */
  onBackgroundReport(key: string): void {
    if (!this.available()) return;
    const record = this.safeByKey(key);
    if (!record) return;
    // What it said (task_notify, task_ask) was a round like any other: with
    // mirror "turn", the owning session is woken to see it. A task_ask leaves
    // the task waiting on the owner, so no driver turn would do this later.
    this.mirrorAfterRound(record.id);
    if (TERMINAL_STATUSES.has(record.status)) return;
    const outcome = this.transition(record.id, "background_report", {
      reason: "a background task reported back",
      // Only when it was queued by this event (the status is judged under the lock).
      patch: (r) => {
        const last = r.transitions.at(-1);
        if (r.status === "queued" && last?.event === "background_report" && last.at === r.lastActivityAt) {
          appendInput(r, formatTomoEvent("subsession-continue", "A background task of yours reported back. Continue with the task: finish it, or schedule a check-back if you still have to wait."));
        }
      },
    });
    if (!outcome.ok) return;
    if (outcome.record.status === "queued") {
      this.schedule();
      return;
    }
    if (outcome.record.status === "active" && !this.driving.has(record.id)) {
      this.continueOwed.add(record.id);
      this.kick(record.id);
    }
  }

  /** A background turn on a task key failed: what it said before failing is still mirrored. */
  onBackgroundTurnFailed(key: string): void {
    const record = this.safeByKey(key);
    if (record) this.mirrorAfterRound(record.id);
  }

  /** The restart the task claimed was not launched: it is not the task's own any more. */
  onRestartClaimFailed(key: string): void {
    const record = this.safeByKey(key);
    if (!record?.restartRequested) return;
    try {
      this.store.update(record.id, (r) => { r.restartRequested = false; });
    } catch (err) {
      log.error({ err, key }, "Could not withdraw a sub-session's own restart request");
    }
  }

  /** The task itself asked for the daemon restart: remembered before the restart starts. */
  onRestartClaimed(key: string): void {
    const record = this.safeByKey(key);
    if (!record) return;
    try {
      this.store.update(record.id, (r) => { r.restartRequested = true; });
    } catch (err) {
      log.error({ err, key }, "Could not record a sub-session's own restart request");
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle of the service
  // ---------------------------------------------------------------------

  /**
   * Startup, step 1, before any channel starts ingesting: read the table,
   * then restart recovery (synchronous, idempotent) runs to completion, then
   * reconcile and the sweep. None of these schedules or runs a turn, and
   * what they would tell the owner waits for start(). Until this returns,
   * `available()` is false, so no input reaches a task recovery has not
   * looked at. Safe to call more than once.
   */
  recoverAtStartup(): void {
    if (this.recovered || this.broken || !this.deps.config().enabled) return;
    let startState: ReturnType<SubsessionStore["state"]>;
    try {
      const table = this.store.read();
      // Captured before anything below writes: a write turns "recovered" or
      // "missing" into "ok", and reconcile must judge the table as it was read.
      startState = this.store.state();
      this.startState = startState;
      this.trustedAtStart = (startState === "ok" || startState === "missing") && !table.untrusted;
    } catch (err) {
      this.broken = true;
      log.error({ err, path: this.store.path }, "Sub-session table unreadable; sub-sessions are off until it is repaired. Nothing was unlinked or cancelled.");
      this.noticeOwner(ownerT("subsessions")("tableUnreadable"));
      return;
    }
    try {
      this.recover();
    } catch (err) {
      // Half a recovery must not be scheduled on: what is left is done by the
      // next start (recovery is idempotent).
      this.broken = true;
      log.error({ err }, "Sub-session restart recovery could not finish; sub-sessions are off until the next start");
      this.noticeOwner(ownerT("subsessions")("recoveryFailed"));
      return;
    }
    // The todos follow the table: a crash between a recovery write and its
    // todo update (here, or in the process that died) leaves no stale line.
    // Ended tasks too: a crash right after `finished`, `cancelled` or
    // `failed` was written left their line saying it is still working. And a
    // task whose todo was made but whose record never got the id adopts it.
    this.safely(() => {
      const todos = this.deps.config().todos && this.deps.todos !== undefined;
      for (const task of this.store.list()) {
        const open = OPEN_STATUSES.has(task.status);
        if (task.status === "archived" || (!open && !todos)) continue;
        // An ended task only finds its todo (to close or update it), never gets a new one.
        if (!task.todoId && todos) this.adoptTodo(task, open);
        this.syncTodo(this.store.get(task.id) ?? task);
      }
    }, "todo resync");
    this.safely(() => this.reconcile(startState), "reconcile");
    this.safely(() => this.sweep(), "sweep");
    this.recovered = true;
  }

  /**
   * Startup, step 2, once the channels are up and the inbox is replayed:
   * send what recovery had to say, then open dispatch with the one
   * schedule() call, and start the driver of every task that already has a
   * turn owed (a finished task whose answer was cut short, a task input
   * reached while dispatch was closed).
   */
  start(): void {
    if (this.started || !this.deps.config().enabled) return;
    this.started = true;
    this.recoverAtStartup();
    this.live = true;
    const deferred = this.deferred;
    this.deferred = [];
    for (const effect of deferred) this.safely(effect, "deferred notice");
    if (!this.recovered) return;
    this.open = true;
    const owed = [...this.startsOwed];
    this.startsOwed.clear();
    for (const [id, reason] of owed) this.safely(() => { this.startTask(id, reason); }, "owed start");
    this.schedule();
    this.safely(() => {
      for (const task of this.store.list()) {
        if (task.status !== "queued" && !TERMINAL_STATUSES.has(task.status) && this.plan(task)) this.kick(task.id);
      }
    }, "resume owed turns");
    this.sweepTimer = setInterval(() => this.safely(() => this.sweep(), "sweep"), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Run an outward effect now, or once start() has the channels up. */
  private outward(effect: () => void): void {
    if (this.live) effect();
    else this.deferred.push(effect);
  }

  /**
   * THE one check before destructive cleanup (unlinking a registry entry,
   * archiving or forgetting a task, removing its cron jobs). The table this
   * process started from must have been read cleanly from the primary and
   * not be marked untrusted, and the record (when there is one) must not
   * come from a backup: a status restored from `.bak` may be older than what
   * happened (the lost primary may have reopened a task the backup says
   * finished). Without a record: may an entry the table does not know be
   * unlinked (the table must also have existed and hold tasks: an empty or
   * missing one next to task entries in the registry is a lost table, not a
   * cleanup).
   */
  private mayCleanUp(record?: SubsessionRecord): boolean {
    if (!this.trustedAtStart) return false;
    const table = this.store.read();
    if (table.untrusted) return false;
    if (!record) return this.startState === "ok" && table.tasks.length > 0;
    return !record.restored;
  }

  stop(): void {
    this.open = false;
    this.startsOwed.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.reportTimers.values()) clearTimeout(timer);
    this.reportTimers.clear();
    this.reportAttempts.clear();
    this.unpersistedReports.clear();
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    if (this.cronRecheckTimer) clearTimeout(this.cronRecheckTimer);
    this.cronRecheckTimer = undefined;
    if (this.registryRecheckTimer) clearTimeout(this.registryRecheckTimer);
    this.registryRecheckTimer = undefined;
    this.registryHeld.clear();
  }

  /**
   * No turn runs at start: an active task's stretch ended when this process
   * last saw it working (`activeSeenAt`), not now. Bank up to there and start
   * the stretch again, so the time Tomo was down never counts toward the
   * active-time cap. (A record from before `activeSeenAt` banks nothing for
   * that stretch: undercounting is the safe side.)
   */
  private settleDowntime(): void {
    const now = this.now();
    for (const task of this.store.list()) {
      if (task.status !== "active" || task.activeSince === undefined) continue;
      this.store.update(task.id, (r) => {
        if (r.status !== "active" || r.activeSince === undefined) return;
        const seen = Math.min(now, Math.max(r.activeSince, r.activeSeenAt ?? r.activeSince));
        r.activeMs += seen - r.activeSince;
        r.activeSince = now;
        r.activeSeenAt = now;
        // The owner's last word may have come after the last heartbeat: its
        // mark can't be past what was banked, or the cap would get that time back.
        if (r.activeAtOwnerInputMs !== undefined) r.activeAtOwnerInputMs = Math.min(r.activeAtOwnerInputMs, r.activeMs);
      });
    }
  }

  /**
   * Restart recovery: one synchronous pass over the table, before reconcile
   * and before anything is scheduled. No turn runs at start, so:
   * - an ACTIVE task was cut short: it is queued to resume (or waits for the
   *   owner, if it restarted Tomo itself; or fails after too many restarts);
   * - a WAITING task that still owes inputs (or its start) it does not hold
   *   on purpose (`heldThrough`) had its last turn cut short after that turn
   *   moved it to waiting (task_ask): they are still owed a completed turn,
   *   so it is queued to resume too;
   * - every input still pending on those, and on a finished task, may have
   *   gone out in the turn that was cut short: `seenThrough` says so.
   * Each task's decision is ONE transition (or update) that also moves it
   * out of the state that triggers it, so running this twice (a crash in the
   * middle of it) gives the same table as running it once.
   */
  private recover(): void {
    // Time first: a task still marked active banks up to when it was last
    // seen working, before the transition below moves it out of active.
    this.settleDowntime();
    for (const task of this.store.list()) {
      const last = lastInputSeq(task);
      // Owed and not held: inputs above heldThrough, or a start no turn
      // completed when nothing was ever held.
      const cutShortWaiting = task.status === "waiting"
        && (last > (task.heldThrough ?? 0) || (!task.startDelivered && task.heldThrough === undefined));
      if (task.status === "active" && task.restartRequested) {
        const outcome = this.transition(task.id, "self_restart", {
          reason: "it restarted Tomo itself",
          expectFrom: ["active"],
          patch: (r) => {
            r.restartRequested = false;
            // Waiting on the owner now: anything it held is the owner's to wake.
            r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r));
            r.heldThrough = lastInputSeq(r);
          },
        });
        if (outcome.ok && outcome.changed) this.tellScope(outcome.record, ownerT("subsessions")("selfRestart", { id: task.id, title: task.title }));
        continue;
      }
      if (task.status === "active" || cutShortWaiting) {
        if (task.interruptStreak + 1 > MAX_INTERRUPT_STREAK) {
          const failed = this.transition(task.id, "fail", { reason: `interrupted by ${MAX_INTERRUPT_STREAK + 1} restarts in a row`, expectFrom: [task.status] });
          if (failed.ok && failed.changed) this.reportFailure(failed.record, ownerT("subsessions")("failedInterrupted", { id: task.id, title: task.title, restarts: MAX_INTERRUPT_STREAK + 1 }));
          continue;
        }
        if (cutShortWaiting) log.warn({ id: task.id, inputs: task.pendingInput.length }, "Sub-session's last turn was cut short while it waited; resuming it");
        this.transition(task.id, cutShortWaiting ? "recover_cut_short" : "restart", {
          reason: cutShortWaiting ? "Tomo restarted before its last turn completed" : "Tomo restarted",
          expectFrom: [task.status],
          patch: (r) => {
            r.resumeNeeded = true;
            r.interruptStreak += 1;
            r.restartRequested = false;
            r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r));
          },
        });
        continue;
      }
      if (task.status === "finished" && last > task.seenThrough) {
        // Its answer turn may have been cut short with these in it.
        this.store.update(task.id, (r) => { r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r)); });
      }
    }
  }

  /**
   * The table rules, at start. The table wins; writes go table-first.
   * Unlinking a registry entry the table does not know happens only when the
   * table read cleanly AND holds tasks: an empty or recovered table next to
   * task entries in the registry is a lost table, not a cleanup.
   */
  private reconcile(startState: ReturnType<SubsessionStore["state"]>): void {
    const table = this.store.read();
    // What the registry says (which task sessions it has, whether a task's
    // conversation is there) decides unlinks, the untrusted mark and failing
    // a task: from an unreadable registry, it says "nothing", which is not
    // true. None of it runs then; the next start reconciles again.
    const registryReadable = this.deps.registryReadable();
    if (!registryReadable) log.error("Session registry unreadable at start; sub-session reconcile acts on nothing it says");
    const known = new Set(table.tasks.map((t) => t.sessionKey));
    const orphans = registryReadable ? this.deps.registryTaskKeys().filter((k) => !known.has(k)) : [];
    if (!registryReadable) {
      // Nothing known about orphans: no unlink, and the mark stays.
    } else if (orphans.length === 0) {
      if (table.untrusted && !table.tasks.some((t) => t.restored)) {
        log.info({ since: table.untrusted.since, reason: table.untrusted.reason }, "Every registry task session is known to the task table again; trusting it");
        this.store.clearUntrusted();
      }
    } else {
      // Whatever happens to them, no new task may take one of their ids.
      const highest = Math.max(0, ...orphans.map(taskNumber));
      if (highest >= table.nextId) this.store.reserveIdsThrough(highest);
      // "ok" as it was READ at start, and never recovered or lost since (the
      // mark survives every write and restart): a table recovered from an
      // older backup is "ok" on disk after its first write.
      if (this.mayCleanUp()) {
        for (const key of orphans) {
          log.warn({ key }, "Registry has a task session the task table does not know; unlinking it");
          this.safely(() => this.deps.unlinkRegistryEntry(key), "unlink orphan");
        }
      } else {
        log.error({ orphans, startState, untrusted: table.untrusted, tasks: table.tasks.length }, "Task table looks lost or recovered while the registry has task sessions; unlinking nothing");
        // Told once per loss: a later start finds the mark and stays quiet.
        if (!table.untrusted || startState === "recovered") this.noticeOwner(ownerT("subsessions")("tableLost", { count: orphans.length }));
        if (!table.untrusted) this.store.markUntrusted(startState === "recovered" ? "recovered" : "lost");
      }
    }
    for (const task of this.store.list()) {
      if ((TERMINAL_STATUSES.has(task.status) || task.status === "finished") && this.mayCleanUp(task)) {
        // Unknown (cron unreadable) is tried too; removing throws then, and is logged.
        if (this.deps.cronJobCount(task.sessionKey) !== 0) this.safely(() => this.deps.removeCronJobs(task.sessionKey), "remove cron jobs");
      }
      if (task.status === "finished" && !task.reportDelivered) this.deliverReport(task);
      else if (task.status === "finished" && this.reportNotePending(task)) {
        // Delivered, and its note still unread: the wake that was queued for
        // it lived in memory and may have died with the process. The note is
        // on disk, so the wake is owed again.
        this.wakeForReport(task);
      }
      if (registryReadable && OPEN_STATUSES.has(task.status) && !this.deps.hasSdkSession(task.sessionKey)) {
        if (task.startDelivered) {
          // A turn completed, so it did things, and the registry came back
          // without its conversation: it cannot resume, and starting it over
          // without that history could repeat what it did.
          const failed = this.transition(task.id, "fail", { reason: "its conversation could not be found after a restart" });
          if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: task.id, title: task.title }));
          continue;
        }
        // No turn of it ever completed. If its first turn was cut short, the
        // SDK session id is linked as soon as the SDK reports it (before any
        // tool call), so without one that turn almost surely did nothing; it
        // starts over, and recovery has set resumeNeeded, so the new first
        // turn also tells it to check for side effects first.
        this.safely(() => this.deps.ensureRegistryEntry(task.sessionKey), "registry entry");
      }
    }
    // Queues what it wakes; start() schedules once everything here is done.
    this.checkExternalWaits("after a restart");
  }

  /**
   * A task waiting on its check-back whose job is gone (the cron store is
   * not fsynced, or was unreadable when the task parked) would wait forever:
   * let it run again and schedule a new one itself. A store that still
   * cannot be read is looked at again shortly, in this process. Never
   * schedules: the caller does, once it is safe to.
   */
  private checkExternalWaits(when: string): void {
    let unknown = false;
    for (const task of this.store.list()) {
      if (task.status !== "waiting" || task.waitingOn !== "external") continue;
      const jobs = this.deps.cronJobCount(task.sessionKey);
      if (jobs === undefined) { unknown = true; continue; }
      if (jobs > 0) continue;
      this.transition(task.id, "cron_wake", {
        reason: `its check-back job was missing ${when}`,
        guard: inputQueueFull,
        patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "Your scheduled check-back is missing (lost in a restart, or never saved). Check on what you were waiting for, and schedule a new check-back if you still need to wait.")); },
      });
    }
    if (unknown) this.armCronRecheck();
  }

  private armCronRecheck(): void {
    if (this.cronRecheckTimer || this.deps.isStopping()) return;
    this.cronRecheckTimer = setTimeout(() => {
      this.cronRecheckTimer = undefined;
      this.safely(() => this.checkExternalWaits("once the cron store could be read again"), "cron recheck");
      this.schedule();
    }, CRON_RECHECK_MS);
    this.cronRecheckTimer.unref?.();
  }

  /** Archive finished tasks after 7 days; forget ended ones after 30. Only what mayCleanUp allows. */
  private sweep(): void {
    const now = this.now();
    const forget: string[] = [];
    for (const task of this.store.list()) {
      if (!this.mayCleanUp(task)) continue;
      // A finished task still owing an answer (pending, or held for the
      // owner's next message) stays finished: archived, it could never be
      // woken to give it, and its input would go with the record.
      // Nor is a task archived or forgotten while its report note is still
      // unread: the note holds only the start of the report, and points to
      // task_status for the rest.
      if (this.reportNotePending(task) || this.earlierReportPending(task)) continue;
      if (task.status === "finished" && task.reportDelivered && task.pendingInput.length === 0
        && now - (task.endedAt ?? task.lastActivityAt) > FINISHED_KEEP_MS) {
        const outcome = this.transition(task.id, "archive", { reason: "finished more than 7 days ago" });
        if (outcome.ok) this.safely(() => this.deps.unlinkRegistryEntry(task.sessionKey), "unlink archived");
      } else if (TERMINAL_STATUSES.has(task.status) && now - (task.endedAt ?? task.lastActivityAt) > ENDED_KEEP_MS) {
        // A failed task's unanswered owner input goes only once it is handed
        // back in full; a handback that could not be written is tried again here.
        if (task.status === "failed" && !task.handedBack && task.pendingInput.some(isOwnerInput) && !this.handBack(task)) continue;
        forget.push(task.id);
      }
    }
    // Cancelled and failed tasks keep their registry link until here, so /s
    // can still show them; dropped together with the record.
    for (const id of forget) {
      const task = this.store.get(id);
      if (task && task.status !== "archived") this.safely(() => this.deps.unlinkRegistryEntry(task.sessionKey), "unlink ended");
    }
    this.store.remove(forget);
  }

  // ---------------------------------------------------------------------
  // Scheduler and driver
  // ---------------------------------------------------------------------

  /**
   * THE one place autonomous work gets a slot: a queued task (new, woken by
   * cron, or resuming after a restart) becomes active while fewer than
   * maxRunning are. Owner input never waits here.
   */
  schedule(): void {
    if (!this.open || !this.available() || this.deps.isStopping()) return;
    let tasks: SubsessionRecord[];
    try {
      tasks = this.store.list();
    } catch (err) {
      log.error({ err }, "Sub-session scheduler could not read the task table");
      return;
    }
    let active = tasks.filter((t) => t.status === "active").length;
    const queued = tasks.filter((t) => t.status === "queued")
      .sort((a, b) => Number(b.resumeNeeded) - Number(a.resumeNeeded) || a.createdAt - b.createdAt);
    const max = this.deps.config().maxRunning;
    for (const task of queued) {
      if (active >= max) break;
      if (this.startQueued(task.id, "a slot is free", false)) active += 1;
    }
  }

  /** queued → active and run. `/s <id> start` (Phase 1b) calls this past the slot cap. */
  startTask(id: string, reason: string): boolean {
    return this.startQueued(id, reason, true, true);
  }

  /**
   * `owed`: a start that does not wait for a slot (the owner's, or one owed
   * from before dispatch opened). Held by mayRun, it stays owed and is made
   * past the cap the moment the hold ends; the scheduler's own starts are
   * simply asked again by the next schedule().
   */
  private startQueued(id: string, reason: string, owed: boolean, byOwner = false): boolean {
    if (!this.open) {
      // Before start(): owed, and made the moment dispatch opens.
      if (!this.recovered || this.deps.isStopping()) return false;
      this.startsOwed.set(id, reason);
      return true;
    }
    const record = this.safeGet(id);
    if (!record || record.status !== "queued") return false;
    const may = this.mayRun(record);
    if (may !== "run") {
      if (may === "held" && owed) this.startsOwed.set(id, reason);
      return false;
    }
    this.startsOwed.delete(id);
    const now = this.now();
    const outcome = this.transition(id, "start", {
      reason,
      expectFrom: ["queued"],
      // The owner's word: the wall-clock cap counts from here again.
      ...(byOwner ? { patch: (r: SubsessionRecord) => { r.activeAtOwnerInputMs = activeTotalMs(r, now); } } : {}),
    });
    if (!outcome.ok) return false;
    if (byOwner) this.ownerStarted.add(id);
    this.kick(id);
    return true;
  }

  /**
   * May the task run a turn now, on its own history? A turn on a key with no
   * live session resumes the SDK session the registry links. While the
   * registry cannot be read, that link is unknown (a fresh process holds an
   * empty last-good state), and a turn would start a NEW conversation: the
   * task is held, and looked at again shortly. Readable, with no link, for a
   * task that completed a turn: its history is gone, and starting over could
   * repeat what it did, so it fails, said plainly. Every dispatch (a start,
   * every driver turn) asks here first.
   */
  private mayRun(record: SubsessionRecord): "run" | "held" | "failed" {
    if (this.deps.hasLiveSession?.(record.sessionKey)) return "run";
    if (!this.deps.registryReadable()) {
      log.error({ id: record.id }, "Session registry unreadable; holding a sub-session turn rather than start it without its history");
      if (!this.registryHoldTold) {
        this.registryHoldTold = true;
        this.noticeOwner(ownerT("subsessions")("registryHold"));
      }
      this.registryHeld.add(record.id);
      this.armRegistryRecheck();
      return "held";
    }
    if (record.startDelivered && !this.deps.hasSdkSession(record.sessionKey)) {
      const failed = this.transition(record.id, "fail", { reason: "its conversation could not be found" });
      if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: record.id, title: record.title }));
      return "failed";
    }
    return "run";
  }

  /** A turn of this task is held until the session registry can be read again. */
  isHeld(id: string): boolean {
    return this.registryHeld.has(id);
  }

  private armRegistryRecheck(): void {
    if (this.registryRecheckTimer || this.deps.isStopping()) return;
    this.registryRecheckTimer = setTimeout(() => {
      this.registryRecheckTimer = undefined;
      if (this.deps.isStopping()) return;
      if (this.deps.registryReadable()) this.registryHoldTold = false;
      // Every held task is asked again (mayRun holds it afresh if it must).
      this.registryHeld.clear();
      const owed = [...this.startsOwed];
      // Every owed start is the owner's (/s start): it keeps its pass past the gate.
      for (const [id, reason] of owed) this.safely(() => { this.startTask(id, reason); }, "owed start");
      this.schedule();
      this.safely(() => {
        for (const task of this.store.list()) {
          if (task.status !== "queued" && !TERMINAL_STATUSES.has(task.status) && this.plan(task)) this.kick(task.id);
        }
      }, "resume held turns");
    }, REGISTRY_RECHECK_MS);
    this.registryRecheckTimer.unref?.();
  }

  private deliverInput(
    id: string,
    event: Extract<SubsessionEvent, "relay" | "owner_message">,
    prompt: string,
    words: string,
    extra?: (record: SubsessionRecord) => void,
  ): TransitionOutcome {
    const now = this.now();
    const outcome = this.transition(id, event, {
      reason: event === "relay" ? "a message from the main session" : "a message from the owner",
      guard: inputQueueFull,
      patch: (r) => {
        appendInput(r, prompt, { from: "owner", words });
        // The owner's word: the wall-clock cap counts from here again.
        r.activeAtOwnerInputMs = activeTotalMs(r, now);
        extra?.(r);
      },
    });
    if (!outcome.ok) return outcome;
    if (outcome.record.status !== "queued") {
      this.kick(id);
      return outcome;
    }
    // Queued: a relay waits for its slot and goes with the first turn. The
    // owner's message never waits for a slot: it starts the task, like
    // `/s <id> start`.
    if (event === "owner_message") {
      try {
        this.startTask(id, "the owner wrote to it");
      } catch (err) {
        // The message is on the task already: it must not be reported as
        // undelivered (the caller would hand it to the owning session too).
        // The start is owed, and made again at the next recheck.
        log.error({ err, id }, "Could not start a queued sub-session for the owner's message; trying again shortly");
        this.startsOwed.set(id, "the owner wrote to it");
        this.armRegistryRecheck();
      }
      return { ...outcome, record: this.safeGet(id) ?? outcome.record };
    }
    return outcome;
  }

  /** Run the task's driver unless one is running. */
  private kick(id: string): void {
    // Closed until start(): start() kicks every task with a turn owed.
    if (!this.open || this.driving.has(id) || this.settleTimers.has(id) || this.registryHeld.has(id) || this.deps.isStopping()) return;
    this.driving.add(id);
    void this.drive(id)
      .catch((err) => log.error({ err, id }, "Sub-session driver failed"))
      .finally(() => {
        this.driving.delete(id);
        // Input that arrived while the last turn was ending.
        const record = this.safeGet(id);
        if (record && record.status !== "queued" && !TERMINAL_STATUSES.has(record.status) && this.plan(record)) this.kick(id);
        this.schedule();
      });
  }

  private async drive(id: string): Promise<void> {
    for (;;) {
      if (this.deps.isStopping()) return;
      const record = this.safeGet(id);
      if (!record || record.status === "queued" || TERMINAL_STATUSES.has(record.status)) return;
      const turn = this.plan(record);
      if (!turn) return;
      if (this.mayRun(record) !== "run") return;
      // A turn the task gives itself (a continue, a check-back, its start)
      // first passes the wall-clock cap and the quota gate.
      let gate: "run" | "paused" | "again";
      try {
        gate = this.gateOwnTurn(record, turn.kind === "compact");
      } catch (err) {
        // The pause could not be written: no turn now (it would run past the
        // gate), and none at once (that would spin); the retry timer asks again.
        log.error({ err, id }, "Could not pause a sub-session at its cap or quota gate; trying again later");
        this.retryAfterSettleFailure(id);
        return;
      }
      if (gate === "paused") return;
      if (gate === "again") continue;
      // Nothing is written before the turn, and nothing it owes is forgotten
      // before it: its inputs, and a "continue" owed, leave with the write
      // that records its result (a retry after a failed write finds them).
      this.toolCalls.delete(id);
      this.undelivered.delete(id);
      this.progressChanged.delete(id);
      this.spoke.delete(id);
      // While the turn runs, a heartbeat: a crash banks active time up to
      // here. (Not a dispatch marker: restart recovery reads only the time.)
      const heartbeat = setInterval(() => this.safely(() => this.store.update(id, (r) => {
        if (r.status === "active") r.activeSeenAt = this.now();
      }), "active heartbeat"), ACTIVE_HEARTBEAT_MS);
      heartbeat.unref?.();
      this.inflightThrough.set(id, turn.throughSeq);
      let outcome: TaskTurnOutcome;
      try {
        outcome = await this.deps.runTaskTurn(record.sessionKey, turn.prompt, { bare: turn.kind === "compact" });
        if (!outcome.shutdown) outcome = await this.answerUnanswered(id, turn, outcome);
      } finally {
        clearInterval(heartbeat);
        this.inflightThrough.delete(id);
      }
      if (!this.afterTurn(id, turn, outcome)) return;
    }
  }

  /**
   * The owner wrote and the task answered nothing through its tools: what it
   * wrote as text goes out once, through the same prefixed path, BEFORE the
   * turn's result is written. If the send fails, nothing is kept aside: the
   * owner's input stays on the record (marked as possibly seen, like any
   * input of a turn that did not complete) and the next turn answers again.
   * Failures count toward the usual fail streak, so it cannot loop.
   */
  private async answerUnanswered(id: string, turn: PlannedTurn, outcome: TaskTurnOutcome): Promise<TaskTurnOutcome> {
    const text = outcome.response?.trim();
    if (!outcome.ok || !turn.fromOwner || this.spoke.has(id)) return outcome;
    if (!text) {
      // It said nothing at all: the owner's message is unanswered, and stays
      // like one whose answer could not be sent (the fail streak bounds it).
      log.warn({ id }, "Sub-session gave no answer to the owner's message; it stays for the next turn");
      return { ...outcome, answerUndelivered: true };
    }
    const key = this.safeGet(id)?.sessionKey;
    if (!key) return outcome;
    let sent: { ok: boolean; error?: string };
    try {
      sent = await this.speak(key, "fallback", truncate(text, FALLBACK_MAX));
    } catch (err) {
      sent = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (sent.ok) return outcome;
    log.warn({ id, error: sent.error }, "Sub-session fallback answer failed; the owner's message stays for the next turn");
    return { ...outcome, answerUndelivered: true };
  }

  /** What the task's next turn is, if it has one. */
  private plan(record: SubsessionRecord): PlannedTurn | undefined {
    // Waiting: only the events that wake it (and move it out of waiting) give it a turn.
    if (record.status === "queued" || record.status === "waiting" || TERMINAL_STATUSES.has(record.status)) return undefined;
    // Finished: it answers what it is sent (a message, a relay), nothing more.
    const active = record.status === "active";
    const start = active && !record.startDelivered;
    // A first turn cut short gets both: the start event (it never completed)
    // and the resume warning (it may have done things before it was cut).
    const resume = active && record.resumeNeeded;
    const inputs = record.pendingInput;
    const throughSeq = inputs.at(-1)?.seq ?? 0;
    // A finished task's inputs it gave up answering are kept, held for the
    // owner's next message, which brings them all back.
    if (!active && throughSeq <= (record.heldThrough ?? 0)) return undefined;
    const owed = record.status === "active" && this.continueOwed.has(record.id);
    if (!start && !resume && inputs.length === 0 && !owed) return undefined;
    // Compact first, but only ahead of a turn the task has anyway: an idle or
    // finished task is not woken just to be compacted.
    if (record.compactPending) {
      return { kind: "compact", prompt: `/compact ${compactInstructions(record)}`, throughSeq: 0, afterCompact: false, fromOwner: false, resume: false, start: false };
    }
    const afterCompact = record.postCompactReminder;
    const parts: string[] = [];
    if (afterCompact) parts.push(formatPostCompactReminder(record));
    if (start) parts.push(formatStartEvent(record));
    if (resume) parts.push(formatResumeEvent(record));
    // Seq order: the inputs that may have been seen are a prefix.
    const seenThrough = Math.max(record.seenThrough, this.unsavedSeen.get(record.id) ?? 0);
    const seen = inputs.filter((i) => i.seq <= seenThrough).length;
    if (seen > 0) {
      parts.push(formatRedeliveryNote(seen));
      parts.push(...inputs.slice(0, seen).map((i) => i.text));
      if (inputs.length > seen) parts.push(formatNewInputNote(), ...inputs.slice(seen).map((i) => i.text));
    } else {
      parts.push(...inputs.map((i) => i.text));
    }
    const lostAnswer = this.answerLost.get(record.id);
    if (lostAnswer && seen > 0) parts.push(formatLostAnswerNote(lostAnswer, LOST_ANSWER_EXCERPT));
    const kind = start || resume || inputs.length > 0 ? "wake" : "continue";
    if (kind === "continue") parts.push(formatContinueEvent());
    const fromOwner = inputs.some((input) => input.text.includes(OWNER_MESSAGE_MARKER));
    return { kind, prompt: parts.join("\n\n"), throughSeq, afterCompact, fromOwner, resume, start };
  }

  /**
   * Record a turn's result. The inputs it carried leave the record in this
   * one write, with everything else the result changes; until it succeeds,
   * none of them is consumed. Returns false when the driver must stop.
   */
  private afterTurn(id: string, turn: PlannedTurn, outcome: TaskTurnOutcome): boolean {
    if (outcome.shutdown) {
      // Never an outcome. Its inputs are still on the record; the next
      // start's recovery marks them as possibly seen.
      return false;
    }
    const tools = this.toolCalls.get(id) ?? 0;
    const progressed = tools > 0 || this.progressChanged.has(id);
    this.toolCalls.delete(id);
    this.progressChanged.delete(id);
    this.spoke.delete(id);

    this.mirrorAfterRound(id);

    if (turn.kind === "compact") {
      try {
        this.store.update(id, (r) => {
          r.compactPending = false;
          if (outcome.ok) r.postCompactReminder = true;
        });
      } catch (err) {
        log.error({ err, id }, "Could not record a sub-session compact; trying again later");
        this.retryAfterSettleFailure(id);
        return false;
      }
      return true;
    }

    let record: SubsessionRecord | undefined;
    // A completed turn whose message (or fallback answer) could not be
    // delivered, or that gave the owner no answer at all, did not answer
    // what it carried: like a failed turn, it keeps its inputs. A turn that
    // carried none has nothing to keep.
    const failedTexts = [...(this.undelivered.get(id) ?? [])];
    const lost = (failedTexts.length > 0 && turn.throughSeq > 0) || outcome.answerUndelivered === true;
    this.undelivered.delete(id);
    const keep = !outcome.ok || lost;
    // A finished task's answer that keeps failing (or that the owner
    // stopped) is held, never deleted: plan() would run a finished task
    // again at once while its input is pending, so it waits for the owner's
    // next message, which brings the held inputs back with it.
    let held: string[] = [];
    try {
      record = this.store.update(id, (r) => {
        if (r.status === "active") r.activeSeenAt = this.now();
        if (outcome.ok) {
          r.interruptStreak = 0;
          if (turn.start) r.startDelivered = true;
          if (turn.resume) r.resumeNeeded = false;
          if (turn.afterCompact) r.postCompactReminder = false;
        }
        if (!keep) {
          r.failStreak = 0;
          r.pendingInput = r.pendingInput.filter((i) => i.seq > turn.throughSeq);
        } else {
          r.failStreak += 1;
          // They stay first in line, marked as possibly seen: the turn may
          // have acted on part of them.
          r.seenThrough = Math.max(r.seenThrough, turn.throughSeq);
          if (r.status === "finished" && (outcome.stopped || r.failStreak >= MAX_FAIL_STREAK)) {
            r.failStreak = 0;
            // What this turn carried, and nothing newer: input that arrived
            // during it was never part of the failing answer and gets a turn.
            held = r.pendingInput.filter((i) => i.seq <= turn.throughSeq).map((i) => (i.words ?? i.text).trim());
            r.heldThrough = Math.max(r.heldThrough ?? 0, turn.throughSeq);
          }
        }
        const usage = this.deps.contextUsage(r.sessionKey);
        if (outcome.ok && usage && !usage.estimated && usage.used > this.deps.config().maxContextTokens && !r.compactPending) {
          log.info({ id, used: usage.used, limit: this.deps.config().maxContextTokens }, "Sub-session context over its limit; compacting before the next turn");
          r.compactPending = true;
        }
      });
    } catch (err) {
      // Nothing was consumed: the inputs go out again, said to be possibly
      // seen (this turn may have acted on them), after a pause so a disk that
      // keeps failing does not spin the task. A "continue" owed is still owed.
      log.error({ err, id }, "Could not record a sub-session turn's result; its inputs stay and go out again");
      if (turn.throughSeq > 0) this.unsavedSeen.set(id, Math.max(this.unsavedSeen.get(id) ?? 0, turn.throughSeq));
      if (lost) this.answerLost.set(id, failedTexts);
      this.retryAfterSettleFailure(id);
      return false;
    }
    this.unsavedSeen.delete(id);
    if (lost && held.length === 0) this.answerLost.set(id, failedTexts);
    else if (!keep || held.length > 0) this.answerLost.delete(id);
    if (!record || record.status !== "active") {
      this.continueOwed.delete(id);
      if (record && held.length > 0) this.handOverUnanswered(record, held);
      return true;
    }
    // Still active, so it owes a continue until a transition out of active is
    // WRITTEN. Marked before anything below writes: a pause, a wait or the
    // progress count that throws leaves the task with a turn owed, never
    // active with no driver and nothing planned.
    this.continueOwed.add(id);
    try {
      this.afterActiveTurn(record, turn, keep, outcome.stopped === true, progressed);
    } catch (err) {
      log.error({ err, id }, "Could not record what follows a sub-session turn; it stays active and continues");
    }
    return true;
  }

  /** The rest of a completed active turn's result: a pause, a wait, or nothing (it continues). */
  private afterActiveTurn(record: SubsessionRecord, turn: PlannedTurn, keep: boolean, stopped: boolean, progressed: boolean): void {
    const id = record.id;
    // Input that arrived during the turn (a relay, a check-back) was not
    // part of what was stopped or failed: it gets its turn first.
    const carried = turn.throughSeq;
    const newInput = (why: string) => (r: SubsessionRecord) => (r.pendingInput.some((i) => i.seq > carried) ? why : undefined);
    if (keep) {
      if (stopped) {
        this.pause(record, "stopped by the owner", ownerT("subsessions")("stopped", { id: record.id, title: record.title }),
          newInput("new input arrived during the stopped turn"));
      } else if (record.failStreak >= MAX_FAIL_STREAK) {
        // A failed turn's own inputs are still pending, and stay for the wake.
        this.pause(record, "its turns keep failing", ownerT("subsessions")("failing", { id: record.id, title: record.title }),
          newInput("new input arrived during the failed turn"));
      }
      return;
    }
    // Input that arrived during the turn gets a turn before any wait: the
    // waits below are also guarded under the lock, for input that lands
    // between this read and the transition.
    if (record.pendingInput.length > 0) return;
    const jobs = this.deps.cronJobCount(record.sessionKey);
    if (jobs === undefined || jobs > 0) {
      // Unknown (the cron store cannot be read) parks it too: auto-continuing
      // could spin on a check-back that exists. A fire, or the next start's
      // reconcile once the store reads again, wakes it.
      const waited = this.transition(id, "wait_external", {
        reason: jobs === undefined ? "waiting for its check-back (the cron store could not be read)" : "waiting for its scheduled check-back",
        expectFrom: ["active"],
        guard: hasPendingInput,
      });
      if (!waited.ok) return;
      this.continueOwed.delete(id);
      if (jobs === undefined) this.armCronRecheck();
      this.schedule();
      return;
    }
    if (!turn.afterCompact) {
      const streak = progressed ? 0 : record.turnsWithoutProgress + 1;
      this.store.update(id, (r) => { r.turnsWithoutProgress = streak; });
      if (streak >= MAX_TURNS_WITHOUT_PROGRESS) {
        this.pause(record, `${streak} turns in a row without progress`, ownerT("subsessions")("stuck", { id: record.id, title: record.title, turns: streak }), hasPendingInput);
      }
    }
  }

  /**
   * A finished task could not answer what it was sent (stopped, or its
   * turns kept failing). The messages stay on the task, held for the
   * owner's next message to it; the owning session gets a copy in a note
   * and is woken, so it can tell the owner or answer them itself.
   */
  private handOverUnanswered(record: SubsessionRecord, texts: string[]): void {
    this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-unanswered",
      `Sub-session ${record.id} ("${record.title}") is finished and could not answer what it was sent (it was stopped, or its turns kept failing). The task keeps these messages and gets them again with the owner's next message to it. What it was sent:\n\n${texts.join("\n\n")}`,
      { name: record.id }));
    this.outward(() => this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-unanswered",
      "A finished sub-session could not answer what it was sent; the messages are in a note above. Answer the owner yourself if you can, or tell them the task will get the messages again when they next write to it.",
      { name: "check" })));
    this.tellScope(record, ownerT("subsessions")("finishedUnanswered", { id: record.id, title: record.title }));
  }

  /** The result could not be written: no turn for this task until a timer gives it one. */
  private retryAfterSettleFailure(id: string): void {
    if (this.settleTimers.has(id) || this.deps.isStopping()) return;
    const timer = setTimeout(() => {
      this.settleTimers.delete(id);
      this.kick(id);
    }, SETTLE_RETRY_MS);
    timer.unref?.();
    this.settleTimers.set(id, timer);
  }

  /**
   * active → waiting(owner), and say why. `guard`: judged under the lock; an
   * answer refuses the pause (input that has to get a turn first). The
   * continue owed leaves only with the written transition. Returns whether
   * it paused.
   */
  private pause(
    record: SubsessionRecord,
    reason: string,
    notice: OwnerText,
    guard?: (r: SubsessionRecord) => string | undefined,
  ): boolean {
    const outcome = this.transition(record.id, "stuck", {
      reason,
      expectFrom: ["active"],
      ...(guard ? { guard } : {}),
      // What it holds now waits for the owner's wake; restart recovery must
      // not take it for a turn cut short.
      patch: (r) => { r.heldThrough = lastInputSeq(r); },
    });
    if (outcome.ok) {
      this.continueOwed.delete(record.id);
      this.tellScope(outcome.record, notice);
    }
    this.schedule();
    return outcome.ok;
  }

  // ---------------------------------------------------------------------
  // Mirror: the owning session sees the owner <-> task conversation
  // ---------------------------------------------------------------------

  /**
   * What the owning session has not seen yet of its tasks' conversations
   * with the owner, as one event (undefined when nothing is new). Read from
   * the table at the moment a turn takes it, so rounds that piled up while
   * the session was busy arrive as one note. Nothing is marked seen here:
   * `markMirrorSeen` does that once the turn that carried it completed.
   */
  mirrorNote(scope: string): MirrorNote | undefined {
    if (!this.available()) return undefined;
    let tasks: SubsessionRecord[];
    try {
      tasks = this.store.list().filter((t) => t.parentKey === scope);
    } catch {
      return undefined;
    }
    const shown: Array<{ record: SubsessionRecord; entries: SubsessionConversationEntry[] }> = [];
    const upTo: Record<string, number> = {};
    for (const record of tasks) {
      const entries = record.conversation.filter((e) => e.seq > record.mirrorSeenSeq);
      if (entries.length === 0) continue;
      shown.push({ record, entries });
      upTo[record.id] = entries.at(-1)!.seq;
    }
    if (shown.length === 0) return undefined;
    return { text: formatMirrorNote(shown), upTo };
  }

  /** Does the scope have unseen words the owner wrote to one of its tasks (what a mirror turn is for)? */
  hasUnseenOwnerWords(scope: string): boolean {
    try {
      return this.store.list().some((t) => t.parentKey === scope && t.conversation.some((e) => e.seq > t.mirrorSeenSeq && e.from === "owner"));
    } catch {
      return false;
    }
  }

  /** Does the scope have conversation it has not seen? */
  hasUnseenMirror(scope: string): boolean {
    try {
      return this.store.list().some((t) => t.parentKey === scope && t.conversation.some((e) => e.seq > t.mirrorSeenSeq));
    } catch {
      return false;
    }
  }

  /** The turn that carried a mirror note completed: those lines are seen. */
  markMirrorSeen(upTo: Record<string, number>): void {
    for (const [id, seq] of Object.entries(upTo)) {
      this.safely(() => this.store.update(id, (r) => { r.mirrorSeenSeq = Math.max(r.mirrorSeenSeq, seq); }), "mark mirror seen");
    }
  }

  /**
   * A round ended (a task turn, or its fallback send): in "turn" mode, wake
   * the owning session to see it. Only when the owner wrote to the task
   * directly (words the owning session has no other way to learn): what the
   * task itself said, the owner has already read, and it waits, as the
   * mirror note, for the session's next turn. Nor while the 5-hour window is at the quota pause: a silent
   * turn on the main conversation is exactly what that headroom is kept for.
   */
  private mirrorAfterRound(id: string): void {
    if (this.deps.config().mirror !== "turn" || !this.deps.mirrorWake) return;
    const record = this.safeGet(id);
    if (!record || !record.conversation.some((e) => e.seq > record.mirrorSeenSeq && e.from === "owner")) return;
    if (!this.mirrorTurnAllowed()) return;
    this.safely(() => this.deps.mirrorWake!(record.parentKey), "mirror wake");
  }

  /**
   * May a mirror turn run now? Not while the 5-hour window is at the quota
   * pause. Asked when the wake is queued AND when it runs (the window can
   * fill while it waits behind the session's other turns).
   */
  mirrorTurnAllowed(): boolean {
    const percent = this.quotaPercent();
    if (percent !== undefined && percent >= QUOTA_PAUSE_PERCENT) {
      log.debug({ percent }, "Quota window nearly used; the mirror waits for the owning session's next turn");
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Transitions, and the todo that follows them
  // ---------------------------------------------------------------------

  /** Every status change: the store's compare-and-set, then the task's todo follows. */
  private transition(id: string, event: SubsessionEvent, opts: TransitionOptions = {}): TransitionOutcome {
    const outcome = this.store.transition(id, event, opts);
    if (outcome.ok && outcome.changed) this.syncTodo(outcome.record);
    return outcome;
  }

  /** Open (or only find, `create` false) the task's todo and link it on the record. */
  private adoptTodo(record: SubsessionRecord, create = true): void {
    this.safely(() => {
      const todoId = create ? this.deps.todos!.open(record) : this.deps.todos!.find(record);
      if (todoId) this.store.update(record.id, (r) => { r.todoId = todoId; });
    }, "open the task's todo");
  }

  private syncTodo(record: SubsessionRecord): void {
    const link = this.deps.todos;
    if (!record.todoId || !link) return;
    const todoId = record.todoId;
    this.safely(() => {
      switch (record.status) {
        case "waiting":
          if (record.waitingOn === "owner") link.set(todoId, "owner", `Answer ${record.id}: ${record.waitingReason ?? "it is waiting for you"}`);
          else link.set(todoId, "external", `${record.id} is waiting for its check-back`);
          return;
        case "queued":
        case "active":
          link.set(todoId, "external", `${record.id} is working on it (/s ${record.id})`);
          return;
        case "finished":
          link.set(todoId, "owner", `Read ${record.id}'s result, then close this`);
          return;
        case "cancelled":
        case "failed":
          link.close(todoId, `sub-session ${record.id} ${record.status}`);
          return;
        case "archived":
          return;
      }
    }, "update the task's todo");
  }

  // ---------------------------------------------------------------------
  // Reporting back
  // ---------------------------------------------------------------------

  /**
   * The report goes to the owning session as a PINNED pending note (never
   * dropped by the note cap), then a silent turn there to tell the owner.
   * `reportDelivered` is set only once the note is on disk; a note already
   * queued or in flight for the same task is not added twice (a restart
   * redelivery can meet the normal one).
   */
  private deliverReport(record: SubsessionRecord): void {
    // An earlier report kept unread whose own note was never written (it
    // failed, and died with the process) gets that note first: until it is
    // on disk, nothing else holds its text once the record goes.
    if (!this.deliverEarlierReports(record)) {
      this.retryReport(record.id);
      return;
    }
    let present = this.reportNotePending(record);
    if (present && this.unpersistedReports.has(record.id)) {
      // The note found is our own, held in memory after its write failed: it
      // is not durable until a write succeeds.
      if (!this.deps.persistPendingNotes?.(record.parentKey)) {
        if (!this.deps.persistPendingNotes) present = false;
        else {
          this.retryReport(record.id);
          return;
        }
      }
    }
    if (!present) {
      const report = record.report ?? "";
      const excerpt = report.length > REPORT_NOTE_EXCERPT ? `${report.slice(0, REPORT_NOTE_EXCERPT - 1)}…` : report;
      const earlier = (record.earlierReports ?? []).map((e) => `#${e.seq}`);
      const note = formatTomoEvent("subsession-report", [
        `Sub-session ${record.id} ("${record.title}") finished. Its report #${record.reportSeq ?? 1}${report.length > REPORT_NOTE_EXCERPT ? " (start; read the whole report with task_status)" : ""}:`,
        excerpt,
        ...(earlier.length > 0 ? [`Its earlier report${earlier.length === 1 ? "" : "s"} ${earlier.join(", ")} ${earlier.length === 1 ? "is" : "are"} kept too: task_status shows ${earlier.length === 1 ? "it" : "them"}.`] : []),
      ].join("\n"), { name: reportNoteName(record) });
      if (!this.deps.queuePendingNote(record.parentKey, note)) {
        this.unpersistedReports.add(record.id);
        this.retryReport(record.id);
        return;
      }
    }
    this.unpersistedReports.delete(record.id);
    this.clearReportRetry(record.id);
    // Wake first, then mark. The wake itself is in memory; what makes it
    // durable is the note: every start wakes the owning session again for a
    // delivered report whose note is still unread (see reconcile).
    this.wakeForReport(record);
    this.safely(() => this.store.update(record.id, (r) => { r.reportDelivered = true; }), "mark report delivered");
  }

  /** Writes the note of every kept earlier report that has none on disk. False when one could not be written. */
  private deliverEarlierReports(record: SubsessionRecord): boolean {
    const missing = (record.earlierReports ?? []).filter((e) => !e.noted);
    if (missing.length === 0) return true;
    for (const e of missing) {
      const name = `${record.id}#${e.seq}`;
      const ok = this.notePending(record.parentKey, name)
        // Found in memory: held after a failed write, so written again.
        ? this.deps.persistPendingNotes?.(record.parentKey) ?? false
        : this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-report", [
          `Sub-session ${record.id} ("${record.title}") finished earlier. Its report #${e.seq}, replaced by a later one before it was read:`,
          e.text.length > REPORT_NOTE_EXCERPT ? `${e.text.slice(0, REPORT_NOTE_EXCERPT - 1)}… (read the whole report with task_status)` : e.text,
        ].join("\n"), { name }));
      if (!ok) return false;
    }
    const seqs = new Set(missing.map((e) => e.seq));
    try {
      this.store.update(record.id, (r) => {
        for (const e of r.earlierReports ?? []) if (seqs.has(e.seq)) e.noted = true;
      });
    } catch (err) {
      log.error({ err, id: record.id }, "Could not mark an earlier sub-session report noted");
      return false;
    }
    return true;
  }

  /** This report's own note (by report seq): an unread earlier report of the same task is another note. */
  private reportNotePending(record: SubsessionRecord): boolean {
    return this.notePending(record.parentKey, reportNoteName(record));
  }

  /** An earlier report a later finish kept (see finish) is still unread. */
  private earlierReportPending(record: SubsessionRecord): boolean {
    // One whose note was never written is outstanding too.
    return (record.earlierReports ?? []).some((e) => !e.noted || this.notePending(record.parentKey, `${record.id}#${e.seq}`));
  }

  private notePending(parentKey: string, name: string): boolean {
    const marker = `<tomo-event type="subsession-report" name="${name}"`;
    return this.deps.hasPendingNote(parentKey, (n) => n.includes(marker));
  }

  private wakeForReport(record: SubsessionRecord): void {
    this.outward(() => this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-report",
      "A sub-session finished; its report is in a note above. Tell the owner the result in a few lines, in your own words, and read the full report with task_status if they will want details. Decide what, if anything, belongs in memory.",
      { name: "check" })));
  }

  /** The report note could not be written: try again in-process, a few times, then on the next start. */
  private retryReport(id: string): void {
    const attempts = (this.reportAttempts.get(id) ?? 0) + 1;
    if (attempts > REPORT_RETRY_MAX) {
      this.clearReportRetry(id);
      log.error({ id, attempts }, "Could not persist a sub-session report note; retried on the next start");
      return;
    }
    log.warn({ id, attempts }, "Could not persist a sub-session report note; retrying");
    this.reportAttempts.set(id, attempts);
    const old = this.reportTimers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.reportTimers.delete(id);
      const record = this.safeGet(id);
      if (!record || record.status !== "finished" || record.reportDelivered) {
        this.clearReportRetry(id);
        return;
      }
      this.deliverReport(record);
    }, REPORT_RETRY_MS);
    timer.unref?.();
    this.reportTimers.set(id, timer);
  }

  private clearReportRetry(id: string): void {
    const timer = this.reportTimers.get(id);
    if (timer) clearTimeout(timer);
    this.reportTimers.delete(id);
    this.reportAttempts.delete(id);
  }

  /**
   * A task that failed may still hold what the owner said to it and it never
   * answered: the notice hands that back (the record, and those inputs with
   * it, is forgotten 30 days on).
   */
  private reportFailure(record: SubsessionRecord, notice: OwnerText): void {
    const unanswered = record.pendingInput.filter(isOwnerInput);
    if (unanswered.length === 0) {
      this.tellScope(record, notice);
      return;
    }
    const list = unanswered.slice(0, UNANSWERED_MAX).map((i) => `• ${truncate((i.words ?? i.text).trim(), UNANSWERED_EXCERPT)}`).join("\n");
    this.tellScope(record, ownerT("subsessions")("withUnanswered", { notice, count: unanswered.length, list }));
    this.handBack(record);
  }

  /**
   * The owner's unanswered input, in full, to the owning session as a pinned
   * note: the one copy that outlives the record. Marked on the record once the
   * note is on disk; until then the sweep keeps the record and tries again.
   */
  private handBack(record: SubsessionRecord): boolean {
    const unanswered = record.pendingInput.filter(isOwnerInput);
    const note = formatTomoEvent("subsession-handback", [
      `Sub-session ${record.id} ("${record.title}") failed before it answered ${unanswered.length === 1 ? "this message" : `these ${unanswered.length} messages`} passed on for the owner. Here in full; decide with the owner whether ${unanswered.length === 1 ? "it still needs" : "they still need"} doing:`,
      ...unanswered.map((i, n) => `${n + 1}. ${(i.words ?? i.text).trim()}`),
    ].join("\n\n"), { name: record.id });
    if (!this.deps.queuePendingNote(record.parentKey, note)) {
      log.warn({ id: record.id }, "Could not write a failed sub-session's handback note; the record is kept and it is tried again");
      return false;
    }
    try {
      this.store.update(record.id, (r) => { r.handedBack = true; });
    } catch (err) {
      log.error({ err, id: record.id }, "Could not mark a sub-session's input handed back");
      return false;
    }
    return true;
  }

  /**
   * A turn the task gives itself (no owner input in it) is held when it has
   * been active on its own past `maxActiveHours`, or when the 5-hour window
   * is at QUOTA_PAUSE_PERCENT or more: it pauses for the owner (one notice),
   * whose word wakes it. "again": the pause was refused (the owner's input
   * just landed): plan the turn afresh.
   */
  private gateOwnTurn(record: SubsessionRecord, compact: boolean): "run" | "paused" | "again" {
    // The owner started it (/s start): its first turn is theirs, and a
    // /compact before that turn does not use the pass up.
    const startedByOwner = compact ? this.ownerStarted.has(record.id) : this.ownerStarted.delete(record.id);
    if (startedByOwner || record.status !== "active" || record.pendingInput.some(isOwnerInput)) return "run";
    const capHours = this.deps.config().maxActiveHours;
    if (capHours > 0) {
      const ownMs = activeTotalMs(record, this.now()) - (record.activeAtOwnerInputMs ?? 0);
      if (ownMs >= capHours * 3_600_000) {
        log.info({ id: record.id, ownMs, capHours }, "Sub-session over its wall-clock cap; pausing for the owner");
        return this.pause(record, `active ${capHours}h on its own (subsessions.maxActiveHours)`,
          ownerT("subsessions")("activeCap", { id: record.id, title: record.title, hours: capHours }), hasOwnerInput) ? "paused" : "again";
      }
    }
    const percent = this.quotaPercent();
    if (percent !== undefined && percent >= QUOTA_PAUSE_PERCENT) {
      log.info({ id: record.id, percent }, "5-hour quota window nearly used; pausing a sub-session for the owner");
      return this.pause(record, `the 5-hour quota window is at ${Math.round(percent)}%`,
        ownerT("subsessions")("quotaHigh", { id: record.id, title: record.title, percent: Math.round(percent) }), hasOwnerInput) ? "paused" : "again";
    }
    return "run";
  }

  /** The 5-hour window's share used, or undefined: none known, or unreadable (fail open, logged). */
  private quotaPercent(): number | undefined {
    if (!this.deps.sessionQuotaPercent) return undefined;
    try {
      const percent = this.deps.sessionQuotaPercent();
      this.quotaReadFailing = false;
      return percent;
    } catch (err) {
      if (!this.quotaReadFailing) log.warn({ err }, "Could not read the quota samples; sub-session turns are not held for quota");
      else log.debug({ err }, "Quota samples still unreadable");
      this.quotaReadFailing = true;
      return undefined;
    }
  }

  /** A harness notice to the owner, and a note so the owning session knows it was said. */
  private tellScope(record: SubsessionRecord, notice: OwnerText): void {
    this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-activity",
      `The harness told the owner about sub-session ${record.id} ("${record.title}"): ${truncate(notice, ACTIVITY_NOTE_EXCERPT)}`,
      { name: record.id }));
    this.outward(() => { void this.deps.noticeToScope(record.parentKey, notice).catch((err) => log.warn({ err, id: record.id }, "Sub-session notice failed")); });
  }

  private noticeOwner(text: OwnerText): void {
    this.outward(() => { void this.deps.noticeOwner(text).catch((err) => log.warn({ err }, "Sub-session notice failed")); });
  }

  private safeByKey(key: string): SubsessionRecord | undefined {
    if (!isTaskSessionKey(key)) return undefined;
    try { return this.store.byKey(key); } catch (err) {
      if (!(err instanceof SubsessionStoreError)) log.warn({ err, key }, "Sub-session lookup failed");
      return undefined;
    }
  }

  private safeGet(id: string): SubsessionRecord | undefined {
    try { return this.store.get(id); } catch { return undefined; }
  }

  private safely(fn: () => void, what: string): void {
    try { fn(); } catch (err) { log.error({ err }, "Sub-session %s failed", what); }
  }
}

function pushConversation(record: SubsessionRecord, entry: Omit<SubsessionConversationEntry, "seq">): void {
  record.conversationSeq += 1;
  record.conversation.push({ seq: record.conversationSeq, ...entry });
}

function inputQueueFull(record: SubsessionRecord): string | undefined {
  return record.pendingInput.length >= PENDING_INPUT_MAX ? `${record.pendingInput.length} inputs already waiting (limit ${PENDING_INPUT_MAX})` : undefined;
}

/** What the owner wrote to a task, as a handback would quote it (files by path). */
function ownerWords(text: string, files: string[] = []): string {
  return files.length > 0 ? `${text}\n(files: ${files.join(", ")})` : text;
}

function isOwnerInput(input: SubsessionInput): boolean {
  // A relay written before inputs carried their origin is still the owner's.
  return input.from === "owner" || input.text.includes('<tomo-event type="subsession-relay"');
}

function hasOwnerInput(record: SubsessionRecord): string | undefined {
  return record.pendingInput.some(isOwnerInput) ? "the owner's input is pending" : undefined;
}

function hasPendingInput(record: SubsessionRecord): string | undefined {
  return record.pendingInput.length > 0 ? "input is pending" : undefined;
}

/** A report note's name: the task id and which of its reports (`s3#2`). */
function reportNoteName(record: SubsessionRecord): string {
  return `${record.id}#${record.reportSeq ?? 1}`;
}

/** `s12` → 12 (0 for anything else). */
function taskNumber(key: string): number {
  const m = /^task:s(\d+)$/.exec(key);
  return m ? Number(m[1]) : 0;
}

/** `[s3 · title]`: how a task's messages are marked in the owner's chat. */
export function taskPrefix(record: Pick<SubsessionRecord, "id" | "title">): string {
  return `[${record.id} · ${record.title}]`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
