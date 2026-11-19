/**
 * Refuse a compact/rollup while the session has background work.
 *
 * Every rewrite of a session file (`tomo lcm <level>`, `tomo lcm compact`,
 * `tomo lcm prune-tools`, the `lcm_rollup` tool) leaves a compact trigger, and
 * the daemon answers it by closing the live session at the end of the turn so
 * the next turn resumes from the rewritten file. Closing the session kills
 * every background subagent / shell it is running.
 *
 * Delaying that reload instead is not safe: the in-memory session still holds
 * the pre-compact context, and any turn it runs in the meantime appends events
 * whose parent uuids the compact has just removed — an orphaned chain the SDK
 * loader silently drops. So the gate sits at the SOURCE: the daemon approves
 * the rewrite and marks the compact pending in one step, refusing while
 * background work runs, and denies new background launches until the reload
 * (agent/compact-reservations.ts). The next nudge tries again.
 */

export type CompactRefusalReason =
  | "background-tasks"
  | "awaiting-task-report"
  | "backgrounding"
  | "recent-launch"
  | "already-pending"
  | "daemon-unreachable";

/**
 * The daemon's answer to "may this session be rewritten now?". An approval
 * carries the reservation to finish once the rewrite is over; `key` and
 * `reservationId` are null when no live session in the daemon is behind it.
 */
export type CompactReservation =
  | { ok: true; key: string | null; reservationId: string | null }
  | {
    ok: false;
    key: string | null;
    reason: Exclude<CompactRefusalReason, "daemon-unreachable">;
    state: { activeBackgroundTasks: number; awaitingTaskReport: boolean; backgroundingInFlight?: number };
  };

export interface CompactRefusal {
  status: "deferred";
  reason: CompactRefusalReason;
  activeBackgroundTasks?: number;
  error: string;
}

const RETRY = "Nothing was changed — retry later (the next nudge will ask again).";

/**
 * The readable refusal for a declined reservation. `what` names the
 * operation in the message ("daily rollup", "prune").
 */
export function compactRefusal(
  res: Extract<CompactReservation, { ok: false }>,
  what = "rollup",
): CompactRefusal {
  switch (res.reason) {
    case "background-tasks": {
      const n = res.state.activeBackgroundTasks;
      const tasks = n === 1 ? "1 background task is" : `${n} background tasks are`;
      return {
        status: "deferred",
        reason: res.reason,
        activeBackgroundTasks: n,
        error: `${tasks} still running in this session. Not running the ${what}: it reloads the session, which would kill them. Nothing was changed — retry after they finish (the next nudge will ask again).`,
      };
    }
    case "awaiting-task-report":
      return {
        status: "deferred",
        reason: res.reason,
        activeBackgroundTasks: 0,
        error: `A background task just finished and its result has not been reported to this session yet. Not running the ${what}: it reloads the session, which would lose that report. ${RETRY}`,
      };
    case "backgrounding":
      return {
        status: "deferred",
        reason: res.reason,
        error: `A task in this session is being moved to the background right now. Not running the ${what}: it reloads the session, which would kill it. ${RETRY}`,
      };
    case "recent-launch":
      return {
        status: "deferred",
        reason: res.reason,
        error: `A background task was launched in this session moments ago. Not running the ${what}: it reloads the session, which would kill it. ${RETRY}`,
      };
    case "already-pending":
      return {
        status: "deferred",
        reason: res.reason,
        error: `Another compact/rollup of this session is already in progress. Not running the ${what}: two back-to-back rewrites can orphan the chain. ${RETRY}`,
      };
  }
}

/** The CLI could not get an answer from a daemon that may be running. */
export function daemonUnreachableRefusal(detail: string, what = "rollup"): CompactRefusal {
  return {
    status: "deferred",
    reason: "daemon-unreachable",
    error:
      `Could not confirm with the running daemon that this session has no background tasks (${detail}). ` +
      `Not running the ${what}: its reload could kill them. Retry later; pass --no-daemon-check only when you are sure no daemon is running.`,
  };
}
