import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The metrics block carries two privacy-relevant switches whose defaults are
 * `true`. A whole-object fallback on one bad field silently re-enables them,
 * so each field has to stand or fall on its own.
 *
 * HOME is stubbed to a scratch dir before src/config.js is imported — the
 * module resolves ~/.tomo/config.json at import time, and nothing here may
 * read the developer's real home.
 */
let home = "";

async function loadConfigWith(file: Record<string, unknown>): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-metrics-"));
  mkdirSync(join(home, ".tomo"), { recursive: true });
  writeFileSync(join(home, ".tomo", "config.json"), JSON.stringify(file));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  vi.stubEnv("TOMO_METRICS", undefined as unknown as string);
  vi.stubEnv("TOMO_METRICS_PORT", undefined as unknown as string);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("metrics config validation", () => {
  it("keeps the other metrics fields when one field is invalid", async () => {
    const { config, configIssues } = await loadConfigWith({
      metrics: { enabled: true, port: "not-a-port", activityLog: true, includeMessageText: false },
    });

    // The whole-object fallback used to reset these to DEFAULT_METRICS, which
    // has includeMessageText: true — transcript text into activity.ndjson for
    // a user who explicitly opted out.
    expect(config.metrics.includeMessageText).toBe(false);
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.activityLog).toBe(true);
    // Only the bad field falls back, and it is still reported.
    expect(config.metrics.port).toBe(9464);
    expect(configIssues.join("\n")).toContain("metrics.port");
  });

  it("still reports a metrics block that is not an object and uses defaults", async () => {
    const { config, configIssues } = await loadConfigWith({ metrics: "yes" });
    expect(configIssues.join("\n")).toContain("metrics:");
    expect(config.metrics).toEqual({
      enabled: false, port: 9464, activityLog: true, includeMessageText: true,
    });
  });

  it("parses a fully valid metrics block with no issues", async () => {
    const { config, configIssues } = await loadConfigWith({
      metrics: { enabled: true, port: 9999, activityLog: false, includeMessageText: false },
    });
    expect(configIssues).toEqual([]);
    expect(config.metrics).toEqual({
      enabled: true, port: 9999, activityLog: false, includeMessageText: false,
    });
  });
});
