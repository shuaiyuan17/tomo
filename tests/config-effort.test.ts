import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// HOME is stubbed before src/config.js is imported: it reads ~/.tomo/config.json at import.
let home = "";

async function loadConfigWith(file: Record<string, unknown>): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-effort-"));
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

describe("effort config", () => {
  it("is unset by default, leaving the level to the SDK", async () => {
    const { config, configIssues } = await loadConfigWith({});
    expect(config.effort).toBeNull();
    expect(config.sessionEffortOverrides).toEqual({});
    expect(configIssues.join("\n")).not.toContain("effort");
  });

  it("accepts every level the SDK accepts", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const { config, configIssues } = await loadConfigWith({ effort: level });
      expect(config.effort).toBe(level);
      expect(configIssues.join("\n")).not.toContain("effort");
    }
  });

  it("reports an invalid level instead of dropping it silently", async () => {
    const { config, configIssues } = await loadConfigWith({ effort: "ultra" });
    expect(config.effort).toBeNull();
    expect(configIssues.join("\n")).toMatch(/^effort: /m);
  });

  it("reads per-session overrides and rejects a bad level in them", async () => {
    const ok = await loadConfigWith({ sessionEffortOverrides: { "dm:owner": "low" } });
    expect(ok.config.sessionEffortOverrides).toEqual({ "dm:owner": "low" });

    const bad = await loadConfigWith({ sessionEffortOverrides: { "dm:owner": "turbo" } });
    expect(bad.config.sessionEffortOverrides).toEqual({});
    expect(bad.configIssues.join("\n")).toContain("sessionEffortOverrides");
  });
});
