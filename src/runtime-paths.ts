import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimePaths {
  homeDir: string;
  tomoHome: string;
  configPath: string;
  configBackupPath: string;
  restartReasonFile: string;
  pidFile: string;
  workspaceDir: string;
  sessionsDir: string;
  logsDir: string;
  sdkSessionsDir: string;
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

export function createRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const homeDir = resolve(options.homeDir ?? homedir());
  const tomoHome = resolve(options.tomoHome ?? join(homeDir, ".tomo"));
  const workspaceDir = resolve(
    options.workspaceDir ?? env.TOMO_WORKSPACE ?? join(tomoHome, "workspace"),
  );
  const sessionsDir = resolve(
    options.sessionsDir ?? env.SESSIONS_DIR ?? join(tomoHome, "data", "sessions"),
  );
  const logsDir = resolve(options.logsDir ?? join(tomoHome, "logs"));

  return {
    homeDir,
    tomoHome,
    configPath: join(tomoHome, "config.json"),
    configBackupPath: join(tomoHome, "config.json.bak"),
    restartReasonFile: join(tomoHome, "data", ".restart-reason"),
    pidFile: join(tomoHome, "tomo.pid"),
    workspaceDir,
    sessionsDir,
    logsDir,
    sdkSessionsDir: sdkSessionsDirForWorkspace(workspaceDir, homeDir),
  };
}

export const defaultRuntimePaths = createRuntimePaths();
