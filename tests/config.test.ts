import { afterEach, describe, expect, it, vi } from "vitest";

async function loadContinuityIntervalMs(value: string): Promise<number> {
  vi.resetModules();
  vi.stubEnv("TOMO_CONTINUITY_INTERVAL_MINUTES", value);
  const { config } = await import("../src/config.js");
  return config.continuityIntervalMs;
}

async function loadWorkspacePaths(workspaceDir: string): Promise<{
  workspaceDir: string;
  sdkSessionsDir: string;
}> {
  vi.resetModules();
  vi.stubEnv("TOMO_WORKSPACE", workspaceDir);
  const { config } = await import("../src/config.js");
  return {
    workspaceDir: config.workspaceDir,
    sdkSessionsDir: config.sdkSessionsDir,
  };
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

  it("derives SDK session storage from TOMO_WORKSPACE", async () => {
    await expect(loadWorkspacePaths("/tmp/custom-tomo.workspace")).resolves.toEqual({
      workspaceDir: "/tmp/custom-tomo.workspace",
      sdkSessionsDir: expect.stringMatching(/\/\.claude\/projects\/-tmp-custom-tomo-workspace$/),
    });
  });

  it("normalizes a relative TOMO_WORKSPACE once for every consumer", async () => {
    await expect(loadWorkspacePaths("relative-workspace/")).resolves.toEqual({
      workspaceDir: expect.stringMatching(/\/relative-workspace$/),
      sdkSessionsDir: expect.stringMatching(/\/\.claude\/projects\/.*-relative-workspace$/),
    });
  });
});
