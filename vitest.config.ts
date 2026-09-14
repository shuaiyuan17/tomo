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
      // Blank the daemon's log file for the run. A test started from a shell
      // the daemon spawned (an agent's, a cron's) inherits the launchd
      // TOMO_LOG_FILE, and the inline destination honours it, so every test
      // file's records landed in the production tomo.log: fake-clock
      // timestamps, "tick failed" warnings from fixtures, test paths that
      // later read as real events. logger.ts treats blank as unset; the
      // redaction tests that need a file still set one with vi.stubEnv.
      TOMO_LOG_FILE: "",
    },
  },
});
