import { useEffect, useState } from "react";
import type { WebRateLimit, WebRequest, WebTurnStatus } from "../../src/web/protocol.js";
import { formatElapsed, modelLabel } from "./tasks.js";
import { i18n } from "./i18n/index.js";
import { deferred, say, type Message } from "./i18n/message.js";

/** How long "Completed" stays before it fades out (plus the fade itself). */
export const COMPLETED_VISIBLE_MS = 2000;
export const COMPLETED_FADE_MS = 200;

/** The request states in words, naming the agent (see agent-name.ts). "running" is shown only as an answer to "check the outcome", and spoken to a screen reader. */
export function requestLabels(agent = "Tomo"): Record<WebRequest["state"], string> {
  return { queued: i18n.t("chat:request.queued"), running: i18n.t("chat:request.running", { agent }), completed: i18n.t("chat:request.completed"),
    failed: i18n.t("chat:request.failed"), refused: i18n.t("chat:request.refused"),
    unknown: i18n.t("chat:request.unknown", { agent }),
    interrupted: i18n.t("chat:request.interrupted", { agent }) };
}
/** A request state as a status note, for state (worded when shown). */
export function requestMessage(state: WebRequest["state"], agent: string): Message {
  switch (state) {
    case "queued": return deferred.t("chat:request.queued");
    case "running": return deferred.t("chat:request.running", { agent });
    case "completed": return deferred.t("chat:request.completed");
    case "failed": return deferred.t("chat:request.failed");
    case "refused": return deferred.t("chat:request.refused");
    case "unknown": return deferred.t("chat:request.unknown", { agent });
    case "interrupted": return deferred.t("chat:request.interrupted", { agent });
  }
}
/** The typing indicator's activity value: a turn is running. */
export const TYPING_ACTIVITY = "typing";

/** Where the latest request stands: a note is tied to this and lapses when it moves. */
export function requestStamp(latest: WebRequest | undefined): string {
  return latest ? `${latest.requestId}:${latest.state}` : "";
}

/** A one-off note from the page (sending, a refusal, a failed check), and the request stamp it was written at. */
/** `warn`: the note says something failed (shown in the destructive colour, `text-destructive`). */
export interface ComposerNote { text: Message | null; at: string; warn?: boolean }

/** A turn status as the page holds it: `at` is when it arrived (local clock). */
export interface TurnStatus { status: WebTurnStatus; at: number }

/** The SDK's typed API errors, as the owner should read them. */
const ERROR_TEXT: Record<string, `chat:apiError.${string}`> = {
  authentication_failed: "chat:apiError.authentication_failed",
  oauth_org_not_allowed: "chat:apiError.oauth_org_not_allowed",
  account_on_hold: "chat:apiError.account_on_hold",
  verification_required: "chat:apiError.verification_required",
  billing_error: "chat:apiError.billing_error",
  rate_limit: "chat:apiError.rate_limit",
  overloaded: "chat:apiError.overloaded",
  invalid_request: "chat:apiError.invalid_request",
  model_not_found: "chat:apiError.model_not_found",
  server_error: "chat:apiError.server_error",
  max_output_tokens: "chat:apiError.max_output_tokens",
  cloud_credential_error: "chat:apiError.cloud_credential_error",
};
export function errorText(error: string): string {
  // i18n-dynamic: chat:apiError.*
  return i18n.t((ERROR_TEXT[error] ?? "chat:apiError.other") as "chat:apiError.other");
}

/** "42s", "3m 05s", "1h 02m". */
export function elapsedLabel(seconds: number): string {
  return formatElapsed(Math.max(0, Math.floor(seconds)) * 1000);
}

/** `mcp__server__tool` reads as "tool"; built-in names stay. */
export function toolName(tool: string): string { return tool.startsWith("mcp__") ? tool.split("__").at(-1) || tool : tool; }

/** Is this what the turn is doing right now (lapses with the turn), rather than how it went? */
export function isTransient(status: WebTurnStatus): boolean { return status.kind === "retry" || status.kind === "tool"; }

/** A tool's progress is only worth a word once it has run this long. */
export const TOOL_PROGRESS_SHOWN_AFTER_S = 10;

/** What a running turn is doing, worth a word in the status line; "" when there is nothing to say. */
export function turnDetail(turn: TurnStatus | undefined, now: number): string {
  if (!turn) return "";
  const { status } = turn;
  if (status.kind === "retry") return i18n.t("chat:turn.retrying", { attempt: status.attempt, max: status.max, error: errorText(status.error).toLowerCase() });
  if (status.kind === "tool") {
    const elapsed = status.elapsed + Math.max(0, (now - turn.at) / 1000);
    return elapsed >= TOOL_PROGRESS_SHOWN_AFTER_S ? `${toolName(status.tool)} · ${elapsedLabel(elapsed)}` : "";
  }
  if (status.kind === "refusal" && status.fallbackModel) return i18n.t("chat:turn.declinedContinuing", { model: modelLabel(status.model), fallback: modelLabel(status.fallbackModel) });
  return "";
}

/** How the last turn went, when the SDK said more than "done" or "failed"; "" otherwise. */
export function turnOutcome(turn: TurnStatus | undefined): string {
  if (!turn) return "";
  const { status } = turn;
  if (status.kind === "stopped") return i18n.t("chat:turn.stopped");
  if (status.kind === "error") return i18n.t("chat:turn.error", { error: errorText(status.error) });
  if (status.kind === "refusal") {
    return status.fallbackModel ? i18n.t("chat:turn.declinedAnswered", { model: modelLabel(status.model), fallback: modelLabel(status.fallbackModel) })
      : i18n.t("chat:turn.declined", { model: modelLabel(status.model) });
  }
  return "";
}

/** A rate-limit window's name as the Plan usage card words it. */
const LIMIT_NAMES: Record<string, `chat:limit.${string}`> = { five_hour: "chat:limit.fiveHour", seven_day: "chat:limit.weekly", seven_day_opus: "chat:limit.weeklyOpus",
  seven_day_sonnet: "chat:limit.weeklySonnet", seven_day_overage_included: "chat:limit.weekly", overage: "chat:limit.overage" };
/** "in 2h 05m" / "in 12 min" / "" when unknown or past. */
export function resetsIn(resetsAt: number | undefined, now: number): string {
  if (!resetsAt || resetsAt <= now) return "";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return i18n.t("tasks:scheduled.inMinutes", { count: minutes });
  if (minutes < 48 * 60) return i18n.t("chat:limit.inSpan", { span: formatElapsed(minutes * 60_000) });
  return i18n.t("chat:limit.inDays", { count: Math.round(minutes / 1440) });
}
/** The live rate-limit line for the Plan usage card; "" while all is well. `shift`: daemon clock → local. */
export function rateLimitNotice(limit: WebRateLimit | undefined, now: number): string {
  if (!limit || limit.status === "allowed") return "";
  // i18n-dynamic: chat:limit.*
  const name = i18n.t(((limit.limit && LIMIT_NAMES[limit.limit]) || "chat:limit.usage") as "chat:limit.usage");
  const reset = resetsIn(limit.resetsAt, now);
  const parts: string[] = [limit.status === "rejected" ? i18n.t("chat:limit.reached", { name }) : i18n.t("chat:limit.almost", { name })];
  if (limit.status !== "rejected" && limit.utilization !== undefined) parts.push(`${limit.utilization}%`);
  if (reset) parts.push(i18n.t("chat:limit.resets", { when: reset }));
  return parts.join(" · ");
}

/**
 * The composer's ONE status line. Live tool/typing activity first; then a
 * note the page produced, but only while the latest request is still where
 * it was when the note was written (any change of request or state retires
 * it, so a note can never hold back "Queued" or "Completed"); then the
 * latest web request's state, read live from the request stream. A
 * completed request shows "Completed" until `settled` names it.
 *
 * A running turn shows only what it has to add (a retry, a long tool, a
 * model that declined): that it is working at all is the chat's to show
 * (the thinking dots, the steps, the reply), and composerStatusSpoken's to
 * say to a screen reader.
 */
export function composerStatus(input: ComposerStatusInput): string {
  const labels = requestLabels(input.agent);
  const { latest } = input;
  const working = input.activity === TYPING_ACTIVITY || latest?.state === "running";
  const detail = working ? turnDetail(input.turn, input.now ?? Date.now()) : "";
  if (input.activity === TYPING_ACTIVITY) return detail;
  if (input.activity) return input.activity;
  if (input.note.text && input.note.at === requestStamp(latest)) return say(input.note.text);
  // How the turn went, in the SDK's own terms, outranks the bare request state
  // (a stopped turn "completed"; a typed error "failed"); never while one runs.
  // A completed request's line clears once settled, whatever it said.
  if (latest?.state === "completed" && input.settled === latest.requestId) return "";
  const outcome = latest?.state === "queued" || latest?.state === "running" ? "" : turnOutcome(input.turn);
  if (outcome) return outcome;
  if (!latest) return "";
  if (latest.state === "running") return detail;
  return labels[latest.state];
}

/**
 * What a screen reader hears ahead of the line composerStatus shows for the
 * same input: "… is working…" whenever that line is a running turn's (its
 * detail, or nothing), so the turn is announced though the words are not
 * shown; "" when the line is anything else (it speaks for itself).
 */
export function composerStatusSpoken(input: ComposerStatusInput): string {
  const { latest } = input;
  const running = input.activity === TYPING_ACTIVITY
    || (!input.activity && !(input.note.text && input.note.at === requestStamp(latest)) && latest?.state === "running");
  return running ? requestLabels(input.agent).running : "";
}

export interface ComposerStatusInput {
  activity: string | undefined;
  note: ComposerNote;
  latest: WebRequest | undefined;
  settled: string | null;
  /** The agent's name (default "Tomo"). */
  agent?: string;
  /** What the SDK last reported about this conversation's turn. */
  turn?: TurnStatus;
  now?: number;
}

/** Request states the status line shows as a problem. */
const PROBLEM_STATES = new Set<WebRequest["state"]>(["failed", "refused", "unknown", "interrupted"]);

/**
 * Whether the line composerStatus shows for the same input reports a
 * problem (shown in the destructive colour): a note marked `warn`, a typed
 * error or an unanswered refusal, or a failed / refused / unknown /
 * interrupted request. Progress, "Stopped" and "Completed" never are.
 */
export function composerStatusIsProblem(input: ComposerStatusInput): boolean {
  const { latest } = input;
  if (input.activity) return false;
  if (input.note.text && input.note.at === requestStamp(latest)) return !!input.note.warn;
  if (latest?.state === "completed" && input.settled === latest.requestId) return false;
  const status = latest?.state === "queued" || latest?.state === "running" ? undefined : input.turn?.status;
  if (status && turnOutcome(input.turn)) return status.kind === "error" || (status.kind === "refusal" && !status.fallbackModel);
  return !!latest && PROBLEM_STATES.has(latest.state);
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
