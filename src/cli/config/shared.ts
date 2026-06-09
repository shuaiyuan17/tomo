import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MODEL_ALIASES, modelLabel } from "../../models.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../../fs-utils.js";

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
  backupFileIfExistsSync(CONFIG_PATH, CONFIG_BACKUP_PATH);
  writeJsonAtomicSync(CONFIG_PATH, cfg);
}

export { modelLabel };
