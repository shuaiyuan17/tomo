/**
 * Refuse a compact/rollup while the session has live background tasks.
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
 * loader silently drops. So the gate sits at the SOURCE: the rewrite is not
 * performed at all while tasks are running, and the next nudge tries again.
 */

export interface BackgroundGateRefusal {
  status: "deferred";
  reason: "background-tasks";
  activeBackgroundTasks: number;
  error: string;
}

/**
 * The refusal for `count` live background tasks, or null when the rewrite may
 * proceed. `what` names the operation in the message ("rollup", "prune").
 */
export function backgroundGateRefusal(count: number, what = "rollup"): BackgroundGateRefusal | null {
  if (!(count > 0)) return null;
  const tasks = count === 1 ? "1 background task is" : `${count} background tasks are`;
  return {
    status: "deferred",
    reason: "background-tasks",
    activeBackgroundTasks: count,
    error:
      `${tasks} still running in this session. Not running the ${what}: it reloads the session, ` +
      "which would kill them. Nothing was changed — retry after they finish (the next nudge will ask again).",
  };
}
