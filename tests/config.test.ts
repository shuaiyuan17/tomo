import { afterEach, describe, expect, it, vi } from "vitest";

async function loadContinuityIntervalMs(value: string): Promise<number> {
  vi.resetModules();
  vi.stubEnv("TOMO_CONTINUITY_INTERVAL_MINUTES", value);
  const { config } = await import("../src/config.js");
  return config.continuityIntervalMs;
}

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("clamps continuity intervals to at least one minute", async () => {
    await expect(loadContinuityIntervalMs("0.001")).resolves.toBe(60_000);
  });

  it("parses fractional continuity intervals above the minimum", async () => {
    await expect(loadContinuityIntervalMs("2.5")).resolves.toBe(150_000);
  });
});
