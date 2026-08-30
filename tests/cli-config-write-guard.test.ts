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
// Isolation MUST NOT depend on anything the fix introduced.
//
// These tests are meant to be run against unchanged `main` too. An earlier
// version of this file isolated by passing a temp path to loadConfig/
// saveConfig — a parameter only the fixed build had. Run against main those
// arguments were ignored and the run overwrote a real ~/.tomo/config.json.
// (Those parameters have since been deleted outright, so that particular
// mistake is now a compile error — but the isolation below must not depend on
// that either.)
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
// Absent on main; the tests that need it skip themselves rather than crash.
const backupConfigIfParseableSync = (shared as {
  backupConfigIfParseableSync?: (p: string, b: string) => boolean;
}).backupConfigIfParseableSync;
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

// Only ever remove the two files under test, never the containing directory:
// a bug in the isolation above must not become a recursive delete of a real
// ~/.tomo.
function clearConfigFiles(): void {
  for (const f of [CONFIG_PATH, CONFIG_BACKUP_PATH]) {
    rmSync(f, { recursive: true, force: true });
  }
}

beforeEach(() => {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  clearConfigFiles();
});

afterEach(clearConfigFiles);

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

/** Run the real CLI against a throwaway $HOME and report what it printed. */
function runConfigCli(files: { config?: string; backup?: string }): {
  status: number; output: string; home: string; configAfter?: string; backupAfter?: string;
} {
  const home = mkdtempSync(join(tmpdir(), "tomo-config-cli-home-"));
  const tomoHome = join(home, ".tomo");
  mkdirSync(tomoHome, { recursive: true });
  const cfg = join(tomoHome, "config.json");
  const bak = join(tomoHome, "config.json.bak");
  if (files.config !== undefined) writeFileSync(cfg, files.config);
  if (files.backup !== undefined) writeFileSync(bak, files.backup);

  let status = 0;
  let output: string;
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
  return {
    status,
    output,
    home,
    configAfter: existsSync(cfg) ? readFileSync(cfg, "utf-8") : undefined,
    backupAfter: existsSync(bak) ? readFileSync(bak, "utf-8") : undefined,
  };
}

describe("`tomo config` against a corrupt config", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  it("exits non-zero and touches neither the config nor its backup", () => {
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    const r = runConfigCli({ config: CORRUPT, backup: good });
    homes.push(r.home);

    expect(r.status).not.toBe(0);
    expect(r.output).toContain("could not be read");
    expect(r.configAfter).toBe(CORRUPT);
    expect(r.backupAfter).toBe(good);
  });

  it("keeps the command alive and offers only the submenus that read no config", () => {
    const r = runConfigCli({ config: CORRUPT });
    homes.push(r.home);

    // Withdrawn: every one of these is loadConfig() -> mutate -> saveConfig().
    for (const label of [
      "Anthropic authentication", "Model", "LiteLLM gateway",
      "Channels", "Identities", "Group chats", "Sessions",
    ]) {
      expect(r.output).not.toContain(label);
    }
    // Still offered: these read no config at all. The command reached the
    // menu at all, which is the point — a parse error does not end it.
    expect(r.output).toContain("Scheduled tasks");
    expect(r.output).toContain("Cost analysis");
    expect(r.output).toContain("Exit");
    expect(r.status).not.toBe(0);
  });

  it("offers the full menu and exits 0 when the config parses", () => {
    const r = runConfigCli({ config: JSON.stringify(GOOD_CONFIG, null, 2) });
    homes.push(r.home);

    expect(r.output).toContain("Anthropic authentication");
    expect(r.output).toContain("Identities");
    expect(r.output).toContain("Scheduled tasks");
    expect(r.status).toBe(0);
  });

  it("names the backup to restore only when there is one", () => {
    const withBak = runConfigCli({ config: CORRUPT, backup: JSON.stringify(GOOD_CONFIG) });
    homes.push(withBak.home);
    expect(withBak.output).toContain("config.json.bak");
    expect(withBak.output).not.toContain("no backup to restore");

    const withoutBak = runConfigCli({ config: CORRUPT });
    homes.push(withoutBak.home);
    expect(withoutBak.output).toContain("no backup to restore");
  });
});

describe("backupConfigIfParseableSync", () => {
  // `tomo init --force` overwrites the config on purpose, so the .bak is the
  // only surviving copy — rotating it content-blind replaced a good backup
  // with the corrupt file.
  it("rotates a config that parses", () => {
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(CONFIG_PATH, good);
    expect(backupConfigIfParseableSync!(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(true);
    expect(readFileSync(CONFIG_BACKUP_PATH, "utf-8")).toBe(good);
  });

  it("keeps the existing backup when the config does not parse", () => {
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(CONFIG_BACKUP_PATH, good);
    writeFileSync(CONFIG_PATH, CORRUPT);

    expect(backupConfigIfParseableSync!(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(false);
    expect(readFileSync(CONFIG_BACKUP_PATH, "utf-8")).toBe(good);
  });

  it("does nothing when there is no config yet", () => {
    expect(backupConfigIfParseableSync!(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(false);
    expect(existsSync(CONFIG_BACKUP_PATH)).toBe(false);
  });
});
