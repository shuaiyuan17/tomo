import * as p from "@clack/prompts";
import { resolveModelName } from "../../models.js";
import { modelLabel, MODELS } from "./shared.js";

const CUSTOM_MODEL = "__custom_model__";

export async function promptForModel(message: string, current?: string): Promise<string | null> {
  const choice = await p.select({
    message,
    options: [
      ...Object.entries(MODELS).map(([short, full]) => ({
        value: full,
        label: `${short} — ${modelLabel(full)}`,
        hint: full === current ? "current" : undefined,
      })),
      {
        value: CUSTOM_MODEL,
        label: "Custom LiteLLM model",
        hint: "e.g. chatgpt/gpt-5.3-codex",
      },
    ],
  });

  if (p.isCancel(choice)) return null;
  if (choice !== CUSTOM_MODEL) return choice as string;

  const custom = await p.text({
    message: "LiteLLM model name",
    placeholder: "chatgpt/gpt-5.3-codex",
    validate: (value) => {
      if (resolveModelName(String(value ?? ""))) return undefined;
      return "Use a Claude alias/model or a LiteLLM provider/model name like chatgpt/gpt-5.3-codex.";
    },
  });

  if (p.isCancel(custom)) return null;
  return resolveModelName(custom as string);
}
