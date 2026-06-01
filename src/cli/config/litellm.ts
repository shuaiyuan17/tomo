import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./shared.js";
import { resolveModelName } from "../../models.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  CHATGPT_SUBSCRIPTION_MODE,
  DEFAULT_LITELLM_API_KEY,
  DEFAULT_LITELLM_BASE_URL,
  DEFAULT_LITELLM_MODE,
  isChatGptSubscriptionModel,
  liteLlmModeLabel,
  parseLiteLlmMode,
  type LiteLlmMode,
} from "../../litellm.js";

interface RawLiteLlmConfig {
  mode?: string;
  baseUrl?: string;
  apiKey?: string;
}

export async function configLiteLlm(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.litellm ?? null) as RawLiteLlmConfig | null;
  const currentMode = parseLiteLlmMode(current?.mode);

  p.log.info([
    `Status:  ${current?.baseUrl ? "enabled" : "disabled"}`,
    `Mode:    ${current?.baseUrl ? liteLlmModeLabel(currentMode) : "(none)"}`,
    `Base URL: ${current?.baseUrl ?? "(none)"}`,
    `API key:  ${current?.apiKey ? "(set)" : "(none)"}`,
  ].join("\n"));

  const action = await p.select({
    message: "LiteLLM gateway",
    options: [
      {
        value: CHATGPT_SUBSCRIPTION_MODE,
        label: "ChatGPT subscription",
        hint: current?.baseUrl && currentMode === CHATGPT_SUBSCRIPTION_MODE ? "current" : "OpenAI login via LiteLLM",
      },
      {
        value: DEFAULT_LITELLM_MODE,
        label: "Custom Anthropic-compatible proxy",
        hint: current?.baseUrl && currentMode === DEFAULT_LITELLM_MODE ? "current" : "advanced",
      },
      { value: "disable", label: "Disable gateway" },
      { value: "back", label: "Back" },
    ],
  });

  if (p.isCancel(action) || action === "back") return;

  if (action === "disable") {
    delete cfg.litellm;
    saveConfig(cfg);
    p.log.success("LiteLLM gateway disabled");
    return;
  }

  const mode = action as LiteLlmMode;
  if (mode === CHATGPT_SUBSCRIPTION_MODE) {
    p.log.message([
      "ChatGPT subscription mode keeps Claude Agent SDK as the agent runtime.",
      "It expects a local LiteLLM proxy serving Anthropic /v1/messages with a chatgpt/* model.",
      "Use a LiteLLM config with model_info.mode=responses, litellm_settings.drop_params=true, and CHATGPT_DEFAULT_INSTRUCTIONS set to a neutral sentence.",
    ].join("\n"));
  }

  const baseUrl = await p.text({
    message: "LiteLLM proxy base URL",
    placeholder: DEFAULT_LITELLM_BASE_URL,
    defaultValue: current?.baseUrl ?? DEFAULT_LITELLM_BASE_URL,
    validate: (value) => {
      const text = String(value ?? "").trim();
      if (!text) return "Base URL is required.";
      if (!/^https?:\/\//i.test(text)) return "Use an http:// or https:// URL.";
      return undefined;
    },
  });
  if (p.isCancel(baseUrl)) return;

  const apiKey = await p.password({
    message: current?.apiKey
      ? "LiteLLM proxy API key (leave blank to keep existing)"
      : `LiteLLM proxy API key (default: ${DEFAULT_LITELLM_API_KEY})`,
  });
  if (p.isCancel(apiKey)) return;

  let chatGptModel: string | null = null;
  if (mode === CHATGPT_SUBSCRIPTION_MODE) {
    const currentModel = String(cfg.model ?? "");
    const model = await p.text({
      message: "ChatGPT model",
      placeholder: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
      defaultValue: isChatGptSubscriptionModel(currentModel) ? currentModel : CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
      validate: (value) => {
        const resolved = resolveModelName(String(value ?? ""));
        if (resolved && isChatGptSubscriptionModel(resolved)) return undefined;
        return `Use a chatgpt/... LiteLLM model name, e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}.`;
      },
    });
    if (p.isCancel(model)) return;
    chatGptModel = resolveModelName(String(model)) ?? CHATGPT_SUBSCRIPTION_DEFAULT_MODEL;

    const setDefault = await p.confirm({
      message: `Set default model to ${chatGptModel}?`,
      initialValue: true,
    });
    if (p.isCancel(setDefault)) return;
    if (setDefault) {
      cfg.model = chatGptModel;
    }
  }

  const nextKey = String(apiKey).trim() || current?.apiKey || DEFAULT_LITELLM_API_KEY;
  cfg.litellm = {
    mode,
    baseUrl: String(baseUrl).trim(),
    apiKey: nextKey,
  };
  saveConfig(cfg);
  p.log.success(
    mode === CHATGPT_SUBSCRIPTION_MODE && chatGptModel
      ? `ChatGPT subscription gateway saved with ${chatGptModel}. Restart tomo for the daemon to use it.`
      : "LiteLLM gateway saved. Restart tomo for the daemon to use it.",
  );
}
