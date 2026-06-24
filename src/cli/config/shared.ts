import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_ALIASES, modelLabel } from "../../models.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../../fs-utils.js";
import { defaultRuntimePaths } from "../../runtime-paths.js";

const paths = defaultRuntimePaths;
export const TOMO_HOME = paths.tomoHome;
export const CONFIG_PATH = paths.configPath;
export const CONFIG_BACKUP_PATH = paths.configBackupPath;
export const SESSIONS_DIR = paths.sessionsDir;
export const SDK_SESSIONS_DIR = paths.sdkSessionsDir;
export const LOG_PATH = join(paths.logsDir, "tomo.log");

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
  backupFileIfExistsSync(CONFIG_PATH, CONFIG_BACKUP_PATH, { mode: 0o600 });
  writeJsonAtomicSync(CONFIG_PATH, cfg, { mode: 0o600 });
}

export { modelLabel };
