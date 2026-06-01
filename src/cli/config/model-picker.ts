import * as p from "@clack/prompts";
import { resolveModelName } from "../../models.js";
import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL } from "../../litellm.js";
import { loadConfig, modelLabel, MODELS } from "./shared.js";

const CUSTOM_MODEL = "__custom_model__";

export async function promptForModel(message: string, current?: string): Promise<string | null> {
  // LiteLLM provider/model names only work when a gateway is configured to
  // route them; without one the SDK would send them straight to Anthropic and
  // fail, so only offer them when a gateway exists.
  const cfg = loadConfig();
  const gatewayConfigured = Boolean((cfg.litellm as { baseUrl?: string } | undefined)?.baseUrl);

  const options = [
    ...Object.entries(MODELS).map(([short, full]) => ({
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
            label: "Custom LiteLLM model",
            hint: `e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`,
          },
        ]
      : []),
  ];

  const choice = await p.select({ message, options });

  if (p.isCancel(choice)) return null;
  if (choice !== CUSTOM_MODEL) return choice as string;

  const custom = await p.text({
    message: "LiteLLM model name",
    placeholder: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
    validate: (value) => {
      if (resolveModelName(String(value ?? ""))) return undefined;
      return `Use a Claude alias/model or a LiteLLM provider/model name like ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}.`;
    },
  });

  if (p.isCancel(custom)) return null;
  return resolveModelName(custom as string);
}
