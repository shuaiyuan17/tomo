import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";

const prompts = vi.hoisted(() => ({ confirm: vi.fn(), warn: vi.fn() }));
vi.mock("@clack/prompts", () => ({ confirm: prompts.confirm, isCancel: (value: unknown) => typeof value === "symbol", log: { warn: prompts.warn } }));
const home = mkdtempSync(join(tmpdir(), "tomo-config-concurrency-"));
vi.stubEnv("HOME", home); vi.resetModules();
const { CONFIG_PATH, loadConfig, saveConfigInteractive, ConfigSaveCancelled } = await import("../src/cli/config/shared.js");
if (!CONFIG_PATH.startsWith(home + "/")) throw new Error("Refusing to write outside isolated home");
const read = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const write = (value: unknown) => writeFileSync(CONFIG_PATH, JSON.stringify(value));
beforeEach(() => { mkdirSync(join(home, ".tomo"), { recursive: true }); prompts.confirm.mockReset(); prompts.warn.mockReset();
  write({ model: "before", sessionModelOverrides: { "dm:owner": "old" }, auth: { apiKey: "synthetic-secret" } });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it("keeps a draft across a collision and preserves concurrent per-session edits after confirmation", async () => {
  const cfg = loadConfig(); const overrides = cfg.sessionModelOverrides as Record<string, string>;
  overrides["dm:owner"] = "draft";
  write({ ...read(), model: "phone-model", sessionModelOverrides: { "dm:owner": "old", "dm:peer": "peer-model" } });
  prompts.confirm.mockResolvedValue(true);
  await saveConfigInteractive(cfg);
  expect(read()).toMatchObject({ model: "phone-model", sessionModelOverrides: { "dm:owner": "draft", "dm:peer": "peer-model" } });
  expect(cfg.sessionModelOverrides).toBe(overrides);
  overrides["dm:owner"] = "second-draft"; await saveConfigInteractive(cfg);
  expect(read().sessionModelOverrides["dm:peer"]).toBe("peer-model");
  expect(JSON.stringify(prompts.warn.mock.calls)).not.toContain("synthetic-secret");
});
it("requires a decision for overlapping changes and keeps edits until explicitly discarded", async () => {
  const cfg = loadConfig(); cfg.model = "draft"; write({ ...read(), model: "concurrent" });
  prompts.confirm.mockImplementation(async () => { expect(cfg.model).toBe("draft"); return false; });
  await expect(saveConfigInteractive(cfg)).rejects.toBeInstanceOf(ConfigSaveCancelled);
  expect(read().model).toBe("concurrent"); expect(cfg.model).toBe("draft");
  expect(prompts.warn.mock.calls.flat().join(" ")).toContain("Both editors changed: model");
});
it("rechecks revisions after the conflict prompt before saving", async () => {
  const cfg = loadConfig(); cfg.model = "draft"; write({ ...read(), city: "first concurrent value" });
  prompts.confirm.mockImplementationOnce(async () => { write({ ...read(), city: "newer value" }); return true; }).mockResolvedValue(true);
  await saveConfigInteractive(cfg);
  expect(read()).toMatchObject({ model: "draft", city: "newer value" }); expect(prompts.confirm).toHaveBeenCalledTimes(2);
});
it("waits briefly on a held config lock and offers retry without losing the draft", async () => {
  const cfg = loadConfig(); cfg.model = "draft";
  const lock = CONFIG_PATH + ".lock"; mkdirSync(lock);
  writeFileSync(join(lock, "owner.test"), JSON.stringify({ pid: process.pid, ts: Date.now(), host: hostname() }));
  prompts.confirm.mockImplementation(async () => { rmSync(lock, { recursive: true }); return true; });
  const start = Date.now(); await saveConfigInteractive(cfg);
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  expect(read().model).toBe("draft"); expect(prompts.confirm).toHaveBeenCalledOnce();
});
