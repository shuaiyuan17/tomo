export const LITELLM_MODE_VALUES = ["anthropic-compatible", "chatgpt-subscription"] as const;
export type LiteLlmMode = typeof LITELLM_MODE_VALUES[number];

export const DEFAULT_LITELLM_MODE: LiteLlmMode = "anthropic-compatible";
export const CHATGPT_SUBSCRIPTION_MODE: LiteLlmMode = "chatgpt-subscription";
export const CHATGPT_SUBSCRIPTION_DEFAULT_MODEL = "chatgpt/gpt-5.5";
export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000";
export const DEFAULT_LITELLM_API_KEY = "sk-tomo-local";

export function parseLiteLlmMode(raw: unknown): LiteLlmMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "chatgpt" || value === "chatgpt-subscription" || value === "openai-subscription") {
    return CHATGPT_SUBSCRIPTION_MODE;
  }
  return DEFAULT_LITELLM_MODE;
}

export function inferLiteLlmMode(raw: unknown, defaultModel: string): LiteLlmMode {
  const explicit = String(raw ?? "").trim();
  if (explicit) return parseLiteLlmMode(explicit);
  return isChatGptSubscriptionModel(defaultModel) ? CHATGPT_SUBSCRIPTION_MODE : DEFAULT_LITELLM_MODE;
}

export function liteLlmModeLabel(mode: LiteLlmMode): string {
  return mode === CHATGPT_SUBSCRIPTION_MODE
    ? "ChatGPT subscription"
    : "Anthropic-compatible proxy";
}

export function isChatGptSubscriptionModel(model: string): boolean {
  return /^chatgpt\//i.test(model.trim());
}

/**
 * Whether a session running `model` actually routes through the LiteLLM gateway.
 * Mirrors the SDK's env-wiring decision (see buildSdkEnv in agent/sdk-options.ts):
 * a generic anthropic-compatible proxy forwards every model, while a
 * chatgpt-subscription proxy only serves chatgpt/* models, so a Claude-model
 * session bypasses it and hits Anthropic directly. Shared so callers such as
 * /usage classify gateway routing the same way the SDK does, rather than the
 * coarse "is any gateway configured".
 */
export function litellmRoutesModel(
  litellm: { baseUrl?: string; mode?: LiteLlmMode } | undefined | null,
  model: string,
): boolean {
  if (!litellm?.baseUrl) return false;
  return litellm.mode !== CHATGPT_SUBSCRIPTION_MODE || isChatGptSubscriptionModel(model);
}
