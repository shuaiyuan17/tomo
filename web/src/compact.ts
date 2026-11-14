import type { WebCompactState } from "../../src/web/protocol.js";

/** Pure state for the "Compact context" button, driven by the server's request state. */

/** "Compacted" shows this long after a request is done. */
export const COMPACT_DONE_MS = 3_000;
/** A refusal or failure message shows this long. */
export const COMPACT_NOTICE_MS = 6_000;

export type CompactButton =
  | { state: "ready"; label: string; note?: string }
  | { state: "busy"; label: string }
  | { state: "requested"; label: string }
  | { state: "done"; label: string }
  | { state: "hidden" };

/**
 * `request` is the latest compact request as the server reports it;
 * `seenAt` is when this browser saw it reach its current state.
 */
export function compactButton(opts: { ownerSession: boolean; running: number; request?: WebCompactState; seenAt: number; now: number }): CompactButton {
  if (!opts.ownerSession) return { state: "hidden" };
  const { request } = opts;
  if (request?.state === "accepted") return { state: "requested", label: "Compact requested…" };
  if (request?.state === "done" && opts.now - opts.seenAt < COMPACT_DONE_MS) return { state: "done", label: "Compacted" };
  if (opts.running > 0) return { state: "busy", label: `${opts.running} ${opts.running === 1 ? "task" : "tasks"} running — wait for ${opts.running === 1 ? "it" : "them"} to finish` };
  const recent = opts.now - opts.seenAt < COMPACT_NOTICE_MS;
  if (request?.state === "failed" && recent) return { state: "ready", label: "Compact context", note: "The compact didn't finish. Try again." };
  if (request?.state === "declined" && recent) return { state: "ready", label: "Compact context", note: "Tasks were running — try again when they finish." };
  return { state: "ready", label: "Compact context" };
}

/** A short message for a refused request. */
export function compactError(code: string): string {
  if (code === "tasks_running") return "Tasks are still running — try again when they finish.";
  if (code === "epoch_changed") return "Tomo restarted — reload and try again.";
  if (code === "owner_setup_required") return "No owner session to compact.";
  return "Couldn't ask Tomo to compact. Try again.";
}
