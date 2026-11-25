import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

/**
 * A hermetic loader for src/config.js.
 *
 * config.ts reads ~/.tomo/config.json and the environment at IMPORT time, so
 * each load is: a fresh scratch HOME, `vi.resetModules()`, then a dynamic
 * import. Everything the module reads from the ambient shell is cleared first,
 * so a developer's real ~/.tomo, a daemon-spawned shell's TOMO_WORKSPACE, or a
 * stray `HISTORY_LIMIT=` cannot change what a test sees:
 *
 * - every TOMO_*, IMESSAGE_* and IMSG_* variable (but the two logger
 *   switches vitest.config.ts sets), plus the few unprefixed
 *   names config.ts reads (HISTORY_LIMIT, CLAUDE_MODEL, TELEGRAM_BOT_TOKEN,
 *   SESSIONS_DIR);
 * - every OTHER variable that is set but blank, because config.ts records a
 *   blank override it ignored and the registry assertions would then depend on
 *   the runner's shell.
 *
 * `configLoader()` registers its own `afterEach`, which unstubs the env, resets
 * the module registry and removes EVERY home it made (a test may load more
 * than once). Call it at the top level of a file or inside a `describe`.
 */
const UNPREFIXED_CONFIG_ENV = ["HISTORY_LIMIT", "CLAUDE_MODEL", "TELEGRAM_BOT_TOKEN", "SESSIONS_DIR"];
/**
 * Set for the whole run by vitest.config.ts so src/logger.ts logs in-process
 * and never into the daemon's tomo.log; clearing them would rebuild a pino
 * transport (a worker thread and an exit hook) on every load.
 */
const KEPT_FROM_VITEST_CONFIG = ["TOMO_LOG_INLINE", "TOMO_LOG_FILE"];

export type ConfigModule = typeof import("../../src/config.js");

export interface ConfigLoader {
  /**
   * Load src/config.js against a fresh home. `file` is written to
   * ~/.tomo/config.json (a string verbatim, anything else as JSON); leave it
   * undefined for no file at all. `env` is applied after the ambient env is
   * cleared.
   */
  load(file?: unknown, env?: Record<string, string>): Promise<ConfigModule>;
  /** The home of the most recent load. */
  home(): string;
}

export function configLoader(prefix = "tomo-config-"): ConfigLoader {
  const homes: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  return {
    async load(file, env = {}) {
      const home = mkdtempSync(join(tmpdir(), prefix));
      homes.push(home);
      mkdirSync(join(home, ".tomo"), { recursive: true });
      if (file !== undefined) {
        writeFileSync(join(home, ".tomo", "config.json"), typeof file === "string" ? file : JSON.stringify(file));
      }
      vi.resetModules();
      vi.stubEnv("HOME", home);
      for (const [name, value] of Object.entries(process.env)) {
        if (name === "HOME" || value === undefined || KEPT_FROM_VITEST_CONFIG.includes(name)) continue;
        const read = /^(TOMO_|IMESSAGE_|IMSG_)/.test(name) || UNPREFIXED_CONFIG_ENV.includes(name);
        if (read || value.trim() === "") vi.stubEnv(name, undefined as unknown as string);
      }
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      return import("../../src/config.js");
    },
    home() {
      const home = homes.at(-1);
      if (!home) throw new Error("configLoader: nothing loaded yet");
      return home;
    },
  };
}
