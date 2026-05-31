import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MODEL_ALIASES, modelLabel } from "../../models.js";

export const TOMO_HOME = join(homedir(), ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");
export const CONFIG_BACKUP_PATH = join(TOMO_HOME, "config.json.bak");
export const SESSIONS_DIR = join(TOMO_HOME, "data", "sessions");
export const LOG_PATH = join(TOMO_HOME, "logs", "tomo.log");

export const MODELS = MODEL_ALIASES;

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

export { modelLabel };
