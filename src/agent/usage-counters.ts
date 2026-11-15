/** Per-turn usage from the SDK's cumulative counters, as a pure step function. */

import type { ModelCounters, UsageBaseline } from "../sessions/types.js";
import {
  cumulativeModelCounters,
  cumulativeModelTokens,
  mainLoopUsage,
  modelUsageDelta,
  tokenSum,
  type ModelTurnUsage,
  type SdkResultLike,
  type TokenTotals,
} from "./sdk-result.js";

/**
 * What a turn's delta is measured against: the SDK's cumulative counters as of
 * the previous result that was ACCOUNTED for. LiveSession keeps two of these —
 * one advanced by every result (session stats), one advanced only once that
 * result's ledger row is on disk (the ledger), so a row that failed to land
 * leaves its turn to be counted by the next one.
 */
export interface UsageCounters {
  totalCost: number;
  tokens: TokenTotals | null;
  models: Record<string, ModelCounters> | null;
  /**
   * The next result is the first since this session resumed an SDK session.
   * `"baseline"`: seeded from a baseline. `"unknown"`: there was none, so the
   * carried totals are unknown. Null otherwise (every fresh session).
   */
  resume: "baseline" | "unknown" | null;
  /** The seeding baseline had totals but no per-model counters. */
  modelsMissing: boolean;
}

/** Counters for a new LiveSession: zero, or seeded from the resume baseline. */
export function initialUsageCounters(resumeFrom?: { sdkSessionId: string; baseline?: UsageBaseline }): UsageCounters {
  const zero: UsageCounters = { totalCost: 0, tokens: null, models: null, resume: null, modelsMissing: false };
  if (!resumeFrom) return zero;
  const baseline = resumeFrom.baseline;
  if (!baseline || baseline.sdkSessionId !== resumeFrom.sdkSessionId) return { ...zero, resume: "unknown" };
  return {
    totalCost: baseline.totalCostUsd,
    tokens: { ...baseline.tokens },
    models: baseline.models ? structuredClone(baseline.models) : null,
    resume: "baseline",
    modelsMissing: !baseline.models,
  };
}

export interface UsageStep {
  /** This turn's own cost. */
  costUsd: number;
  /** The SDK's cumulative total at this result. */
  totalCost: number;
  tokens: TokenTotals;
  /** This turn per model; undefined when it cannot be split. */
  models: Record<string, ModelTurnUsage> | undefined;
  /** First result after a resume with no usable baseline: cost recorded as 0. */
  noBaseline: boolean;
  /** The cumulative snapshot the next resume must start from; null when it cannot be trusted. */
  baseline: UsageBaseline | null;
  /** The counters after this result. */
  next: UsageCounters;
}

/**
 * Per-turn cost and tokens for `result`, measured against `prev`.
 *
 * `total_cost_usd` and `modelUsage` are cumulative per query() (and
 * `modelUsage` covers the whole pipeline, subagents included, where `usage`
 * is the MAIN AGENT LOOP ONLY), so a turn's own figures are the delta from
 * the previous result. A counter that went BACKWARDS is a reset, not a
 * refund — crash results carry zeroed totals and a mid-session /clear
 * restarts the running sum — so the cumulative value is then this turn's
 * own; never record a negative. A result without `modelUsage` (older CLIs,
 * zeroed crash results) falls back to `usage`, already per-turn.
 *
 * THE FIRST RESULT AFTER A RESUME is different: the SDK continues from the
 * totals the transcript saved, so it already carries every earlier turn.
 *  - With a baseline, the counters were seeded from it and the delta is
 *    this turn's own. If the carried total is BELOW the baseline, the
 *    transcript saved an older total than tomo last recorded (e.g. a reload
 *    after compaction); that is not a reset — charging the whole carried
 *    total is exactly the over-count this exists to prevent — so it takes
 *    the no-baseline path below.
 *  - With NO baseline, the carried total is unknown. The SDK exposes no
 *    per-turn cost, so this turn's cost is recorded as 0 and its tokens as
 *    `usage` (per-turn, main loop only): a one-turn UNDERcount instead of
 *    charging the session's lifetime. The result then becomes the baseline
 *    for every later delta.
 */
export function stepUsage(prev: UsageCounters, result: SdkResultLike, sessionId: string | null | undefined): UsageStep {
  const totalCost = result.total_cost_usd ?? 0;
  const cumulative = cumulativeModelTokens(result);
  const cumulativeModels = cumulativeModelCounters(result);
  const perTurnUsage = mainLoopUsage(result);
  const prevTokens = prev.tokens;

  const tokensWentBackwards = !!(cumulative && prevTokens) && (
    cumulative.input < prevTokens.input
    || cumulative.output < prevTokens.output
    || cumulative.cacheRead < prevTokens.cacheRead
    || cumulative.cacheCreated < prevTokens.cacheCreated
  );
  const costWentBackwards = totalCost < prev.totalCost;

  const next: UsageCounters = {
    totalCost,
    tokens: cumulative ?? prev.tokens,
    models: cumulativeModels ?? prev.models,
    resume: null,
    modelsMissing: false,
  };

  const baselineFor = (trusted: boolean): UsageBaseline | null =>
    trusted && cumulative && sessionId
      ? {
        sdkSessionId: sessionId,
        totalCostUsd: totalCost,
        tokens: { ...cumulative },
        ...(cumulativeModels ? { models: structuredClone(cumulativeModels) } : {}),
      }
      : null;

  if (prev.resume === "unknown" || (prev.resume === "baseline" && (costWentBackwards || tokensWentBackwards))) {
    // A zeroed crash result is no baseline at all — keep none. Judge
    // "zeroed" by cost AND tokens: a zero-cost route (e.g. a gateway that
    // reports no price) with real cumulative tokens is a valid baseline.
    const zeroed = totalCost <= 0 && !(cumulative && tokenSum(cumulative) > 0);
    return { costUsd: 0, totalCost, tokens: perTurnUsage, models: undefined, noBaseline: true, baseline: baselineFor(!zeroed), next };
  }

  // A reset is decided ONCE for the whole result: after one (crash or
  // /clear) every cumulative figure is this turn's own. Deciding per field
  // would subtract the old total from any counter that happened to come
  // back larger than before, undercounting that turn.
  const reset = costWentBackwards || tokensWentBackwards;
  const costUsd = reset ? totalCost : totalCost - prev.totalCost;
  const tokens = cumulative
    ? prevTokens && !reset
      ? {
        input: cumulative.input - prevTokens.input,
        output: cumulative.output - prevTokens.output,
        cacheRead: cumulative.cacheRead - prevTokens.cacheRead,
        cacheCreated: cumulative.cacheCreated - prevTokens.cacheCreated,
      }
      : cumulative
    : perTurnUsage;
  // Per model the same way. A resume from a baseline with totals but no
  // per-model counters has nothing to subtract per model: no split.
  const models = !cumulativeModels || (prev.modelsMissing && !reset)
    ? undefined
    : modelUsageDelta(result, cumulativeModels, reset ? null : prev.models);
  // After a reset it is unknown what total the SDK transcript saved (a
  // crash leaves the old one, a /clear the new one): drop the baseline so
  // the next resume takes the conservative path instead of guessing.
  return { costUsd, totalCost, tokens, models, noBaseline: false, baseline: baselineFor(!reset), next };
}
