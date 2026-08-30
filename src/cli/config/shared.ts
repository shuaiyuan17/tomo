import { mkdirSync, readFileSync } from "node:fs";
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

/**
 * The config file exists but could not be turned into an object. Carries the
 * underlying error as `cause` so callers can show the syntax error (or the
 * errno) that a user has to fix by hand.
 */
export class ConfigReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`config file could not be read: ${path}`, { cause });
    this.name = "ConfigReadError";
    this.path = path;
  }
}

/**
 * Read the config, or return undefined when there is no file at all.
 *
 * Absent is a normal state (a fresh install has no config); anything else —
 * EACCES, EIO, a trailing comma left by a hand-edit — is a failure, not
 * emptiness. Reading a failure as `{}` is what made every `configXxx()` a
 * read-modify-write that persisted a config containing only the key just
 * edited, silently destroying the bot token, allowlists, identities,
 * groupSecret, mcpServers, plugins and auth — while printing success.
 */
function readConfigFile(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigReadError(path, err);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigReadError(path, err);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigReadError(path, new Error("config root is not a JSON object"));
  }
  return data as Record<string, unknown>;
}

/** Throws {@link ConfigReadError} when the file exists but is unreadable. */
export function loadConfig(path = CONFIG_PATH): Record<string, unknown> {
  return readConfigFile(path) ?? {};
}

export function saveConfig(
  cfg: Record<string, unknown>,
  path = CONFIG_PATH,
  backupPath = CONFIG_BACKUP_PATH,
): void {
  // Re-check the file at write time, not just at load time. Two reasons, and
  // both are data loss:
  //  - the backup is a copy of THIS file, so rotating it from a file we
  //    cannot parse would replace a good `.bak` with a broken one — the
  //    second save is what makes the damage unrecoverable;
  //  - the caller assembled `cfg` from whatever load returned, so writing it
  //    over content we never understood publishes a config with the missing
  //    keys gone.
  // The file can also have been hand-edited between load and save (the config
  // UI is a long-lived interactive session), so the load-time check alone is
  // not enough.
  readConfigFile(path);
  mkdirSync(dirname(path), { recursive: true });
  backupFileIfExistsSync(path, backupPath, { mode: 0o600 });
  writeJsonAtomicSync(path, cfg, { mode: 0o600 });
}

export { modelLabel };
