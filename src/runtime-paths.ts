import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimePaths {
  homeDir: string;
  tomoHome: string;
  configPath: string;
  configBackupPath: string;
  restartReasonFile: string;
  pidFile: string;
  watchSocketPath: string;
  workspaceDir: string;
  sessionsDir: string;
  logsDir: string;
  sdkSessionsDir: string;
  /** Env overrides (`TOMO_WORKSPACE`, `SESSIONS_DIR`) that were set but blank,
   *  and so ignored. config.ts folds these into `ignoredEnvOverrideNames` so
   *  the startup notice names them alongside its own. */
  ignoredEnvOverrides: readonly string[];
}

export interface RuntimePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tomoHome?: string;
  workspaceDir?: string;
  sessionsDir?: string;
  logsDir?: string;
}

/**
 * Claude stores project sessions under ~/.claude/projects using an encoded
 * workspace path. Keep that derivation in one place so every Tomo
 * feature reads and rewrites the same SDK JSONL files.
 */
export function sdkSessionsDirForWorkspace(workspaceDir: string, homeDir = homedir()): string {
  const encodedWorkspace = resolve(workspaceDir).replace(/[/.]/g, "-");
  return join(homeDir, ".claude", "projects", encodedWorkspace);
}

/**
 * An env override that is set but blank is not an override.
 *
 * Same rule as `envVar()` in config.ts, duplicated because config.ts imports
 * this module and the dependency cannot go the other way. It matters more
 * here than anywhere else: `resolve("")` is the *current working directory*,
 * so `TOMO_WORKSPACE=` (or `TOMO_WORKSPACE=$TYPO`) would silently make
 * whatever directory the daemon happened to be launched from the workspace —
 * and with it `sdkSessionsDir`, which is derived from the workspace path.
 */
function envOverride(env: NodeJS.ProcessEnv, name: string, ignored: string[]): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    ignored.push(name);
    return undefined;
  }
  return value;
}

export function createRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const ignoredEnvOverrides: string[] = [];
  const homeDir = resolve(options.homeDir ?? homedir());
  const tomoHome = resolve(options.tomoHome ?? join(homeDir, ".tomo"));
  const workspaceDir = resolve(
    options.workspaceDir ?? envOverride(env, "TOMO_WORKSPACE", ignoredEnvOverrides) ?? join(tomoHome, "workspace"),
  );
  const sessionsDir = resolve(
    options.sessionsDir ?? envOverride(env, "SESSIONS_DIR", ignoredEnvOverrides) ?? join(tomoHome, "data", "sessions"),
  );
  const logsDir = resolve(options.logsDir ?? join(tomoHome, "logs"));

  return {
    homeDir,
    tomoHome,
    configPath: join(tomoHome, "config.json"),
    configBackupPath: join(tomoHome, "config.json.bak"),
    restartReasonFile: join(tomoHome, "data", ".restart-reason"),
    pidFile: join(tomoHome, "tomo.pid"),
    watchSocketPath: join(tomoHome, "watch.sock"),
    workspaceDir,
    sessionsDir,
    logsDir,
    sdkSessionsDir: sdkSessionsDirForWorkspace(workspaceDir, homeDir),
    ignoredEnvOverrides,
  };
}

export const defaultRuntimePaths = createRuntimePaths();
