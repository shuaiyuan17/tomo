import type { HistoryPage, WebRequest } from "../../src/web/protocol.js";

/** Request and turn ids of assistant replies the canonical history records. */
export function recordedReplyIds(history: HistoryPage): Set<string> {
  return new Set(history.messages.filter((m) => m.role === "assistant").flatMap((m) => [m.requestId, m.turnId]).filter((id): id is string => !!id));
}
/** Messages this owner sent from the browser that the transcript does not show yet (#381). */
export function pendingUserMessages(requests: WebRequest[], history: HistoryPage, sessionId: string): WebRequest[] {
  const recorded = new Set(history.messages.filter((m) => m.role === "user").map((m) => m.requestId));
  return requests.filter((r) => r.sessionId === sessionId && r.text && !recorded.has(r.requestId) && r.state !== "refused");
}
export function pendingLabel(request: WebRequest): string {
  if (request.joined) return "Joined the running turn";
  return ({ queued: "Queued", running: "Sent", completed: "Sent", failed: "Not delivered", refused: "Not accepted",
    unknown: "Outcome unknown — may have run", interrupted: "Interrupted by a restart — may have run" } as const)[request.state];
}
/**
 * Badge for a recorded history bubble whose request did not end cleanly, by
 * requestId — every such bubble, not just the latest request.
 */
export function historyBadge(requestId: string | undefined, requests: WebRequest[]): string | undefined {
  if (!requestId) return undefined;
  const state = requests.find((r) => r.requestId === requestId)?.state;
  return state === "interrupted" ? "Interrupted" : state === "unknown" ? "Outcome unknown" : undefined;
}
/** An interrupted request the owner can still resend or dismiss (it has its text). */
export function awaitingOwner(request: WebRequest): boolean {
  return request.state === "interrupted" && request.text !== undefined;
}

/** How many settled requests the browser keeps; unsettled and awaiting-owner ones never count. */
export const MAX_KEPT_REQUESTS = 128;
/**
 * Bound the browser's request list without ever dropping a request that is
 * still in flight or an interrupted one awaiting the owner: those only leave
 * when the daemon says they are settled or resolved.
 */
export function trimRequests(requests: WebRequest[]): WebRequest[] {
  const keep = (r: WebRequest) => awaitingOwner(r) || r.state === "queued" || r.state === "running";
  const others = requests.filter((r) => !keep(r));
  const drop = new Set(others.slice(0, Math.max(0, others.length - MAX_KEPT_REQUESTS)));
  return requests.filter((r) => !drop.has(r));
}

/**
 * Is `sent` still a resend of the interrupted `original` — the same text, or
 * the owner's edit of it — rather than something else typed over it? An edit
 * keeps at least half of the original's words; replacing the draft with other
 * content does not.
 */
export function isResendOf(original: string, sent: string): boolean {
  const a = original.trim(); const b = sent.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const words = (text: string) => text.toLowerCase().split(/\s+/u).filter(Boolean);
  const originalWords = words(a);
  // Text without spaces (e.g. Chinese) has one "word": compare characters.
  if (originalWords.length < 4) {
    const chars = new Set([...b]);
    const shared = [...a].filter((c) => chars.has(c)).length;
    return shared / [...a].length >= 0.5;
  }
  const sentWords = new Set(words(b));
  return originalWords.filter((w) => sentWords.has(w)).length / originalWords.length >= 0.5;
}

/** An interrupted request the owner is resending from the composer. */
export interface Resend { requestId: string; original: string }
/** Clearing the composer cancels a resend; editing it does not. */
export function resendAfterDraftChange(resend: Resend | null, draft: string): Resend | null {
  return resend && draft.trim() ? resend : null;
}
/** The interrupted request to dismiss once `sent` was ACCEPTED — only if it really was that message (or an edit of it). */
export function dismissAfterAcceptedSend(resend: Resend | null, sent: string): string | null {
  return resend && isResendOf(resend.original, sent) ? resend.requestId : null;
}
