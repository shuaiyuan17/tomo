import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("falls back to defaults on non-numeric numeric env vars and reports them", async () => {
    vi.resetModules();
    vi.stubEnv("HISTORY_LIMIT", "abc");
    vi.stubEnv("TOMO_MAX_TURNS", "not-a-number");
    vi.stubEnv("IMESSAGE_WEBHOOK_PORT", "");
    const { config, configIssues, assertConfigValid } = await import("../src/config.js");
    expect(config.historyLimit).toBe(20);
    expect(config.maxTurns).toBe(50);
    expect(config.imessageWebhookPort).toBe(3100);

    // The fallbacks are no longer silent: each bad value is reported and the
    // daemon refuses to start. An empty env var counts as unset, not invalid.
    expect(configIssues.join("\n")).toContain("HISTORY_LIMIT");
    expect(configIssues.join("\n")).toContain("TOMO_MAX_TURNS");
    expect(configIssues.join("\n")).not.toContain("IMESSAGE_WEBHOOK_PORT");
    expect(() => assertConfigValid()).toThrow(/HISTORY_LIMIT/);
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

describe("config file validation", () => {
  let home = "";

  async function loadWithConfigFile(content: string): Promise<typeof import("../src/config.js")> {
    home = join(tmpdir(), `tomo-config-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(home, ".tomo"), { recursive: true });
    writeFileSync(join(home, ".tomo", "config.json"), content);
    vi.resetModules();
    vi.stubEnv("HOME", home);
    return import("../src/config.js");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("parses a valid config file with no issues", async () => {
    const { config, configIssues, assertConfigValid } = await loadWithConfigFile(JSON.stringify({
      model: "claude-sonnet-5",
      maxTurns: 75,
      steering: "false",
      showThinking: "yes",
      channels: {
        telegram: { token: "tg-token", allowlist: [12345, "-100999"] },
      },
      identities: [{ name: "Alice", channels: { telegram: "12345" } }],
      lcm: { nudgeAtPct: 85 },
      groupSecret: "open-sesame",
    }));

    expect(configIssues).toEqual([]);
    expect(() => assertConfigValid()).not.toThrow();
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.maxTurns).toBe(75);
    expect(config.steering).toBe(false);
    expect(config.showThinking).toBe(true);
    expect(config.telegramToken).toBe("tg-token");
    // Chat ids written as JSON numbers are normalized to strings.
    expect(config.channelAllowlists).toEqual({ telegram: ["12345", "-100999"] });
    expect(config.identities).toEqual([
      { name: "Alice", channels: { telegram: "12345" }, replyPolicy: "last-active" },
    ]);
    expect(config.lcm).toMatchObject({ nudgeAtPct: 85, nudgeResetPct: 60 });
    expect(config.groupSecret).toBe("open-sesame");
  });

  // Thinking is HIDDEN by default: the outbound scaffold filter strips a
  // leaked "思考:" preamble unless this is turned on (see scaffold-filter.ts).
  it("hides thinking by default and lets TOMO_SHOW_THINKING turn it on", async () => {
    const { config } = await loadWithConfigFile(JSON.stringify({ channels: { telegram: { token: "t" } } }));
    expect(config.showThinking).toBe(false);

    vi.stubEnv("TOMO_SHOW_THINKING", "true");
    const withEnv = await loadWithConfigFile(JSON.stringify({ channels: { telegram: { token: "t" } } }));
    expect(withEnv.config.showThinking).toBe(true);
    expect(withEnv.configIssues).toEqual([]);
  });

  it("records an issue for a non-boolean showThinking and falls back to hidden", async () => {
    const { config, configIssues } = await loadWithConfigFile(
      JSON.stringify({ showThinking: "maybe", channels: { telegram: { token: "t" } } }),
    );
    expect(config.showThinking).toBe(false);
    expect(configIssues.some((i) => i.startsWith("showThinking (TOMO_SHOW_THINKING)"))).toBe(true);
  });

  it("reports invalid values, falls back to defaults, and refuses startup", async () => {
    const { config, configIssues, assertConfigValid } = await loadWithConfigFile(JSON.stringify({
      maxTurns: "plenty",
      groupSecret: 42,
      saveInboundImages: "sometimes",
      lcm: { nudgeAtPct: 500 },
      sessionModelOverrides: { "dm:alice": 7 },
    }));

    expect(config.maxTurns).toBe(50);
    expect(config.groupSecret).toBeNull();
    expect(config.saveInboundImages).toBe(true);
    expect(config.lcm).toMatchObject({ nudgeAtPct: 70, nudgeResetPct: 60 });
    expect(config.sessionModelOverrides).toEqual({});

    const report = configIssues.join("\n");
    expect(report).toContain("maxTurns");
    expect(report).toContain("groupSecret");
    expect(report).toContain("saveInboundImages");
    expect(report).toContain("lcm");
    expect(report).toContain("sessionModelOverrides");
    expect(() => assertConfigValid()).toThrow(/Invalid Tomo configuration/);
  });

  it("derives the lcm reset threshold when only nudgeAtPct is customized", async () => {
    // nudgeAtPct below the stock reset (60): reset derives to nudgeAtPct - 10.
    const low = await loadWithConfigFile(JSON.stringify({ lcm: { nudgeAtPct: 50 } }));
    expect(low.configIssues).toEqual([]);
    expect(low.config.lcm).toMatchObject({ nudgeAtPct: 50, nudgeResetPct: 40 });

    // nudgeAtPct above the stock reset: the stock reset still applies.
    rmSync(home, { recursive: true, force: true });
    const high = await loadWithConfigFile(JSON.stringify({ lcm: { nudgeAtPct: 85 } }));
    expect(high.configIssues).toEqual([]);
    expect(high.config.lcm).toMatchObject({ nudgeAtPct: 85, nudgeResetPct: 60 });
  });

  it("rejects an explicitly conflicting lcm reset threshold", async () => {
    const { config, configIssues } = await loadWithConfigFile(JSON.stringify({
      lcm: { nudgeAtPct: 50, nudgeResetPct: 60 },
    }));

    expect(config.lcm).toMatchObject({ nudgeAtPct: 70, nudgeResetPct: 60 });
    expect(configIssues.join("\n")).toContain("nudgeResetPct must be below nudgeAtPct");
  });

  it("drops only the invalid identity entries and reports each one", async () => {
    const { config, configIssues } = await loadWithConfigFile(JSON.stringify({
      identities: [
        { name: "Alice", channels: { telegram: 12345 } },
        { channels: { telegram: "222" } },
        { name: "", channels: { telegram: "333" } },
      ],
    }));

    expect(config.identities).toEqual([
      { name: "Alice", channels: { telegram: "12345" }, replyPolicy: "last-active" },
    ]);
    expect(configIssues.join("\n")).toContain("identities[1]");
    expect(configIssues.join("\n")).toContain("identities[2]");
  });

  it("reports malformed JSON instead of silently ignoring the file", async () => {
    const { config, configIssues, assertConfigValid } = await loadWithConfigFile("{ this is not json");

    expect(config.maxTurns).toBe(50);
    expect(configIssues.join("\n")).toContain("not valid JSON");
    expect(() => assertConfigValid()).toThrow(/not valid JSON/);
  });

  it("rejects a config file whose root is not an object", async () => {
    const { configIssues } = await loadWithConfigFile(JSON.stringify(["not", "an", "object"]));

    expect(configIssues.join("\n")).toContain("must contain a JSON object");
  });
});
