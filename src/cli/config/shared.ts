import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_ALIASES, modelLabel } from "../../models.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../../fs-utils.js";
import { defaultRuntimePaths } from "../../runtime-paths.js";
import { threeWayMerge, withConfigLockSync } from "../../config-file.js";

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

/** What each object `loadConfig` returned looked like on disk, so a later
 *  `saveConfig` can merge only the fields the editor actually changed. */
const loadedSnapshots = new WeakMap<object, string>();

/** Throws {@link ConfigReadError} when the file exists but is unreadable. */
export function loadConfig(): Record<string, unknown> {
  const cfg = readConfigFile(CONFIG_PATH) ?? {};
  loadedSnapshots.set(cfg, JSON.stringify(cfg));
  return cfg;
}

/**
 * Neither this nor {@link loadConfig} takes a path override, deliberately.
 * An earlier revision let tests pass a temp path, which meant the test
 * isolated only on a build that had the parameter — run against one without
 * it, the same test wrote the developer's real ~/.tomo/config.json. That
 * happened. Tests isolate by $HOME instead (see
 * tests/cli-config-write-guard.test.ts), which holds on every revision;
 * removing the parameter makes the old mistake a compile error.
 */
export function saveConfig(cfg: Record<string, unknown>): void {
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
  //
  // LOST UPDATES. `tomo config` is long-lived and the daemon writes the same
  // file (group activation, /model, owner-session adoption moving a model
  // override). Writing `cfg` whole would revert whatever the daemon wrote
  // since this menu loaded. So: take the shared config lock, re-read, and
  // write a field-level three-way merge of (what we loaded, what we want,
  // what is there now). `cfg` is then updated in place to what was written,
  // so the menu's next save merges against the right base.
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  withConfigLockSync(CONFIG_PATH, () => {
    const theirs = readConfigFile(CONFIG_PATH) ?? {};
    const snapshot = loadedSnapshots.get(cfg);
    const base = snapshot === undefined ? {} : JSON.parse(snapshot) as Record<string, unknown>;
    const merged = threeWayMerge(base, cfg, theirs) as Record<string, unknown>;
    backupFileIfExistsSync(CONFIG_PATH, CONFIG_BACKUP_PATH, { mode: 0o600 });
    writeJsonAtomicSync(CONFIG_PATH, merged, { mode: 0o600 });
    for (const key of Object.keys(cfg)) if (!(key in merged)) delete cfg[key];
    Object.assign(cfg, JSON.parse(JSON.stringify(merged)) as Record<string, unknown>);
    loadedSnapshots.set(cfg, JSON.stringify(merged));
  });
}

/**
 * Rotate `path` into `backupPath` only if it currently parses.
 *
 * `backupFileIfExistsSync` is content-blind, so calling it directly on a
 * config that has gone bad replaces the one good backup with the broken file
 * — which is what made the damage in this issue unrecoverable after a second
 * write. Callers that intend to overwrite regardless (`tomo init --force`)
 * want to skip the rotation, not abort, so this reports rather than throws.
 *
 * Returns true when a backup was taken.
 */
export function backupConfigIfParseableSync(path: string, backupPath: string): boolean {
  try {
    if (readConfigFile(path) === undefined) return false; // nothing there yet
  } catch {
    return false; // unparseable: keep whatever backup already exists
  }
  backupFileIfExistsSync(path, backupPath, { mode: 0o600 });
  return true;
}

export { modelLabel };
