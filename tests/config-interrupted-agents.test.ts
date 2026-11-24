import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// HOME is stubbed before src/config.js is imported: it reads ~/.tomo/config.json at import.
let home = "";

async function loadConfigWith(file: Record<string, unknown>, env: Record<string, string> = {}): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-interrupted-"));
  mkdirSync(join(home, ".tomo"), { recursive: true });
  writeFileSync(join(home, ".tomo", "config.json"), JSON.stringify(file));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  vi.stubEnv("TOMO_INTERRUPTED_AGENTS", "");
  vi.stubEnv("TOMO_INTERRUPTED_AGENTS_AUTO_RESUME", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("interruptedAgents config", () => {
  it("defaults to on, with auto-resume on", async () => {
    const { config } = await loadConfigWith({});
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([true, true]);
  });

  it("keeps the plain boolean form", async () => {
    const { config, configIssues } = await loadConfigWith({ interruptedAgents: false });
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([false, true]);
    expect(configIssues).toEqual([]);
  });

  it("reads the object form", async () => {
    const { config, configIssues } = await loadConfigWith({ interruptedAgents: { autoResume: false } });
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([true, false]);
    expect(configIssues).toEqual([]);
    const off = await loadConfigWith({ interruptedAgents: { enabled: false } });
    expect(off.config.interruptedAgents).toBe(false);
  });

  it("an env var overrides the file", async () => {
    const { config } = await loadConfigWith({ interruptedAgents: { autoResume: true } }, { TOMO_INTERRUPTED_AGENTS_AUTO_RESUME: "false" });
    expect(config.interruptedAgentsAutoResume).toBe(false);
  });
});
