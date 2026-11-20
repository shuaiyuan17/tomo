import type { WebCompactState } from "../../src/web/protocol.js";
import { i18n } from "./i18n/index.js";

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
  const label = i18n.t("common:compact.label");
  if (request?.state === "accepted") return { state: "requested", label: i18n.t("common:compact.requestedLabel") };
  if (request?.state === "done" && opts.now - opts.seenAt < COMPACT_DONE_MS) return { state: "done", label: i18n.t("common:compact.done") };
  if (request?.state === "unverified" && opts.now - opts.seenAt < COMPACT_NOTICE_MS) {
    return { state: "ready", label, note: i18n.t("common:compact.unverified") };
  }
  if (opts.running > 0) return { state: "busy", label: i18n.t("common:compact.busy", { count: opts.running }) };
  const recent = opts.now - opts.seenAt < COMPACT_NOTICE_MS;
  if (request?.state === "failed" && recent) return { state: "ready", label, note: i18n.t("common:compact.failed") };
  if (request?.state === "declined" && recent) return { state: "ready", label, note: i18n.t("common:compact.declined") };
  return { state: "ready", label };
}

/** A short message for a refused request. */
export function compactError(code: string): string {
  if (code === "tasks_running") return i18n.t("common:compact.error.tasks_running");
  if (code === "epoch_changed") return i18n.t("common:compact.error.epoch_changed");
  if (code === "owner_setup_required") return i18n.t("common:compact.error.owner_setup_required");
  return i18n.t("common:compact.error.other");
}
