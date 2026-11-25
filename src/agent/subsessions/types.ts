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
 * One message the task sent out: task_notify, task_reply, task_ask, or the
 * harness's fallback (an owner-triggered turn that called none of them).
 */
export interface SubsessionSentMessage {
  at: number;
  kind: "notify" | "reply" | "ask" | "fallback";
  text: string;
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

/** One input owed to the task. */
export interface SubsessionInput {
  seq: number;
  text: string;
  /**
   * "owner": the owner's word (a relay from the owning session, or a message
   * from the owner). A turn carrying one is never held by the wall-clock cap
   * or the quota gate, and a failed task hands it back to the owner.
   * Unset: the harness's own (a check-back, a background report).
   */
  from?: "owner";
  /** For an owner input: what was said, without the event wrapper (quoted back if it is never answered). */
  words?: string;
}

/** Append an input: the only way one is added. */
export function appendInput(record: SubsessionRecord, text: string, origin?: { from: "owner"; words: string }): void {
  record.pendingInput.push({ seq: record.nextInputSeq, text, ...(origin ? { from: origin.from, words: origin.words } : {}) });
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
  /** Completed turns in a row with no tool call and no progress change. */
  turnsWithoutProgress: number;
  /** The task itself asked for the daemon restart (RestartCoordinator). */
  restartRequested: boolean;
  /** One-line status (task_progress). */
  progress?: string;
  /** Goal, progress, next step and side effects (task_checkpoint). */
  checkpoint?: string;
  report?: string;
  /** Counts the task's reports (a finished task can be woken and finish again); its report note is named by it. */
  reportSeq?: number;
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
   * (archive, forget, unlink, cron removal). Cleared only by an ending this
   * process saw happen (task_finish, a cancel).
   */
  restored?: boolean;
  /** Recent messages the task sent out, newest last (at most SENT_KEEP). */
  sent: SubsessionSentMessage[];
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
   * table does not know (it may be a task the lost table had). Cleared once
   * no such entry is left and no record is still `restored`.
   */
  untrusted?: { since: number; reason: "recovered" | "lost" };
}

export const SENT_KEEP = 20;
export const TRANSITION_LOG_KEEP = 50;
export const REPLY_MAP_KEEP = 200;
export const OWNER_MESSAGE_IDS_KEEP = 50;
/** Inputs a task may have owed at once; more are refused (never silently dropped). */
export const PENDING_INPUT_MAX = 50;
