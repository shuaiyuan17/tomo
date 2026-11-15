import { useEffect, useState } from "react";
import type { WebRateLimit, WebRequest, WebTurnStatus } from "../../src/web/protocol.js";
import { modelLabel } from "./tasks.js";

/** How long "Completed" stays before it fades out (plus the fade itself). */
export const COMPLETED_VISIBLE_MS = 2000;
export const COMPLETED_FADE_MS = 200;

/** The request states as the status line words them, naming the agent (see agent-name.ts). */
export function requestLabels(agent = "Tomo"): Record<WebRequest["state"], string> {
  return { queued: "Queued", running: `${agent} is working…`, completed: "Completed",
    failed: "Delivery failed — check the conversation before sending again", refused: "Message was not accepted",
    unknown: `Outcome unknown — ${agent} may already have acted on it. Check the conversation before sending again`,
    interrupted: `Interrupted by a restart and not answered — ${agent} may have started on it. Check before sending again` };
}
export const REQUEST_LABELS = requestLabels();
/** The typing indicator's activity value; the status line words it with the agent's name. */
export const TYPING_ACTIVITY = "typing";

/** Where the latest request stands: a note is tied to this and lapses when it moves. */
export function requestStamp(latest: WebRequest | undefined): string {
  return latest ? `${latest.requestId}:${latest.state}` : "";
}

/** A one-off note from the page (sending, a refusal, a failed check), and the request stamp it was written at. */
export interface ComposerNote { text: string; at: string }

/** A turn status as the page holds it: `at` is when it arrived (local clock). */
export interface TurnStatus { status: WebTurnStatus; at: number }

/** The SDK's typed API errors, as the owner should read them. */
const ERROR_TEXT: Record<string, string> = {
  authentication_failed: "Claude login expired. Send /login to sign in again",
  oauth_org_not_allowed: "This Claude account's organization is not allowed here",
  account_on_hold: "The Claude account is on hold",
  verification_required: "The Claude account needs verification",
  billing_error: "Billing problem on the Claude account",
  rate_limit: "Usage limit reached",
  overloaded: "Claude is overloaded",
  invalid_request: "The request was rejected as invalid",
  model_not_found: "This model is not available",
  server_error: "Claude had a server error",
  max_output_tokens: "The reply hit the output limit",
  cloud_credential_error: "Cloud credentials were rejected",
};
export function errorText(error: string): string { return ERROR_TEXT[error] ?? "The model returned an error"; }

/** "42s", "3m 05s", "1h 02m". */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** `mcp__server__tool` reads as "tool"; built-in names stay. */
export function toolName(tool: string): string { return tool.startsWith("mcp__") ? tool.split("__").at(-1) || tool : tool; }

/** Is this what the turn is doing right now (lapses with the turn), rather than how it went? */
export function isTransient(status: WebTurnStatus): boolean { return status.kind === "retry" || status.kind === "tool"; }

/** A tool's progress is only worth a word once it has run this long. */
export const TOOL_PROGRESS_SHOWN_AFTER_S = 10;

/** What a running turn is doing, appended to "… is working…"; "" when there is nothing to add. */
export function turnDetail(turn: TurnStatus | undefined, now: number): string {
  if (!turn) return "";
  const { status } = turn;
  if (status.kind === "retry") return `Retrying ${status.attempt}/${status.max} · ${errorText(status.error).toLowerCase()}`;
  if (status.kind === "tool") {
    const elapsed = status.elapsed + Math.max(0, (now - turn.at) / 1000);
    return elapsed >= TOOL_PROGRESS_SHOWN_AFTER_S ? `${toolName(status.tool)} · ${elapsedLabel(elapsed)}` : "";
  }
  if (status.kind === "refusal" && status.fallbackModel) return `${modelLabel(status.model)} declined · continuing on ${modelLabel(status.fallbackModel)}`;
  return "";
}

/** How the last turn went, when the SDK said more than "done" or "failed"; "" otherwise. */
export function turnOutcome(turn: TurnStatus | undefined): string {
  if (!turn) return "";
  const { status } = turn;
  if (status.kind === "stopped") return "Stopped";
  if (status.kind === "error") return `${errorText(status.error)} — not answered`;
  if (status.kind === "refusal") {
    return status.fallbackModel ? `${modelLabel(status.model)} declined this; answered by ${modelLabel(status.fallbackModel)}`
      : `${modelLabel(status.model)} declined this request`;
  }
  return "";
}

/** A rate-limit window's name as the Plan usage card words it. */
const LIMIT_NAMES: Record<string, string> = { five_hour: "5-hour limit", seven_day: "Weekly limit", seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit", seven_day_overage_included: "Weekly limit", overage: "Extra usage" };
/** "in 2h 05m" / "in 12 min" / "" when unknown or past. */
export function resetsIn(resetsAt: number | undefined, now: number): string {
  if (!resetsAt || resetsAt <= now) return "";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `in ${Math.round(minutes / 1440)} days`;
}
/** The live rate-limit line for the Plan usage card; "" while all is well. `shift`: daemon clock → local. */
export function rateLimitNotice(limit: WebRateLimit | undefined, now: number): string {
  if (!limit || limit.status === "allowed") return "";
  const name = (limit.limit && LIMIT_NAMES[limit.limit]) || "Usage limit";
  const reset = resetsIn(limit.resetsAt, now);
  if (limit.status === "rejected") return `${name} reached${reset ? ` · resets ${reset}` : ""}`;
  return `${name} almost reached${limit.utilization !== undefined ? ` · ${limit.utilization}%` : ""}${reset ? ` · resets ${reset}` : ""}`;
}

/**
 * The composer's ONE status line. Live tool/typing activity first; then a
 * note the page produced, but only while the latest request is still where
 * it was when the note was written (any change of request or state retires
 * it, so a note can never hold back "Running" or "Completed"); then the
 * latest web request's state, read live from the request stream. A
 * completed request shows "Completed" until `settled` names it.
 */
export function composerStatus(input: {
  activity: string | undefined;
  note: ComposerNote;
  latest: WebRequest | undefined;
  settled: string | null;
  /** The agent's name (default "Tomo"). */
  agent?: string;
  /** What the SDK last reported about this conversation's turn. */
  turn?: TurnStatus;
  now?: number;
}): string {
  const labels = requestLabels(input.agent);
  const { latest } = input;
  const working = input.activity === TYPING_ACTIVITY || latest?.state === "running";
  const detail = working ? turnDetail(input.turn, input.now ?? Date.now()) : "";
  if (input.activity === TYPING_ACTIVITY) return detail ? `${labels.running} ${detail}` : labels.running;
  if (input.activity) return input.activity;
  if (input.note.text && input.note.at === requestStamp(latest)) return input.note.text;
  // How the turn went, in the SDK's own terms, outranks the bare request state
  // (a stopped turn "completed"; a typed error "failed"); never while one runs.
  // A completed request's line clears once settled, whatever it said.
  if (latest?.state === "completed" && input.settled === latest.requestId) return "";
  const outcome = latest?.state === "queued" || latest?.state === "running" ? "" : turnOutcome(input.turn);
  if (outcome) return outcome;
  if (!latest) return "";
  if (latest.state === "running" && detail) return `${labels.running} ${detail}`;
  return labels[latest.state];
}

/**
 * When the latest request completes: "fading" after COMPLETED_VISIBLE_MS,
 * then its id as `settled` (the line clears) once the fade is over.
 */
export function useCompletedSettle(latest: WebRequest | undefined): { settled: string | null; fading: boolean } {
  const [settled, setSettled] = useState<string | null>(null);
  const [fading, setFading] = useState<string | null>(null);
  const id = latest?.state === "completed" ? latest.requestId : null;
  useEffect(() => {
    if (!id) return;
    const fade = setTimeout(() => setFading(id), COMPLETED_VISIBLE_MS);
    const clear = setTimeout(() => setSettled(id), COMPLETED_VISIBLE_MS + COMPLETED_FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(clear); };
  }, [id]);
  return { settled, fading: !!id && fading === id && settled !== id };
}
