import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// HOME is stubbed before src/config.js is imported: it reads ~/.tomo/config.json at import.
let home = "";

async function loadConfigWith(file: Record<string, unknown>): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-todos-"));
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

describe("todos config", () => {
  it("defaults every limit", async () => {
    const { config, DEFAULT_TODOS } = await loadConfigWith({});
    expect(config.todos).toEqual(DEFAULT_TODOS);
    expect(DEFAULT_TODOS).toEqual({
      maxOpen: 30, maxSnoozes: 3, titleMaxChars: 120, nextMaxChars: 200,
      reviewDaysSelf: 3, reviewDaysWaiting: 7, maxReviewDays: 90, dueMax: 3,
    });
  });

  it("takes overrides and drops only a bad field", async () => {
    const { config, configIssues } = await loadConfigWith({ todos: { maxOpen: 50, maxSnoozes: "lots", dueMax: 5 } });
    expect(config.todos.maxOpen).toBe(50);
    expect(config.todos.dueMax).toBe(5);
    expect(config.todos.maxSnoozes).toBe(3);
    expect(configIssues.join("\n")).toContain("todos.maxSnoozes");
  });
});
