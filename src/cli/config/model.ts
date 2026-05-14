import * as p from "@clack/prompts";
import { loadConfig, saveConfig, modelLabel, MODELS } from "./shared.js";

export async function configModel(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.model as string) ?? "claude-sonnet-4-6";
  p.log.info(`Current default: ${modelLabel(current)}`);

  const choice = await p.select({
    message: "Select default model",
    options: Object.entries(MODELS).map(([short, full]) => ({
      value: full,
      label: `${short} — ${modelLabel(full)}`,
      hint: full === current ? "current" : undefined,
    })),
  });

  if (p.isCancel(choice)) return;

  cfg.model = choice;
  saveConfig(cfg);
  p.log.success(`Default model set to ${modelLabel(choice as string)}`);
}
