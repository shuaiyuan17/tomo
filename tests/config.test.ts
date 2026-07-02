import { afterEach, describe, expect, it, vi } from "vitest";

async function loadContinuityIntervalMs(value: string): Promise<number> {
  vi.resetModules();
  vi.stubEnv("TOMO_CONTINUITY_INTERVAL_MINUTES", value);
  const { config } = await import("../src/config.js");
  return config.continuityIntervalMs;
}

async function loadLiveSessionTimeoutMs(value: string): Promise<number> {
  vi.resetModules();
  vi.stubEnv("TOMO_LIVE_SESSION_TIMEOUT_MS", value);
  const { config } = await import("../src/config.js");
  return config.liveSessionTimeoutMs;
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

  it("falls back to defaults on non-numeric numeric env vars", async () => {
    vi.resetModules();
    vi.stubEnv("HISTORY_LIMIT", "abc");
    vi.stubEnv("TOMO_MAX_TURNS", "not-a-number");
    vi.stubEnv("IMESSAGE_WEBHOOK_PORT", "");
    const { config } = await import("../src/config.js");
    expect(config.historyLimit).toBe(20);
    expect(config.maxTurns).toBe(50);
    expect(config.imessageWebhookPort).toBe(3100);
  });

  it("parses valid numeric env vars", async () => {
    vi.resetModules();
    vi.stubEnv("HISTORY_LIMIT", "5");
    vi.stubEnv("TOMO_MAX_TURNS", "75");
    const { config } = await import("../src/config.js");
    expect(config.historyLimit).toBe(5);
    expect(config.maxTurns).toBe(75);
  });

  it("clamps continuity intervals to at least one minute", async () => {
    await expect(loadContinuityIntervalMs("0.001")).resolves.toBe(60_000);
  });

  it("parses fractional continuity intervals above the minimum", async () => {
    await expect(loadContinuityIntervalMs("2.5")).resolves.toBe(150_000);
  });

  it("parses live session timeout from the environment", async () => {
    await expect(loadLiveSessionTimeoutMs("2500")).resolves.toBe(2500);
  });

  it("falls back to the default live session timeout for invalid values", async () => {
    await expect(loadLiveSessionTimeoutMs("0")).resolves.toBe(10 * 60 * 1000);
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
