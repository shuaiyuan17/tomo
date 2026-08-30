import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { ConfigReadError, loadConfig, saveConfig } from "../src/cli/config/shared.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GOOD_CONFIG = {
  model: "claude-opus-4",
  channels: { telegram: { token: "8123456:AAH-secret", allowlist: ["1"] } },
  auth: { apiKey: "sk-ant-real" },
};

let dir: string;
let configPath: string;
let backupPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-config-guard-"));
  configPath = join(dir, "config.json");
  backupPath = join(dir, "config.json.bak");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeGoodConfig(): void {
  writeFileSync(configPath, JSON.stringify(GOOD_CONFIG, null, 2));
}

describe("loadConfig", () => {
  it("returns {} when the file does not exist", () => {
    expect(loadConfig(configPath)).toEqual({});
  });

  it("reads a well-formed config", () => {
    writeGoodConfig();
    expect(loadConfig(configPath)).toEqual(GOOD_CONFIG);
  });

  it("throws instead of reporting {} when the file exists but cannot be parsed", () => {
    // The exact hand-edit from the report: a trailing comma.
    writeFileSync(configPath, '{\n  "model": "claude-opus-4",\n}\n');
    expect(() => loadConfig(configPath)).toThrow(ConfigReadError);
  });

  it("throws when the file is unreadable for reasons other than absence", () => {
    // A directory where the config should be: not ENOENT, not emptiness.
    mkdirSync(configPath);
    expect(() => loadConfig(configPath)).toThrow(ConfigReadError);
  });

  it("throws when the root is valid JSON but not an object", () => {
    writeFileSync(configPath, "[1, 2, 3]\n");
    expect(() => loadConfig(configPath)).toThrow(ConfigReadError);
  });
});

describe("saveConfig", () => {
  it("writes and rotates a backup when the on-disk config parses", () => {
    writeGoodConfig();
    saveConfig({ ...GOOD_CONFIG, model: "claude-sonnet-5" }, configPath, backupPath);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).model).toBe("claude-sonnet-5");
    expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual(GOOD_CONFIG);
  });

  it("refuses to write over a config it could not parse, and leaves the file byte-identical", () => {
    const corrupt = '{\n  "model": "claude-opus-4",\n}\n';
    writeFileSync(configPath, corrupt);
    const before = statSync(configPath);

    expect(() => saveConfig({ model: "claude-sonnet-5" }, configPath, backupPath))
      .toThrow(ConfigReadError);

    expect(readFileSync(configPath, "utf-8")).toBe(corrupt);
    expect(statSync(configPath).mtimeMs).toBe(before.mtimeMs);
    // No backup was taken either — there was nothing good to back up.
    expect(existsSync(backupPath)).toBe(false);
  });

  it("does not let a corrupt file overwrite a good backup", () => {
    // Save once from a good file: .bak now holds the good config.
    writeGoodConfig();
    saveConfig({ ...GOOD_CONFIG, model: "claude-sonnet-5" }, configPath, backupPath);
    const goodBackup = readFileSync(backupPath, "utf-8");

    // The user hand-edits the config and breaks it, then runs `tomo config`
    // again. This second save is what used to eat the only recoverable copy.
    writeFileSync(configPath, '{ "model": "x" ,}');
    expect(() => saveConfig({ model: "claude-haiku-4" }, configPath, backupPath))
      .toThrow(ConfigReadError);

    expect(readFileSync(backupPath, "utf-8")).toBe(goodBackup);
  });

  it("still writes when there is no config file yet (fresh install)", () => {
    saveConfig({ model: "claude-opus-4" }, configPath, backupPath);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ model: "claude-opus-4" });
    expect(existsSync(backupPath)).toBe(false);
  });
});

describe("`tomo config` against a corrupt config", () => {
  it("exits non-zero and touches neither the config nor its backup", () => {
    const home = mkdtempSync(join(tmpdir(), "tomo-config-home-"));
    try {
      const tomoHome = join(home, ".tomo");
      mkdirSync(tomoHome, { recursive: true });
      const cfg = join(tomoHome, "config.json");
      const bak = join(tomoHome, "config.json.bak");
      const corrupt = '{\n  "model": "claude-opus-4",\n}\n';
      writeFileSync(cfg, corrupt);
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
            env: { ...process.env, HOME: home, TOMO_WORKSPACE: join(home, "workspace"), SESSIONS_DIR: join(home, "sessions") },
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
      expect(readFileSync(cfg, "utf-8")).toBe(corrupt);
      expect(readFileSync(bak, "utf-8")).toBe(bakBefore);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
