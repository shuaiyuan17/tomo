import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL } from "./litellm.js";

/**
 * The 5.5 family. Context support comes from the Agent SDK's own model
 * registry (bundled Claude Code 2.1.299): Opus 5.5, Sonnet 5.5, Haiku 5.5 and
 * Fable 5.1 all run with a 1M window natively (`native_1m`), and only Opus 5.5
 * also declares the `[1m]` suffix. So the Opus default carries the suffix and
 * the others are 1M as plain ids — no `[1m]` id is invented for a model that
 * does not declare one.
 *
 * Any other direct model id (an older `claude-sonnet-5[1m]`, `claude-opus-4-8`,
 * …) is still accepted by resolveModelName, so existing configs keep working;
 * the pickers just no longer list them.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const MODEL_ALIASES: Record<string, string> = {
  "sonnet": DEFAULT_MODEL,
  "sonnet-1m": DEFAULT_MODEL,
  "opus": "claude-opus-5-5[1m]",
  "opus-1m": "claude-opus-5-5[1m]",
  // Explicit Opus id without the `[1m]` suffix.
  "opus-std": "claude-opus-5-5",
  "haiku": "claude-haiku-5-5",
  "fable": "claude-fable-5-1",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5 1M (fast, recommended)",
  "claude-opus-5-5[1m]": "Opus 5.5 1M (most capable Opus)",
  "claude-opus-5-5": "Opus 5.5 (no [1m] suffix)",
  "claude-haiku-5-5": "Haiku 5.5 1M (cheapest)",
  "claude-fable-5-1": "Fable 5.1 1M (most capable, priciest)",
  // Older ids: no longer offered, still labelled when a config uses them.
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-5[1m]": "Sonnet 5 1M",
  "claude-opus-5": "Opus 5",
  "claude-opus-5[1m]": "Opus 5 1M",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-8[1m]": "Opus 4.8 1M",
  "claude-haiku-4-5": "Haiku 4.5",
};

/** The models the pickers offer (`tomo init`, `tomo config`), default first. */
export const PICKER_MODELS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: DEFAULT_MODEL, label: "Claude Sonnet 5.5", hint: "1M context, fast — recommended" },
  { id: "claude-opus-5-5[1m]", label: "Claude Opus 5.5 1M", hint: "most capable Opus, 1M context" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "1M context, cheapest" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "most capable, 1M context, highest price" },
];

const DIRECT_MODEL_RE = /^[a-z0-9][a-z0-9._:-]*(?:\[[a-z0-9_-]+\])?$/i;
const LITELLM_PROVIDER_MODEL_RE = /^[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9._:/-]*(?:\[[a-z0-9_-]+\])?$/i;

export function isKnownClaudeModel(model: string): boolean {
  return Object.values(MODEL_ALIASES).includes(model);
}

export function isLiteLlmProviderModel(model: string): boolean {
  return LITELLM_PROVIDER_MODEL_RE.test(model);
}

export function isDirectModelName(model: string): boolean {
  return DIRECT_MODEL_RE.test(model);
}

export function resolveModelName(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const alias = MODEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  if (isKnownClaudeModel(trimmed)) return trimmed;
  if (isLiteLlmProviderModel(trimmed)) return trimmed;
  if (isDirectModelName(trimmed)) return trimmed;

  return null;
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export function modelHelpText(): string {
  return [
    Object.keys(MODEL_ALIASES).join(", "),
    `any direct model ID like ${DEFAULT_MODEL}`,
    `or a LiteLLM provider/model name like ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`,
  ].join(", ");
}
