import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Isolation MUST NOT depend on the fix being present.
//
// These tests are meant to be run against unchanged `main` as well, and
// loadConfig/saveConfig take no path arguments in any revision: they read and
// WRITE `~/.tomo/config.json` unconditionally. An earlier version of this file
// isolated by passing a temp path — a parameter only the fixed build has —
// and when it was run against main those arguments were ignored and the run
// overwrote a real config.json.
//
// So isolate by $HOME, which every revision honours (os.homedir() reads
// process.env.HOME on POSIX, and runtime-paths.ts derives everything from it
// at module load), stub it BEFORE the module graph is built, and then refuse
// to run at all unless the paths we got back are inside the temp tree.
// ---------------------------------------------------------------------------
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-config-guard-home-"));
vi.stubEnv("HOME", TEST_HOME);
vi.resetModules();

const shared = await import("../src/cli/config/shared.js");
const { CONFIG_PATH, CONFIG_BACKUP_PATH, loadConfig, saveConfig } = shared;
// `ConfigReadError` does not exist on unchanged main; `toThrow(undefined)`
// then degrades to "throws anything", which is the honest assertion there.
const ConfigReadError = (shared as { ConfigReadError?: new (...a: never[]) => Error }).ConfigReadError;

for (const [name, value] of Object.entries({ CONFIG_PATH, CONFIG_BACKUP_PATH })) {
  if (!value.startsWith(TEST_HOME + "/")) {
    throw new Error(
      `refusing to run: ${name} is ${value}, which is outside the temp HOME ${TEST_HOME}. ` +
      "These tests write to it; running them would destroy a real config.",
    );
  }
}

const GOOD_CONFIG = {
  model: "claude-opus-4",
  channels: { telegram: { token: "8123456:AAH-secret", allowlist: ["1"] } },
  auth: { apiKey: "sk-ant-real" },
};

const CORRUPT = '{\n  "model": "claude-opus-4",\n}\n';

beforeEach(() => {
  rmSync(dirname(CONFIG_PATH), { recursive: true, force: true });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
});

afterEach(() => {
  rmSync(dirname(CONFIG_PATH), { recursive: true, force: true });
});

function writeGoodConfig(): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(GOOD_CONFIG, null, 2));
}

describe("loadConfig", () => {
  it("returns {} when the file does not exist", () => {
    expect(loadConfig()).toEqual({});
  });

  it("reads a well-formed config", () => {
    writeGoodConfig();
    expect(loadConfig()).toEqual(GOOD_CONFIG);
  });

  it("throws instead of reporting {} when the file exists but cannot be parsed", () => {
    // The exact hand-edit from the report: a trailing comma.
    writeFileSync(CONFIG_PATH, CORRUPT);
    expect(() => loadConfig()).toThrow(ConfigReadError);
  });

  it("throws when the file is unreadable for reasons other than absence", () => {
    // A directory where the config should be: not ENOENT, not emptiness.
    mkdirSync(CONFIG_PATH);
    expect(() => loadConfig()).toThrow(ConfigReadError);
  });

  it("throws when the root is valid JSON but not an object", () => {
    writeFileSync(CONFIG_PATH, "[1, 2, 3]\n");
    expect(() => loadConfig()).toThrow(ConfigReadError);
  });
});

describe("saveConfig", () => {
  it("writes and rotates a backup when the on-disk config parses", () => {
    writeGoodConfig();
    saveConfig({ ...GOOD_CONFIG, model: "claude-sonnet-5" });
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).model).toBe("claude-sonnet-5");
    expect(JSON.parse(readFileSync(CONFIG_BACKUP_PATH, "utf-8"))).toEqual(GOOD_CONFIG);
  });

  it("refuses to write over a config it could not parse, and leaves the file byte-identical", () => {
    writeFileSync(CONFIG_PATH, CORRUPT);
    const before = statSync(CONFIG_PATH);

    expect(() => saveConfig({ model: "claude-sonnet-5" })).toThrow(ConfigReadError);

    expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(CORRUPT);
    expect(statSync(CONFIG_PATH).mtimeMs).toBe(before.mtimeMs);
    // No backup was taken either — there was nothing good to back up.
    expect(existsSync(CONFIG_BACKUP_PATH)).toBe(false);
  });

  it("does not let a corrupt file overwrite a good backup", () => {
    // Save once from a good file: .bak now holds the good config.
    writeGoodConfig();
    saveConfig({ ...GOOD_CONFIG, model: "claude-sonnet-5" });
    const goodBackup = readFileSync(CONFIG_BACKUP_PATH, "utf-8");

    // The user hand-edits the config and breaks it, then runs `tomo config`
    // again. This second save is what used to eat the only recoverable copy.
    writeFileSync(CONFIG_PATH, '{ "model": "x" ,}');
    expect(() => saveConfig({ model: "claude-haiku-4" })).toThrow(ConfigReadError);

    expect(readFileSync(CONFIG_BACKUP_PATH, "utf-8")).toBe(goodBackup);
  });

  it("still writes when there is no config file yet (fresh install)", () => {
    saveConfig({ model: "claude-opus-4" });
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ model: "claude-opus-4" });
    expect(existsSync(CONFIG_BACKUP_PATH)).toBe(false);
  });
});

describe("`tomo config` against a corrupt config", () => {
  it("exits non-zero and touches neither the config nor its backup", () => {
    // The subprocess gets its own HOME for the same reason: it must not be
    // able to reach a real config even if the code under test ignores
    // everything else we do.
    const home = mkdtempSync(join(tmpdir(), "tomo-config-cli-home-"));
    try {
      const tomoHome = join(home, ".tomo");
      mkdirSync(tomoHome, { recursive: true });
      const cfg = join(tomoHome, "config.json");
      const bak = join(tomoHome, "config.json.bak");
      writeFileSync(cfg, CORRUPT);
      writeFileSync(bak, JSON.stringify(GOOD_CONFIG, null, 2));
      const bakBefore = readFileSync(bak, "utf-8");

      let status = 0;
      let output = "";
      try {
        output = execFileSync(
          process.execPath,
          ["--import", "tsx", join(REPO_ROOT, "src", "cli.ts"), "config"],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              HOME: home,
              TOMO_WORKSPACE: join(home, "workspace"),
              SESSIONS_DIR: join(home, "sessions"),
            },
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60_000,
          },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        status = e.status ?? -1;
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }

      expect(status).not.toBe(0);
      expect(output).toContain("could not be read");
      expect(readFileSync(cfg, "utf-8")).toBe(CORRUPT);
      expect(readFileSync(bak, "utf-8")).toBe(bakBefore);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
