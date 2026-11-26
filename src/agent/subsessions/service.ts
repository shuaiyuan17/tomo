import { createHash, randomUUID } from "node:crypto";
import { log } from "../../logger.js";
import { INTERRUPTED_NOTE_MARKER } from "../pending-notes-queue.js";
import { ownerT, type OwnerText } from "../../i18n/index.js";
import type { SubsessionConfig } from "../../config.js";
import { isTaskSessionKey } from "../../sessions/keys.js";
import { appendToTomoEventBody, formatTomoEvent } from "../../tomo-event.js";
import type { QuotaGateReading } from "../../usage/limits-log.js";
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
import type { OwnerTurnMessage } from "../audience.js";
import { classifyFailure, failureDetail, failureHint, type TurnFailure } from "./failure.js";
import { OPEN_STATUSES, OWNER_ACTION_MAX, OWNER_MESSAGE_MARKER, PENDING_INPUT_MAX, PENDING_INPUT_OWNER_RESERVE, needsOwner, reportNumber, PLAN_MAX_STEPS, PLAN_STEP_MAX, PROGRESS_TEXT_MAX, STEP_RESULT_MAX, TERMINAL_STATUSES, oneLine, type SubsessionPlanStep, activeTotalMs, appendInput, HARNESS, type InputOrigin, lastInputSeq, type SubsessionConversationEntry, type SubsessionInput, type SubsessionRecord, type SubsessionStatus } from "./types.js";


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
  /** A failed turn: what it left of why (see ./failure.ts). */
  failure?: TurnFailure;
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
  /** `id`: the event's stable identity, so a second copy of it is not queued (see PendingNotesQueue.queueNote). */
  queuePendingNote(key: string, note: string, id?: string): boolean;
  /**
   * Take back a note just queued whose write failed (the sender is told it
   * was not handed over, so it must not reach a turn from memory).
   */
  withdrawPendingNote?(key: string, match: (note: string) => boolean): boolean;
  /** `whenUnreadable` is the answer while the session's stored notes cannot be read. */
  hasPendingNote(key: string, predicate: (note: string) => boolean, whenUnreadable?: boolean): boolean;
  /**
   * Write the session's pending notes (queued and in flight) to disk again.
   * A note whose first write failed is still held in memory, so finding it
   * there does not mean it is durable. Returns false when the write fails.
   */
  persistPendingNotes?(key: string): boolean;
  /** A pending-notes file was moved aside and its notes are not all written again yet (see rebuildLostNotes): nothing is cleaned up meanwhile. */
  pendingNotesRecovering?(): boolean;
  /** A harness notice to the owner's own chat (no task to attribute it to). `false`: it could not be sent (no reachable DM). */
  noticeOwner(text: OwnerText): Promise<boolean | void>;
  /** The owner's own main session key (where notices about sub-sessions as a whole go, ownerMessages "via-main"). */
  ownerKey?(): string | undefined;
  /**
   * A silent turn on the owning session that reads the notes queued for it.
   * `taskId`: the task it is for, so the Cost page charges the turn to it.
   */
  wakeScope(parentKey: string, prompt: string, taskId?: string): void;
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
   * What the quota gate reads: the fuller of the subscription's 5-hour and
   * weekly windows (`readQuotaGateReading`), 0–100; undefined when neither is
   * known (no quota samples yet, API-key auth). Throws when the samples
   * cannot be read: the gate then lets the turn run (fail open).
   */
  quotaReading?(): QuotaGateReading | undefined;
  /**
   * Before a task's own turn is gated: take a fresh usage reading when the
   * last one is stale, waiting a bounded time (QuotaGateReader.ensureFresh).
   * Never rejects.
   */
  freshenQuota?(): Promise<void>;
  now?(): number;
  /**
   * mirror "turn": a silent turn on the owning session, which takes the
   * unseen conversation as its prefix. Merged while one is already queued.
   */
  mirrorWake?(parentKey: string): void;
  /**
   * ownerMessages "via-main": a silent turn on the owning session for the
   * `subsession-message` notes its tasks handed it. Merged while one is
   * queued; it runs only if such a note is still unread when it starts.
   */
  messageWake?(parentKey: string): void;
}

export const STOP_TIMEOUT_MS = 30_000;
export const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The waiting reason of a task waiting on its own background work (its report wakes it). */
const WAITING_FOR_OWNER = "waiting for the owner";
/** A wait on the task's own background work gets a turn after this long, while the work still runs (checkExternalWaits). */
export const BACKGROUND_WAIT_MAX_MS = 60 * 60_000;
export const BACKGROUND_WAIT_REASON = "waiting for its background work to report back";
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
/** Default of `subsessions.quotaPauseAtPct`: at this share of the fuller quota window, a task's own turns pause for the owner. */
export const QUOTA_PAUSE_PERCENT = 85;
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
  /**
   * Carries the owner's own words (a message to the task, or theirs attached
   * to a relay), by each input's stored origin: text the task wrote but did
   * not send goes to them as its answer (fallback send).
   */
  fromOwner: boolean;
  /**
   * Carries a message the owner wrote to the task itself (/s, a reply, the
   * panel): a turn that says nothing at all keeps it for the next turn. Words
   * of theirs passed on in a relay ("keep going") may need no answer.
   */
  ownerMessage: boolean;
  resume: boolean;
  /**
   * Runs again what an earlier turn may have done (inputs that may have been
   * seen, or a resume after a cut-short turn): what it hands the main
   * session may repeat what that turn handed over.
   */
  retry?: boolean;
  start: boolean;
}

type SpeakKind = "notify" | "reply" | "ask" | "fallback";

/**
 * How a task's words went: `direct` to the owner's chat, `main` as a note to
 * the owning session, `panel` kept in the web task panel. `waiting`
 * (task_ask): the task now waits for the owner.
 */
export interface SpeakResult {
  ok: boolean;
  error?: string;
  via?: "direct" | "main" | "panel";
  waiting?: boolean;
  /** task_ask: not handed over after all (input is pending that the turn has not read). */
  withdrawn?: boolean;
}

/** Is the question standing after a transition the same one (same note) as before it? */
function sameQuestion(before: NonNullable<SubsessionRecord["askViaMain"]>, after: SubsessionRecord["askViaMain"]): boolean {
  if (!after) return false;
  return before.note !== undefined || after.note !== undefined ? before.note === after.note : before.at === after.at;
}

/** A message note's name: the task, the tool, the highest input seq its turn answers, and a digest of the words. */
function messageNoteName(id: string, kind: SpeakKind, body: string, through: number): string {
  return `${id}:${kind}:${through}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

/** A message note name's parts (see messageNoteName); undefined for any other name. */
function parseMessageNoteName(name: string): { id: string; kind: string; through: number; digest: string } | undefined {
  const m = /^([^:]+):([a-z]+):(\d+):([0-9a-f]+)$/.exec(name);
  return m ? { id: m[1], kind: m[2], through: Number(m[3]), digest: m[4] } : undefined;
}

/** The name of a task_ask note, or undefined for any other note. */
function askNoteName(note: string): string | undefined {
  const name = messageNoteNameOf(note);
  return name && /^[^:]+:ask:/.test(name) ? name : undefined;
}

/**
 * The name of a `subsession-message` note, read from its OUTER envelope only
 * (after an interrupted-note marker, if any): the body may quote a tag.
 * Undefined for any other note.
 */
export function messageNoteNameOf(note: string): string | undefined {
  const head = note.startsWith(INTERRUPTED_NOTE_MARKER) ? note.slice(INTERRUPTED_NOTE_MARKER.length).replace(/^\n/, "") : note;
  const tag = /^<tomo-event\b[^>]*>/.exec(head)?.[0];
  if (!tag || !tag.startsWith(MESSAGE_NOTE_MARKER)) return undefined;
  return /\bname="([^"]*)"/.exec(tag)?.[1] ?? "";
}

/** Every `subsession-message` note starts its opening tag with this. */
export const MESSAGE_NOTE_MARKER = '<tomo-event type="subsession-message"';

/**
 * A task's task_reply / task_ask (or the fallback answer) for
 * the owning session: labeled with the task, quoting the words in full,
 * with what is expected of the session.
 */
function formatMessageNote(record: SubsessionRecord, kind: SpeakKind, body: string, name: string, retry = false): string {
  const who = `Sub-session ${record.id} ("${record.title}")`;
  const head = kind === "ask"
    ? `${who} asks the owner (task_ask) and waits for their answer:`
    : kind === "notify"
      ? `${who} has news for the owner:`
      : `${who} answers the owner's message to it${kind === "fallback" ? " (its turn's text; it sent no task_reply)" : ""}:`;
  const tail = kind === "ask"
    ? `Put this question to the owner (keep its options; send_message, and its MEDIA: lines if any); don't answer it for them, even if you think you know. When they answer, pass it on with task_message ${record.id} and attach_owner_message, in the turn of their answer, so the task gets their own words: that ends the wait. task_status ${record.id} shows the question while it waits.`
    : `Decide whether, when and how the owner hears it (send_message, in your own words or as is; its MEDIA: lines if a file should go with it). Nothing else delivers it.`;
  // The harness never hands the same words over twice while a note is
  // unread; past that, the session that tells the owner is where a repeat
  // from a retried turn is caught.
  const repeat = retry
    ? ["", "Its previous turn did not complete and this one runs again: this may repeat something it already handed you. Don't tell the owner the same thing twice."]
    : [];
  return formatTomoEvent("subsession-message", [head, body, "", tail, ...repeat].join("\n"), { name });
}

/** Why the harness gives a notice, for the owning session's note. */
interface NoticeCause {
  /** A short machine-readable kind (no_progress, turns_failing, quota, …). */
  kind: string;
  reason: string;
  /** The failed turns' cause (category, error text), when the notice is about failures. */
  failure?: { category?: string; refused?: boolean; detail?: string };
  /** The task has ended (failed): nothing resumes it. */
  ended?: boolean;
  /** The task is finished; a message to it reopens it. */
  finished?: boolean;
  /** More for the session, appended as is. */
  detail?: string;
}

const NO_SESSION_CAUSE: NoticeCause = { kind: "conversation_lost", reason: "its conversation could not be found, and starting over could repeat what it already did", ended: true };
const INPUT_FULL_CAUSE: NoticeCause = { kind: "input_full", reason: "a scheduled check-back was dropped: too many messages are already waiting for it" };

/**
 * A notice note's name: the task (or "subsessions"), the kind "notice", the
 * occurrence, and a digest of its words. A task's notice is one event each
 * time (two check-backs dropped are two notes): it is always queued, and
 * `occurrence` only labels it. A notice about the list itself, said again at
 * each start while it holds, is 0 and matched by name: the same one still
 * unread is not handed over twice.
 */
function noticeNoteName(id: string | undefined, notice: string, cause: NoticeCause, occurrence: number): string {
  return `${id ?? "subsessions"}:notice:${occurrence}:${createHash("sha256").update(`${notice}\n${JSON.stringify(cause)}`).digest("hex").slice(0, 16)}`;
}

/** A harness notice, handed to the owning session instead of the owner's chat (ownerMessages "via-main"). */
function formatNoticeNote(notice: string, cause: NoticeCause, name: string, record?: SubsessionRecord): string {
  const lines: string[] = [];
  if (record) {
    const id = record.id;
    lines.push(`The harness has news about sub-session ${id} ("${record.title}") and hands it to you instead of the owner's chat:`, notice, "");
    lines.push(`Why: ${cause.reason} (kind: ${cause.kind}).`);
    if (cause.failure) {
      const category = cause.failure.category;
      lines.push(`Failure category: ${category ?? "unknown"}${cause.failure.detail ? ` (last error: ${cause.failure.detail})` : ""}.`, failureHint(category, cause.failure.refused === true));
    }
    if (cause.detail) lines.push("", cause.detail);
    lines.push("");
    if (cause.ended) lines.push(`It has ended; nothing resumes it. If the work is still needed, start it again with task_spawn. task_status ${id} shows what it did.`);
    else if (cause.finished) lines.push(`task_message ${id} reopens it with what you write (the owner can also write /s ${id} …). task_status ${id} shows its record.`);
    else lines.push(`To go on: task_message ${id} with what it should do (the owner can also write /s ${id} …). To end it: task_cancel ${id}. task_status ${id} shows its plan and steps.`);
  } else {
    lines.push("The harness has news about the sub-sessions and hands it to you instead of the owner's chat:", notice, "", `Why: ${cause.reason}.`, "Any /s command it names is the owner's to send.");
  }
  lines.push("Decide whether, when and how the owner hears it (send_message, in your own words). Nothing else tells them.");
  return formatTomoEvent("subsession-message", lines.join("\n"), { name });
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
  /** Set while the startup hook's work is incomplete: no record is archived or forgotten, so a later start can still match against it as it is. */
  private keepEndedRecords = false;
  private readonly reportTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportAttempts = new Map<string, number>();
  /** The highest input seq the turn in flight carries, per task (runtime only). */
  private readonly inflightThrough = new Map<string, number>();
  /** Which turn is in flight, per task: a serial, so two turns that carry the same seq still differ. */
  private readonly inflightTurn = new Map<string, number>();
  /** Tasks whose turn in flight is a retry (PlannedTurn.retry). */
  private readonly inflightRetry = new Set<string>();
  /** Tasks whose last turn did not complete (its start or "continue" runs again, with no input to mark it). */
  private readonly lastTurnFailed = new Set<string>();
  /** Per task, the message notes the turn in flight already wrote or matched (see handToMain). */
  private readonly notesUsed = new Map<string, Set<string>>();
  /** Per task, the panel answers the turn in flight has already matched as repeats (by their time). */
  private readonly panelRepeatsUsed = new Map<string, Set<number>>();
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

  /**
   * The owner did what a finished task's report asked of them, or says it no
   * longer needs doing (`/s <id> done`, or task_done from the owning
   * session): the task stops showing as "Needs you". `scope` is the session
   * that asked; a task of another scope is unknown here. `report` is the
   * report seq the owner answered (task_done carries the one its note
   * named): a newer report's ask is never cleared by an answer to an older
   * one (reason "newer", with the record). Without it (a bare `/s <id> done`)
   * it is report 1: what the owner saw when they typed it is not known, so
   * once a task has sent a second report the number has to be given.
   * Not a transition: the task stays finished, and archives like any other.
   */
  markDone(scope: string, id: string, report?: number): { ok: true; record: SubsessionRecord } | { ok: false; reason: "unknown" | "nothing" | "unreadable" } | { ok: false; reason: "newer"; record: SubsessionRecord } {
    if (!this.available()) return { ok: false, reason: "unreadable" };
    const record = this.store.get(id);
    if (!record || record.parentKey !== scope) return { ok: false, reason: "unknown" };
    if (!needsOwner(record)) return { ok: false, reason: "nothing" };
    // Under the lock, and only the ask of the report the owner answered: a
    // task_finish that landed since is a new report (a new reportSeq) whose
    // ask they have not answered, even when its words are the same.
    const seq = report ?? 1;
    // A number past the latest report answers nothing the task asked.
    if (seq > reportNumber(record)) return { ok: false, reason: "nothing" };
    if (reportNumber(record) !== seq) return { ok: false, reason: "newer", record };
    let cleared = false;
    let newer = false;
    const updated = this.store.update(id, (r) => {
      if (r.status !== "finished" || !r.ownerAction) return;
      if (reportNumber(r) !== seq) { newer = true; return; }
      delete r.ownerAction;
      cleared = true;
    });
    if (updated && newer) return { ok: false, reason: "newer", record: updated };
    if (!updated || !cleared) return { ok: false, reason: "nothing" };
    log.info({ id }, "Sub-session marked done by the owner");
    return { ok: true, record: updated };
  }

  /**
   * The owner checked a table recovered from its backup (or found missing
   * tasks) and says it is right (`/s trust`). Every `restored` mark and the
   * table's `untrusted` mark go, and the registry task sessions the table
   * does not know are let go (unlinked; their transcripts stay on disk),
   * which is what the recovery notice said this would do. Refused while the
   * session registry cannot be read: which entries the table does not know
   * would be a guess.
   */
  trust(): { ok: true; unlinked: number; failed: number } | { ok: false; reason: "unreadable" | "registry" | "nothing" } {
    if (!this.available()) return { ok: false, reason: "unreadable" };
    if (!this.deps.registryReadable()) return { ok: false, reason: "registry" };
    let orphans: string[];
    try {
      const table = this.store.read();
      const known = new Set(table.tasks.map((t) => t.sessionKey));
      orphans = this.deps.registryTaskKeys().filter((k) => !known.has(k));
      // Their ids stay given out: a later task never reuses one.
      const highest = Math.max(0, ...orphans.map(taskNumber));
      if (highest >= table.nextId) this.store.reserveIdsThrough(highest);
      if (!this.store.trust()) return { ok: false, reason: "nothing" };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    this.trustedAtStart = true;
    // Archiving and forgetting wait for the next start all the same: the
    // startup hook did not run on a table it could not trust.
    let unlinked = 0;
    let failed = 0;
    for (const key of orphans) {
      log.warn({ key }, "The owner trusted the recovered task table; unlinking a registry task session it does not know");
      try {
        this.deps.unlinkRegistryEntry(key);
        unlinked += 1;
      } catch (err) {
        // Tried again at the next start (an unknown entry next to a trusted table).
        failed += 1;
        log.error({ err, key }, "Sub-session unlink orphan failed");
      }
    }
    log.info({ unlinked, failed }, "The owner trusted the sub-session table again");
    return { ok: true, unlinked, failed };
  }

  /** Whether the table is marked as possibly missing tasks or stale (see `SubsessionTable.untrusted`), so cleanup waits for `/s trust`. */
  untrusted(): boolean {
    try { return !!this.store.read().untrusted || this.store.list().some((t) => t.restored); } catch { return false; }
  }

  /** The owning session passes something on. */
  relay(id: string, text: string, ownerMessages: readonly OwnerTurnMessage[] = []): TransitionOutcome & { held?: "answer" | "paused" } {
    if (!this.available()) return { ok: false, from: null };
    if (ownerMessages.length === 0) {
      // A task waiting for the owner is woken only by the owner's own
      // words. A note without them does not end the wait (to a question, it
      // would only ask again, and the two sessions could go round for good;
      // to a pause, the time or usage limit would pause it again at once): it
      // is kept, held, and goes to the task with the owner's word. Every
      // waiting(owner) task is held so, whether or not it recorded what it
      // waits on (fail closed).
      const held = this.holdForAnswer(id, text);
      if (held) return held;
    }
    // The owning session's own words are a note from it, never the owner's
    // word: only messages the harness copied from the owner's own turn
    // (`ownerMessages`) count as the owner's input, for everything gated on
    // the owner (the wall-clock cap, the quota gate, the handback). A task
    // waiting on a question it handed to the main session is woken either
    // way, and told whether the owner's answer came with it.
    const origin: InputOrigin = ownerMessages.length > 0
      ? { from: "owner", words: ownerMessages.map((m) => m.text).join("\n\n") }
      : { from: "main", words: text };
    // Framed as the answer to the question the main session put to the owner;
    // a question the task sent the owner directly was not put by it. A note
    // with none of the owner's words is the session's own (autonomous) work:
    // it queues a task waiting on something external, never past the cap.
    return this.deliverInput(id, ownerMessages.length > 0 ? "relay" : "note", (r) => formatRelayEvent(text, r.askViaMain && !r.askViaMain.direct ? r.askViaMain.text : undefined, ownerMessages), origin);
  }

  /** relay() of a note alone to a task waiting for the owner: kept for the owner's wake ("answer" to a recorded question, else "paused"); undefined when the task is not waiting for the owner. */
  private holdForAnswer(id: string, text: string): (TransitionOutcome & { held: "answer" | "paused" }) | undefined {
    let refused: string | undefined;
    let held: "answer" | "paused" | undefined;
    const record = this.store.update(id, (r) => {
      if (r.status !== "waiting" || r.waitingOn !== "owner") return;
      held = r.askViaMain ? "answer" : "paused";
      refused = inputQueueFull(r, PENDING_INPUT_OWNER_RESERVE);
      if (refused) return;
      holdInput(r, formatRelayEvent(text), { from: "main", words: text });
    });
    if (!record || !held) return undefined;
    if (refused) return { ok: false, from: record.status, record, refused, held };
    log.info({ id, held }, "A note from the main session to a sub-session waiting for the owner; kept for their wake");
    return { ok: true, changed: false, from: record.status, record, held };
  }

  /**
   * The owner wrote to a task (`/s <id> …`, or a reply to one of its
   * messages). `scope` is the session the owner wrote from: a task owned by
   * another scope is unknown here. `messageId` dedups a replayed delivery.
   * The message is on disk (the task's pendingInput) when this returns ok.
   */
  ownerMessage(scope: string, id: string, text: string, opts: { messageId?: string; files?: string[]; source?: "panel" } = {}): OwnerMessageResult {
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
      outcome = this.deliverInput(id, "owner_message", formatOwnerMessageEvent(text, opts.files),
        { from: "owner", words: ownerWords(text, opts.files), ...(opts.source ? { source: opts.source } : {}) }, (r) => {
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
  // Task side (task_reply / task_ask / task_plan / task_update / task_checkpoint / task_finish / task_reopen)
  // ---------------------------------------------------------------------

  /** A message sent as unprompted news, whatever the turn carries (no tool calls this; task_reply picks the kind). */
  async notify(key: string, text: string): Promise<SpeakResult> {
    return this.speak(key, "notify", text);
  }

  /**
   * task_reply, the task's one way to speak: an answer when the turn in
   * flight carries a message the owner wrote to it, otherwise a message it
   * sends unprompted (notify). Which one decides only the note's heading
   * and whether an answer to a panel message stays in the panel.
   */
  async reply(key: string, text: string): Promise<SpeakResult> {
    const record = this.safeByKey(key);
    return this.speak(key, record && this.answersOwner(record) ? "reply" : "notify", text);
  }

  /**
   * task_ask: a question only the owner can answer. Sent first, then the
   * task waits for the owner (nothing autonomous wakes it). A send that
   * failed leaves the status as it was, so the task can try again.
   */
  async ask(key: string, question: string): Promise<SpeakResult> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (record.status !== "active" && record.status !== "waiting") {
      return { ok: false, error: `task_ask needs an active task; this one is ${record.status}. Use task_reply to answer the owner, or task_reopen first.` };
    }
    // Input this turn does not carry — the owner's answer that arrived while
    // the question was being sent, or anything that was already waiting
    // before the ask — is pending, and its kick() found this turn running.
    // Waiting now would strand it (nothing autonomous wakes waiting(owner)),
    // so the guard, judged under the lock, keeps the task as it is and that
    // input is its next turn.
    const guard = (r: SubsessionRecord) => (r.pendingInput.some((i) => i.seq > (this.inflightThrough.get(r.id) ?? 0))
      ? "input is pending that this turn does not carry" : undefined);
    if (this.deps.config().ownerMessages !== "direct") return this.askViaMain(record, question.trim(), guard);
    const sent = await this.speak(key, "ask", question);
    if (!sent.ok) return sent;
    const at = this.now();
    const outcome = this.transition(record.id, "ask", {
      reason: `asked the owner: ${truncate(question.trim(), 200)}`,
      guard,
      // The wait on it, as via the main session: a note from the main session
      // alone is held for the owner's answer and does not end it.
      patch: (r) => { r.askViaMain = { at, text: question.trim(), direct: true }; },
    });
    if (!outcome.ok) return { ...sent, waiting: false };
    this.continueOwed.delete(record.id);
    this.schedule();
    return { ...sent, waiting: true };
  }

  /**
   * ownerMessages "via-main": the question's note and the wait on it go
   * together, with no await between them. The note is written first (a task
   * never waits on a question nobody holds); the wait then stores it
   * (`askViaMain`, with the note's name). When the guard refuses the wait
   * (input is pending), the note is taken back before anything reads it: the
   * task reads that input first and asks again if it still needs to.
   */
  private askViaMain(record: SubsessionRecord, question: string, guard: (r: SubsessionRecord) => string | undefined): SpeakResult {
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: `This task is ${record.status}; nothing more is sent.` };
    if (!question) return { ok: false, error: "text is empty" };
    let waiting = false;
    const result = this.handToMain(record, "ask", question, (name, at) => {
      const outcome = this.transition(record.id, "ask", {
        reason: `asked the owner (through the main session): ${truncate(question, 200)}`,
        guard,
        // The main session's task_message with the answer is marked as that answer.
        patch: (r) => { r.askViaMain = { at, text: question, note: name }; },
      });
      waiting = outcome.ok;
      return outcome.ok;
    });
    if (!result.ok) return result;
    if (!waiting) {
      return { ok: true, via: "main", waiting: false, withdrawn: true };
    }
    this.continueOwed.delete(record.id);
    this.schedule();
    return { ...result, waiting: true };
  }

  private async speak(key: string, kind: SpeakKind, text: string): Promise<SpeakResult> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: `This task is ${record.status}; nothing more is sent.` };
    const body = text.trim();
    if (!body) return { ok: false, error: "text is empty" };
    if (this.deps.config().ownerMessages !== "direct") {
      // An answer to the owner's message from the web task panel stays there.
      // Not one with a file: the panel shows text only, so the main session sends it.
      const via = (kind === "reply" || kind === "fallback") && !/^\s*MEDIA:/m.test(body) && this.answersPanel(record) ? "panel" : "main";
      return via === "panel" ? this.keepInPanel(record, kind, body) : this.handToMain(record, kind, body);
    }
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
      return { ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.ok ? { via: "direct" as const } : {}) };
    } finally {
      sends.delete(work);
      this.sendOwners.delete(work);
      if (sends.size === 0) this.inFlightSends.delete(record.parentKey);
    }
  }

  /**
   * Did the owner write every owner input of the turn in flight in the web
   * task panel? Then the task's answer stays in the panel.
   */
  private answersPanel(record: SubsessionRecord): boolean {
    // Only when all of them came from the panel. Mixed with one from the
    // phone or a relay carrying the owner's words, which answer is which
    // cannot be told, so it goes through the main session.
    const owner = this.ownerInputsInFlight(record);
    return owner.length > 0 && owner.every((i) => i.source === "panel");
  }

  /**
   * Does the turn in flight carry the owner's own words (a message to the
   * task, or a relay with theirs attached, such as their answer to task_ask)?
   * Then task_reply is an answer, not news.
   */
  private answersOwner(record: SubsessionRecord): boolean {
    return this.ownerInputsInFlight(record).length > 0;
  }

  /** The owner's inputs the turn in flight carries. */
  private ownerInputsInFlight(record: SubsessionRecord): SubsessionInput[] {
    const through = this.inflightThrough.get(record.id);
    if (through === undefined) return [];
    let current: SubsessionRecord | undefined;
    try { current = this.store.get(record.id); } catch { current = record; }
    // From each input's stored origin only, never its text: a direct message
    // and a relay carrying the owner's own words both count; a note the main
    // session wrote itself, or the harness's own input, never does.
    return (current ?? record).pendingInput.filter((i) => i.seq <= through && isOwnerInput(i));
  }

  /**
   * ownerMessages "via-main", an answer to a panel message: no send. It is
   * recorded in the conversation, which the panel shows, and which the
   * owning session sees through the mirror like any exchange the owner had
   * with the task. A record that cannot be written leaves the answer
   * undelivered (the owner's message stays owed).
   */
  private keepInPanel(record: SubsessionRecord, kind: SpeakKind, body: string): SpeakResult {
    const at = this.now();
    const through = this.inflightThrough.get(record.id) ?? 0;
    let written = false;
    try {
      written = !!this.store.update(record.id, (r) => {
        // A retried turn's same answer is already there: one an earlier
        // attempt wrote while carrying inputs this turn carries again (they
        // are the ones that may have been seen), each used up once per turn,
        // so the same words answering a newer message still show.
        const text = truncate(body, CONVERSATION_TEXT_MAX);
        const first = r.pendingInput.at(0)?.seq ?? Infinity;
        const seenThrough = Math.max(r.seenThrough, this.unsavedSeen.get(r.id) ?? 0);
        const used = this.panelRepeatsUsed.get(r.id) ?? new Set<number>();
        const repeat = r.sent.find((m) => m.via === "panel" && m.kind === kind && m.text === body && m.answers !== undefined
          && m.answers >= first && m.answers <= seenThrough && !used.has(m.at));
        if (repeat) {
          used.add(repeat.at);
          this.panelRepeatsUsed.set(r.id, used);
          return;
        }
        r.sent.push({ at, kind, text: body, via: "panel", answers: through });
        pushConversation(r, { at, from: "task", kind, text });
      });
    } catch (err) {
      log.error({ err, id: record.id }, "Could not record a sub-session's answer in the web panel");
    }
    this.markDelivery(record.id, body, written);
    if (!written) return { ok: false, error: "the answer could not be saved for the web panel; try again." };
    if (kind !== "fallback") this.spoke.add(record.id);
    // The round's end wakes the owning session to see it (mirrorAfterRound), as for any panel message.
    return { ok: true, via: "panel" };
  }

  /**
   * ownerMessages "via-main": the task's words go to the owning session as
   * a PINNED `subsession-message` note (never dropped by the note cap, read
   * by its next turn whatever wakes it), plus a merged silent wake there.
   * The task is told they were handed over only once the note is on disk; a
   * note whose write failed is taken back (not left to reach a turn from
   * memory), and the task is told to try again. The owning scope is the
   * record's parentKey: a group-owned task's words go to that group's
   * session, never to the owner's DM.
   *
   * The note is named by its words: the same words handed over again while
   * the first note is still unread (a retry after a failed or cut-short
   * turn, or after an error the task was shown) add nothing.
   *
   * `commit` (task_ask's wait) runs right after the note is saved, with no
   * await between; when it declines, the note is taken back and nothing is
   * recorded.
   */
  private handToMain(record: SubsessionRecord, kind: SpeakKind, body: string, commit?: (name: string, at: number) => boolean): SpeakResult {
    const at = this.now();
    // The inputs the turn answers name it too: the same words answering
    // another message are another message.
    const through = this.inflightThrough.get(record.id) ?? 0;
    const name = messageNoteName(record.id, kind, body, through);
    // An unread note of the same words from an earlier attempt of this turn
    // (named by inputs this turn carries again, the ones that may have been
    // seen) is the same message, even if newer input joined the batch.
    const current = this.safeGet(record.id) ?? record;
    const first = current.pendingInput.at(0)?.seq ?? Infinity;
    const seenThrough = Math.max(current.seenThrough, this.unsavedSeen.get(record.id) ?? 0);
    // Each unread note stands for one message per turn: the same words said
    // twice in a turn (two messages answered alike) are two.
    const used = this.notesUsed.get(record.id) ?? new Set<string>();
    if (this.inflightTurn.has(record.id)) this.notesUsed.set(record.id, used);
    const exact = (n: string) => messageNoteNameOf(n) === name;
    let matched: string | undefined;
    const own = (n: string) => {
      const other = messageNoteNameOf(n);
      if (!other || used.has(other)) return false;
      const parsed = other === name ? undefined : parseMessageNoteName(other);
      const same = other === name || (!!parsed && parsed.id === record.id && parsed.kind === kind && parsed.digest === name.slice(name.lastIndexOf(":") + 1)
        && parsed.through >= first && parsed.through <= seenThrough);
      if (same) matched = other;
      return same;
    };
    const already = this.deps.hasPendingNote(record.parentKey, own);
    used.add(matched ?? name);
    // Its own identity: the same words handed over twice are two notes.
    const noteId = `subsession-message:${record.id}:${randomUUID()}`;
    if (!already) {
      const note = formatMessageNote(record, kind, body, name, this.inflightRetry.has(record.id));
      let saved = false;
      try {
        saved = this.deps.queuePendingNote(record.parentKey, note, noteId);
      } catch (err) {
        log.error({ err, id: record.id }, "Could not queue a sub-session's message note");
      }
      if (!saved) {
        used.delete(name);
        this.withdrawMessageNote(record.parentKey, exact);
        this.markDelivery(record.id, body, false);
        return { ok: false, error: "it could not be handed to the main session (saving it failed); try again." };
      }
    }
    if (commit) {
      let committed = false;
      try {
        committed = commit(name, at);
      } finally {
        // A wait that was refused or threw: the question does not stand
        // (a note an earlier, identical ask still holds is left alone).
        if (!committed && !already) this.withdrawMessageNote(record.parentKey, exact);
      }
      if (!committed) return { ok: true, via: "main", withdrawn: true };
    }
    this.markDelivery(record.id, body, true);
    if (kind !== "fallback") this.spoke.add(record.id);
    if (!already) {
      // The note is the durable copy; the record's log is for task_status and
      // the panel (marked so the mirror does not show it twice).
      this.safely(() => this.store.update(record.id, (r) => {
        r.sent.push({ at, kind, text: body, via: "main", note: name, noteId });
        pushConversation(r, { at, from: "task", kind, text: truncate(body, CONVERSATION_TEXT_MAX), noted: true });
      }), "record a message handed to the main session");
    }
    this.wakeForMessages(record.parentKey);
    return { ok: true, via: "main" };
  }

  private withdrawMessageNote(parentKey: string, match: (note: string) => boolean): boolean {
    let found = false;
    this.safely(() => { found = this.deps.withdrawPendingNote?.(parentKey, match) ?? false; }, "withdraw a task message note");
    return found;
  }

  /**
   * A task stopped waiting on a question it handed to the main session, by
   * anything but the answer (the owner wrote to it directly, it was
   * cancelled or failed): the question no longer stands. Its note is taken
   * back if no turn has read it yet; otherwise the session is told, so it
   * does not put the question to the owner.
   */
  private retractQuestion(record: SubsessionRecord, ask: NonNullable<SubsessionRecord["askViaMain"]>, why: string): void {
    const name = ask.note;
    if (name && this.withdrawMessageNote(record.parentKey, (n) => messageNoteNameOf(n) === name)) return;
    this.safely(() => {
      this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-message", [
        `Sub-session ${record.id} ("${record.title}") no longer waits on its question (${why}):`,
        truncate(ask.text, REPORT_NOTE_EXCERPT),
        "",
        "Don't put it to the owner now. If you already did and they answer, you may still pass it on with task_message, as information.",
      ].join("\n"), { name: `${record.id}:retract-${ask.at}` }));
      // Soon, not with whatever turn comes next: the session may be about to ask.
      this.wakeForMessages(record.parentKey);
    }, "tell the owning session a question no longer stands");
  }

  /** A silent turn on the owning session for its unread `subsession-message` notes. */
  private wakeForMessages(parentKey: string): void {
    if (!this.deps.messageWake) return;
    this.outward(() => this.deps.messageWake!(parentKey));
  }

  /** Is a `subsession-message` note still unread (queued or in flight) on the session? */
  hasMessageNote(parentKey: string): boolean {
    return this.deps.hasPendingNote(parentKey, (n) => messageNoteNameOf(n) !== undefined);
  }

  /** Track a message that did or did not reach its destination (see sendOut). */
  private markDelivery(id: string, words: string, delivered: boolean): void {
    const failed = this.undelivered.get(id);
    if (delivered) {
      failed?.delete(words);
      if (failed?.size === 0) this.undelivered.delete(id);
    } else if (failed) {
      failed.add(words);
    } else {
      this.undelivered.set(id, new Set([words]));
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
    this.markDelivery(record.id, words, result.ok);
    return result;
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
    const finishedTexts = new Set(finished.map((f) => f.text));
    const sent: SubsessionPlanStep[] = steps.flatMap((s): SubsessionPlanStep[] => {
      const text = oneLine(s.step, PLAN_STEP_MAX);
      return text ? [{ text, status: s.status === "in_progress" ? "in_progress" : "pending" }] : [];
    });
    // Every step ahead reads differently ("Run the tests again", not a second
    // "Run the tests"): a step is known by its words, and with two alike a
    // call that finishes one could not say which.
    if (new Set(sent.map((step) => step.text)).size < sent.length) return { ok: false, error: "duplicate_step" };
    // A step sent as done and still in `steps` is done: it is not also shown ahead.
    const next = sent.filter((step) => !finishedTexts.has(step.text)).slice(0, PLAN_MAX_STEPS);
    const why = reason ? oneLine(reason, PROGRESS_TEXT_MAX) : "";
    let changed = false;
    let refused = false;
    let missing: string[] = [];
    const at = this.now();
    // Checked inside the lock, against the plan on disk.
    const updated = this.store.update(record.id, (r) => {
      const planChanged = JSON.stringify(r.plan ?? []) !== JSON.stringify(next);
      if (planChanged && !why && planNeedsReason(r.plan ?? [], next, [...finishedTexts])) {
        refused = true;
        const kept = new Set(next.map((step) => step.text));
        missing = (r.plan ?? []).map((step) => step.text).filter((text) => !finishedTexts.has(text) && !kept.has(text));
        return;
      }
      const ahead = new Set((r.plan ?? []).map((step) => step.text));
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
        const filed = ahead.has(step.text) ? undefined : [...(r.doneSteps ?? [])].reverse().find((d) => d.text === step.text);
        if (filed) {
          if (step.result !== undefined && filed.result !== step.result) { filed.result = step.result; changed = true; }
          continue;
        }
        (r.doneSteps ??= []).push({ at, ...step });
        ahead.delete(step.text);
        changed = true;
      }
      if (planChanged && why) (r.updates ??= []).push({ at, kind: "plan", text: why });
    });
    if (!updated) return { ok: false, error: "no_record" };
    if (refused) return { ok: false, error: "reason_required", missing };
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
  finish(key: string, report: string, ownerAction?: string): FinishOutcome {
    const action = ownerAction === undefined ? "" : oneLine(ownerAction, OWNER_ACTION_MAX);
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
        // While the notes file is lost (it may be the read just below that
        // finds it unreadable and moves it aside), "no note" means nothing:
        // every earlier report is kept, as if unread.
        const recovering = this.notesRecovering();
        const noteUnread = (name: string): boolean => recovering || this.notePending(r.parentKey, name);
        const kept = (r.earlierReports ?? []).filter((e) => e.seq !== previous && (!e.noted || noteUnread(`${r.id}#${e.seq}`)));
        if (r.report !== undefined && previous > 0 && (!r.reportDelivered || noteUnread(reportNoteName({ ...r, reportSeq: previous })))) {
          kept.push({ seq: previous, text: r.report, ...(r.reportDelivered ? { noted: true } : {}) });
        }
        r.earlierReports = kept.length > 0 ? kept : undefined;
        r.reportSeq = previous + 1;
        r.report = forced ? `${report.trim()}\n\n${formatUnreadAtFinish(unread)}` : report.trim();
        r.reportDelivered = false;
        // Each report says afresh what it asks of the owner: none, and the last one's ask is gone too.
        if (action) r.ownerAction = action;
        else delete r.ownerAction;
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
  onCronFire(key: string, prompt: string, depth = 0): boolean {
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
    if (record.status === "waiting" && record.waitingOn === "owner") return this.deferCheckBack(record, prompt, depth);
    const outcome = this.transition(record.id, "cron_wake", {
      reason: "scheduled check-back",
      // Waiting for the owner by the time the lock is held: kept for their
      // wake instead (an unheld input there would requeue it after a restart).
      guard: (r) => (r.status === "waiting" && r.waitingOn === "owner" ? WAITING_FOR_OWNER : inputQueueFull(r)),
      patch: (r) => { appendInput(r, prompt, HARNESS); },
    });
    if (!outcome.ok) {
      if (outcome.refused === WAITING_FOR_OWNER && depth < 2) {
        const now = this.safeGet(record.id);
        return now ? this.deferCheckBack(now, prompt, depth + 1) : false;
      }
      if (outcome.refused) this.tellScope(record, ownerT("subsessions")("inputFull", { id: record.id, title: record.title, max: PENDING_INPUT_MAX }), INPUT_FULL_CAUSE);
      return false;
    }
    if (outcome.record.status === "queued") this.schedule();
    else this.kick(record.id);
    return true;
  }

  /**
   * A check-back that fires while the task waits for the owner. Only the
   * owner wakes it, so the check-back gets no turn of its own; it is kept as
   * input, held for the owner's wake (recovery must not take it for a turn
   * cut short), and the next turn sees it. It is handled, not failed: a
   * refusal here read as an error to the cron scheduler, which retried a
   * one-shot twice and then disabled it. A recurring job firing again while
   * the same check-back still waits adds nothing.
   */
  private deferCheckBack(record: SubsessionRecord, prompt: string, depth = 0): boolean {
    const text = `${formatTomoEvent("subsession-continue", "This check-back fired while you were waiting for the owner. Look at it now, with what the owner sent; act on it only if it still matters.", { name: record.id })}\n\n${prompt}`;
    const same = withoutTimes(text);
    let added = false;
    const outcome = this.transition(record.id, "cron_wake", {
      reason: "check-back while waiting for the owner",
      expectFrom: ["waiting"],
      guard: (r) => (r.waitingOn !== "owner" ? "no longer waiting for the owner" : r.pendingInput.some((i) => withoutTimes(i.text) === same) ? undefined : inputQueueFull(r, PENDING_INPUT_OWNER_RESERVE)),
      patch: (r) => {
        if (r.pendingInput.some((i) => withoutTimes(i.text) === same)) return;
        holdInput(r, text, HARNESS);
        added = true;
      },
    });
    if (!outcome.ok) {
      if (outcome.refused && outcome.refused !== "no longer waiting for the owner") {
        this.tellScope(record, ownerT("subsessions")("inputFull", { id: record.id, title: record.title, max: PENDING_INPUT_MAX - PENDING_INPUT_OWNER_RESERVE }), INPUT_FULL_CAUSE);
        return false;
      }
      // No longer waiting for the owner (the guard, or the status moved
      // before the lock): an ordinary check-back again.
      const now = this.safeGet(record.id);
      return now && depth < 2 && !(now.status === "waiting" && now.waitingOn === "owner") ? this.onCronFire(record.sessionKey, prompt, depth + 1) : false;
    }
    log.info({ id: record.id, added }, "Cron fired on a sub-session waiting for the owner; kept for its next wake");
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
    // What it said (task_reply, task_ask) was a round like any other: with
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
          appendInput(r, formatTomoEvent("subsession-continue", "A background task of yours reported back. Continue with the task: finish it, or schedule a check-back if you still have to wait."), HARNESS);
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
   *
   * `onTableRead` is handed the records exactly as read, before recovery,
   * reconcile or the sweep change or forget any (a migration that has to see
   * every task: dropping the todos the old todo link made), and `keepAsk`,
   * which moves an ask onto a finished task's record (its `ownerAction`,
   * left as it is when the record already has one; once per record, so an
   * ask the owner cleared never comes back). Only records the table can be
   * trusted with are handed over (not one read from the backup). It answers whether its
   * work is complete: until it is (false, or a throw), the sweep archives or
   * forgets no record in this process, so the next start can still match against them.
   * Called only when the table could be read.
   */
  recoverAtStartup(onTableRead?: (records: readonly SubsessionRecord[], keepAsk: (id: string, action: string) => boolean) => boolean): void {
    if (this.recovered || this.broken || !this.deps.config().enabled) return;
    let startState: ReturnType<SubsessionStore["state"]>;
    try {
      const table = this.store.read();
      // Captured before anything below writes: a write turns "recovered" or
      // "missing" into "ok", and reconcile must judge the table as it was read.
      startState = this.store.state();
      this.startState = startState;
      this.trustedAtStart = (startState === "ok" || startState === "missing") && !table.untrusted;
      if (onTableRead) {
        // A table recovered from its backup, or a record read from it, may
        // hold an older status than what happened: the hook acts on neither
        // (it runs again next start), so its work is not complete.
        this.keepEndedRecords = true;
        const trusted = this.trustedAtStart ? table.tasks.filter((r) => !r.restored) : [];
        const whole = this.trustedAtStart && trusted.length === table.tasks.length;
        this.safely(() => {
          const done = onTableRead(trusted, (id, action) => this.keepAsk(id, action));
          this.keepEndedRecords = !(done && whole);
        }, "startup hook");
      }
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
    this.externalWaitTimer = setInterval(() => {
      if (!this.open || this.deps.isStopping()) return;
      this.safely(() => this.checkExternalWaits("while Tomo was running"), "check-back recheck");
      this.safely(() => this.schedule(), "schedule after the check-back recheck");
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
        if (outcome.ok && outcome.changed) this.tellScope(outcome.record, ownerT("subsessions")("selfRestart", { id: task.id, title: task.title }),
          { kind: "self_restart", reason: "Tomo restarted at its own request, so it is paused" });
        continue;
      }
      if (task.status === "active" || cutShortWaiting) {
        if (task.interruptStreak + 1 > MAX_INTERRUPT_STREAK) {
          const failed = this.transition(task.id, "fail", { reason: `interrupted by ${MAX_INTERRUPT_STREAK + 1} restarts in a row`, expectFrom: [task.status] });
          if (failed.ok && failed.changed) this.reportFailure(failed.record, ownerT("subsessions")("failedInterrupted", { id: task.id, title: task.title, restarts: MAX_INTERRUPT_STREAK + 1 }),
            { kind: "interrupted_by_restarts", reason: `restarts cut it short ${MAX_INTERRUPT_STREAK + 1} times in a row`, ended: true });
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
    const registryKeys = registryReadable ? this.deps.registryTaskKeys() : [];
    const orphans = registryKeys.filter((k) => !known.has(k));
    if (orphans.length > 0) {
      const highest = Math.max(0, ...orphans.map(taskNumber));
      if (highest >= table.nextId) this.store.reserveIdsThrough(highest);
    }
    if (orphans.length > 0 && this.mayCleanUp()) {
      // "ok" as it was READ at start, and never recovered or lost since (the
      // mark survives every write and restart): a table recovered from an
      // older backup is "ok" on disk after its first write.
      for (const key of orphans) {
        log.warn({ key }, "Registry has a task session the task table does not know; unlinking it");
        this.safely(() => this.deps.unlinkRegistryEntry(key), "unlink orphan");
      }
    } else if (!table.untrusted && (orphans.length > 0 || (startState === "missing" && !registryReadable))) {
      // A missing (or empty) table next to task sessions it does not know is
      // a lost table, not a cleanup; so is a missing one next to a registry
      // that cannot say what it holds. Whatever happens to them, no new task
      // may take one of their ids (reserved above).
      log.error({ orphans, startState, registryReadable, tasks: table.tasks.length }, "Task table looks lost; unlinking nothing until the owner checks it (/s trust)");
      this.store.markUntrusted("lost");
    }
    // Recovered from the backup, or lost: nothing is cleaned up (no unlink,
    // archive or forget) until the owner has looked and says it is right
    // (/s trust); the mark never ends on its own. Told once per mark, and
    // marked told only once the notice has gone out: a start cut short
    // before sending it, or a send that failed, tells them again next start.
    const mark = this.store.read().untrusted;
    if (mark && !mark.notified) {
      const say = ownerT("subsessions");
      const restored = table.tasks.filter((r) => r.restored).length;
      const told = () => this.safely(() => this.store.markNotified(), "mark the recovery notice sent");
      if (mark.reason === "recovered") {
        log.error({ orphans, restored, registryReadable }, "Task table recovered from its backup; no cleanup until the owner checks it (/s trust)");
        this.noticeOwner(registryReadable ? say("tableRecovered", { restored, unknown: orphans.length }) : say("tableRecoveredUnknown", { restored }), told);
      } else {
        this.noticeOwner(registryReadable ? say("tableLost", { count: orphans.length }) : say("tableLostUnknown"), told);
      }
    }
    // Messages a task handed to its owning session whose note is still
    // unread: the wake queued for them lived in memory; the note is on disk,
    // so the wake is owed again.
    // A question's note stands only while its task waits on it: one left on
    // disk by a withdrawal that could not be written (the wait ended, or
    // never began) is taken back now.
    const standing = new Set(this.store.list().map((t) => t.askViaMain?.note).filter((n): n is string => !!n));
    // The owner's session too: a notice about sub-sessions as a whole has no task.
    let ownerKey: string | undefined;
    try { ownerKey = this.deps.ownerKey?.(); } catch { ownerKey = undefined; }
    for (const parentKey of new Set([...this.store.list().map((t) => t.parentKey), ...(ownerKey ? [ownerKey] : [])])) {
      this.safely(() => {
        while (this.withdrawMessageNote(parentKey, (n) => { const ask = askNoteName(n); return ask !== undefined && !standing.has(ask); })) { /* next */ }
      }, "take back stale question notes");
      this.safely(() => { if (this.hasMessageNote(parentKey)) this.wakeForMessages(parentKey); }, "wake for unread task messages");
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
          if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: task.id, title: task.title }), NO_SESSION_CAUSE);
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
      if (task.waitingReason === BACKGROUND_WAIT_REASON) {
        // Waiting on its own background work: it wakes on the report. Work
        // that is gone with no report reaching it (a restart ends it; a
        // report that landed while its turn was still ending) would leave it
        // waiting forever.
        if (this.deps.hasBackgroundWork?.(task.sessionKey) === true) {
          // Background work that never ends (a dev server, a watcher left
          // running) would keep it waiting for good, uncounted by
          // maxActiveHours: once an hour it gets a turn to look.
          const since = task.transitions.at(-1)?.at ?? this.now();
          if (this.now() - since < BACKGROUND_WAIT_MAX_MS) continue;
          this.transition(task.id, "cron_wake", {
            reason: "its background work was still running after an hour",
            expectFrom: ["waiting"],
            guard: (r) => (r.waitingReason !== BACKGROUND_WAIT_REASON ? "no longer waiting on its background work" : inputQueueFull(r)),
            patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "Your background work has been running for an hour without reporting back. Check on it. If it is something that never ends by itself (a server, a watcher), stop it once you no longer need it, or carry on without waiting for it: while it runs, you are only woken like this once an hour."), HARNESS); },
          });
          continue;
        }
        this.transition(task.id, "cron_wake", {
          reason: `its background work was no longer running ${when}`,
          expectFrom: ["waiting"],
          guard: (r) => (r.waitingReason !== BACKGROUND_WAIT_REASON ? "no longer waiting on its background work" : inputQueueFull(r)),
          patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "The background work you were waiting for is no longer running, and its report may not have reached you (it finished as your turn ended, or a restart stopped it). Check what it produced, then carry on with the task."), HARNESS); },
        });
        continue;
      }
      const jobs = this.deps.cronJobCount(task.sessionKey);
      if (jobs === undefined) { unknown = true; continue; }
      if (jobs > 0) continue;
      this.transition(task.id, "cron_wake", {
        reason: `its check-back job was missing ${when}`,
        expectFrom: ["waiting"],
        guard: (r) => (r.waitingOn !== "external" ? "no longer waiting on something external" : inputQueueFull(r)),
        patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "Your scheduled check-back is missing (removed, disabled, lost in a restart, or never saved). Check on what you were waiting for, and schedule a new check-back if you still need to wait."), HARNESS); },
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

  /** onTableRead's keepAsk: true once the finished task's old ask has been moved onto it (now or by an earlier start), false when it is not finished or the write failed. */
  private keepAsk(id: string, action: string): boolean {
    try {
      const updated = this.store.update(id, (r) => {
        if (r.status !== "finished" || r.legacyAskMoved) return;
        if (!r.ownerAction) r.ownerAction = oneLine(action, OWNER_ACTION_MAX);
        r.legacyAskMoved = true;
      });
      return !!updated && updated.status === "finished" && !!updated.legacyAskMoved;
    } catch (err) {
      log.warn({ err, id }, "Could not move a sub-session's old todo onto its record");
      return false;
    }
  }

  /** Archive finished tasks after 7 days; forget ended ones after 30. Only what mayCleanUp allows. */
  private sweep(): void {
    const now = this.now();
    const forget: string[] = [];
    for (const task of this.store.list()) {
      if (!this.mayCleanUp(task)) continue;
      // While the startup hook's work is incomplete, nothing is archived or
      // forgotten: the next start matches its old todos against the tasks
      // as they are now (an archived task's would no longer become its card).
      if (this.keepEndedRecords) continue;
      // A finished task still owing an answer (pending, or held for the
      // owner's next message) stays finished: archived, it could never be
      // woken to give it, and its input would go with the record.
      // Nor is a task archived or forgotten while its report note is still
      // unread: the note holds only the start of the report, and points to
      // task_status for the rest.
      if (this.reportNotePending(task) || this.earlierReportPending(task)) continue;
      // Nor while a message it handed over is unread: restart recovery finds
      // the session to wake through its tasks' records.
      if (this.deps.hasPendingNote(task.parentKey, (n) => messageNoteNameOf(n)?.startsWith(`${task.id}:`) === true)) continue;
      // Nor while its report still asks something of the owner: until they
      // do it (or say it is done), the task is theirs and stays in view.
      if (needsOwner(task)) continue;
      // The check above may just have found the notes file unreadable and
      // moved it aside: "no note pending" means nothing until they are sent again.
      if (this.notesRecovering()) break;
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
    // A queued task holding the owner's own words (a message they wrote to
    // it, or a relay with theirs attached) never waits for a slot. Read from
    // the table, so a start that failed, or that a restart cut off, is made
    // here the next time the scheduler runs.
    for (const task of queued) {
      if (!task.pendingInput.some(isOwnerInput)) continue;
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
      if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: record.id, title: record.title }), NO_SESSION_CAUSE);
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
    event: Extract<SubsessionEvent, "relay" | "note" | "owner_message">,
    prompt: string | ((record: SubsessionRecord) => string),
    origin: InputOrigin,
    extra?: (record: SubsessionRecord) => void,
  ): TransitionOutcome {
    const now = this.now();
    const outcome = this.transition(id, event, {
      reason: event === "owner_message" ? "a message from the owner" : "a message from the main session",
      // A task waiting on the owner always takes their word, even past the
      // limit: only it wakes the task, which then works the queue down.
      guard: (r) => (origin.from === "owner" && r.status === "waiting" && r.waitingOn === "owner" ? undefined : inputQueueFull(r)),
      patch: (r) => {
        appendInput(r, typeof prompt === "string" ? prompt : prompt(r), origin);
        // The owner's word: the wall-clock cap counts from here again. A note
        // the main session wrote itself is not their word.
        if (origin.from === "owner") r.activeAtOwnerInputMs = activeTotalMs(r, now);
        extra?.(r);
      },
    });
    if (!outcome.ok) return outcome;
    if (outcome.record.status !== "queued") {
      this.kick(id);
      return outcome;
    }
    // Queued: the main session's own note waits for its slot and goes with
    // the first turn (a note that woke a waiting task asks the scheduler for
    // one now). The owner's words never wait for a slot, whether they came as
    // a message or attached to a relay: they start the task, like
    // `/s <id> start`.
    if (origin.from !== "owner") {
      // The note is on the task already: a failed start must not fail its delivery.
      if (outcome.changed) this.safely(() => this.schedule(), "schedule after a note");
      return outcome;
    }
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

  /** Run the task's driver unless one is running. */
  private kick(id: string): void {
    // Closed until start(): start() kicks every task with a turn owed.
    if (!this.open || this.driving.has(id) || this.settleTimers.has(id) || this.registryHeld.has(id) || this.deps.isStopping()) return;
    this.driving.add(id);
    let threw = false;
    void this.drive(id)
      .catch((err) => {
        threw = true;
        log.error({ err, id }, "Sub-session driver failed; trying it again later");
      })
      .finally(() => {
        this.driving.delete(id);
        // A driver that threw leaves its turn owed. Asked again by the retry
        // timer, never at once: a failure that persists (a table that reads
        // but will not write) would otherwise re-run it in a loop, before
        // anything else (a timer, I/O, any channel) gets to run.
        if (threw) this.retryAfterSettleFailure(id);
        else {
          // Input that arrived while the last turn was ending.
          const record = this.safeGet(id);
          if (record && record.status !== "queued" && !TERMINAL_STATUSES.has(record.status) && this.plan(record)) this.kick(id);
        }
        this.schedule();
      });
  }

  private async drive(id: string): Promise<void> {
    for (;;) {
      if (this.deps.isStopping()) return;
      // The quota gate below decides on the newest usage reading: make it a
      // current one first (a no-op while it is, bounded when it is not).
      if (this.deps.freshenQuota) {
        try { await this.deps.freshenQuota(); } catch (err) { log.warn({ err }, "Quota reading refresh failed; the gate decides on what it has"); }
        if (this.deps.isStopping()) return;
      }
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
      if (turn.retry) this.inflightRetry.add(id);
      const serial = ++this.turnSerial;
      this.inflightTurn.set(id, serial);
      let outcome: TaskTurnOutcome;
      try {
        outcome = await this.deps.runTaskTurn(record.sessionKey, turn.prompt, { bare: turn.kind === "compact" });
        if (turn.kind !== "compact") {
          if (outcome.ok) this.lastTurnFailed.delete(id);
          else this.lastTurnFailed.add(id);
        }
        if (!outcome.shutdown) outcome = await this.answerUnanswered(id, turn, outcome);
      } finally {
        clearInterval(heartbeat);
        this.inflightThrough.delete(id);
        this.inflightRetry.delete(id);
        this.panelRepeatsUsed.delete(id);
        this.notesUsed.delete(id);
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
      if (!turn.ownerMessage) return outcome;
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
      return { kind: "compact", prompt: `/compact ${compactInstructions(record)}`, throughSeq: 0, afterCompact: false, fromOwner: false, ownerMessage: false, resume: false, start: false };
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
    // From each input's stored origin, never from its text: only the owner's
    // own words (a message to the task, or theirs attached to a relay).
    const ownerMessage = inputs.some(isOwnerMessageInput);
    const fromOwner = ownerMessage || inputs.some(isOwnerInput);
    return { kind, prompt: parts.join("\n\n"), throughSeq, afterCompact, fromOwner, ownerMessage, resume, start, retry: seen > 0 || resume || this.lastTurnFailed.has(record.id) };
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
          r.lastFailure = undefined;
          r.pendingInput = r.pendingInput.filter((i) => i.seq > turn.throughSeq);
          // The turn ended waiting for the owner (task_ask) and input landed
          // after the wait began (a check-back, a note): it waits for their
          // wake too. Held, so recovery does not take a completed wait for a
          // turn cut short and requeue it without their answer.
          if (r.status === "waiting" && r.waitingOn === "owner" && r.pendingInput.length > 0) r.heldThrough = Math.max(r.heldThrough ?? 0, lastInputSeq(r));
        } else {
          r.failStreak += 1;
          if (!outcome.ok && !outcome.stopped) {
            const { category, refused } = classifyFailure(outcome.failure);
            const detail = failureDetail(outcome.failure);
            r.lastFailure = { at: this.now(), ...(category ? { category } : {}), ...(refused ? { refused } : {}), ...(detail ? { detail } : {}) };
          } else if (outcome.ok) {
            r.lastFailure = { at: this.now(), category: "answer_undelivered", detail: "its answer to the owner could not be delivered" };
          }
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
      // Run again with nothing to mark it (a start, a continue): still a retry.
      this.lastTurnFailed.add(id);
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
        this.pause(record, { kind: "stopped_by_owner", reason: "stopped by the owner" }, ownerT("subsessions")("stopped", { id: record.id, title: record.title }),
          newInput("new input arrived during the stopped turn"));
      } else if (record.failStreak >= MAX_FAIL_STREAK) {
        // A failed turn's own inputs are still pending, and stay for the wake.
        this.pause(record, { kind: "turns_failing", reason: "its turns keep failing", failure: true }, ownerT("subsessions")("failing", { id: record.id, title: record.title }),
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
    if (this.deps.hasBackgroundWork?.(record.sessionKey) === true) {
      // No check-back, and its own background work (a subagent, a background
      // command) is still running: the task waits for it, and its report wakes it
      // (onBackgroundReport). Neither a "continue" that could only poll, nor
      // a turn toward the no-progress pause: waiting on its own work is not
      // being stuck.
      const waited = this.transition(id, "wait_external", {
        reason: BACKGROUND_WAIT_REASON,
        expectFrom: ["active"],
        guard: hasPendingInput,
        patch: (r) => { r.turnsWithoutProgress = 0; },
      });
      if (!waited.ok) return;
      this.continueOwed.delete(id);
      this.schedule();
      return;
    }
    if (!turn.afterCompact) {
      const streak = progressed ? 0 : record.turnsWithoutProgress + 1;
      this.store.update(id, (r) => { r.turnsWithoutProgress = streak; });
      if (streak >= MAX_TURNS_WITHOUT_PROGRESS) {
        this.pause(record, { kind: "no_progress", reason: `${streak} turns in a row without progress` }, ownerT("subsessions")("stuck", { id: record.id, title: record.title, turns: streak }), hasPendingInput);
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
    const notice = ownerT("subsessions")("finishedUnanswered", { id: record.id, title: record.title });
    const cause: NoticeCause = { kind: "finished_unanswered", reason: "it is finished and could not answer what it was sent (it was stopped, or its turns kept failing)", finished: true,
      detail: `The task keeps these messages and gets them again with the owner's next message to it. Answer the owner yourself if you can, or tell them the task will get them when they next write to it. What it was sent:\n\n${texts.join("\n\n")}` };
    // ownerMessages "via-main": one pinned note carries the notice and the
    // messages (and its wake); the separate note below is the direct mode's.
    if (this.viaMain() && this.noticeToMain(record.parentKey, notice, cause, record)) return;
    this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-unanswered",
      `Sub-session ${record.id} ("${record.title}") is finished and could not answer what it was sent (it was stopped, or its turns kept failing). The task keeps these messages and gets them again with the owner's next message to it. What it was sent:\n\n${texts.join("\n\n")}`,
      { name: record.id }));
    this.outward(() => this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-unanswered",
      "A finished sub-session could not answer what it was sent; the messages are in a note above. Answer the owner yourself if you can, or tell them the task will get the messages again when they next write to it.",
      { name: "check" }), record.id));
    this.tellDirect(record, notice);
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
    why: { kind: string; reason: string; failure?: boolean },
    notice: OwnerText,
    guard?: (r: SubsessionRecord) => string | undefined,
  ): boolean {
    const reason = why.reason;
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
      this.tellScope(outcome.record, notice, {
        kind: why.kind, reason,
        ...(why.failure ? { failure: outcome.record.lastFailure ?? {} } : {}),
      });
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
      // What the task handed to the session as a note it has read there.
      const entries = record.conversation.filter((e) => e.seq > record.mirrorSeenSeq && !e.noted);
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
      return this.store.list().some((t) => t.parentKey === scope && t.conversation.some((e) => e.seq > t.mirrorSeenSeq && !e.noted));
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
   * May a mirror turn run now? Not while the quota window is at the quota
   * pause. Asked when the wake is queued AND when it runs (the window can
   * fill while it waits behind the session's other turns).
   */
  mirrorTurnAllowed(): boolean {
    const reading = this.quotaAtPause();
    if (reading) {
      log.debug({ window: reading.window, percent: reading.percent }, "Quota window nearly used; the mirror waits for the owning session's next turn");
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------

  /** Every status change: the store's compare-and-set, then a question handed to the main session that it ended is withdrawn. */
  private transition(id: string, event: SubsessionEvent, opts: TransitionOptions = {}): TransitionOutcome {
    // A question handed to the main session, which this transition may end.
    let ask: SubsessionRecord["askViaMain"];
    const userPatch = opts.patch;
    const outcome = this.store.transition(id, event, {
      ...opts,
      patch: (r) => { ask = r.askViaMain; userPatch?.(r); },
    });
    // Ended by anything but the relay that answers it, or replaced by a new
    // question: it no longer stands. A question sent to the owner directly
    // has nothing at the main session to take back.
    if (ask?.direct) return outcome;
    if (outcome.ok && ask && event === "relay" && !outcome.record.askViaMain) {
      // Answered by the main session: an unread copy of the question must not
      // be put to the owner later.
      const answered = ask;
      if (answered.note) this.withdrawMessageNote(outcome.record.parentKey, (n) => messageNoteNameOf(n) === answered.note);
    } else if (outcome.ok && ask && !sameQuestion(ask, outcome.record.askViaMain)) {
      this.retractQuestion(outcome.record, ask, event === "owner_message" ? "the owner wrote to it directly"
        : outcome.record.askViaMain ? "it asked a new question" : `it is ${outcome.record.status} now`);
    }
    return outcome;
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
    let present = this.reportNotePending(record, false);
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
      if (!this.deps.queuePendingNote(record.parentKey, reportNote(record), reportNoteId(reportNoteName(record)))) {
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

  /**
   * A pending-notes file was moved aside (see SessionStore.loadPendingNotes),
   * so every sub-session note it held is gone. Each one is written again from
   * the records, under its own id (never matched by text), so a copy still
   * held in memory is not added twice and this can run any number of times:
   * the report of every finished task and its noted earlier reports, the
   * handback of every failed one, and every message handed to the owning
   * session that no turn there has read (a question only while the task
   * still waits on it). Some were already read, so each says it may have
   * been told already, and each owning session is woken once. True when all
   * of them are on disk; the caller tries again until then.
   */
  rebuildLostNotes(): boolean {
    if (!this.recovered || this.broken) return false;
    let ok = true;
    const woken = new Set<string>();
    const put = (key: string, id: string, note: string): void => {
      woken.add(key);
      try {
        if (!this.deps.queuePendingNote(key, appendToTomoEventBody(note, LOST_NOTE_LINE), id)) ok = false;
      } catch (err) {
        ok = false;
        log.error({ err, id }, "Could not write a sub-session note again");
      }
    };
    for (const task of this.store.list()) {
      if (task.status === "archived") continue;
      if (task.status === "finished" && task.reportDelivered) put(task.parentKey, reportNoteId(reportNoteName(task)), reportNote(task));
      for (const e of task.earlierReports ?? []) {
        if (e.noted) put(task.parentKey, reportNoteId(`${task.id}#${e.seq}`), earlierReportNote(task, e));
      }
      if (task.status === "failed" && task.handedBack && task.pendingInput.some(isOwnerInput)) {
        put(task.parentKey, `subsession-handback:${task.id}`, handbackNote(task));
      }
      const ask = task.askViaMain;
      for (const m of task.sent) {
        if (m.noteId === undefined || m.note === undefined || m.read) continue;
        if (m.kind === "ask" && !(task.status === "waiting" && ask?.note === m.note && !ask.direct)) continue;
        put(task.parentKey, m.noteId, formatMessageNote(task, m.kind, m.text, m.note));
      }
    }
    if (!ok) return false;
    for (const parentKey of woken) {
      this.outward(() => this.deps.wakeScope(parentKey, formatTomoEvent("subsession-report",
        "Tomo's pending notes file could not be read and was set aside, so the sub-session notes above were written again from the task records. Some may already have been told to the owner: check the conversation, and tell the owner only what they have not heard.",
        { name: "resent" })));
    }
    return true;
  }

  /** A turn of an owning session carried these pending notes to its end: the task messages among them are marked read. */
  notesRead(ids: string[]): void {
    const byTask = new Map<string, Set<string>>();
    for (const id of ids) {
      const task = /^subsession-message:([^:]+):/.exec(id)?.[1];
      if (task) byTask.set(task, (byTask.get(task) ?? new Set()).add(id));
    }
    for (const [task, read] of byTask) {
      this.safely(() => this.store.update(task, (r) => {
        for (const m of r.sent) if (m.noteId !== undefined && read.has(m.noteId)) m.read = true;
      }), "mark a task message read");
    }
  }

  private notesRecovering(): boolean {
    return this.deps.pendingNotesRecovering?.() ?? false;
  }

  /** Writes the note of every kept earlier report that has none on disk. False when one could not be written. */
  private deliverEarlierReports(record: SubsessionRecord): boolean {
    const missing = (record.earlierReports ?? []).filter((e) => !e.noted);
    if (missing.length === 0) return true;
    for (const e of missing) {
      const name = `${record.id}#${e.seq}`;
      const ok = this.notePending(record.parentKey, name, false)
        // Found in memory: held after a failed write, so written again.
        ? this.deps.persistPendingNotes?.(record.parentKey) ?? false
        : this.deps.queuePendingNote(record.parentKey, earlierReportNote(record, e), reportNoteId(name));
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
  private reportNotePending(record: SubsessionRecord, whenUnreadable = true): boolean {
    return this.notePending(record.parentKey, reportNoteName(record), whenUnreadable);
  }

  /** An earlier report a later finish kept (see finish) is still unread. */
  private earlierReportPending(record: SubsessionRecord): boolean {
    // One whose note was never written is outstanding too.
    return (record.earlierReports ?? []).some((e) => !e.noted || this.notePending(record.parentKey, `${record.id}#${e.seq}`));
  }

  /** While the notes cannot be read, the note may be unread on disk: by
   *  default that counts as pending (nothing is cleaned up over it). The
   *  delivery paths pass false, so they write a copy and retry until it lands. */
  private notePending(parentKey: string, name: string, whenUnreadable = true): boolean {
    const marker = `<tomo-event type="subsession-report" name="${name}"`;
    return this.deps.hasPendingNote(parentKey, (n) => n.includes(marker), whenUnreadable);
  }

  private wakeForReport(record: SubsessionRecord): void {
    this.outward(() => this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-report",
      "A sub-session finished; its report is in a note above. Tell the owner the result in a few lines, in your own words, and read the full report with task_status if they will want details. Decide what, if anything, belongs in memory.",
      { name: "check" }), record.id));
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
  private reportFailure(record: SubsessionRecord, notice: OwnerText, cause: NoticeCause): void {
    const unanswered = record.pendingInput.filter(isOwnerInput);
    if (unanswered.length === 0) {
      this.tellScope(record, notice, cause);
      return;
    }
    const list = unanswered.slice(0, UNANSWERED_MAX).map((i) => `• ${truncate((i.words ?? i.text).trim(), UNANSWERED_EXCERPT)}`).join("\n");
    this.tellScope(record, ownerT("subsessions")("withUnanswered", { notice, count: unanswered.length, list }), cause);
    this.handBack(record);
  }

  /**
   * The owner's unanswered input, in full, to the owning session as a pinned
   * note: the one copy that outlives the record. Marked on the record once the
   * note is on disk; until then the sweep keeps the record and tries again.
   */
  private handBack(record: SubsessionRecord): boolean {
    if (!this.deps.queuePendingNote(record.parentKey, handbackNote(record), `subsession-handback:${record.id}`)) {
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
   * been active on its own past `maxActiveHours`, or when the 5-hour or the
   * weekly window is at `quotaPauseAtPct` or more: it pauses for the owner (one notice),
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
        return this.pause(record, { kind: "active_hours_cap", reason: `active ${capHours}h on its own (subsessions.maxActiveHours)` },
          ownerT("subsessions")("activeCap", { id: record.id, title: record.title, hours: capHours }), hasOwnerInput) ? "paused" : "again";
      }
    }
    const reading = this.quotaAtPause();
    if (reading) {
      const percent = Math.round(reading.percent);
      const threshold = this.quotaPausePercent();
      log.info({ id: record.id, window: reading.window, percent: reading.percent, threshold }, "Quota window nearly used; pausing a sub-session for the owner");
      const windowName = reading.window === "weekly" ? "weekly (all models)" : "5-hour";
      const vars = { id: record.id, title: record.title, percent };
      const notice = reading.window === "weekly" ? ownerT("subsessions")("quotaHighWeekly", vars) : ownerT("subsessions")("quotaHigh", vars);
      return this.pause(record, { kind: "quota", reason: `the ${windowName} quota window is at ${percent}% (pauses at ${threshold}%, subsessions.quotaPauseAtPct)` },
        notice, hasOwnerInput) ? "paused" : "again";
    }
    return "run";
  }

  private quotaPausePercent(): number {
    return this.deps.config().quotaPauseAtPct ?? QUOTA_PAUSE_PERCENT;
  }

  /** The quota reading when it is at the pause threshold or over; undefined below it, unknown or unreadable. */
  private quotaAtPause(): QuotaGateReading | undefined {
    const reading = this.quotaReading();
    return reading && reading.percent >= this.quotaPausePercent() ? reading : undefined;
  }

  /** The fuller quota window's share used, or undefined: none known, or unreadable (fail open, logged). */
  private quotaReading(): QuotaGateReading | undefined {
    if (!this.deps.quotaReading) return undefined;
    try {
      const reading = this.deps.quotaReading();
      this.quotaReadFailing = false;
      return reading;
    } catch (err) {
      if (!this.quotaReadFailing) log.warn({ err }, "Could not read the quota samples; sub-session turns are not held for quota");
      else log.debug({ err }, "Quota samples still unreadable");
      this.quotaReadFailing = true;
      return undefined;
    }
  }

  private noticeSeq = 0;

  /** Strictly increasing within the process; a label only (a task's notice note is never matched by name). */
  private nextNoticeOccurrence(): number {
    this.noticeSeq = Math.max(this.noticeSeq + 1, this.now());
    return this.noticeSeq;
  }

  private viaMain(): boolean {
    return this.deps.config().ownerMessages !== "direct";
  }

  /**
   * A harness notice about a task. ownerMessages "via-main": handed to the
   * owning session (record.parentKey: a group's task to that group, never the
   * owner's DM) as a pinned note with a wake, which decides whether and how
   * the owner hears it; only when that note cannot be saved does it go
   * straight to the chat, so it is never lost. "direct": to the chat, as before.
   */
  private tellScope(record: SubsessionRecord, notice: OwnerText, cause: NoticeCause): void {
    if (this.viaMain() && this.noticeToMain(record.parentKey, notice, cause, record)) return;
    this.tellDirect(record, notice);
  }

  /**
   * The notice as a PINNED `subsession-message` note on `key` (never dropped
   * by the note cap, kept across a restart, which wakes for it again), and a
   * merged silent wake there. Named by the task and the notice's words: the
   * same notice while the first is still unread adds nothing. False when it
   * could not be saved (or nothing would wake for it): the caller sends it
   * straight to the chat instead.
   */
  private noticeToMain(key: string, notice: OwnerText, cause: NoticeCause, record?: SubsessionRecord): boolean {
    if (!this.deps.messageWake) return false;
    const name = noticeNoteName(record?.id, notice, cause, record ? this.nextNoticeOccurrence() : 0);
    let saved = false;
    try {
      // Only a notice about the list itself is ever said twice (at each start
      // while it holds); a task's notice is one event each time, never matched.
      saved = (!record && this.deps.hasPendingNote(key, (n) => messageNoteNameOf(n) === name))
        || this.deps.queuePendingNote(key, formatNoticeNote(notice, cause, name, record));
    } catch (err) {
      log.error({ err, id: record?.id }, "Could not queue a sub-session notice for the main session; sending it to the chat");
    }
    if (!saved) {
      log.warn({ id: record?.id, kind: cause.kind }, "Sub-session notice could not be handed to the main session; sending it to the chat");
      this.withdrawMessageNote(key, (n) => messageNoteNameOf(n) === name);
      return false;
    }
    this.wakeForMessages(key);
    return true;
  }

  /** A harness notice to the owner's chat, and a note so the owning session knows it was said. */
  private tellDirect(record: SubsessionRecord, notice: OwnerText): void {
    this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-activity",
      `The harness told the owner about sub-session ${record.id} ("${record.title}"): ${truncate(notice, ACTIVITY_NOTE_EXCERPT)}`,
      { name: record.id }));
    this.outward(() => { void this.deps.noticeToScope(record.parentKey, notice).catch((err) => log.warn({ err, id: record.id }, "Sub-session notice failed")); });
  }

  /**
   * A notice about sub-sessions as a whole (no task). ownerMessages
   * "via-main": to the owner's main session, like a task's notice. Straight
   * to the owner's DM when the session registry cannot be read (the main
   * session cannot load its own conversation then either), when the owner's
   * session is not known, in "direct" mode, or when the note cannot be saved.
   * `sent`: called once the notice has gone out or its note is on disk (not
   * when it could not be sent, or failed).
   */
  private noticeOwner(text: OwnerText, sent?: () => void): void {
    let ownerKey: string | undefined;
    try { ownerKey = this.viaMain() && this.deps.registryReadable() ? this.deps.ownerKey?.() : undefined; } catch { ownerKey = undefined; }
    if (ownerKey && this.noticeToMain(ownerKey, text, { kind: "subsessions", reason: "a problem with the sub-session list itself" })) {
      sent?.();
      return;
    }
    this.outward(() => {
      void this.deps.noticeOwner(text).then((ok) => { if (ok !== false) sent?.(); else log.warn("Sub-session notice not sent: no reachable owner DM"); },
        (err: unknown) => log.warn({ err }, "Sub-session notice failed"));
    });
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

/**
 * At the limit, new input is refused. `reserve`: input kept for a task
 * waiting on the owner (a main-session note, a check-back) stops that many
 * short, so the owner's message that wakes it always fits.
 */
function inputQueueFull(record: SubsessionRecord, reserve = 0): string | undefined {
  const limit = PENDING_INPUT_MAX - reserve;
  return record.pendingInput.length >= limit ? `${record.pendingInput.length} inputs already waiting (limit ${limit})` : undefined;
}

/** What the owner wrote to a task, as a handback would quote it (files by path). */
function ownerWords(text: string, files: string[] = []): string {
  return files.length > 0 ? `${text}\n(files: ${files.join(", ")})` : text;
}

/** An input's text with its event times taken out: the same check-back fired again compares equal. */
/**
 * Input for a task waiting on the owner, kept for their wake. Held only when
 * nothing else was owed: inputs a turn still in flight carried stay owed, so
 * a crash still resumes that turn (restart recovery requeues a waiting task
 * for any input it does not hold on purpose).
 */
function holdInput(r: SubsessionRecord, text: string, origin: InputOrigin): void {
  const owed = lastInputSeq(r) > (r.heldThrough ?? 0) || (!r.startDelivered && r.heldThrough === undefined);
  appendInput(r, text, origin);
  if (!owed) r.heldThrough = lastInputSeq(r);
}

function withoutTimes(text: string): string {
  return text.replace(/ ts="[^"]*"/g, "");
}

/**
 * The owner's own words: only an input created as theirs (a message they
 * wrote to the task, or a relay the owning session attached their messages
 * to). An input without that origin (the main session's note, the harness's
 * own, one read without an origin) never is, whatever its text says.
 */
function isOwnerInput(input: SubsessionInput): boolean {
  return input.from === "owner";
}

/**
 * A message the owner wrote to the task itself (/s, a reply to it, the web
 * panel): the owner's origin, and the harness's own event opens its text
 * (a relay with the owner's words attached is theirs, but not a message).
 */
function isOwnerMessageInput(input: SubsessionInput): boolean {
  return input.from === "owner" && input.text.startsWith(OWNER_MESSAGE_MARKER);
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

/** Added to a note written again after the notes file was lost. */
const LOST_NOTE_LINE = "(Written again from the task record: the pending notes file was lost. It may already have been told to the owner.)";

/** A finished task's report note (see deliverReport). */
function reportNote(record: SubsessionRecord): string {
  const report = record.report ?? "";
  const excerpt = report.length > REPORT_NOTE_EXCERPT ? `${report.slice(0, REPORT_NOTE_EXCERPT - 1)}…` : report;
  const earlier = (record.earlierReports ?? []).map((e) => `#${e.seq}`);
  return formatTomoEvent("subsession-report", [
    `Sub-session ${record.id} ("${record.title}") finished. Its report #${record.reportSeq ?? 1}${report.length > REPORT_NOTE_EXCERPT ? " (start; read the whole report with task_status)" : ""}:`,
    excerpt,
    ...(earlier.length > 0 ? [`Its earlier report${earlier.length === 1 ? "" : "s"} ${earlier.join(", ")} ${earlier.length === 1 ? "is" : "are"} kept too: task_status shows ${earlier.length === 1 ? "it" : "them"}.`] : []),
    needsOwner(record)
      ? `It needs the owner to: ${needsOwner(record)!.replace(/[.。]+$/, "")}. Tell them. The task shows as "Needs you" until they do it: once they say it is done (or no longer needed), call task_done("${record.id}", ${reportNumber(record)}).`
      : "It needs nothing from the owner.",
  ].join("\n"), { name: reportNoteName(record) });
}

/** The note of an earlier report a later finish kept unread (see deliverEarlierReports). */
function earlierReportNote(record: SubsessionRecord, e: { seq: number; text: string }): string {
  return formatTomoEvent("subsession-report", [
    `Sub-session ${record.id} ("${record.title}") finished earlier. Its report #${e.seq}, replaced by a later one before it was read:`,
    e.text.length > REPORT_NOTE_EXCERPT ? `${e.text.slice(0, REPORT_NOTE_EXCERPT - 1)}… (read the whole report with task_status)` : e.text,
  ].join("\n"), { name: `${record.id}#${e.seq}` });
}

/** A failed task's handback note: the owner's messages it never answered, in full (see handBack). */
function handbackNote(record: SubsessionRecord): string {
  const unanswered = record.pendingInput.filter(isOwnerInput);
  return formatTomoEvent("subsession-handback", [
    `Sub-session ${record.id} ("${record.title}") failed before it answered ${unanswered.length === 1 ? "this message" : `these ${unanswered.length} messages`} passed on for the owner. Here in full; decide with the owner whether ${unanswered.length === 1 ? "it still needs" : "they still need"} doing:`,
    ...unanswered.map((i, n) => `${n + 1}. ${(i.words ?? i.text).trim()}`),
  ].join("\n\n"), { name: record.id });
}

/** The pending-note id of report `name` (`s3#2`): one note per report, however often it is delivered. */
function reportNoteId(name: string): string {
  return `subsession-report:${name}`;
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

/** What task_plan did: saved, or refused because the change needs a reason (or the task has no record). */
export type PlanOutcome = { ok: true; record: SubsessionRecord }
  | { ok: false; error: "no_record" | "duplicate_step" }
  /** `missing`: the steps still ahead that left the plan without being filed done (empty: only the order changed). */
  | { ok: false; error: "reason_required"; missing: string[] };

/**
 * Whether replacing `before` with `after` drops, rewords or reorders a step
 * still ahead. A step leaving the plan as one of `done` is not dropped, a
 * status change is not a rewording, and new steps are free only after every
 * step that stayed.
 */
export function planNeedsReason(before: readonly SubsessionPlanStep[], after: readonly SubsessionPlanStep[], done: readonly string[]): boolean {
  const finished = new Set(done);
  const kept = before.map((s) => s.text).filter((text) => !finished.has(text));
  // The steps that stayed must open the new plan, in their order; anything after them is an addition.
  if (after.length < kept.length) return true;
  return kept.some((text, i) => after[i].text !== text);
}
