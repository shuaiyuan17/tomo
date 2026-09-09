import { configDefaults, defineConfig } from "vitest/config";

/**
 * Deliberately minimal: everything but `env` and one `exclude` entry is
 * vitest's default.
 */
export default defineConfig({
  test: {
    // An agent's isolated worktree lives INSIDE the repo (`.claude/worktrees/
    // <agent>/`) and carries a full copy of tests/. Left behind, it makes vitest
    // run every suite twice, and the suites that pin a fixed tmp path
    // (cron-store, rollup-cooldown, status-cron) then race each other and fail
    // nondeterministically — which looked like flakiness for two days.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
    env: {
      // Tell src/logger.ts to log through an in-process destination instead of
      // building a pino transport. A transport is a worker thread plus a
      // `process.on("exit")` hook, and this module is evaluated once per test
      // file inside one worker process — past ten files that is a
      // MaxListenersExceededWarning and a hundred-odd threads.
      //
      // The variable is the PROJECT's, set here rather than read off vitest's
      // own `VITEST`: what the daemon does with its logs should not be
      // decided by a name the test runner owns and can rename, and which any
      // process is free to export.
      TOMO_LOG_INLINE: "1",
    },
  },
});
