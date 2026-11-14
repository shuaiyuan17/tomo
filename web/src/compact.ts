/** Pure state for the "Compact context" button. */

/** After a request, the button shows "Requested…" until context drops or this passes. */
export const COMPACT_PENDING_MS = 10 * 60_000;
/** "Clearly dropped": below this fraction of the usage when it was requested. */
export const COMPACT_DROP_FRACTION = 0.7;

export interface CompactRequest { at: number; usedAtRequest: number }

export type CompactButton =
  | { state: "ready"; label: string }
  | { state: "busy"; label: string }
  | { state: "requested"; label: string }
  | { state: "hidden" };

export function compactButton(opts: { ownerSession: boolean; running: number; request?: CompactRequest; contextUsed: number; now: number }): CompactButton {
  if (!opts.ownerSession) return { state: "hidden" };
  if (opts.request && !compactSettled(opts.request, opts.contextUsed, opts.now)) return { state: "requested", label: "Compact requested…" };
  if (opts.running > 0) return { state: "busy", label: `${opts.running} ${opts.running === 1 ? "task" : "tasks"} running — wait for ${opts.running === 1 ? "it" : "them"} to finish` };
  return { state: "ready", label: "Compact context" };
}

/** The request is over: the context clearly dropped, or it has been long enough. */
export function compactSettled(request: CompactRequest, contextUsed: number, now: number): boolean {
  if (now - request.at >= COMPACT_PENDING_MS) return true;
  return request.usedAtRequest > 0 && contextUsed > 0 && contextUsed < request.usedAtRequest * COMPACT_DROP_FRACTION;
}

/** A short message for a refused request. */
export function compactError(code: string): string {
  if (code === "tasks_running") return "Tasks are still running — try again when they finish.";
  if (code === "epoch_changed") return "Tomo restarted — reload and try again.";
  if (code === "owner_setup_required") return "No owner session to compact.";
  return "Couldn't ask Tomo to compact. Try again.";
}
