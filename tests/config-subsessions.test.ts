import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// HOME is stubbed before src/config.js is imported: it reads ~/.tomo/config.json at import.
let home = "";

async function loadConfigWith(file: Record<string, unknown>): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-subsessions-"));
  mkdirSync(join(home, ".tomo"), { recursive: true });
  writeFileSync(join(home, ".tomo", "config.json"), JSON.stringify(file));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("subsessions config", () => {
  it("is on by default, with the design's defaults", async () => {
    const { config, DEFAULT_SUBSESSIONS } = await loadConfigWith({});
    expect(config.subsessions).toEqual(DEFAULT_SUBSESSIONS);
    expect(config.subsessions.enabled).toBe(true);
    expect(DEFAULT_SUBSESSIONS).toEqual({ enabled: true, maxRunning: 2, maxOpen: 5, maxTurns: 200, maxContextTokens: 500_000, defaultModel: null, maxActiveHours: 24 });
  });

  it("can be turned off, and takes a wall-clock cap (0 = none)", async () => {
    const { config, configIssues } = await loadConfigWith({ subsessions: { enabled: false, maxActiveHours: 0 } });
    expect(config.subsessions).toMatchObject({ enabled: false, maxActiveHours: 0 });
    expect(configIssues.join("\n")).not.toContain("subsessions");
    const bad = await loadConfigWith({ subsessions: { maxActiveHours: -1 } });
    expect(bad.config.subsessions.maxActiveHours).toBe(24);
    expect(bad.configIssues.join("\n")).toContain("subsessions.maxActiveHours");
  });

  it("takes overrides and drops only a bad field", async () => {
    const { config, configIssues } = await loadConfigWith({ subsessions: { enabled: true, maxRunning: 0, defaultModel: "sonnet" } });
    expect(config.subsessions).toMatchObject({ enabled: true, maxRunning: 2, defaultModel: "sonnet" });
    expect(configIssues.join("\n")).toContain("subsessions.maxRunning");
  });

  it("keeps sub-sessions off LCM compaction (the harness sends /compact)", async () => {
    await loadConfigWith({});
    const { usesLcmCompact } = await import("../src/agent/sdk-options.js");
    expect(usesLcmCompact("task:s1")).toBe(false);
    expect(usesLcmCompact("dm:owner")).toBe(true);
  });
});
