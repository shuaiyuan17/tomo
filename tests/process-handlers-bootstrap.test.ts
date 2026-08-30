import { describe, it, expect, vi } from "vitest";

/**
 * The bootstrap handlers exist for the window BEFORE pino is loaded: a throw
 * while logger.ts initialises (an unwritable TOMO_LOG_FILE directory fails its
 * module-level mkdirSync) must still die with a marker. That only holds if
 * importing process-handlers.ts does not itself import logger.ts — which it
 * used to, statically, so the "bootstrap" install ran after pino anyway.
 */
describe("installBootstrapErrorHandlers", () => {
  it("can be imported and installed without loading logger.ts", async () => {
    vi.resetModules();
    vi.doMock("../src/logger.js", () => { throw new Error("logger.ts was loaded before the bootstrap handlers"); });
    try {
      const mod = await import("../src/process-handlers.js");
      const uninstall = mod.installBootstrapErrorHandlers();
      expect(process.listenerCount("uncaughtException")).toBeGreaterThanOrEqual(1);
      uninstall();
    } finally {
      vi.doUnmock("../src/logger.js");
      vi.resetModules();
    }
  });
});
