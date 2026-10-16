import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL } from "./litellm.js";

/**
 * The 5.5 family, 1M context on by default.
 *
 * Evidence (Agent SDK 0.3.299): the model registry in the bundled Claude
 * Code binary gives Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1
 * `context: {window: 1e6, native_1m: true}`, and that binary handles the
 * `[1m]` tag in its own model lookup — it normalizes the id before the
 * registry lookup and checks the tag separately, e.g.
 * `_k(e){return eS(qe(e,{identity:!0}),e.endsWith("[1m]"))}`. (sdk.mjs's
 * `QT` stripper only feeds its blocked-model check.) sdk.mjs's alias list
 * includes `sonnet[1m]`, `opus[1m]` and `fable[1m]` but no `haiku[1m]`, so
 * Haiku 5.5 keeps its plain id; it is 1M natively either way.
 *
 * Because all four are natively 1M, an id without the tag has the same
 * context; there are no separate "non-1M" aliases. Any other direct model
 * id (an older `claude-sonnet-5[1m]`, `claude-opus-4-8`, …) is still accepted
 * by resolveModelName, so existing configs keep working.
 */
export const DEFAULT_MODEL = "claude-opus-5-5[1m]";

export const MODEL_ALIASES: Record<string, string> = {
  "opus": DEFAULT_MODEL,
  "opus-1m": DEFAULT_MODEL,
  "sonnet": "claude-sonnet-5-5[1m]",
  "sonnet-1m": "claude-sonnet-5-5[1m]",
  "haiku": "claude-haiku-5-5",
  "fable": "claude-fable-5-1[1m]",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5[1m]": "Opus 5.5 1M (default)",
  "claude-opus-5-5": "Opus 5.5 (1M; no [1m] tag)",
  "claude-sonnet-5-5[1m]": "Sonnet 5.5 1M (fast)",
  "claude-sonnet-5-5": "Sonnet 5.5 (1M; no [1m] tag)",
  "claude-haiku-5-5": "Haiku 5.5 1M (cheapest)",
  "claude-fable-5-1[1m]": "Fable 5.1 1M (most capable, priciest)",
  "claude-fable-5-1": "Fable 5.1 (1M; no [1m] tag)",
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
  { id: DEFAULT_MODEL, label: "Claude Opus 5.5 1M", hint: "1M context — recommended" },
  { id: "claude-sonnet-5-5[1m]", label: "Claude Sonnet 5.5 1M", hint: "1M context, faster and cheaper" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "1M context, cheapest" },
  { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1 1M", hint: "most capable, highest price" },
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
