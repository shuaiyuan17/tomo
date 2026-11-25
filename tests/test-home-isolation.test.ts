import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
// Static on purpose: this is how almost every test reaches these paths, so it is
// the case the setup file has to win — it runs before this import is evaluated.
import { defaultRuntimePaths } from "../src/runtime-paths.js";
import { restartHelperDisabled } from "../src/restart-request.js";

// The guard for tests/setup/isolate-home.ts. If the setup file is dropped from
// vitest.config.ts, every one of these fails: the defaults resolve to the
// account's real home again, where a running daemon keeps its state.

const realHome = userInfo().homedir;
// Where a running daemon (and Claude Code) keep their state. Checked rather than
// "anything under the real home", which a TMPDIR inside it would trip.
const realState = [join(realHome, ".tomo"), join(realHome, ".claude")];

/** The path with its nearest existing ancestor resolved (it may not exist yet). */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolved(parent), basename(path));
  }
}
const inside = (dir: string, path: string) => {
  const rel = relative(resolved(dir), resolved(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const inRealState = (path: string) => realState.some((dir) => inside(dir, path));

describe("tests never see the real home", () => {
  it("homedir() is a throwaway directory, not the account's home", () => {
    expect(homedir()).not.toBe(realHome);
    expect(inside(fileURLToPath(new URL("../node_modules/.cache", import.meta.url)), homedir())).toBe(true);
    expect(inside(tmpdir(), homedir()), "a group sandbox can read the temp dir").toBe(false);
    expect(resolved(homedir())).not.toBe(resolved(realHome));
  });

  it("every default runtime path resolves under the temp home", () => {
    const { homeDir, tomoHome, configPath, restartReasonFile, workspaceDir, sessionsDir, logsDir, sdkSessionsDir, pidFile } =
      defaultRuntimePaths;
    expect(homeDir).toBe(homedir());
    for (const path of [tomoHome, configPath, restartReasonFile, workspaceDir, sessionsDir, logsDir, sdkSessionsDir, pidFile]) {
      expect(inside(homedir(), path), path).toBe(true);
      expect(inRealState(path), path).toBe(false);
    }
  });

  it("drops the overrides and session identity a daemon's shell would pass down", () => {
    for (const name of ["TOMO_WORKSPACE", "SESSIONS_DIR", "TOMO_SESSION_KEY", "TOMO_DAEMON_PID"]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it("switches the real restart helper off", () => {
    expect(restartHelperDisabled()).toBe(true);
  });
});
