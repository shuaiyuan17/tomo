/**
 * The 5.5 family plus Fable 5.2, all natively 1M: ids carry no `[1m]` tag.
 *
 * Evidence (Agent SDK 0.3.332): the model registry in the bundled Claude
 * Code binary gives Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 and Fable 5.2
 * `context: {window: 1e6, native_1m: true}` (Fable 5.2: max_output 128000,
 * fallback_3p claude-fable-5-1). A native-1M model has the same context with
 * or without the tag, so the tag is dropped everywhere tomo names a model.
 *
 * Older configs, sub-session records and cron entries may still hold a tagged
 * id (`claude-opus-5-5[1m]`). resolveModelName still accepts it and returns
 * the untagged id (see normalizeModelId); modelLabel labels it the same.
 * Nothing rewrites the config file. Any other direct model id (an older
 * `claude-sonnet-5[1m]`, `claude-opus-4-8`, …) is still accepted as is.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

export const MODEL_ALIASES: Record<string, string> = {
  "opus": DEFAULT_MODEL,
  // The -1m aliases stay so `/model opus-1m` and stored aliases keep working;
  // every model here is 1M already.
  "opus-1m": DEFAULT_MODEL,
  "sonnet": "claude-sonnet-5-5",
  "sonnet-1m": "claude-sonnet-5-5",
  "haiku": "claude-haiku-5-5",
  "fable": "claude-fable-5-2",
};

/** Natively 1M models: a `[1m]` tag on these ids changes nothing and is dropped. */
const NATIVE_1M_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5 (default)",
  "claude-sonnet-5-5": "Sonnet 5.5 (fast)",
  "claude-haiku-5-5": "Haiku 5.5 (cheapest)",
  "claude-fable-5-2": "Fable 5.2 (most capable, priciest)",
  // Older ids: no longer offered, still labelled when a config uses them.
  "claude-fable-5-1": "Fable 5.1 (older)",
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
  { id: DEFAULT_MODEL, label: "Claude Opus 5.5", hint: "1M context — recommended" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "1M context, faster and cheaper" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "1M context, cheapest" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", hint: "1M context, most capable, highest price" },
];

/**
 * The untagged id of a natively 1M model written with a `[1m]` tag
 * (`claude-opus-5-5[1m]` → `claude-opus-5-5`, any case of the tag); any other
 * string is returned unchanged. Older models whose tag did change the context
 * (`claude-sonnet-5[1m]`) keep it.
 */
export function normalizeModelId(model: string): string {
  const match = /^(.*)\[1m\]$/i.exec(model);
  return match && NATIVE_1M_MODELS.has(match[1]) ? match[1] : model;
}

/**
 * The full id a stored model name stands for: a tomo alias resolved
 * (`opus-1m` → `claude-opus-5-5`), a redundant `[1m]` dropped; anything
 * resolveModelName refuses is returned unchanged.
 */
export function canonicalModelId(model: string): string {
  return resolveModelName(model) ?? model;
}

/** Whether two stored model names (aliases or ids) name the same model. */
export function sameModel(a: string, b: string): boolean {
  return canonicalModelId(a) === canonicalModelId(b);
}

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
  if (isDirectModelName(trimmed)) return normalizeModelId(trimmed);

  return null;
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? MODEL_LABELS[normalizeModelId(model)] ?? model;
}
