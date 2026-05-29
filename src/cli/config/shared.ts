import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const TOMO_HOME = join(homedir(), ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");
export const CONFIG_BACKUP_PATH = join(TOMO_HOME, "config.json.bak");
export const SESSIONS_DIR = join(TOMO_HOME, "data", "sessions");
export const LOG_PATH = join(TOMO_HOME, "logs", "tomo.log");

export const MODELS: Record<string, string> = {
  "sonnet": "claude-sonnet-4-6",
  "opus": "claude-opus-4-8",
  "haiku": "claude-haiku-4-5",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6 (fast)",
  "claude-opus-4-8": "Opus 4.8 (most capable)",
  "claude-haiku-4-5": "Haiku 4.5 (cheapest)",
};

export function loadConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Record<string, unknown>): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH);
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}
