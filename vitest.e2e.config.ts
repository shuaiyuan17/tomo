import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  include: ["tests/e2e/*.e2e.ts"], testTimeout: 30_000, hookTimeout: 15_000,
  env: { TOMO_LOG_INLINE: "1", TOMO_LOG_FILE: "" },
} });
