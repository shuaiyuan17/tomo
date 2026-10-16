import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { threeWayMerge } from "../src/config-file.js";

// Isolated by $HOME exactly like tests/cli-config-write-guard.test.ts: stub it
// before the module graph is built, and refuse to run unless the config path
// we got back is inside the temp tree.
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-config-lost-update-"));
vi.stubEnv("HOME", TEST_HOME);
vi.resetModules();
const { CONFIG_PATH, loadConfig, saveConfig } = await import("../src/cli/config/shared.js");
if (!CONFIG_PATH.startsWith(TEST_HOME + "/")) {
  throw new Error(`refusing to run: CONFIG_PATH ${CONFIG_PATH} is outside the temp HOME ${TEST_HOME}`);
}
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function writeDisk(cfg: unknown): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
const disk = () => JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;

/** What the daemon's adoption does to config.json (src/agent.ts moveModelOverride). */
function daemonMovesOverride(from: string, to: string): void {
  const cfg = disk();
  const overrides = cfg.sessionModelOverrides as Record<string, string>;
  overrides[to] = overrides[from];
  delete overrides[from];
  writeDisk(cfg);
}

describe("config.json lost updates between `tomo config` and the daemon", () => {
  it("a stale `tomo config` save does not revert an override the daemon moved during adoption", () => {
    writeDisk({
      channels: { telegram: { token: "t" } },
      sessionModelOverrides: { "telegram:123456789": "claude-opus-5-5[1m]", "telegram:-100555": "claude-haiku-5-5" },
    });
    const ui = loadConfig();                                     // the menu opens
    daemonMovesOverride("telegram:123456789", "dm:owner");       // adoption runs meanwhile
    ui.groupSecret = "tomo-abc";                                 // the user edits something else
    saveConfig(ui);

    expect(disk()).toEqual({
      channels: { telegram: { token: "t" } },
      sessionModelOverrides: { "dm:owner": "claude-opus-5-5[1m]", "telegram:-100555": "claude-haiku-5-5" },
      groupSecret: "tomo-abc",
    });
    // The menu's object follows what was written, so its next save merges correctly.
    expect(ui.sessionModelOverrides).toEqual({ "dm:owner": "claude-opus-5-5[1m]", "telegram:-100555": "claude-haiku-5-5" });
    ui.model = "claude-sonnet-5-5[1m]";
    saveConfig(ui);
    expect(disk().sessionModelOverrides).toEqual({ "dm:owner": "claude-opus-5-5[1m]", "telegram:-100555": "claude-haiku-5-5" });
    expect(disk().model).toBe("claude-sonnet-5-5[1m]");
  });

  it("the user's own edit wins on the field they changed, and a field they deleted stays deleted", () => {
    writeDisk({ sessionModelOverrides: { "dm:owner": "a", "telegram:-1": "b" }, groupSecret: "old" });
    const ui = loadConfig();
    daemonMovesOverride("telegram:-1", "telegram:-2");
    (ui.sessionModelOverrides as Record<string, string>)["dm:owner"] = "c";
    delete ui.groupSecret;
    saveConfig(ui);
    expect(disk()).toEqual({ sessionModelOverrides: { "dm:owner": "c", "telegram:-2": "b" } });
  });
});

describe("threeWayMerge", () => {
  it.each([
    ["unchanged by me → theirs", { a: 1 }, { a: 1 }, { a: 2 }, { a: 2 }],
    ["unchanged by them → mine", { a: 1 }, { a: 3 }, { a: 1 }, { a: 3 }],
    ["both changed a scalar → mine", { a: 1 }, { a: 3 }, { a: 2 }, { a: 3 }],
    ["disjoint keys merge", { a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 }, { a: 2, b: 3 }],
    ["their addition survives", {}, { a: 1 }, { b: 2 }, { a: 1, b: 2 }],
    ["my deletion survives", { a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 }, { b: 2 }],
    ["arrays are atomic; mine wins when both changed", { l: [1] }, { l: [1, 2] }, { l: [1, 3] }, { l: [1, 2] }],
  ])("%s", (_name, base, mine, theirs, expected) => {
    expect(threeWayMerge(base, mine, theirs)).toEqual(expected);
  });
});
