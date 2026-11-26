import { configDefaults, defineConfig } from "vitest/config";

/**
 * The UI gallery (`npm run web:gallery`): screenshots of every web UI surface and state, not a
 * test. Kept out of `npm test` (its files are not `*.test.ts`) and `npm run test:e2e` (not
 * `tests/e2e/*.e2e.ts`). Run through `scripts/ui-gallery.mjs`, which also writes the contact sheet.
 */
export default defineConfig({ test: {
  include: ["tests/gallery/*.gallery.ts"],
  exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  // One viewport-and-theme pass per test; each boots the real stack and drives its own Chromium.
  testTimeout: 300_000, hookTimeout: 60_000,
  fileParallelism: false,
  // A temp HOME per file (and for every process it starts): see tests/setup/isolate-home.ts.
  setupFiles: ["./tests/setup/isolate-home.ts"],
  env: { TOMO_LOG_INLINE: "1", TOMO_LOG_FILE: "" },
} });
