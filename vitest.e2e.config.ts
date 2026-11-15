import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  include: ["tests/e2e/*.e2e.ts"], testTimeout: 30_000, hookTimeout: 15_000,
  // One file at a time. Each file drives its own Chromium, and the Home files render WebGL on a
  // software rasteriser that takes every core; run side by side they starve the chat tests' timing.
  fileParallelism: false,
  env: { TOMO_LOG_INLINE: "1", TOMO_LOG_FILE: "" },
} });
