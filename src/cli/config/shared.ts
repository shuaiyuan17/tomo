import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const TOMO_HOME = join(homedir(), ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");
export const SESSIONS_DIR = join(TOMO_HOME, "data", "sessions");
export const LOG_PATH = join(TOMO_HOME, "logs", "tomo.log");

export const MODELS: Record<string, string> = {
  "sonnet": "claude-sonnet-4-6",
  "sonnet-1m": "claude-sonnet-4-6[1m]",
  "opus": "claude-opus-4-7",
  "opus-1m": "claude-opus-4-7[1m]",
  "haiku": "claude-haiku-4-5",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6 (fast)",
  "claude-sonnet-4-6[1m]": "Sonnet 4.6 1M (fast, Max Plan only)",
  "claude-opus-4-7": "Opus 4.7 (most capable)",
  "claude-opus-4-7[1m]": "Opus 4.7 1M (most capable, Max Plan only)",
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
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}
