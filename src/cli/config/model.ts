import * as p from "@clack/prompts";
import { loadConfig, saveConfig, modelLabel } from "./shared.js";
import { promptForModel } from "./model-picker.js";

export async function configModel(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.model as string) ?? "claude-sonnet-4-6[1m]";
  p.log.info(`Current default: ${modelLabel(current)}`);

  const choice = await promptForModel("Select default model", current);
  if (!choice) return;

  cfg.model = choice;
  saveConfig(cfg);
  p.log.success(`Default model set to ${modelLabel(choice)}`);
}
