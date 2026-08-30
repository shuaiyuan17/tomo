import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `FOO=` is how a shell, a launchd plist or a `.env` file blanks a variable
 * out. It must not beat the config file: `process.env.FOO ?? file.foo` only
 * falls through on undefined, so an empty string used to win and silently
 * disable a configured setting.
 *
 * Every module under test derives its paths from $HOME, so HOME is stubbed to
 * a scratch directory before src/config.js is imported — nothing here reads or
 * writes the developer's real ~/.tomo.
 */
let home = "";

async function loadConfigWith(
  file: Record<string, unknown>,
  env: Record<string, string>,
): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-env-"));
  mkdirSync(join(home, ".tomo"), { recursive: true });
  writeFileSync(join(home, ".tomo", "config.json"), JSON.stringify(file));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  // Neutralize anything the ambient environment happens to set.
  for (const name of [
    "TELEGRAM_BOT_TOKEN", "CLAUDE_MODEL", "TOMO_CITY",
    "TOMO_LITELLM_BASE_URL", "TOMO_LITELLM_API_KEY", "TOMO_LITELLM_MODE",
    "TOMO_CONTINUITY_SCRIPT",
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("empty-string env overrides", () => {
  it("keeps the configured Telegram token when TELEGRAM_BOT_TOKEN is empty", async () => {
    const { config } = await loadConfigWith(
      { channels: { telegram: { token: "file-token", allowlist: ["1"] } } },
      { TELEGRAM_BOT_TOKEN: "" },
    );
    expect(config.telegramToken).toBe("file-token");
  });

  it("still lets a non-empty TELEGRAM_BOT_TOKEN override the file", async () => {
    const { config } = await loadConfigWith(
      { channels: { telegram: { token: "file-token", allowlist: ["1"] } } },
      { TELEGRAM_BOT_TOKEN: "env-token" },
    );
    expect(config.telegramToken).toBe("env-token");
  });

  it("keeps the configured LiteLLM gateway when TOMO_LITELLM_BASE_URL is empty", async () => {
    const { config } = await loadConfigWith(
      { litellm: { baseUrl: "http://127.0.0.1:4000", apiKey: "sk-file" } },
      { TOMO_LITELLM_BASE_URL: "", TOMO_LITELLM_API_KEY: "" },
    );
    // An empty base URL used to return null here: the daemon silently started
    // against the wrong backend, with no configIssues entry to explain it.
    expect(config.litellm).not.toBeNull();
    expect(config.litellm?.baseUrl).toBe("http://127.0.0.1:4000");
    expect(config.litellm?.apiKey).toBe("sk-file");
  });

  it("keeps the configured model when CLAUDE_MODEL is empty", async () => {
    const { config, configIssues } = await loadConfigWith(
      { model: "claude-sonnet-5" },
      { CLAUDE_MODEL: "" },
    );
    expect(config.model).toBe("claude-sonnet-5");
    expect(configIssues.join("\n")).not.toContain("model");
  });

  it("keeps the configured city when TOMO_CITY is empty", async () => {
    const { config } = await loadConfigWith({ city: "Brooklyn" }, { TOMO_CITY: "" });
    expect(config.city).toBe("Brooklyn");
  });

  it("keeps the configured continuity script when TOMO_CONTINUITY_SCRIPT is empty", async () => {
    const { config } = await loadConfigWith(
      { continuityScript: { path: "/tmp/continuity.sh" } },
      { TOMO_CONTINUITY_SCRIPT: "" },
    );
    expect(config.continuityScript?.path).toBe("/tmp/continuity.sh");
  });
});
