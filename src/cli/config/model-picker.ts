import * as p from "@clack/prompts";
import { isLiteLlmProviderModel, resolveModelName } from "../../models.js";
import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL } from "../../litellm.js";
import { loadConfig, modelLabel, MODELS } from "./shared.js";

const CUSTOM_MODEL = "__custom_model__";

export async function promptForModel(message: string, current?: string): Promise<string | null> {
  // Direct model IDs can be passed through immediately. LiteLLM provider/model
  // names still need a configured gateway; without one the SDK would send them
  // straight to Anthropic and fail.
  const cfg = loadConfig();
  const gatewayConfigured = Boolean((cfg.litellm as { baseUrl?: string } | undefined)?.baseUrl);
  const seenModelValues = new Set<string>();

  const options = [
    ...Object.entries(MODELS)
      .filter(([, full]) => {
        if (seenModelValues.has(full)) return false;
        seenModelValues.add(full);
        return true;
      })
      .map(([short, full]) => ({
        value: full,
        label: `${short} — ${modelLabel(full)}`,
        hint: full === current ? "current" : undefined,
      })),
    ...(gatewayConfigured
      ? [
          {
            value: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
            label: `ChatGPT subscription — ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`,
            hint: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL === current ? "current" : "via LiteLLM",
          },
          {
            value: CUSTOM_MODEL,
            label: "Custom model ID",
            hint: `e.g. claude-sonnet-5 or ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`,
          },
        ]
      : [
          {
            value: CUSTOM_MODEL,
            label: "Custom model ID",
            hint: "e.g. claude-sonnet-5",
          },
        ]),
  ];

  const choice = await p.select({ message, options });

  if (p.isCancel(choice)) return null;
  if (choice !== CUSTOM_MODEL) return choice as string;

  const custom = await p.text({
    message: "Model ID",
    placeholder: gatewayConfigured ? CHATGPT_SUBSCRIPTION_DEFAULT_MODEL : "claude-sonnet-5",
    validate: (value) => {
      const resolved = resolveModelName(String(value ?? ""));
      if (!resolved) {
        return `Use a Claude alias/model or a LiteLLM provider/model name like ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}.`;
      }
      if (isLiteLlmProviderModel(resolved) && !gatewayConfigured) {
        return "LiteLLM provider/model names need a configured LiteLLM gateway.";
      }
      return undefined;
    },
  });

  if (p.isCancel(custom)) return null;
  return resolveModelName(custom as string);
}
