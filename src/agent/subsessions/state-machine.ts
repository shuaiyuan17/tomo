import type { SubsessionStatus, WaitingOn } from "./types.js";

/**
 * Every way a task's lifecycle can change, and the one table that says what
 * each does from each status. Pure: ./store.ts applies it under the table's
 * lock (compare-and-set on the status read inside the lock), and nothing else
 * writes `status`.
 *
 * Two rules shape the table:
 * - AUTONOMOUS WORK GOES THROUGH THE SCHEDULER. A start, a cron check-back,
 *   a background report on a task waiting on something external and a
 *   resume after a restart all land in `queued`; `start` (the scheduler) is
 *   the only autonomous way to `active`, so the slot cap and the quota gate
 *   apply to every one of them in one place. The other routes there take no
 *   new slot: `owner_message` and `relay` from waiting carry the owner's
 *   words, and `reopen` is made inside a turn the task is already running.
 *   A finished task stays finished while it answers what it is sent; a turn
 *   of it with none of the owner's words (a `note`) waits for a slot in the
 *   service's driver (`waitsForSlot`), since no status change marks it.
 * - THE OWNER IS NEVER QUEUED. A message from the owner (or a relay from the
 *   owning session that carries the owner's own words) gets its turn
 *   whatever the slots say, and wakes a waiting task. Nothing autonomous
 *   wakes a waiting(owner) task: a cron firing there is kept for the owner's
 *   wake ("same"), not a turn of its own.
 * - The owning session's own note (`note`, no words of the owner's in it) is
 *   autonomous work: it wakes a task waiting on something external into
 *   `queued`, never past the slot cap. To a task the harness paused at one
 *   of its limits it is a `release`: the pause ends, into `queued` too. A
 *   question to the owner is never ended that way.
 */
export const SUBSESSION_EVENTS = [
  "start",
  "wait_external",
  "stuck",
  "ask",
  "finish",
  "reopen",
  "owner_message",
  "relay",
  "note",
  "release",
  "cron_wake",
  "background_report",
  "restart",
  "self_restart",
  "recover_cut_short",
  "cancel",
  "fail",
  "archive",
] as const;
export type SubsessionEvent = typeof SUBSESSION_EVENTS[number];

export interface TransitionTarget {
  status: SubsessionStatus;
  waitingOn?: WaitingOn;
}

/**
 * - a target: the event moves the task there;
 * - `"same"`: the event is legal and leaves the status as it is (a message to
 *   a task that is already active still gets its turn);
 * - `null`: illegal from here. The caller refuses it (tests throw).
 */
export type TransitionResult = TransitionTarget | "same" | null;

const ACTIVE: TransitionTarget = { status: "active" };
const QUEUED: TransitionTarget = { status: "queued" };
const WAIT_OWNER: TransitionTarget = { status: "waiting", waitingOn: "owner" };
const WAIT_EXTERNAL: TransitionTarget = { status: "waiting", waitingOn: "external" };

export function nextStatus(status: SubsessionStatus, waitingOn: WaitingOn | undefined, event: SubsessionEvent): TransitionResult {
  const waiting = status === "waiting";
  switch (event) {
    case "start":
      return status === "queued" ? ACTIVE : null;
    case "wait_external":
      return status === "active" ? WAIT_EXTERNAL : null;
    case "stuck":
      return status === "active" ? WAIT_OWNER : null;
    case "ask":
      return status === "active" || waiting ? WAIT_OWNER : null;
    case "finish":
      return status === "active" || waiting ? { status: "finished" } : null;
    case "reopen":
      return status === "finished" ? ACTIVE : null;
    case "owner_message":
    case "relay":
      if (waiting) return ACTIVE;
      return status === "queued" || status === "active" || status === "finished" ? "same" : null;
    case "note":
      // A note to a waiting(owner) task is held for the owner's wake before
      // any transition (relay() appends it held); refused here, so nothing
      // could append it unheld and let restart recovery end that wait.
      if (waiting) return waitingOn === "external" ? QUEUED : null;
      return status === "queued" || status === "active" || status === "finished" ? "same" : null;
    case "release":
      // The owning session lifts a pause the harness made (the service checks
      // which pauses it may). Its own act, not the owner's message: through
      // the scheduler, like its note to a task waiting on something external.
      return waiting && waitingOn === "owner" ? QUEUED : null;
    case "cron_wake":
      if (waiting) return waitingOn === "external" ? QUEUED : "same";
      return status === "queued" || status === "active" ? "same" : null;
    case "background_report":
      // The report turn itself already ran (the SDK starts it; it cannot be
      // held). What follows it is autonomous work, so it goes through the
      // scheduler like a cron check-back.
      if (waiting) return waitingOn === "external" ? QUEUED : "same";
      return status === "queued" || status === "active" || status === "finished" ? "same" : null;
    case "restart":
      return status === "active" ? QUEUED : null;
    case "recover_cut_short":
      // Not a wake: the task's own turn moved it to waiting (task_ask, a
      // pause) and a crash cut that turn short. Its inputs are still owed a
      // completed turn, and only restart recovery sends this.
      return waiting ? QUEUED : null;
    case "self_restart":
      return status === "active" ? WAIT_OWNER : null;
    case "cancel":
      // Idempotent: cancelling a cancelled task is a legal no-op.
      if (status === "cancelled") return "same";
      return status === "queued" || status === "active" || waiting || status === "finished" ? { status: "cancelled" } : null;
    case "fail":
      return status === "queued" || status === "active" || waiting || status === "finished" ? { status: "failed" } : null;
    case "archive":
      return status === "finished" ? { status: "archived" } : null;
  }
}

export class IllegalTransitionError extends Error {
  constructor(readonly id: string, readonly from: SubsessionStatus, readonly event: SubsessionEvent) {
    super(`Sub-session ${id}: "${event}" is not allowed from ${from}`);
    this.name = "IllegalTransitionError";
  }
}
