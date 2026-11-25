import { log } from "../../logger.js";
import { ownerT, type OwnerText } from "../../i18n/index.js";
import type { SubsessionConfig } from "../../config.js";
import { isDmSessionKey, isTaskSessionKey } from "../../sessions/keys.js";
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
import { OPEN_STATUSES, PENDING_INPUT_MAX, PLAN_MAX_STEPS, PLAN_STEP_MAX, PROGRESS_TEXT_MAX, STEP_RESULT_MAX, TERMINAL_STATUSES, oneLine, type SubsessionPlanStep, activeTotalMs, appendInput, lastInputSeq, type SubsessionConversationEntry, type SubsessionInput, type SubsessionRecord, type SubsessionStatus } from "./types.js";

const OWNER_MESSAGE_MARKER = '<tomo-event type="subsession-owner-message"';

/** How a task turn ended, as the agent's turn runner saw it. */
/** task_finish's outcome: `unread` when it was refused for input the task has not read. */
export type FinishOutcome = TransitionOutcome | { ok: false; from: SubsessionStatus | null; record?: SubsessionRecord; refused?: string; unread: number };

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
  /**
   * Does the key's live session still have its own background work (a
   * background command or subagent running, or one that finished and whose
   * report turn is still due)? Display only: it never changes the lifecycle.
   */
  hasBackgroundWork?(key: string): boolean;
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
  /**
   * A silent turn on the owning session for what its tasks handed it
   * (task_notify notices, task_ask questions). Merged: one queued at a time
   * per scope. When it runs, it asks `handOffFor` for its prompt (nothing to
   * hand over: no turn), and calls `afterHandOff` once the turn is over,
   * whatever its outcome. Unset: a notice still wakes the scope through
   * `wakeScope`, and a question goes straight to the owner's chat.
   */
  handOffWake?(parentKey: string): void;
}

/** What a hand-off turn on the owning session carries (SubsessionService.handOffFor). */
export interface HandOff {
  prompt: string;
  /** The questions it shows, by task id and ask time: the ones afterHandOff forwards if the turn did not. */
  asks: Array<{ id: string; at: number }>;
}

export const STOP_TIMEOUT_MS = 30_000;
export const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A task parked while the cron store could not be read: how soon it is looked at again. */
export const CRON_RECHECK_MS = 60_000;
/**
 * While Tomo runs, how often tasks waiting on their check-back are looked at:
 * a job can go away mid-run (a one-shot disabled after an interrupt or after
 * its retries ran out, a bad interval held disabled, a job removed by hand),
 * and nothing else would wake the task before the next restart.
 */
export const EXTERNAL_WAIT_CHECK_MS = 5 * 60_000;
export const MAX_INTERRUPT_STREAK = 3;
export const MAX_TURNS_WITHOUT_PROGRESS = 3;
export const MAX_FAIL_STREAK = 2;
/**
 * Turns in a row whose task_finish was refused for unread input, the unread
 * count never going down, after which the next turn's task_finish goes
 * through anyway (the unread input is quoted in its report, and stays owed).
 */
export const MAX_FINISH_REFUSALS = 3;
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
/**
 * A question handed to the owning session and still not forwarded this long
 * after it was asked (its hand-off turn never ran, failed, or the send
 * failed) is forwarded by the harness, at the next EXTERNAL_WAIT_CHECK_MS
 * look: a task waiting for the owner must never wait on a question nobody saw.
 */
export const ASK_FORWARD_GRACE_MS = 5 * 60_000;
const NOTICE_MARKER = '<tomo-event type="subsession-notice"';
/** At most this many of one task's notices wait unread in its owning session's notes; more are refused. */
export const MAX_PENDING_NOTICES = 5;
const noticeMarker = (id: string): string => `${NOTICE_MARKER} name="${id}@`;
const askKey = (id: string, at: number): string => `${id}@${at}`;
/** How soon a notice note or a sent message's record that could not be written is tried again. */
export const CUSTODY_RETRY_MS = 5_000;

/** The pending note that hands one notice to the owning session (rebuilt the same from the record when it must be queued again). */
function noticeNote(record: Pick<SubsessionRecord, "id" | "title">, at: number, body: string): string {
  return formatTomoEvent("subsession-notice", [
    `Sub-session ${record.id} ("${record.title}") handed you this for the owner. These are its words; nothing has been sent to them:`,
    quoteBlock(body),
    "Decide now: tell the owner with send_message, in your own words (merged with other news when that reads better), or keep it for the next time you talk with them. A result they are waiting for, a blocker, or a decision only they can make should reach them now. Nothing reaches them unless you send it. This note is not shown to you again (task_status keeps it).",
  ].join("\n"), { name: `${record.id}@${at}` });
}
const notShownNote = (question: string): string => formatTomoEvent("subsession-redelivery",
  `Your question was never shown to the owner (its send failed, or Tomo stopped before it went out), so no message since then answers it:\n${quoteBlock(question)}\nAsk again with task_ask if you still need it.`,
  { name: "question-not-shown" });
const noticeNamed = (id: string, at: number) => (n: string): boolean => n.includes(`${NOTICE_MARKER} name="${id}@${at}"`);
/** How much of each unanswered message a failure notice quotes. */
const UNANSWERED_EXCERPT = 300;
const UNANSWERED_MAX = 5;
/** How much of an undelivered message the next turn is shown. */
const LOST_ANSWER_EXCERPT = 1500;
const ACTIVITY_NOTE_EXCERPT = 1500;
/** Per unread input a forced task_finish quotes in its report. */
const UNREAD_AT_FINISH_EXCERPT = 1500;
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
  /** A question being forwarded, per task (by its ask time): a second forward joins it, never sends twice. */
  /**
   * Questions this process forwarded (`id@at`), so a record write that failed
   * after the send went out cannot send them a second time.
   */
  private readonly forwardedAsks = new Set<string>();
  /** Notices (`id@at`) this process put in the owning session's notes queue (in memory at least). */
  private readonly noticesQueued = new Set<string>();
  /**
   * Sends that went out but whose record write failed: the write (the
   * conversation, the reply ids, a forward's mark) is kept and tried again,
   * and the reply ids already route the owner's replies to the task.
   */
  private readonly unrecorded = new Map<string, Array<{ write: (r: SubsessionRecord) => void; replyIds: Array<{ channel: string; messageId: string }> }>>();
  private custodyTimer?: ReturnType<typeof setTimeout>;
  private readonly lastNoticeAt = new Map<string, number>();
  /** Tasks whose running turn carries the owner's words: a notify there answers them, so it goes out directly. */
  private readonly ownerTurns = new Set<string>();
  private readonly forwarding = new Map<string, { at: number; done: Promise<{ ok: true; already?: boolean } | { ok: false; error: string }> }>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly reportTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportAttempts = new Map<string, number>();
  /** The highest input seq the turn in flight carries, per task (runtime only). */
  private readonly inflightThrough = new Map<string, number>();
  /** Which turn is in flight, per task: a serial, so two turns that carry the same seq still differ. */
  private readonly inflightTurn = new Map<string, number>();
  private turnSerial = 0;
  /**
   * task_finish refused for unread input, per task (runtime only): in how
   * many turns in a row, the last refused turn, and how much was unread then.
   * A turn that ends with no refusal clears it.
   */
  private readonly finishRefusals = new Map<string, { turns: number; turn: number; unread: number }>();
  /** Reports whose note write failed: the note may sit in memory only. */
  private readonly unpersistedReports = new Set<string>();
  private cronRecheckTimer?: NodeJS.Timeout;
  private externalWaitTimer?: NodeJS.Timeout;
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
  /**
   * Is the task waiting(external) while its own background work still runs?
   * It then wakes by itself when that work reports back, so /s, task_status
   * and the web rail show it as working (in the background), not as waiting.
   * Display only: the status stays waiting(external), and slots, quota and
   * the caps read the status as before.
   */
  backgroundRunning(record: Pick<SubsessionRecord, "status" | "waitingOn" | "sessionKey">): boolean {
    if (record.status !== "waiting" || record.waitingOn !== "external") return false;
    try {
      return this.deps.hasBackgroundWork?.(record.sessionKey) === true;
    } catch {
      return false;
    }
  }

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
    const unrecorded = (id: string) => (this.unrecorded.get(id) ?? []).some((u) => u.replyIds.some((m) => m.channel === channel && m.messageId === messageId));
    return tasks.find((t) => t.replyMap.some((m) => m.channel === channel && m.messageId === messageId) || unrecorded(t.id));
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
  // Task side (task_reply / task_notify / task_ask / task_plan / task_update / task_checkpoint / task_finish / task_reopen)
  // ---------------------------------------------------------------------

  /**
   * task_notify: hand a message to the owning session, which decides whether
   * and when the owner hears it (it may fold it into other news, or keep it
   * for the next time they talk). The note is pinned in the owning session's
   * pending notes and a hand-off turn wakes it. The record holds the notice
   * (`unsavedNotices`) BEFORE the note is queued, and lets go of it only once
   * the note is on disk (or a turn took it), so it survives a note write
   * that fails and a restart before the retry. Only a notice the record
   * could not hold, or one past MAX_PENDING_NOTICES unread, is refused, and
   * counts as an undelivered message of this turn, like a failed send. In a turn that
   * carries the owner's words, a notify answers them, so it goes straight to
   * the owner's chat like task_reply.
   */
  async notify(key: string, text: string): Promise<{ ok: boolean; error?: string; via?: "main" | "direct" }> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: `This task is ${record.status}; nothing more is sent.` };
    const body = text.trim();
    if (!body) return { ok: false, error: "text is empty" };
    if (this.ownerTurns.has(record.id)) {
      const sent = await this.speak(key, "notify", body);
      return sent.ok ? { ...sent, via: "direct" } : sent;
    }
    let waiting = 0;
    const full = this.deps.hasPendingNote(record.parentKey, (n) => n.includes(noticeMarker(record.id)) && ++waiting >= MAX_PENDING_NOTICES);
    if (full) {
      this.markDelivery(record.id, body, false);
      return { ok: false, error: `the main session already has ${MAX_PENDING_NOTICES} of your notices it has not read. Wait for it, or put this in task_finish.` };
    }
    // One notice, one time: the note's name and the record's entry are keyed by it.
    const at = Math.max(this.now(), (this.lastNoticeAt.get(record.id) ?? 0) + 1, ...(record.unsavedNotices ?? []).map((n) => n.at + 1));
    this.lastNoticeAt.set(record.id, at);
    // Custody first: the record holds the notice until its note is on disk,
    // so a process that dies before the notes are written loses nothing.
    try {
      if (!this.store.update(record.id, (r) => { r.unsavedNotices = [...(r.unsavedNotices ?? []), { at, text: body }]; })) throw new Error("the task record is gone");
    } catch (err) {
      log.error({ err, id: record.id }, "Could not hold a sub-session notice on its record");
      this.markDelivery(record.id, body, false);
      return { ok: false, error: "the main session could not be given the message. Try again." };
    }
    this.queueNotice(record, at, body);
    this.markDelivery(record.id, body, true);
    this.spoke.add(record.id);
    this.safely(() => this.store.update(record.id, (r) => { r.sent.push({ at, kind: "notify", text: body, via: "main" }); }), "record a handed-off notice");
    this.handOff(record.parentKey);
    return { ok: true, via: "main" };
  }

  /** Put a held notice's note in the owning session's queue; the record lets go of it once the note is on disk. */
  private queueNotice(record: Pick<SubsessionRecord, "id" | "title" | "parentKey">, at: number, body: string): void {
    let saved = false;
    try {
      saved = this.deps.queuePendingNote(record.parentKey, noticeNote(record, at, body));
      this.noticesQueued.add(askKey(record.id, at));
    } catch (err) {
      log.error({ err, id: record.id }, "Could not queue a sub-session notice's note; the record holds it and it is tried again");
    }
    if (saved) this.releaseNotice(record.id, at);
    else {
      log.warn({ id: record.id }, "A sub-session notice's note is not on disk yet; the record holds it and it is tried again");
      this.armCustodyRetry();
    }
  }

  private releaseNotice(id: string, at: number): void {
    try {
      this.store.update(id, (r) => {
        const left = (r.unsavedNotices ?? []).filter((n) => n.at !== at);
        r.unsavedNotices = left.length > 0 ? left : undefined;
      });
    } catch (err) {
      log.warn({ err, id }, "Could not release a saved sub-session notice; tried again");
      this.armCustodyRetry();
    }
  }

  /**
   * Each notice the record still holds: its note in memory is written again
   * (released once it is on disk); one this process queued that is gone was
   * taken by a turn (released); one this process never queued (its queue
   * threw, or it is from before a restart) is queued again. Records whose
   * sends went out without being written are written.
   */
  private secureCustody(): void {
    let again = !this.flushUnrecorded();
    let tasks: SubsessionRecord[] = [];
    try {
      const all = this.store.list();
      // A race mark with no send in flight in this process (it died before the
      // send settled, or the record of its end failed): never confirmed, so
      // not shown.
      for (const t of all) {
        const race = t.forwardRacing;
        if (!race) continue;
        if (!race.failed && this.forwarding.get(t.id)?.at === race.at) continue;
        if (!race.failed && this.forwardedAsks.has(askKey(t.id, race.at))) {
          this.safely(() => this.store.update(t.id, (r) => { if (r.forwardRacing?.at === race.at) delete r.forwardRacing; }), "clear a settled forward race");
          continue;
        }
        if (!race.failed) {
          try {
            this.store.update(t.id, (r) => { if (r.forwardRacing?.at === race.at) r.forwardRacing.failed = true; });
          } catch {
            again = true;
            continue;
          }
        }
        this.tellNotShown(t.id);
      }
      tasks = all.filter((t) => t.unsavedNotices?.length);
    } catch {
      again = true;
    }
    for (const task of tasks) {
      for (const n of task.unsavedNotices ?? []) {
        if (this.deps.hasPendingNote(task.parentKey, noticeNamed(task.id, n.at))) {
          let ok = false;
          try {
            ok = this.deps.persistPendingNotes ? this.deps.persistPendingNotes(task.parentKey) : true;
          } catch (err) {
            log.warn({ err, id: task.id }, "Could not write a sub-session notice's note");
          }
          if (ok) this.releaseNotice(task.id, n.at);
          else again = true;
        } else if (this.noticesQueued.has(askKey(task.id, n.at))) {
          this.releaseNotice(task.id, n.at);
        } else {
          this.queueNotice(task, n.at, n.text);
          this.handOff(task.parentKey);
        }
      }
    }
    if (again) this.armCustodyRetry();
  }

  /**
   * Write the sends that went out but were not recorded (best effort: they
   * live in memory, so a process that dies first loses them). Writes only
   * records, arms nothing: also the last try once turns have drained at
   * shutdown. True when nothing is left.
   */
  flushUnrecorded(): boolean {
    for (const [id, writes] of [...this.unrecorded]) {
      try {
        const done = this.store.update(id, (r) => { for (const w of writes) w.write(r); });
        this.unrecorded.delete(id);
        if (!done) log.warn({ id }, "A sub-session's sent message could not be recorded: the task is gone");
      } catch (err) {
        log.warn({ err, id }, "Still could not record a sub-session's sent message");
      }
    }
    return this.unrecorded.size === 0;
  }

  private armCustodyRetry(): void {
    // Not before dispatch opens (start() runs a pass) and never after stop().
    if (this.custodyTimer || !this.open) return;
    this.custodyTimer = setTimeout(() => {
      this.custodyTimer = undefined;
      if (this.deps.isStopping()) return;
      this.safely(() => this.secureCustody(), "secure notices and sent records");
    }, CUSTODY_RETRY_MS);
    this.custodyTimer.unref?.();
  }

  /** task_reply: answer the owner's message. Straight to the owner's chat. */
  async reply(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return this.speak(key, "reply", text);
  }

  /**
   * task_ask: a question only the owner can answer. The question is stored
   * on the record and the task waits for the owner in ONE transition, then
   * the owning session is woken to forward it word for word
   * (task_forward_question), so the owner's reply to it still comes back to
   * the task as their own words. If that turn forwards nothing, the harness
   * forwards it when the turn is over (and again, failing that, after
   * ASK_FORWARD_GRACE_MS). A transition the guard refuses (input is pending
   * that this turn does not carry: waiting now would strand it) leaves the
   * task as it is, and the question goes straight to the owner's chat, as
   * before.
   */
  async ask(key: string, question: string): Promise<{ ok: boolean; error?: string; via?: "main" | "direct" }> {
    const first = this.store.byKey(key);
    if (!first) return { ok: false, error: "No task record for this session." };
    // A forward of the earlier question in flight settles first, so it is
    // not sent again folded into this one.
    await this.forwarding.get(first.id)?.done.catch(() => undefined);
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (record.status !== "active" && record.status !== "waiting") {
      return { ok: false, error: `task_ask needs an active task; this one is ${record.status}. Use task_reply to answer the owner, or task_reopen first.` };
    }
    const body = question.trim();
    if (!body) return { ok: false, error: "text is empty" };
    const at = this.now();
    const outcome = this.transition(record.id, "ask", {
      reason: `asked the owner: ${truncate(body, 200)}`,
      guard: (r) => (r.pendingInput.some((i) => i.seq > (this.inflightThrough.get(r.id) ?? 0))
        ? "input is pending that this turn does not carry" : undefined),
      patch: (r) => {
        // A question asked again before the first one went out keeps both.
        const earlier = r.pendingAsk && this.unforwarded(r) ? r.pendingAsk.text : undefined;
        r.pendingAsk = { at, text: earlier ? `${earlier}\n\n${body}` : body };
      },
    });
    if (!outcome.ok) {
      const sent = await this.speak(key, "ask", body);
      return sent.ok ? { ...sent, via: "direct" } : sent;
    }
    this.spoke.add(record.id);
    this.continueOwed.delete(record.id);
    this.schedule();
    if (this.deps.handOffWake) this.handOff(record.parentKey);
    else this.outward(() => { void this.forwardQuestion(record.id).catch(() => undefined); });
    return { ok: true, via: "main" };
  }

  /**
   * task_forward_question (owning session), and the harness's own forward:
   * send a waiting task's question to the owner's chat word for word, with
   * its prefix, and record where it landed so the owner's reply to it goes
   * back to the task. Not part of any task turn, so it never touches the
   * turn's undelivered bookkeeping.
   */
  async forwardQuestion(id: string, scope?: string): Promise<{ ok: true; already?: boolean } | { ok: false; error: string }> {
    const record = this.safeGet(id);
    if (!record || (scope !== undefined && record.parentKey !== scope)) return { ok: false, error: `no task ${id} in this conversation.` };
    const ask = record.pendingAsk;
    if (record.status !== "waiting" || record.waitingOn !== "owner" || !ask) {
      return { ok: false, error: `${record.id} has no question waiting for the owner.` };
    }
    if (!this.unforwarded(record)) return { ok: true, already: true };
    const inFlight = this.forwarding.get(record.id);
    if (inFlight?.at === ask.at) return inFlight.done;
    const done = (async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await this.sendAndRecord(record, "ask", ask.text, {
        spoke: false,
        patch: (r, sentAt) => {
          if (r.pendingAsk?.at === ask.at) r.pendingAsk.forwardedAt = sentAt;
          // A wake raced this send: it went out, recorded in the same write.
          if (r.forwardRacing?.at === ask.at && !r.forwardRacing.failed) delete r.forwardRacing;
        },
      });
      if (!result.ok) return { ok: false, error: result.error ?? "the question did not go out." };
      this.forwardedAsks.add(askKey(record.id, ask.at));
      return { ok: true };
    })();
    this.forwarding.set(record.id, { at: ask.at, done });
    try {
      return await done;
    } finally {
      if (this.forwarding.get(record.id)?.done === done) this.forwarding.delete(record.id);
    }
  }

  /** A question stands on the task and has not gone out (by the record, or by this process's memory of a send). */
  private unforwarded(r: SubsessionRecord): boolean {
    return r.pendingAsk !== undefined && r.pendingAsk.forwardedAt === undefined && !this.forwardedAsks.has(askKey(r.id, r.pendingAsk.at));
  }

  /** A task waiting for the owner on a question not yet forwarded. */
  private asking(r: SubsessionRecord): boolean {
    return r.status === "waiting" && r.waitingOn === "owner" && this.unforwarded(r);
  }

  /**
   * What a hand-off turn on `scope` shows: its tasks' notices waiting in
   * notes (named, not repeated: the notes are the turn's prefix) and their
   * unforwarded questions, verbatim. Undefined when there is nothing.
   */
  handOffFor(scope: string): HandOff | undefined {
    if (!this.available()) return undefined;
    let tasks: SubsessionRecord[];
    try {
      tasks = this.store.list().filter((t) => t.parentKey === scope);
    } catch {
      return undefined;
    }
    const asking = tasks.filter((t) => this.asking(t));
    const notices = this.deps.hasPendingNote(scope, (n) => n.includes(NOTICE_MARKER));
    if (asking.length === 0 && !notices) return undefined;
    const canForward = isDmSessionKey(scope);
    const lines = ["Your sub-sessions handed you something for the owner. Nothing they hand you reaches the owner unless it is sent."];
    if (notices) {
      lines.push("",
        "Their notices are in the notes above (subsession-notice). For each, decide: tell the owner now with send_message, in your own words and merged with other news when that reads better; or keep it for the next time you talk with them if it can wait. A note is not shown to you again (task_status keeps it). A result they are waiting for, a blocker, or a decision only they can make should reach them now.");
    }
    if (asking.length > 0) {
      lines.push("",
        canForward
          ? "These tasks are waiting for the owner's answer. Forward each question with task_forward_question(id): it sends the question word for word, and the owner's reply to it goes straight back to the task. You may send one line of context first with send_message, but never reword the question or answer it for them. If you forward nothing, the harness forwards it when this turn ends."
          : "These tasks are waiting for the owner's answer. The harness forwards each question to this chat word for word when this turn ends; you may send one line of context first with send_message.");
      for (const t of asking) lines.push(`- ${t.id} ("${t.title}"):`, quoteBlock(t.pendingAsk!.text));
    }
    lines.push("", "If nothing needs sending, end with NO_REPLY.");
    return {
      prompt: formatTomoEvent("subsession-handoff", lines.join("\n"), { name: "check" }),
      asks: asking.map((t) => ({ id: t.id, at: t.pendingAsk!.at })),
    };
  }

  /** A hand-off turn is over: forward each question it showed that it did not forward. */
  async afterHandOff(scope: string, asks: HandOff["asks"]): Promise<void> {
    for (const a of asks) {
      const record = this.safeGet(a.id);
      if (!record || record.parentKey !== scope || record.pendingAsk?.at !== a.at || !this.unforwarded(record)) continue;
      const result = await this.forwardQuestion(a.id, scope).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (!result.ok) log.warn({ id: a.id, error: result.error }, "Could not forward a sub-session question after its hand-off turn; retried later");
    }
  }

  /**
   * Questions handed off longer than ASK_FORWARD_GRACE_MS ago and still not
   * forwarded go out from here (a hand-off turn that never ran, a send that
   * failed). Runs with the check-back recheck, while dispatch is open.
   */
  private forwardOverdueQuestions(): void {
    const now = this.now();
    for (const task of this.store.list()) {
      if (!this.asking(task) || now - task.pendingAsk!.at < ASK_FORWARD_GRACE_MS) continue;
      void this.forwardQuestion(task.id).then((r) => {
        if (!r.ok) log.warn({ id: task.id, error: r.error }, "Could not forward an overdue sub-session question; retried later");
      }, (err: unknown) => log.warn({ err, id: task.id }, "Could not forward an overdue sub-session question; retried later"));
    }
  }

  /**
   * After a restart: a hand-off whose turn may not have run (a question not
   * forwarded, a notice note still unread) gets one. Its note and the
   * record are durable; the wake was only in memory.
   */
  private handOffAfterRestart(): void {
    const scopes = new Set<string>();
    for (const task of this.store.list()) {
      if (this.asking(task)) scopes.add(task.parentKey);
      else if (this.deps.hasPendingNote(task.parentKey, (n) => n.includes(NOTICE_MARKER))) scopes.add(task.parentKey);
    }
    for (const scope of scopes) {
      if (this.deps.handOffWake) {
        this.handOff(scope);
        continue;
      }
      const asks = this.handOffFor(scope)?.asks ?? [];
      if (asks.length > 0) void this.afterHandOff(scope, asks);
      if (this.deps.hasPendingNote(scope, (n) => n.includes(NOTICE_MARKER))) this.handOff(scope);
    }
  }

  /** Wake the owning session for what its tasks handed it (merged), or, with no hand-off turn, the old wake. */
  private handOff(scope: string): void {
    this.outward(() => {
      if (this.deps.handOffWake) this.deps.handOffWake(scope);
      else this.deps.wakeScope(scope, formatTomoEvent("subsession-notice",
        "A sub-session handed you a notice for the owner; it is in a note above. Decide whether to tell the owner now with send_message, or keep it for the next time you talk with them. If nothing needs sending, end with NO_REPLY.",
        { name: "check" }));
    });
  }

  private speak(key: string, kind: "reply" | "notify" | "ask" | "fallback", text: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.store.byKey(key);
    if (!record) return Promise.resolve({ ok: false, error: "No task record for this session." });
    if (TERMINAL_STATUSES.has(record.status)) return Promise.resolve({ ok: false, error: `This task is ${record.status}; nothing more is sent.` });
    const body = text.trim();
    if (!body) return Promise.resolve({ ok: false, error: "text is empty" });
    return this.sendAndRecord(record, kind, body, { spoke: kind !== "fallback", track: true });
  }

  /**
   * Send the task's words (prefixed) to its owning scope's chat and record
   * them: the conversation the mirror reads, the reply map, `sent`. `track`:
   * part of the task's turn (sendOut's undelivered bookkeeping); `patch`:
   * more to write with the record of a send that went out.
   */
  private async sendAndRecord(record: SubsessionRecord, kind: "reply" | "notify" | "ask" | "fallback", body: string,
    opts: { spoke: boolean; track?: boolean; patch?: (r: SubsessionRecord, at: number) => void }): Promise<{ ok: boolean; error?: string }> {
    const prefix = taskPrefix(record);
    const work = (async () => {
      const result = opts.track
        ? await this.sendOut(record, `${prefix} ${body}`, prefix)
        : await this.sendRaw(record, `${prefix} ${body}`, prefix);
      if (result.ok) {
        if (opts.spoke) this.spoke.add(record.id);
        const at = this.now();
        const replyIds = result.channel ? (result.messageIds ?? []).map((messageId) => ({ channel: result.channel!, messageId })) : [];
        const write = (r: SubsessionRecord): void => {
          // A retry of a write that did land is not applied twice.
          if (r.sent.some((m) => m.at === at && m.text === body && m.kind === kind)) return;
          r.sent.push({ at, kind, text: body });
          pushConversation(r, { at, from: "task", kind, text: truncate(body, CONVERSATION_TEXT_MAX) });
          for (const m of replyIds) r.replyMap.push({ ...m, at });
          opts.patch?.(r, at);
        };
        try {
          this.store.update(record.id, write);
        } catch (err) {
          // Out, but not recorded: the write is kept and tried again (until
          // then its reply ids still route the owner's replies to the task).
          log.error({ err, id: record.id }, "Could not record a sub-session's sent message; trying again");
          const kept = this.unrecorded.get(record.id) ?? [];
          kept.push({ write, replyIds });
          this.unrecorded.set(record.id, kept);
          this.armCustodyRetry();
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

  /** The send itself, errors folded into the result. */
  private async sendRaw(record: SubsessionRecord, text: string, harnessPrefix: string): Promise<ScopeSendResult> {
    try {
      return await this.deps.sendToScope(record.parentKey, text, record.sessionKey,
        `Your sub-session ${record.id} ("${record.title}")`, harnessPrefix);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * EVERY send of a task's words to its owning scope during its turn goes
   * through here. A send that fails, by its result or by throwing, marks the
   * turn's answer as undelivered (part of the turn's result: the inputs it
   * carried stay owed). Only a later send of the same text that goes out
   * clears that mark (the model was told the send failed, and sent it
   * again); a send of other words, which answers something else, does not.
   */
  private async sendOut(record: SubsessionRecord, text: string, harnessPrefix: string): Promise<ScopeSendResult> {
    const result = await this.sendRaw(record, text, harnessPrefix);
    // Keyed (and later quoted) without the harness prefix: a model that
    // copies the quote back must not send the prefix twice.
    const prefix = `${taskPrefix(record)} `;
    this.markDelivery(record.id, text.startsWith(prefix) ? text.slice(prefix.length) : text, result.ok);
    return result;
  }

  /** The turn's undelivered bookkeeping for one message (see sendOut). A hand-off that failed counts as a failed send. */
  private markDelivery(id: string, words: string, ok: boolean): void {
    const failed = this.undelivered.get(id);
    if (ok) {
      failed?.delete(words);
      if (failed?.size === 0) this.undelivered.delete(id);
    } else if (failed) {
      failed.add(words);
    } else {
      this.undelivered.set(id, new Set([words]));
    }
  }

  /**
   * task_update: a decision or change the owner should know about (scope,
   * approach, blocked or unblocked), kept with its time. The same line twice
   * in a row is kept once. Counts as progress.
   */
  postUpdate(key: string, line: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    const value = oneLine(line, PROGRESS_TEXT_MAX);
    if (!value) return record;
    let changed = false;
    const at = this.now();
    const updated = this.store.update(record.id, (r) => {
      const last = r.updates?.at(-1);
      if (last && !last.kind && last.text === value) return;
      (r.updates ??= []).push({ at, text: value });
      changed = true;
    });
    if (updated && changed) this.progressChanged.add(record.id);
    return updated;
  }

  /**
   * task_plan: replace the steps still ahead (empty clears the plan) and file
   * the ones just done, each with its one-line result. A change to either
   * counts as progress for the no-progress pause.
   *
   * Marking steps done, moving the status and adding steps at the end are
   * free. Dropping, rewording or reordering a step still ahead needs a
   * `reason`, filed as a plan-change update, so the owner sees why the
   * checklist moved (refused with `reason_required` without one, and nothing
   * is written). A reason given with any other change to the plan is filed
   * the same way.
   */
  setPlan(key: string, steps: ReadonlyArray<{ step: string; status?: "pending" | "in_progress" }>, done: ReadonlyArray<{ step: string; result?: string }> = [], reason?: string): PlanOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "no_record" };
    const finished = done.flatMap((d) => {
      const text = oneLine(d.step, PLAN_STEP_MAX);
      const result = d.result ? oneLine(d.result, STEP_RESULT_MAX) : "";
      return text ? [{ text, ...(result ? { result } : {}) }] : [];
    });
    const doneTexts = finished.map((f) => f.text);
    const sent: SubsessionPlanStep[] = steps.flatMap((s): SubsessionPlanStep[] => {
      const text = oneLine(s.step, PLAN_STEP_MAX);
      return text ? [{ text, status: s.status === "in_progress" ? "in_progress" : "pending" }] : [];
    });
    const why = reason ? oneLine(reason, PROGRESS_TEXT_MAX) : "";
    let changed = false;
    let refused = false;
    const at = this.now();
    // Checked inside the lock, against the plan on disk.
    const updated = this.store.update(record.id, (r) => {
      const next = planAfterDone(r.plan ?? [], sent, doneTexts).slice(0, PLAN_MAX_STEPS);
      const planChanged = JSON.stringify(r.plan ?? []) !== JSON.stringify(next);
      if (planChanged && !why && planNeedsReason(r.plan ?? [], next, doneTexts)) { refused = true; return; }
      // How many copies of each text were ahead: two steps may read the same.
      const ahead = countTexts(r.plan ?? []);
      if (planChanged) {
        changed = true;
        if (next.length > 0) r.plan = next;
        else delete r.plan;
      }
      for (const step of finished) {
        // A step that was still ahead is filed done, even one done before
        // (it was added again). One that was not (a retried call, the whole
        // done list sent again) is not filed twice: a new result for it
        // replaces the one it had.
        const filed = (ahead.get(step.text) ?? 0) > 0 ? undefined : [...(r.doneSteps ?? [])].reverse().find((d) => d.text === step.text);
        if (filed) {
          if (step.result !== undefined && filed.result !== step.result) { filed.result = step.result; changed = true; }
          continue;
        }
        (r.doneSteps ??= []).push({ at, ...step });
        ahead.set(step.text, (ahead.get(step.text) ?? 0) - 1);
        changed = true;
      }
      if (planChanged && why) (r.updates ??= []).push({ at, kind: "plan", text: why });
    });
    if (!updated) return { ok: false, error: "no_record" };
    if (refused) return { ok: false, error: "reason_required" };
    if (changed) this.progressChanged.add(record.id);
    return { ok: true, record: updated };
  }

  checkpoint(key: string, summary: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    this.progressChanged.add(record.id);
    return this.store.update(record.id, (r) => { r.checkpoint = summary.trim().slice(0, 8000); });
  }

  /**
   * task_finish. Refused while input is pending that the turn in flight does
   * not carry (it arrived after the turn started, so the task has never seen
   * it): finishing would leave it unread. The task stays as it is, and that
   * input is its next turn. Judged under the lock, like task_ask. After
   * MAX_FINISH_REFUSALS refused turns in a row whose unread count did not
   * go down (a turn with less unread does not count), the next turn finishes anyway: the unread input is quoted in the report
   * and stays pending, answered like any input to a finished task.
   * Outside a turn of its own (no task calls a tool there) nothing is refused.
   */
  finish(key: string, report: string): FinishOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, from: null };
    const id = record.id;
    const turn = this.inflightTurn.get(id);
    const through = this.inflightThrough.get(id) ?? 0;
    let unread: SubsessionInput[] = [];
    let forced = false;
    const outcome = this.transition(id, "finish", {
      guard: (r) => {
        if (turn === undefined) return undefined;
        unread = r.pendingInput.filter((i) => i.seq > through);
        if (unread.length === 0) return undefined;
        const prev = this.finishRefusals.get(id);
        forced = prev !== undefined && prev.turn !== turn && prev.turns >= MAX_FINISH_REFUSALS;
        return forced ? undefined : `${unread.length} unread input${unread.length === 1 ? "" : "s"} this turn does not carry`;
      },
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
        r.report = forced ? `${report.trim()}\n\n${formatUnreadAtFinish(unread)}` : report.trim();
        r.reportDelivered = false;
        delete r.restored;
      },
    });
    if (!outcome.ok) {
      if (!outcome.refused || turn === undefined || unread.length === 0) return outcome;
      const prev = this.finishRefusals.get(id);
      // A retry in the same turn changes nothing: the turn counts once, with what its first refusal saw.
      // A turn with less unread than the last refused one does not count
      // (it is getting through it), but does not start over either: drops
      // in a row are bounded by the count, so the streak still ends.
      const turns = !prev ? 1 : prev.turn === turn || unread.length < prev.unread ? prev.turns : prev.turns + 1;
      if (prev?.turn !== turn) this.finishRefusals.set(id, { turns, turn, unread: unread.length });
      log.info({ id, unread: unread.length, turns }, "Sub-session task_finish refused: input it has not read is pending");
      return { ...outcome, unread: unread.length };
    }
    this.finishRefusals.delete(id);
    if (forced) log.warn({ id, unread: unread.length }, "Sub-session finished with input it has not read, after refusals in a row; the input stays pending");
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

  /**
   * A tool call finished on a task session. Every tool call counts as the
   * task doing something, task_plan and task_update included (even one that
   * changed nothing): the no-progress pause is for turns that call no tool.
   */
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
    this.safely(() => this.secureCustody(), "notices held on records");
    this.safely(() => this.handOffAfterRestart(), "hand-offs after a restart");
    this.safely(() => {
      for (const task of this.store.list()) {
        if (task.status !== "queued" && !TERMINAL_STATUSES.has(task.status) && this.plan(task)) this.kick(task.id);
      }
    }, "resume owed turns");
    this.sweepTimer = setInterval(() => this.safely(() => this.sweep(), "sweep"), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    this.externalWaitTimer = setInterval(() => {
      if (!this.open || this.deps.isStopping()) return;
      this.safely(() => this.checkExternalWaits("while Tomo was running"), "check-back recheck");
      this.safely(() => this.schedule(), "schedule after the check-back recheck");
      this.safely(() => this.forwardOverdueQuestions(), "forward overdue questions");
      this.safely(() => this.secureCustody(), "notices held on records");
    }, EXTERNAL_WAIT_CHECK_MS);
    this.externalWaitTimer.unref?.();
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
    if (this.externalWaitTimer) clearInterval(this.externalWaitTimer);
    this.externalWaitTimer = undefined;
    if (this.custodyTimer) clearTimeout(this.custodyTimer);
    this.custodyTimer = undefined;
    this.flushUnrecorded();
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
   * not fsynced, was unreadable when the task parked, or the job was disabled
   * or removed while Tomo ran) would wait forever: let it run again and
   * schedule a new one itself. Runs after restart recovery and every
   * EXTERNAL_WAIT_CHECK_MS while dispatch is open. A store that still cannot
   * be read is looked at again shortly, in this process. Never schedules:
   * the caller does, once it is safe to.
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
        patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "Your scheduled check-back is missing (removed, disabled, lost in a restart, or never saved). Check on what you were waiting for, and schedule a new check-back if you still need to wait.")); },
      });
    }
    if (unknown) this.armCronRecheck();
  }

  private armCronRecheck(): void {
    if (this.cronRecheckTimer || this.deps.isStopping()) return;
    this.cronRecheckTimer = setTimeout(() => {
      this.cronRecheckTimer = undefined;
      this.safely(() => this.checkExternalWaits("once the cron store could be read again"), "cron recheck");
      this.safely(() => this.schedule(), "schedule after the cron recheck");
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
      // Looked at again shortly: a queued task holding the owner's message
      // must not wait for some later event to come along.
      log.error({ err }, "Sub-session scheduler could not read the task table; trying again shortly");
      this.armRegistryRecheck();
      return;
    }
    let active = tasks.filter((t) => t.status === "active").length;
    const queued = tasks.filter((t) => t.status === "queued")
      .sort((a, b) => Number(b.resumeNeeded) - Number(a.resumeNeeded) || a.createdAt - b.createdAt);
    const max = this.deps.config().maxRunning;
    // A queued task holding a message the owner wrote to it never waits for
    // a slot. Read from the table, so a start that failed, or that a restart
    // cut off, is made here the next time the scheduler runs.
    for (const task of queued) {
      if (!task.pendingInput.some((p) => p.text.includes(OWNER_MESSAGE_MARKER))) continue;
      try {
        if (this.startTask(task.id, "the owner wrote to it")) active += 1;
      } catch (err) {
        log.error({ err, id: task.id }, "Could not start a queued sub-session for the owner's message; trying again shortly");
        this.armRegistryRecheck();
      }
    }
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
    let record: SubsessionRecord | undefined;
    try {
      record = this.store.get(id);
    } catch (err) {
      // Unreadable just now: nothing else may come along to start it (an
      // owner's message to a queued task waits on exactly this), so look again.
      log.warn({ err, id }, "Could not read a queued sub-session to start it; trying again shortly");
      this.armRegistryRecheck();
      return false;
    }
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
    let racing: { done: Promise<{ ok: true; already?: boolean } | { ok: false; error: string }>; text: string; at: number } | undefined;
    const outcome = this.transition(id, event, {
      reason: event === "relay" ? "a message from the main session" : "a message from the owner",
      guard: inputQueueFull,
      patch: (r) => {
        // A question the task asked that never reached the owner (its
        // forward had not gone out yet) ends with this wake: the task is
        // told, so it does not take this message for the answer.
        // A forward in flight may still land: the task is told what happened
        // once it settles (racing), not guessed now.
        const ask = r.pendingAsk && this.unforwarded(r) ? r.pendingAsk : undefined;
        const inFlight = ask ? this.forwarding.get(r.id) : undefined;
        racing = ask && inFlight?.at === ask.at ? { done: inFlight.done, text: ask.text, at: ask.at } : undefined;
        let note: string | undefined;
        // An earlier question marked as never shown is told now, before any
        // new mark could take its place.
        const earlier = r.forwardRacing?.failed ? notShownNote(r.forwardRacing.text) : undefined;
        if (earlier) delete r.forwardRacing;
        if (racing) {
          // Written before the owner could have seen the question, whatever
          // the send does: said now, in this turn's own input. Whether the
          // question then went out is settled on the record (forwardRacing).
          note = formatTomoEvent("subsession-redelivery",
            `Your question was still being sent to the owner when this message came, so this message was written before they saw it and is most likely not an answer to it:\n${quoteBlock(racing.text)}\nIf the question reaches them, their answer to it comes to you as their words. If it does not, you will be told.`,
            { name: "question-in-flight" });
          r.forwardRacing = { at: racing.at, text: racing.text };
        } else if (ask) {
          note = formatTomoEvent("subsession-redelivery",
            `Your question had not been forwarded to the owner when this message came, so this message is most likely not an answer to it:\n${quoteBlock(ask.text)}\nAsk again with task_ask if you still need it.`,
            { name: "question-not-shown" });
        }
        const notes = [earlier, note].filter((x): x is string => x !== undefined);
        appendInput(r, notes.length > 0 ? `${prompt}\n\n${notes.join("\n")}` : prompt, { from: "owner", words });
        // The owner's word: the wall-clock cap counts from here again.
        r.activeAtOwnerInputMs = activeTotalMs(r, now);
        extra?.(r);
      },
    });
    if (!outcome.ok) return outcome;
    if (racing) {
      const { done, at } = racing;
      void done.catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
        .then((result) => this.settleForwardRace(id, at, result.ok));
    }
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
        // The scheduler starts it from the table at the next recheck (and
        // after a restart), past the slot cap.
        log.error({ err, id }, "Could not start a queued sub-session for the owner's message; trying again shortly");
        this.armRegistryRecheck();
      }
      return { ...outcome, record: this.safeGet(id) ?? outcome.record };
    }
    return outcome;
  }

  /**
   * A message woke the task while its question was being forwarded (the task
   * was told so in that input). The send settled: out, and the mark goes
   * (the owner's answer comes back through the reply map); failed, and the
   * mark says so, and the task is told with its next input.
   */
  private settleForwardRace(id: string, at: number, reached: boolean): void {
    try {
      this.store.update(id, (r) => {
        if (r.forwardRacing?.at !== at) return;
        if (reached) delete r.forwardRacing;
        else r.forwardRacing.failed = true;
      });
    } catch (err) {
      log.error({ err, id }, "Could not record how a sub-session question's forward ended; settled again later");
      this.armCustodyRetry();
      return;
    }
    if (!reached) this.tellNotShown(id);
  }

  /**
   * A question marked as not shown goes to the task with input of its own
   * only while a turn is coming anyway (active or queued) and the input list
   * has room; otherwise it rides on the task's next wake (deliverInput).
   */
  private tellNotShown(id: string): void {
    let told = false;
    try {
      this.store.update(id, (r) => {
        if (!r.forwardRacing?.failed) return;
        if (r.status !== "active" && r.status !== "queued") return;
        if (r.pendingInput.length >= PENDING_INPUT_MAX) return;
        appendInput(r, notShownNote(r.forwardRacing.text));
        delete r.forwardRacing;
        told = true;
      });
    } catch (err) {
      log.error({ err, id }, "Could not tell a sub-session its question was never shown; told later");
      this.armCustodyRetry();
      return;
    }
    if (told) {
      const record = this.safeGet(id);
      if (record?.status === "active") this.kick(id);
      else if (record?.status === "queued") this.schedule();
    }
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
      if (turn.fromOwner) this.ownerTurns.add(id);
      const serial = ++this.turnSerial;
      this.inflightTurn.set(id, serial);
      let outcome: TaskTurnOutcome;
      try {
        outcome = await this.deps.runTaskTurn(record.sessionKey, turn.prompt, { bare: turn.kind === "compact" });
        if (!outcome.shutdown) outcome = await this.answerUnanswered(id, turn, outcome);
      } finally {
        clearInterval(heartbeat);
        this.inflightThrough.delete(id);
        this.ownerTurns.delete(id);
        this.inflightTurn.delete(id);
        // Refused turns count only in a row: a turn with no refusal ends the streak.
        if (this.finishRefusals.get(id)?.turn !== serial) this.finishRefusals.delete(id);
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
      // could spin on a check-back that exists. A fire wakes it, or, once
      // the store reads again and the job is gone, checkExternalWaits (the
      // cron recheck, the periodic check, the next start).
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

/** The unread input a forced task_finish quotes in its report. */
function formatUnreadAtFinish(unread: SubsessionInput[]): string {
  return [
    `[Tomo: this task finished with ${unread.length} input${unread.length === 1 ? "" : "s"} it never read (task_finish was refused ${MAX_FINISH_REFUSALS} turns in a row and more kept arriving). They stay with the task, which still gets them as a finished task:]`,
    ...unread.map((i, n) => `${n + 1}. ${truncate((i.words ?? i.text).trim(), UNREAD_AT_FINISH_EXCERPT)}`),
  ].join("\n");
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

/** The text as a quote, line by line (the owning session must see it as the task's words, not its own). */
function quoteBlock(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What task_plan did: saved, or refused because the change needs a reason (or the task has no record). */
export type PlanOutcome = { ok: true; record: SubsessionRecord } | { ok: false; error: "no_record" | "reason_required" };

function countTexts(steps: readonly SubsessionPlanStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.text, (counts.get(s.text) ?? 0) + 1);
  return counts;
}

/**
 * The steps with ONE copy taken out per name in `done`: the copy in
 * progress if there is one, else the first. Two steps may read the same
 * ("run the tests" early and again at the end); finishing one leaves the
 * other. `limit` caps how many copies of a text go; `prefer` names, per
 * text, which copies (by their place among that text's copies) to take
 * first. Also returns the places of the copies it took, the same way.
 */
function takeOut(steps: readonly SubsessionPlanStep[], done: readonly string[], limit?: Map<string, number>, prefer?: Map<string, number[]>): { kept: SubsessionPlanStep[]; took: Map<string, number[]> } {
  const gone = new Set<number>();
  const took = new Map<string, number[]>();
  for (const text of done) {
    const already = took.get(text) ?? [];
    if (limit && already.length >= (limit.get(text) ?? 0)) continue;
    const copies = steps.flatMap((s, i) => (s.text === text ? [i] : []));
    const free = copies.map((at, nth) => ({ at, nth })).filter((c) => !gone.has(c.at));
    const wanted = prefer?.get(text)?.find((nth) => !already.includes(nth));
    const pick = free.find((c) => c.nth === wanted) ?? free.find((c) => steps[c.at].status === "in_progress") ?? free[0];
    if (!pick) continue;
    gone.add(pick.at);
    took.set(text, [...already, pick.nth]);
  }
  return { kept: steps.filter((_, i) => !gone.has(i)), took };
}

/**
 * The plan a task_plan call leaves: the steps it sent, less any it also
 * marked done. A done step is dropped from what was sent only as often as
 * it was sent again on top of the copies that stay ahead (the plan before,
 * less what is done), so another step with the same text is kept. Where it
 * was sent again, the copy dropped is the one in the same place as the copy
 * finished in the plan before.
 *
 * One call cannot be told from its own retry: with two copies ahead,
 * `steps: [build, run tests]` + `done: [run tests]` finishes the first;
 * sent again, it reads as "the second is done too, sent again by mistake".
 */
export function planAfterDone(before: readonly SubsessionPlanStep[], sent: readonly SubsessionPlanStep[], done: readonly string[]): SubsessionPlanStep[] {
  const { kept, took } = takeOut(before, done);
  const staying = countTexts(kept);
  const extra = new Map<string, number>();
  for (const [text, n] of countTexts(sent)) extra.set(text, Math.max(0, n - (staying.get(text) ?? 0)));
  return takeOut(sent, done, extra, took).kept;
}

/**
 * Whether replacing `before` with `after` drops, rewords or reorders a step
 * still ahead. A step leaving the plan as one of `done` is not dropped, a
 * status change is not a rewording, and new steps are free only after every
 * step that stayed.
 */
export function planNeedsReason(before: readonly SubsessionPlanStep[], after: readonly SubsessionPlanStep[], done: readonly string[]): boolean {
  const kept = takeOut(before, done).kept.map((s) => s.text);
  // The steps that stayed must open the new plan, in their order; anything after them is an addition.
  if (after.length < kept.length) return true;
  return kept.some((text, i) => after[i].text !== text);
}
