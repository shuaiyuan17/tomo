import type { EffortLevel, TomoConfig } from "../config.js";
import { isLiteLlmProviderModel, resolveModelName } from "../models.js";

/** Where a session's effort comes from. */
export type EffortSource =
  /** Its `sessionEffortOverrides` entry. */
  | "session"
  /** The top-level `effort`. */
  | "global"
  /** Neither is set: no option is sent and the SDK uses the model's default. */
  | "sdk-default"
  /** A LiteLLM `provider/model` (not a Claude model): no option is sent, whatever is configured. */
  | "not-supported";

export interface EffectiveEffort {
  /** The level sent to the SDK as `effort`; null when none is sent. */
  level: EffortLevel | null;
  source: EffortSource;
}

/**
 * The effort a session starts with — the one rule shared by `sdkOptions`
 * (what is sent) and the web Model page (what is shown), so they cannot drift.
 *
 * Claude models without effort support, or without a level (e.g. `max`), are
 * left to the CLI: it silently downgrades the level or sends none. A LiteLLM
 * provider model is not a Claude model, so — as for adaptive thinking — the
 * option is not sent at all.
 */
export function effectiveEffort(
  cfg: Pick<TomoConfig, "effort" | "sessionEffortOverrides">,
  sessionKey: string | undefined,
  model: string,
): EffectiveEffort {
  const resolved = resolveModelName(model) ?? model;
  if (isLiteLlmProviderModel(resolved)) return { level: null, source: "not-supported" };
  const override = sessionKey ? cfg.sessionEffortOverrides?.[sessionKey] : undefined;
  if (override) return { level: override, source: "session" };
  if (cfg.effort) return { level: cfg.effort, source: "global" };
  return { level: null, source: "sdk-default" };
}
