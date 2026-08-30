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
/** Every scratch home this file made; a test may load the config more than once. */
const homes: string[] = [];

async function loadConfigWith(
  file: Record<string, unknown>,
  env: Record<string, string>,
): Promise<typeof import("../src/config.js")> {
  home = mkdtempSync(join(tmpdir(), "tomo-config-env-"));
  homes.push(home);
  mkdirSync(join(home, ".tomo"), { recursive: true });
  writeFileSync(join(home, ".tomo", "config.json"), JSON.stringify(file));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  // Neutralize anything the ambient environment happens to set, so the test is
  // hermetic under any shell. TOMO_WORKSPACE/SESSIONS_DIR are cleared rather
  // than pointed somewhere: these tests assert the ~/.tomo defaults.
  for (const name of [
    "TELEGRAM_BOT_TOKEN", "CLAUDE_MODEL", "TOMO_CITY",
    "TOMO_LITELLM_BASE_URL", "TOMO_LITELLM_API_KEY", "TOMO_LITELLM_MODE",
    "TOMO_CONTINUITY_SCRIPT", "TOMO_WORKSPACE", "SESSIONS_DIR",
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
  // Any OTHER blank variable in the ambient environment (`TOMO_METRICS=`,
  // `HISTORY_LIMIT=`, …) would be recorded as an ignored override too and make
  // the registry assertions below depend on the runner's shell. Clear them all.
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && value.trim() === "") vi.stubEnv(name, undefined as unknown as string);
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it("treats a whitespace-only TOMO_CONTINUITY_SCRIPT as unset too", async () => {
    // `FOO=" "` reaches the process as a non-empty string, but there is no
    // path in it — the old code trimmed it to "" and returned null, disabling
    // a configured script.
    const { config } = await loadConfigWith(
      { continuityScript: { path: "/tmp/continuity.sh" } },
      { TOMO_CONTINUITY_SCRIPT: "   " },
    );
    expect(config.continuityScript?.path).toBe("/tmp/continuity.sh");
  });

  it("keeps the configured LiteLLM mode when TOMO_LITELLM_MODE is empty", async () => {
    const { config } = await loadConfigWith(
      {
        model: "claude-sonnet-5",
        litellm: { baseUrl: "http://127.0.0.1:4000", mode: "chatgpt-subscription" },
      },
      { TOMO_LITELLM_MODE: "" },
    );
    // An empty mode used to fall through inferLiteLlmMode's "no explicit
    // value" branch, which infers from the model — silently routing a
    // chatgpt-subscription gateway as a generic anthropic-compatible proxy.
    expect(config.litellm?.mode).toBe("chatgpt-subscription");
  });

  it("records every blank override it ignored, for the startup log line", async () => {
    // Read defensively so a build without the export fails on the CONTENTS
    // (nothing was recorded) rather than on the destructuring.
    const ignoredEnvOverrideNames = (await loadConfigWith(
      { model: "claude-sonnet-5", city: "Brooklyn" },
      { CLAUDE_MODEL: "", TOMO_CITY: "   " },
    )).ignoredEnvOverrideNames ?? [];
    // The fallback is right, but it is invisible: no surface prints the
    // effective model, so the daemon logs these once at startup.
    expect([...ignoredEnvOverrideNames].sort()).toEqual(["CLAUDE_MODEL", "TOMO_CITY"]);
  });

  it("renders the startup notice naming every ignored variable, and nothing when there are none", async () => {
    // `tomo start` prints this on BOTH paths — as a log line on a good boot,
    // and after the error when a config assertion fails — so the wording is
    // pinned here rather than in start.ts, which has no test harness.
    const withBlanks = await loadConfigWith({ model: "claude-sonnet-5" }, { CLAUDE_MODEL: "", TOMO_CITY: "" });
    const notice = withBlanks.ignoredEnvOverridesNotice?.();
    expect(notice).toMatch(/^Ignoring blank environment overrides/);
    expect(notice).toContain("CLAUDE_MODEL");
    expect(notice).toContain("TOMO_CITY");

    const clean = await loadConfigWith({ model: "claude-sonnet-5" }, { CLAUDE_MODEL: "claude-opus-5" });
    expect(clean.ignoredEnvOverridesNotice?.()).toBeUndefined();
  });

  it("records nothing when the overrides are absent or genuinely set", async () => {
    const ignoredEnvOverrideNames = (await loadConfigWith(
      { model: "claude-sonnet-5" },
      { CLAUDE_MODEL: "claude-opus-5" },
    )).ignoredEnvOverrideNames ?? [];
    expect([...ignoredEnvOverrideNames]).toEqual([]);
    // ...and the override itself still applies.
  });
});

describe("empty-string env overrides for runtime paths", () => {
  it("keeps the default workspace when TOMO_WORKSPACE is empty", async () => {
    // resolve("") is the CURRENT WORKING DIRECTORY: a blank TOMO_WORKSPACE
    // used to make whatever directory the daemon was launched from the
    // workspace, and sdkSessionsDir is derived from that path.
    const { config } = await loadConfigWith({}, { TOMO_WORKSPACE: "" });
    expect(config.workspaceDir).toBe(join(home, ".tomo", "workspace"));
    expect(config.workspaceDir).not.toBe(process.cwd());
  });

  it("keeps the default sessions dir when SESSIONS_DIR is empty", async () => {
    const { config } = await loadConfigWith({}, { SESSIONS_DIR: "" });
    expect(config.sessionsDir).toBe(join(home, ".tomo", "data", "sessions"));
  });

  it("records the blank path overrides too, so the startup notice names them", async () => {
    // runtime-paths.ts cannot import config.ts; it reports what it ignored on
    // its result and config.ts folds that into the same registry.
    const ignoredEnvOverrideNames = (await loadConfigWith({}, { TOMO_WORKSPACE: "", SESSIONS_DIR: "  " }))
      .ignoredEnvOverrideNames ?? [];
    expect([...ignoredEnvOverrideNames].sort()).toEqual(["SESSIONS_DIR", "TOMO_WORKSPACE"]);
  });
});
