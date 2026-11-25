import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWebConfig } from "../src/web/config.js";

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

it("defaults to loopback port 9465 and degrades invalid optional config without reflecting values", () => {
  expect(parseWebConfig(undefined)).toEqual({ enabled: true, port: 9465 });
  expect(parseWebConfig({ enabled: false, port: 9876 })).toEqual({ enabled: false, port: 9876 });
  const diagnostic = vi.fn();
  expect(parseWebConfig({ port: "secret-value" }, diagnostic).enabled).toBe(false);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret-value");
  expect(diagnostic).toHaveBeenCalledOnce();
});

it("accepts only an exact HTTPS Serve origin in optional configuration", () => {
  expect(parseWebConfig({ externalOrigin: "https://test-node.test-tailnet.ts.net" }).enabled).toBe(true);
  for (const externalOrigin of ["http://test-node.test-tailnet.ts.net", "https://*.ts.net", "https://example.com", "https://test-node.test-tailnet.ts.net/", "https://test-node.test-tailnet.ts.net/path", "https://user@test-node.test-tailnet.ts.net"]) {
    expect(parseWebConfig({ externalOrigin }).enabled).toBe(false);
  }
});
