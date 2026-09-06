import { defineConfig } from "vitest/config";

/**
 * Deliberately minimal: everything but `env` is vitest's default, so adding
 * this file changed nothing about which tests run or how.
 */
export default defineConfig({
  test: {
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
