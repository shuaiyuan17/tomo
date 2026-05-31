export const MODEL_ALIASES: Record<string, string> = {
  "sonnet": "claude-sonnet-4-6",
  "sonnet-1m": "claude-sonnet-4-6[1m]",
  "opus": "claude-opus-4-8",
  "opus-1m": "claude-opus-4-8[1m]",
  "haiku": "claude-haiku-4-5",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6 (fast)",
  "claude-sonnet-4-6[1m]": "Sonnet 4.6 1M (fast, long context)",
  "claude-opus-4-8": "Opus 4.8 (most capable)",
  "claude-opus-4-8[1m]": "Opus 4.8 1M (most capable, long context)",
  "claude-haiku-4-5": "Haiku 4.5 (cheapest)",
};

const LITELLM_PROVIDER_MODEL_RE = /^[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9._:/-]*(?:\[[a-z0-9_-]+\])?$/i;

export function isKnownClaudeModel(model: string): boolean {
  return Object.values(MODEL_ALIASES).includes(model);
}

export function isLiteLlmProviderModel(model: string): boolean {
  return LITELLM_PROVIDER_MODEL_RE.test(model);
}

export function resolveModelName(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const alias = MODEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  if (isKnownClaudeModel(trimmed)) return trimmed;
  if (isLiteLlmProviderModel(trimmed)) return trimmed;

  return null;
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export function modelHelpText(): string {
  return [
    Object.keys(MODEL_ALIASES).join(", "),
    "or a LiteLLM provider/model name like chatgpt/gpt-5.3-codex",
  ].join(", ");
}
