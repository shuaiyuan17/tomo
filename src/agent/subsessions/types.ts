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

/** One message the task sent out (task_notify, later task_reply / task_ask). */
export interface SubsessionSentMessage {
  at: number;
  kind: "notify";
  text: string;
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
  reportDelivered: boolean;
  /** A `/compact` turn is due (context over subsessions.maxContextTokens). */
  compactPending: boolean;
  /** The next turn carries the task-record reminder and does not count. */
  postCompactReminder: boolean;
  /**
   * Prompts owed to the task: a cron check-back, a relay, a message that
   * arrived while it had no turn to take them (queued, or between turns).
   * An input leaves this list only when a turn that carried it COMPLETED, so
   * a crash at any point loses none (at-least-once). Never trimmed: when it
   * holds PENDING_INPUT_MAX entries, new input is refused, not dropped.
   */
  pendingInput: string[];
  /**
   * The first N entries of pendingInput went out with the turn in flight.
   * Written before the turn starts; cleared when it ends. Non-zero at start
   * means that turn was cut short by a crash or a shutdown.
   */
  inflightInputs: number;
  /**
   * The first N entries of pendingInput already went out once, in a turn a
   * restart cut short: the task may have acted on them. The next turn says so.
   */
  redeliveredInputs: number;
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
}

export const SENT_KEEP = 20;
export const TRANSITION_LOG_KEEP = 50;
/** Inputs a task may have owed at once; more are refused (never silently dropped). */
export const PENDING_INPUT_MAX = 50;
