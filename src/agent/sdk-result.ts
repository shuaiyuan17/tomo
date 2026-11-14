/** SDK result classification for one LiveSession turn: fabricated replies, result errors, token totals. */

import type { UsageBaseline } from "../sessions/types.js";

/**
 * Sentinel resolution for a steered message that merged into the in-flight
 * turn: that turn's owner request receives (and delivers) the combined
 * response, so the steered caller gets this empty marker instead. The empty
 * string is safe as a sentinel only because send()/steer() can never
 * legitimately resolve with "" — empty turns fall back to "I'm not sure how
 * to respond to that." in the result handler.
 */
export const STEER_MERGED = "";
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
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
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
  ) {
    super(message);
    this.name = "SdkResultError";
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
export function describeResultFailure(result: SdkResultLike): SdkResultError | null {
  const errors = result.errors ?? [];
  switch (result.subtype) {
    case "success":
      if (!result.is_error) return null;
      return new SdkResultError(result.result?.trim() || "API Error: the turn ended on an API error", result.subtype, errors);
    case "error_max_turns":
      return new SdkResultError(MAX_TURNS_RESPONSE, result.subtype, errors);
    case "error_max_budget_usd":
      return new SdkResultError(MAX_BUDGET_RESPONSE, result.subtype, errors);
    default:
      return result.subtype.startsWith("error") || result.is_error
        ? new SdkResultError(EXECUTION_ERROR_RESPONSE, result.subtype, errors, result.num_turns)
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
