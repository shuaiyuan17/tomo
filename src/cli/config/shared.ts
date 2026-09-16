import { join } from "node:path";
import { MODEL_ALIASES, modelLabel } from "../../models.js";
import { ConfigStore } from "../../config/store.js";
import { defaultRuntimePaths } from "../../runtime-paths.js";

const paths = defaultRuntimePaths;
export const TOMO_HOME = paths.tomoHome;
export const CONFIG_PATH = paths.configPath;
export const CONFIG_BACKUP_PATH = paths.configBackupPath;
export const SESSIONS_DIR = paths.sessionsDir;
export const SDK_SESSIONS_DIR = paths.sdkSessionsDir;
export const LOG_PATH = join(paths.logsDir, "tomo.log");

export const MODELS = MODEL_ALIASES;

const store = new ConfigStore(CONFIG_PATH, CONFIG_BACKUP_PATH);
const revisions = new WeakMap<Record<string, unknown>, string>();
export function loadConfig(): Record<string, unknown> {
  const { value, revision } = store.read(); revisions.set(value, revision); return value;
}
export function saveConfig(cfg: Record<string, unknown>): void {
  const result = store.update(() => cfg, revisions.get(cfg)); revisions.set(cfg, result.revision);
}
export { ConfigReadError, backupConfigIfParseableSync } from "../../config/store.js";
export { modelLabel };
