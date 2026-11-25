import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
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
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));
vi.resetModules();

const {
  CONFIG_PATH, CONFIG_BACKUP_PATH, ConfigReadError, backupConfigIfParseableSync, loadConfig, saveConfig,
} = await import("../src/cli/config/shared.js");

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

/**
 * Run the real CLI against a throwaway $HOME and report what it printed.
 *
 * Asynchronous on purpose: each run is a `node --import tsx` start (1–3 s, far
 * more under a loaded runner), and the three runs below go in parallel.
 */
async function runConfigCli(home: string, files: { config?: string; backup?: string }): Promise<{
  status: number; output: string; configAfter?: string; backupAfter?: string;
}> {
  const tomoHome = join(home, ".tomo");
  mkdirSync(tomoHome, { recursive: true });
  const cfg = join(tomoHome, "config.json");
  const bak = join(tomoHome, "config.json.bak");
  if (files.config !== undefined) writeFileSync(cfg, files.config);
  if (files.backup !== undefined) writeFileSync(bak, files.backup);

  const { status, output } = await new Promise<{ status: number; output: string }>((resolve) => {
    const child = execFile(
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
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: number | string } | null)?.code;
        resolve({ status: err ? (typeof code === "number" ? code : -1) : 0, output: `${stdout}${stderr}` });
      },
    );
    // No input, like a closed terminal: the menu's first prompt sees EOF.
    child.stdin?.end();
  });
  return {
    status,
    output,
    configAfter: existsSync(cfg) ? readFileSync(cfg, "utf-8") : undefined,
    backupAfter: existsSync(bak) ? readFileSync(bak, "utf-8") : undefined,
  };
}

// Each `it` reads one of three CLI runs made once, in parallel, up front: the
// spawns are the whole cost of this block, and two inputs (a corrupt config
// with and without a .bak) serve two assertions each.
describe("`tomo config` against a corrupt config", { timeout: 60_000 }, () => {
  const good = JSON.stringify(GOOD_CONFIG, null, 2);
  const root = mkdtempSync(join(tmpdir(), "tomo-config-cli-home-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let corruptWithBak: Awaited<ReturnType<typeof runConfigCli>>;
  let corruptOnly: Awaited<ReturnType<typeof runConfigCli>>;
  let parses: Awaited<ReturnType<typeof runConfigCli>>;

  beforeAll(async () => {
    [corruptWithBak, corruptOnly, parses] = await Promise.all([
      runConfigCli(join(root, "corrupt-with-bak"), { config: CORRUPT, backup: good }),
      runConfigCli(join(root, "corrupt-only"), { config: CORRUPT }),
      runConfigCli(join(root, "parses"), { config: good }),
    ]);
  }, 120_000);

  it("exits non-zero and touches neither the config nor its backup", () => {
    expect(corruptWithBak.status).not.toBe(0);
    expect(corruptWithBak.output).toContain("could not be read");
    expect(corruptWithBak.configAfter).toBe(CORRUPT);
    expect(corruptWithBak.backupAfter).toBe(good);
  });

  it("keeps the command alive and offers only the submenus that read no config", () => {
    // Withdrawn: every one of these is loadConfig() -> mutate -> saveConfig().
    for (const label of [
      "Anthropic authentication", "Model", "LiteLLM gateway",
      "Channels", "Owner", "Group chats", "Sessions",
    ]) {
      expect(corruptOnly.output).not.toContain(label);
    }
    // Still offered: these read no config at all. The command reached the
    // menu at all, which is the point — a parse error does not end it.
    expect(corruptOnly.output).toContain("Scheduled tasks");
    expect(corruptOnly.output).toContain("Cost analysis");
    if (process.platform === "darwin") expect(corruptOnly.output).toContain("Autostart");
    expect(corruptOnly.output).toContain("Exit");
    expect(corruptOnly.status).not.toBe(0);
    // Nothing was written in its place either.
    expect(corruptOnly.configAfter).toBe(CORRUPT);
    expect(corruptOnly.backupAfter).toBeUndefined();
  });

  it("offers the full menu and exits 0 when the config parses", () => {
    expect(parses.output).toContain("Anthropic authentication");
    expect(parses.output).toContain("Owner");
    expect(parses.output).not.toContain("Identities");
    expect(parses.output).toContain("Scheduled tasks");
    expect(parses.status).toBe(0);
  });

  it("names the backup to restore only when there is one", () => {
    expect(corruptWithBak.output).toContain("config.json.bak");
    expect(corruptWithBak.output).not.toContain("no backup to restore");
    expect(corruptOnly.output).toContain("no backup to restore");
  });
});

describe("backupConfigIfParseableSync", () => {
  // `tomo init --force` overwrites the config on purpose, so the .bak is the
  // only surviving copy — rotating it content-blind replaced a good backup
  // with the corrupt file.
  it("rotates a config that parses", () => {
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(CONFIG_PATH, good);
    expect(backupConfigIfParseableSync(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(true);
    expect(readFileSync(CONFIG_BACKUP_PATH, "utf-8")).toBe(good);
  });

  it("keeps the existing backup when the config does not parse", () => {
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(CONFIG_BACKUP_PATH, good);
    writeFileSync(CONFIG_PATH, CORRUPT);

    expect(backupConfigIfParseableSync(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(false);
    expect(readFileSync(CONFIG_BACKUP_PATH, "utf-8")).toBe(good);
  });

  it("does nothing when there is no config yet", () => {
    expect(backupConfigIfParseableSync(CONFIG_PATH, CONFIG_BACKUP_PATH)).toBe(false);
    expect(existsSync(CONFIG_BACKUP_PATH)).toBe(false);
  });
});

describe("`tomo init --force` over an existing config", () => {
  // The init command is interactive, so the write step is exercised through
  // the function it calls; the guard itself is tested above. Isolated in a
  // temp tree — the paths are explicit parameters here.
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-init-force-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does not rotate a corrupt config over a good .bak", async () => {
    const { writeInitConfig } = await import("../src/cli/init.js");
    const cfg = join(dir, ".tomo", "config.json");
    const bak = join(dir, ".tomo", "config.json.bak");
    mkdirSync(dirname(cfg), { recursive: true });
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(cfg, CORRUPT);
    writeFileSync(bak, good);

    writeInitConfig(cfg, bak, { model: "fresh" });

    expect(readFileSync(bak, "utf-8")).toBe(good);            // the last recoverable version survives
    expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ model: "fresh" });
  });

  it("rotates a config that parses, as before", async () => {
    const { writeInitConfig } = await import("../src/cli/init.js");
    const cfg = join(dir, ".tomo", "config.json");
    const bak = join(dir, ".tomo", "config.json.bak");
    mkdirSync(dirname(cfg), { recursive: true });
    const good = JSON.stringify(GOOD_CONFIG, null, 2);
    writeFileSync(cfg, good);

    writeInitConfig(cfg, bak, { model: "fresh" });

    expect(readFileSync(bak, "utf-8")).toBe(good);
    expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ model: "fresh" });
  });
});
