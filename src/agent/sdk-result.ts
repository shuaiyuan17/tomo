/** SDK result classification for one LiveSession turn: fabricated replies, result errors, token totals. */

import type { ModelCounters, UsageBaseline } from "../sessions/types.js";
import type { SdkErrorKind } from "./sdk-signals.js";

/**
 * Sentinel resolution for a steered message that merged into the in-flight
 * turn: that turn's owner request receives (and delivers) the combined
 * response, so the steered caller gets this empty marker instead. The empty
 * string is safe as a sentinel only because send()/steer() can never
 * legitimately resolve with "" — a turn with no text resolves EMPTY_REPLY.
 */
export const STEER_MERGED = "";
/**
 * Resolution of a turn that ended with no reply text anywhere (no text block,
 * no result text) and that the model did not answer with a literal NO_REPLY.
 * Silent to the channel like NO_REPLY, but NOT a successful outcome: the
 * runner reports it (TurnSpec.onEmpty) so cron records "empty", not "ok".
 * Never delivered or recorded as text: the runner swaps it for NO_REPLY.
 */
export const EMPTY_REPLY = "[empty reply]";
export const QUERY_TIMEOUT_ERROR_PREFIX = "Query timed out after";

/** Fabricated reply for a turn the CLI cut short at the max-turns limit. */
export const MAX_TURNS_RESPONSE = "I ran out of steps trying to complete that. Can you try a simpler request?";
/** Fabricated reply for a turn the CLI cut short at the per-query budget. */
export const MAX_BUDGET_RESPONSE = "I hit the spending limit for this turn before finishing.";
/** Fabricated reply for a turn that died inside the CLI (`error_during_execution` and friends). */
export const EXECUTION_ERROR_RESPONSE = "Something went wrong while I was working on that and the turn stopped early.";

/**
 * The slice of `SDKResultMessage` the result handler reads. Typed by hand
 * rather than imported so an SDK release that adds result subtypes keeps
 * compiling — `subtype` is compared as a string and unknown values fall into
 * the generic execution-error branch.
 */
export interface SdkResultLike {
  subtype: string;
  is_error?: boolean;
  /** Error subtypes: why the turn stopped. */
  errors?: string[];
  /** `success` subtype: the final assistant text — or, with `is_error`, the API error text. */
  result?: string;
  num_turns?: number;
  /**
   * Client uuids of the user messages this result's turn consumed (the
   * `uuid` stamped on each pushed SDKUserMessage). Absent on turns the CLI
   * started itself and from older CLIs; `user_message_uuid` is the last one.
   */
  user_message_uuid?: string;
  user_message_uuids?: string[];
  /** Set when the CLI started the turn itself, e.g. `{ kind: "task-notification" }`. */
  origin?: { kind?: string };
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheCreationEphemeral5mInputTokens?: number;
    cacheCreationEphemeral1hInputTokens?: number;
    thinkingTokens?: number;
    webSearchRequests?: number;
    costUSD?: number;
    costBasis?: string;
  }>;
  session_id?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreated: number;
}

/** Cumulative `modelUsage` summed across models; null when the result has none. */
export function cumulativeModelTokens(result: SdkResultLike): TokenTotals | null {
  const models = result.modelUsage ? Object.values(result.modelUsage) : [];
  if (models.length === 0) return null;
  return models.reduce<TokenTotals>((acc, m) => ({
    input: acc.input + (m.inputTokens ?? 0),
    output: acc.output + (m.outputTokens ?? 0),
    cacheRead: acc.cacheRead + (m.cacheReadInputTokens ?? 0),
    cacheCreated: acc.cacheCreated + (m.cacheCreationInputTokens ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 });
}

/** Cumulative `modelUsage` per model; null when the result has none. */
export function cumulativeModelCounters(result: SdkResultLike): Record<string, ModelCounters> | null {
  const entries = result.modelUsage ? Object.entries(result.modelUsage) : [];
  if (entries.length === 0) return null;
  const out: Record<string, ModelCounters> = {};
  for (const [model, m] of entries) {
    out[model] = {
      input: m.inputTokens ?? 0,
      output: m.outputTokens ?? 0,
      cacheRead: m.cacheReadInputTokens ?? 0,
      cacheCreated: m.cacheCreationInputTokens ?? 0,
      ...(m.cacheCreationEphemeral5mInputTokens !== undefined ? { cacheCreated5m: m.cacheCreationEphemeral5mInputTokens } : {}),
      ...(m.cacheCreationEphemeral1hInputTokens !== undefined ? { cacheCreated1h: m.cacheCreationEphemeral1hInputTokens } : {}),
      ...(m.thinkingTokens !== undefined ? { thinking: m.thinkingTokens } : {}),
      webSearch: m.webSearchRequests ?? 0,
      costUsd: m.costUSD ?? 0,
    };
  }
  return out;
}

/** One model's share of one turn: its counter deltas plus the price table used. */
export type ModelTurnUsage = ModelCounters & { costBasis?: string };

const COUNTER_KEYS = ["input", "output", "cacheRead", "cacheCreated", "cacheCreated5m", "cacheCreated1h", "thinking", "webSearch", "costUsd"] as const;

/**
 * This turn's usage per model: `current` minus `previous` (null = this turn
 * owns the whole cumulative, as on a fresh session or after a reset). Models
 * that did nothing this turn are left out. A counter the CLI did not report
 * stays absent rather than reading as 0.
 */
export function modelUsageDelta(
  result: SdkResultLike,
  current: Record<string, ModelCounters>,
  previous: Record<string, ModelCounters> | null,
): Record<string, ModelTurnUsage> {
  const out: Record<string, ModelTurnUsage> = {};
  for (const [model, cur] of Object.entries(current)) {
    const prev = previous?.[model];
    const delta: Record<string, number> = {};
    let active = false;
    for (const key of COUNTER_KEYS) {
      const now = cur[key];
      if (now === undefined) continue;
      const value = now - (prev?.[key] ?? 0);
      delta[key] = value;
      if (value !== 0) active = true;
    }
    if (!active) continue;
    const basis = result.modelUsage?.[model]?.costBasis;
    out[model] = { ...(delta as unknown as ModelCounters), ...(basis ? { costBasis: basis } : {}) };
  }
  return out;
}

/** `usage`: main agent loop only, but already per-turn. */
export function tokenSum(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheCreated;
}

export function mainLoopUsage(result: SdkResultLike): TokenTotals {
  const u = result.usage as Record<string, number> | undefined;
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreated: u?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * The CLI's own API error message, when it is the last thing the turn's
 * assistant said: a synthetic assistant message whose `error` names the kind
 * and whose text is the error line ("Not logged in · Please run /login").
 */
export interface TurnApiError {
  kind: SdkErrorKind;
  /** The error line, as the CLI wrote it. */
  text: string;
  /** Before it, the turn made no tool call, produced no block of the model's own, and took in no steered message. */
  nothingRan: boolean;
}

/**
 * A turn the CLI ended on a non-success result. Thrown (rejected) from
 * send()/steer() so the failure travels the same path as any other turn
 * error and TurnRunner's `TurnErrorPolicy` decides what the chat sees —
 * delivered to a DM, note-only for a group cron, ignored for continuity —
 * and CronScheduler records the run as failed. `message` is owner-facing
 * (or, for an API-error result, the API error text, which the delivery
 * pipeline's `isAgentErrorResponse` already classifies).
 */
export class SdkResultError extends Error {
  constructor(
    message: string,
    readonly subtype: string,
    readonly errors: string[] = [],
    /** `num_turns` from the result, when the SDK reported it. 0 = nothing ran. */
    readonly numTurns?: number,
    /** The typed API error the turn's last assistant message carried, if it ended on one. */
    readonly apiError?: Pick<TurnApiError, "kind" | "nothingRan">,
  ) {
    super(message);
    this.name = "SdkResultError";
  }

  /**
   * The login was refused before the model did anything: no tool call, no
   * block of its own, no steered message folded in. Seen as a passing state
   * on the first request of a freshly started CLI, so the same prompt is safe
   * to send once more (LiveSessionManager): nothing of the turn exists to
   * repeat. An account that really is logged out fails the second time too.
   */
  get isAuthFailureBeforeAnyWork(): boolean {
    return this.apiError?.kind === "authentication_failed" && this.apiError.nothingRan;
  }

  /**
   * A resume that couldn't find its conversation, as current SDKs report it:
   * an execution-error result with zero turns and the reason in `errors`,
   * rather than a throw. Nothing ran, so the turn is safe to re-run on a
   * fresh session. Every condition is required; a result that ran any turn,
   * or failed for any other reason too, is not this.
   */
  get isResumeMissing(): boolean {
    return this.subtype === "error_during_execution"
      && this.numTurns === 0
      && this.errors.length > 0
      && this.errors.every((e) => e.includes("No conversation found"));
  }
}

/**
 * The owner stopped this turn on purpose (/rewind). Not a session failure:
 * LiveSessionManager never retries it (a retry would repeat whatever the turn
 * already did), and TurnRunner delivers nothing for it — the command's own
 * reply says the turn was stopped. The message must not match the manager's
 * "session closed" patterns.
 */
/**
 * Owner browser input that was going to join a running turn, but the turn
 * stopped being eligible (background work took over, a group was summoned in,
 * the turn ended) before injection. Thrown BEFORE anything reaches the SDK, so
 * the input is handed back to the session's FIFO queue as its own turn —
 * never sent around that queue. Not a failure: nothing is delivered or
 * recorded for it.
 */
export class SteerDeclinedError extends Error {
  constructor() {
    super("Steer declined: the running turn is no longer eligible");
    this.name = "SteerDeclinedError";
  }
}

export class TurnInterruptedError extends Error {
  constructor(message = "Turn stopped by /rewind.") {
    super(message);
    this.name = "TurnInterruptedError";
  }
}

/**
 * Classify a turn-ending result. `null` for a clean success; otherwise the
 * typed error the turn should reject with.
 *
 * The SDK's result union (`SDKResultSuccess | SDKResultError`) is closed
 * today, but new error subtypes have been added before; every one so far is
 * `error_*`, so an unrecognised `error_*` subtype is treated as an execution
 * error rather than as success.
 */
export function describeResultFailure(result: SdkResultLike, apiError?: TurnApiError): SdkResultError | null {
  const errors = result.errors ?? [];
  const typed = apiError ? { kind: apiError.kind, nothingRan: apiError.nothingRan } : undefined;
  switch (result.subtype) {
    case "success":
      // A turn whose last assistant message was the CLI's API error message
      // failed, whether or not the result says so: its only "answer" is that
      // error text, which must not pass for a reply.
      if (!result.is_error && !apiError) return null;
      return new SdkResultError(
        (result.is_error ? result.result?.trim() : "") || apiError?.text.trim() || "API Error: the turn ended on an API error",
        result.subtype, errors, result.num_turns, typed,
      );
    case "error_max_turns":
      return new SdkResultError(MAX_TURNS_RESPONSE, result.subtype, errors, undefined, typed);
    case "error_max_budget_usd":
      return new SdkResultError(MAX_BUDGET_RESPONSE, result.subtype, errors, undefined, typed);
    default:
      return result.subtype.startsWith("error") || result.is_error
        ? new SdkResultError(EXECUTION_ERROR_RESPONSE, result.subtype, errors, result.num_turns, typed)
        : null;
  }
}

export interface QueryResult {
  /** Cost of this turn only (delta of the SDK's cumulative per-process total) */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextUsed: number;
  contextMax: number;
  contextBreakdown?: { name: string; tokens: number }[];
  /**
   * The SDK could not report context usage for this turn, so `contextUsed` is
   * a crude approximation from the turn's own token counts and `contextMax` is
   * the last reading that WAS real (0 if there has never been one). Anything
   * that acts on the ratio — the context-nudge ladder — must skip instead.
   */
  contextEstimated?: boolean;
  /**
   * The SDK's cumulative counters after this turn — what the next resume of
   * this SDK session must difference against. `null` when they cannot be
   * trusted as that baseline (the totals just reset, or the result carried no
   * `modelUsage`/session id), which makes the next resume take the
   * conservative no-baseline path rather than charge a carried total.
   */
  usageBaseline?: UsageBaseline | null;
}
