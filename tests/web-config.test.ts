import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warning = vi.hoisted(() => vi.fn());
vi.mock("../src/logger.js", () => ({ log: { warn: warning, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
let root = "";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (root) rmSync(root, { recursive: true, force: true }); });
it("logs invalid optional web configuration without making it a startup blocker or exposing its value", async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-config-"));
  mkdirSync(join(root, ".tomo"));
  writeFileSync(join(root, ".tomo", "config.json"), JSON.stringify({ web: { port: "private-invalid-value" } }));
  vi.stubEnv("HOME", root); vi.stubEnv("TOMO_HOME", join(root, ".tomo")); vi.stubEnv("TOMO_WORKSPACE", join(root, "workspace"));
  const { config, configIssues } = await import("../src/config.js");
  expect(config.web.enabled).toBe(false);
  expect(configIssues.some((issue) => issue.includes("web."))).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("Invalid web settings"));
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-invalid-value");
});
