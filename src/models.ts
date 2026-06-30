import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL } from "./litellm.js";

export const DEFAULT_MODEL = "claude-sonnet-5";

export const MODEL_ALIASES: Record<string, string> = {
  "sonnet": DEFAULT_MODEL,
  "sonnet-1m": DEFAULT_MODEL,
  "opus": "claude-opus-4-8",
  "opus-1m": "claude-opus-4-8[1m]",
  "haiku": "claude-haiku-4-5",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-5": "Sonnet 5 (fast, 1M context)",
  "claude-opus-4-8": "Opus 4.8 (most capable)",
  "claude-opus-4-8[1m]": "Opus 4.8 1M (most capable, long context)",
  "claude-haiku-4-5": "Haiku 4.5 (cheapest)",
};

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
