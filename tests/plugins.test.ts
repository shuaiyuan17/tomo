import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePlugins, type PluginSpec } from "../src/agent/plugins.js";

let tmp: string;
let claudePluginsDir: string;

function makePluginDir(rel: string, withComponents = true): string {
  const dir = join(tmp, rel);
  mkdirSync(dir, { recursive: true });
  if (withComponents) {
    mkdirSync(join(dir, "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nhi\n");
  }
  return dir;
}

function writeInstalled(plugins: Record<string, { scope?: string; installPath?: string }[]>): void {
  mkdirSync(claudePluginsDir, { recursive: true });
  writeFileSync(
    join(claudePluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tomo-plugins-"));
  claudePluginsDir = join(tmp, "claude-plugins");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolvePlugins", () => {
  it("resolves an absolute local path", () => {
    const dir = makePluginDir("my-plugin");
    const out = resolvePlugins([{ ref: dir }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir }]);
  });

  it("skips a missing local path without throwing", () => {
    const out = resolvePlugins([{ ref: join(tmp, "nope") }], claudePluginsDir);
    expect(out).toEqual([]);
  });

  it("resolves an exact name@marketplace ref via installed_plugins.json", () => {
    const dir = makePluginDir("cache/mkt/tool/1.0.0");
    writeInstalled({ "tool@mkt": [{ scope: "user", installPath: dir }] });
    const out = resolvePlugins([{ ref: "tool@mkt" }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir }]);
  });

  it("resolves a bare name when unambiguous", () => {
    const dir = makePluginDir("cache/mkt/tool/1.0.0");
    writeInstalled({ "tool@mkt": [{ scope: "user", installPath: dir }] });
    const out = resolvePlugins([{ ref: "tool" }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir }]);
  });

  it("skips an ambiguous bare name", () => {
    const a = makePluginDir("cache/a/tool/1.0.0");
    const b = makePluginDir("cache/b/tool/1.0.0");
    writeInstalled({
      "tool@a": [{ scope: "user", installPath: a }],
      "tool@b": [{ scope: "user", installPath: b }],
    });
    expect(resolvePlugins([{ ref: "tool" }], claudePluginsDir)).toEqual([]);
  });

  it("skips an uninstalled name and keeps later entries", () => {
    const dir = makePluginDir("ok-plugin");
    writeInstalled({});
    const out = resolvePlugins([{ ref: "ghost" }, { ref: dir }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir }]);
  });

  it("prefers the user-scope entry when several scopes exist", () => {
    const userDir = makePluginDir("cache/mkt/tool/2.0.0");
    const projDir = makePluginDir("cache/mkt/tool/1.0.0");
    writeInstalled({
      "tool@mkt": [
        { scope: "project", installPath: projDir },
        { scope: "user", installPath: userDir },
      ],
    });
    const out = resolvePlugins([{ ref: "tool@mkt" }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: userDir }]);
  });

  it("passes skipMcpDiscovery through", () => {
    const dir = makePluginDir("my-plugin");
    const specs: PluginSpec[] = [{ ref: dir, isPath: true, skipMcpDiscovery: true }];
    const out = resolvePlugins(specs, claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir, skipMcpDiscovery: true }]);
  });

  it("still resolves (with a warning) when the dir has no components", () => {
    const dir = makePluginDir("empty-plugin", false);
    const out = resolvePlugins([{ ref: dir }], claudePluginsDir);
    expect(out).toEqual([{ type: "local", path: dir }]);
  });

  it("treats explicit isPath=false refs as installed names even if a dir exists", () => {
    writeInstalled({});
    const out = resolvePlugins([{ ref: "tool", isPath: false }], claudePluginsDir);
    expect(out).toEqual([]);
  });

  it("handles a missing installed_plugins.json gracefully", () => {
    expect(resolvePlugins([{ ref: "tool" }], claudePluginsDir)).toEqual([]);
  });
});
