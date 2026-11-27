/**
 * Sub-sessions: one long task per `task:<id>` session. The task table
 * (`data/subsessions.json`, ./store.ts) is the one source of truth for a
 * task's lifecycle; the registry, the SDK session file, pending notes and
 * cron jobs follow it (see ./service.ts for the reconcile rules).
 *
 * The persisted status is LIFECYCLE ONLY. Whether a turn is in flight is
 * runtime state, read from the live session, and never written here.
 */

export const SUBSESSION_STATUSES = ["queued", "active", "waiting", "finished", "cancelled", "failed", "archived"] as const;
export type SubsessionStatus = typeof SUBSESSION_STATUSES[number];

/** Statuses that never run again. `finished` is not one: it still answers, and can be reopened. */
export const TERMINAL_STATUSES: ReadonlySet<SubsessionStatus> = new Set(["cancelled", "failed", "archived"]);
/** Statuses that count against `subsessions.maxOpen`. */
export const OPEN_STATUSES: ReadonlySet<SubsessionStatus> = new Set(["queued", "active", "waiting"]);

export type WaitingOn = "owner" | "external";

/**
 * One message the task sent out: task_reply (kind reply or notify), task_ask, or the
 * harness's fallback (an owner-triggered turn that called none of them).
 */
export interface SubsessionSentMessage {
  at: number;
  kind: "notify" | "reply" | "ask" | "fallback";
  text: string;
  /**
   * "main": handed to the owning session as a note, which decides whether
   * and how the owner hears it. "panel": an answer that stayed in the web
   * task panel the owner wrote from. Unset: sent to the owner's chat as is.
   */
  via?: "main" | "panel";
  /** via "panel": the highest input seq its turn answered (a retried turn's same answer is kept once). */
  answers?: number;
}

/**
 * A provider message id the task sent, so the owner's reply to it (a thread
 * reply or a tapback) is routed back to the task. Kept on the record, not in
 * memory, so replies still route after a restart.
 */
export interface SubsessionReplyRef {
  channel: string;
  messageId: string;
  at: number;
}

/**
 * One line of the conversation between the owner and the task, as the owning
 * session sees it mirrored (service.ts, "mirror"): what the owner wrote to
 * the task, and what the task said back through its tools. Turns the task
 * ran on its own without speaking add nothing.
 */
export interface SubsessionConversationEntry {
  /** Per task, increasing; compared with `mirrorSeenSeq`. */
  seq: number;
  at: number;
  from: "owner" | "task";
  /** owner: "message"; task: the tool that said it, or "fallback". */
  kind: "message" | "notify" | "reply" | "ask" | "fallback";
  text: string;
  /** Files the owner sent with it (count only: their paths stay out of the mirror). */
  files?: number;
  /**
   * The task's words were handed to the owning session as a note: the
   * mirror does not show them again.
   */
  noted?: true;
}

/** One input owed to the task. */
export interface SubsessionInput {
  seq: number;
  text: string;
  /**
   * "owner": the owner's own words: a message they wrote to the task, or a
   * relay the owning session attached their messages to (copied by the
   * harness from the turn they wrote them in, never typed by the model). A
   * turn carrying one is never held by the wall-clock cap or the quota gate,
   * and a failed task hands it back to the owner.
   * "main": a relay that carries only the owning session's own note. It is
   * not the owner's word: it answers no question, is not handed back, and by
   * itself passes no gate and restarts no cap (lifting a harness pause is the
   * `release` transition's doing, recorded as the session's own act).
   * "harness": the harness's own (a check-back, a "continue", a background
   * report), and every input read without an origin: only an input created
   * as the owner's is ever theirs (never guessed from its text).
   */
  from: "owner" | "main" | "harness";
  /**
   * Set on every owner input written since origins were checked. Before
   * that, every relay was stored as `from: "owner"`, the main session's own
   * notes included: an owner input without it is read as a main-session
   * note (fail closed), never as the owner's word, unless it is an owner
   * message (`OWNER_MESSAGE_MARKER`), which only the owner's `/s` or panel
   * message ever was.
   */
  checked?: true;
  /** For an owner input or a main-session note: what was said, without the event wrapper (quoted back if it is never answered). */
  words?: string;
  /** "panel": the owner wrote it in the web task panel (an answer to it stays there). */
  source?: "panel";
}

/**
 * How long a go-ahead after a quota pause lasts (ms epoch): until the window
 * that made the pause resets, or `QUOTA_PASS_FALLBACK_MS` from the go-ahead
 * when its reset time is not known.
 */
export interface QuotaPass { until: number }
/** A go-ahead after a quota pause whose window gave no reset time lasts this long. */
export const QUOTA_PASS_FALLBACK_MS = 60 * 60_000;

/** The kinds of pause the harness makes (`SubsessionService.pause`). */
export const PAUSE_KINDS = ["stopped_by_owner", "turns_failing", "no_progress", "active_hours_cap", "quota"] as const;
export type PauseKind = typeof PAUSE_KINDS[number];

/**
 * Pauses the owning session may lift with a task_message of its own (no
 * owner message attached): the limits the harness watches for the owner.
 * They are there so somebody knows, not to keep the owning session out,
 * which speaks for the owner. Not a stop the owner made themselves.
 */
export const MAIN_RELEASABLE_PAUSES: ReadonlySet<PauseKind> = new Set<PauseKind>(["quota", "active_hours_cap", "no_progress", "turns_failing"]);

export type InputOrigin = { from: "owner"; words: string; source?: "panel" } | { from: "main"; words: string } | { from: "harness" };

/** The harness's own input (a check-back, a "continue", a start, a background report). */
export const HARNESS: InputOrigin = { from: "harness" };

/** Append an input: the only way one is added. Every input says where it came from. */
export function appendInput(record: SubsessionRecord, text: string, origin: InputOrigin): void {
  record.pendingInput.push({ seq: record.nextInputSeq, text,
    ...(origin.from === "owner" ? { from: origin.from, checked: true as const, words: origin.words, ...(origin.source ? { source: origin.source } : {}) }
      : origin.from === "main" ? { from: "main" as const, words: origin.words } : { from: "harness" as const }) });
  record.nextInputSeq += 1;
}

/** Active time, the current stretch included. */
export function activeTotalMs(record: SubsessionRecord, now: number): number {
  return record.activeMs + (record.activeSince !== undefined ? Math.max(0, now - record.activeSince) : 0);
}

/** The highest seq pending (0 when none). */
export function lastInputSeq(record: SubsessionRecord): number {
  return record.pendingInput.at(-1)?.seq ?? 0;
}

/** One status change, kept on the record (the newest TRANSITION_LOG_KEEP). */
export interface SubsessionTransition {
  at: number;
  from: SubsessionStatus | null;
  to: SubsessionStatus;
  event: string;
  reason?: string;
}

/** A plan step the task marked done (task_plan), with the one-line result it gave. */
export interface SubsessionDoneStep {
  at: number;
  text: string;
  result?: string;
}

/**
 * A decision or a change the owner should know about (task_update): scope,
 * approach, blocked or unblocked. `kind: "plan"`: the reason task_plan gave
 * for dropping, rewording or reordering steps.
 */
export interface SubsessionUpdate {
  at: number;
  text: string;
  kind?: "plan";
}

/** A step still ahead in a task's plan (task_plan). Done steps leave the plan for the history. */
export interface SubsessionPlanStep {
  text: string;
  status: "pending" | "in_progress";
}

export interface SubsessionRecord {
  /** Short id, unique across every owning scope: `s1`, `s2`, … */
  id: string;
  /** `task:<id>`. */
  sessionKey: string;
  /**
   * The session that opened the task and owns it: where its messages and its
   * report go, whose audience it runs with, and who may address it. Today
   * always the owner's `dm:` key (task_spawn is owner-only).
   */
  parentKey: string;
  title: string;
  brief: string;
  /** The owner's own words, quoted verbatim from the parent transcript at spawn. */
  quote?: string[];
  status: SubsessionStatus;
  /** Set exactly when status is `waiting`. */
  waitingOn?: WaitingOn;
  /** Why it waits, in the harness's words (shown by /s and task_status). */
  waitingReason?: string;
  /** Model alias or id; unset follows `subsessions.defaultModel`, then `model`. */
  model?: string;
  effort?: string;
  createdAt: number;
  lastActivityAt: number;
  /** When it entered finished / cancelled / failed / archived. */
  endedAt?: number;
  /** Time spent active, banked each time it leaves active. */
  activeMs: number;
  /** Set while active: when the current active stretch began. */
  activeSince?: number;
  /**
   * Set while active: the last time this process saw the task's work going
   * (a turn starting or ending, and a heartbeat while one runs). A restart
   * banks active time only up to here, never the downtime after it.
   */
  activeSeenAt?: number;
  /**
   * `activeTotalMs` when the owner last said something to the task (unset:
   * never). The wall-clock cap (`subsessions.maxActiveHours`) counts the
   * active time since then: the owner's word buys it another full stretch.
   */
  activeAtOwnerInputMs?: number;
  /**
   * A restart cut this task's work short: the next turn it gets is a resume
   * (check side effects first), not a start. Set with the restart transition
   * (active → queued), cleared by the first turn that completes.
   */
  resumeNeeded: boolean;
  /** The start event (brief + the owner's words) reached a completed turn. */
  startDelivered: boolean;
  /** Restarts in a row that cut it short with no completed turn between. */
  interruptStreak: number;
  /** Failed turns in a row. */
  failStreak: number;
  /**
   * The last failed turn's cause, for the notice when the failures pause or
   * end the task. Kept until a turn completes.
   */
  lastFailure?: { at: number; category?: string; refused?: boolean; detail?: string };
  /** Completed turns in a row with no tool call and no progress change. */
  turnsWithoutProgress: number;
  /** The task itself asked for the daemon restart (RestartCoordinator). */
  restartRequested: boolean;
  /** The steps still ahead, in order, as task_plan last set them (at most PLAN_MAX_STEPS). Unset: no plan. */
  plan?: SubsessionPlanStep[];
  /** Plan steps marked done, oldest first, at most DONE_STEPS_KEEP. Unset on records written before plans existed. */
  doneSteps?: SubsessionDoneStep[];
  /** Decisions and changes (task_update), oldest first, at most UPDATES_KEEP. */
  updates?: SubsessionUpdate[];
  /** Goal, progress, next step and side effects (task_checkpoint). */
  checkpoint?: string;
  report?: string;
  /**
   * What the owner has to do with the report (task_finish `owner_action`:
   * review and merge a PR, make a choice), one line. A finished task with
   * one is the owner's ("Needs you") until they do it: `/s <id> done` or the
   * owning session's task_done clears it (that report's ask only), and the
   * next task_finish sets it afresh or not. A reopen leaves it (the ask
   * stands until a new report says otherwise) but hides it: meaningful only
   * while the task is finished, read through `needsOwner`.
   */
  ownerAction?: string;
  /** Counts the task's reports (a finished task can be woken and finish again); its report note is named by it. Read through `reportNumber`. */
  reportSeq?: number;
  /**
   * Set once a start moved the old todo link's "Read sN's result" onto this
   * record as its `ownerAction`: never moved again (an ask the owner has
   * since cleared stays cleared, even while that todo could not be dropped).
   */
  legacyAskMoved?: true;
  /**
   * The id of the todo the old todo link kept for this task (a record written
   * before had it as `todoId`). Read only by the startup pass that drops those
   * todos (`legacy-todos.ts`): it names the link's own item whatever title
   * limit was in force when it was written.
   */
  legacyTodoId?: string;
  /**
   * Earlier reports a later task_finish replaced while they were still
   * unread (their note still waiting, or never written), oldest first, at
   * kept until read. task_status shows them; they go with the record.
   * `noted`: its note was written (once that note is read, the entry may go).
   */
  earlierReports?: Array<{ seq: number; text: string; noted?: boolean }>;
  /**
   * A failed task's unanswered owner input was handed back in full (a pinned
   * `subsession-handback` note on disk): until then the record is not forgotten.
   */
  handedBack?: boolean;
  reportDelivered: boolean;
  /** A `/compact` turn is due (context over subsessions.maxContextTokens). */
  compactPending: boolean;
  /** The next turn carries the task-record reminder and does not count. */
  postCompactReminder: boolean;
  /**
   * Prompts owed to the task (a cron check-back, a relay, a message), in the
   * order they arrived. APPEND-ONLY: a turn only reads them and remembers, in
   * memory, the highest seq it carried. Entries leave the list only in the
   * one atomic write that records that turn's completed result, so a crash at
   * any point loses none (at-least-once), and nothing is written before a
   * turn starts. Never trimmed: at PENDING_INPUT_MAX, new input is refused.
   */
  pendingInput: SubsessionInput[];
  /** The seq the next input gets (per task, never reused). */
  nextInputSeq: number;
  /** Provider ids of what it sent, newest last (at most REPLY_MAP_KEEP). */
  replyMap: SubsessionReplyRef[];
  /**
   * Inbound message ids already delivered to it (at most OWNER_MESSAGE_IDS_KEEP):
   * a crash between the delivery and the inbox's `done` replays the message,
   * and this keeps it from arriving twice.
   */
  ownerMessageIds: string[];
  /** The owner ↔ task conversation, newest last (at most CONVERSATION_KEEP). */
  conversation: SubsessionConversationEntry[];
  /** The last `seq` given out in `conversation`. */
  conversationSeq: number;
  /** The newest `seq` the owning session has seen (mirror), advanced only by a turn that completed. */
  mirrorSeenSeq: number;
  /**
   * Inputs with seq up to this went out in a turn that did not complete (cut
   * short by a restart, failed, or its result could not be saved): the task
   * may have acted on them, and the next turn says so. Raised only, together
   * with the outcome that justifies it (a failed turn's write, or startup
   * recovery).
   */
  seenThrough: number;
  /**
   * Set by a pause that keeps what the task owes for the owner's wake (it was
   * stopped, its turns kept failing, it restarted Tomo itself), in the same
   * transition: inputs with seq up to this, and an undelivered start, are
   * held on purpose. Unset: nothing was ever held. Startup recovery requeues
   * a waiting task only for what is NOT held, which a turn cut short (one
   * that called task_ask) left unconsumed.
   */
  heldThrough?: number;
  /**
   * The record came from `.bak` (the primary table was lost or unreadable):
   * its status may be older than what happened, so no cleanup acts on it
   * (archive, forget, unlink, cron removal). Cleared by an ending this
   * process saw happen (task_finish, a cancel, any move to a terminal
   * status), or by the owner's `/s trust`; never by time. Never set on a
   * terminal record: cancelled, failed and archived never change again, so
   * a backup cannot hold an older version of them.
   */
  restored?: boolean;
  /** Recent messages the task sent out, newest last (at most SENT_KEEP). */
  sent: SubsessionSentMessage[];
  /**
   * The question a task_ask is waiting on, kept while the task waits for
   * the owner. ownerMessages "via-main": handed to the owning session, which
   * passes it on, and its task_message with the owner's answer ends the
   * wait. "direct" (`direct`): sent to the owner's chat, which they answer
   * with /s or a reply. Either way a note from the main session alone does
   * not end it. The store drops it on any transition out of waiting(owner).
   */
  askViaMain?: {
    at: number;
    text: string;
    /** Its note's name (to take it back). */
    note?: string;
    /**
     * ownerMessages "direct": the question went straight to the owner's chat,
     * not through the main session (no note to take back, nothing to retract
     * there). The wait is the same: only the owner's own words end it.
     */
    direct?: true;
  };
  /**
   * Why the harness paused it (`SubsessionService.pause`), kept while it
   * waits for the owner. A pause of a kind in `MAIN_RELEASABLE_PAUSES` is
   * there so the owner knows, and the owning session's task_message lifts it
   * on their behalf; any other waiting(owner) (a question, a stop the owner
   * made, a self-restart, a wait that recorded nothing) ends only with the
   * owner's own words. A quota pause keeps when its window resets
   * (`resetsAt`, when the reading gave it), for the go-ahead's `quotaPass`.
   * The store drops it on any transition out of waiting(owner), and when a
   * question replaces the pause.
   */
  pausedBy?: { kind: PauseKind; resetsAt?: number };
  /**
   * A go-ahead after a quota pause (the owner's own word to the paused task,
   * or the owning session lifting the pause): the quota gate does not pause
   * this task for usage again (either window: one go-ahead, one rule)
   * before `until`: when the window that paused it resets (as the pause read
   * it: `pausedBy.resetsAt`), or `QUOTA_PASS_FALLBACK_MS` after the go-ahead
   * when that is not known or already past. Without it
   * the first turn the task gave itself after the go-ahead would pause again
   * at once. A time, so nothing has to clear it; the store drops it when the
   * task finishes or ends.
   */
  quotaPass?: QuotaPass;
  /** The newest status changes, oldest first. */
  transitions: SubsessionTransition[];
}

export interface SubsessionTable {
  version: 1;
  /** Next numeric id (s<nextId>). Never reused, across every scope. */
  nextId: number;
  tasks: SubsessionRecord[];
  /**
   * Set when this table may be missing tasks: it was recovered from `.bak`,
   * or it was missing while the registry held task sessions. Kept across
   * every write and restart, so no later start unlinks a registry entry the
   * table does not know (it may be a task the lost table had), and no record
   * is archived or forgotten. Never cleared on its own (no time limit, no
   * count of what is left): only the owner's `/s trust` ends it.
   */
  untrusted?: {
    since: number;
    reason: "recovered" | "lost";
    /** The owner was told (once per mark: a fresh recovery tells them again). */
    notified?: true;
  };
}

export const SENT_KEEP = 20;
export const TRANSITION_LOG_KEEP = 50;
export const REPLY_MAP_KEEP = 200;
export const OWNER_MESSAGE_IDS_KEEP = 50;
export const CONVERSATION_KEEP = 40;
export const DONE_STEPS_KEEP = 20;
export const UPDATES_KEEP = 20;
/** A progress or update line is one line of at most this many characters. */
export const PROGRESS_TEXT_MAX = 300;
/** A plan holds at most this many steps, each one line of at most PLAN_STEP_MAX characters. */
export const PLAN_MAX_STEPS = 8;
export const PLAN_STEP_MAX = 120;
/** A finished step's one-line result. */
export const STEP_RESULT_MAX = 200;

/** The latest time a JS Date can hold (ms since the epoch). */
const MAX_DATE_MS = 8.64e15;
/** A time a record may hold: finite ms since the epoch that a Date can show. Anything else (a hand edit, 1e20) is dropped, not drawn. */
export function isTimestamp(at: unknown): at is number {
  return typeof at === "number" && Number.isFinite(at) && at >= 0 && at <= MAX_DATE_MS;
}

/** The plan step an open task is on (its "Now"), if it marked one in progress. An ended task is on none. */
export function currentStep(record: Pick<SubsessionRecord, "plan" | "status">): string | undefined {
  if (!OPEN_STATUSES.has(record.status)) return undefined;
  return record.plan?.find((s) => s.status === "in_progress")?.text;
}

/** task_finish's `owner_action`: one line. */
export const OWNER_ACTION_MAX = 300;

/**
 * What a finished task still asks of the owner (its report's `owner_action`),
 * or undefined when it asks nothing or the task is not finished. A task that
 * returns one is the owner's: shown as "Needs you" and never archived.
 */
/** The number of the task's latest report: `reportSeq`, or 1 for a record written before reports were counted. */
export function reportNumber(record: Pick<SubsessionRecord, "reportSeq">): number {
  return record.reportSeq ?? 1;
}

export function needsOwner(record: Pick<SubsessionRecord, "status" | "ownerAction">): string | undefined {
  return record.status === "finished" && record.ownerAction ? record.ownerAction : undefined;
}

/** One line, trimmed, at most `max` characters (by code point, so a pair is never split). */
export function oneLine(text: string, max: number): string {
  return Array.from(text.trim().split("\n")[0].trim()).slice(0, max).join("");
}
/** Inputs a task may have owed at once; more are refused (never silently dropped). */
export const PENDING_INPUT_MAX = 50;
/** Slots input held for a task waiting on the owner never takes, kept for the owner's message that wakes it. */
export const PENDING_INPUT_OWNER_RESERVE = 5;
/** How an owner's `/s` or panel message starts: an envelope only the harness writes (a relay starts with its own). */
export const OWNER_MESSAGE_MARKER = '<tomo-event type="subsession-owner-message"';
