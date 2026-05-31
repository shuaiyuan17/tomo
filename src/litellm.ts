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

export function liteLlmModeLabel(mode: LiteLlmMode): string {
  return mode === CHATGPT_SUBSCRIPTION_MODE
    ? "ChatGPT subscription"
    : "Anthropic-compatible proxy";
}

export function isChatGptSubscriptionModel(model: string): boolean {
  return /^chatgpt\//i.test(model.trim());
}

