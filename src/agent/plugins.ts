import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { log } from "../logger.js";

/** Normalized plugin entry from ~/.tomo/config.json `plugins`.
 *
 *  Accepted config forms (see config.ts parsePlugins):
 *    "./my-plugin"                          — local path (has a path separator, or starts with ./ ~/ /)
 *    "swift-lsp@claude-plugins-official"    — CLI-installed plugin id (exact key in installed_plugins.json)
 *    "swift-lsp"                            — CLI-installed plugin bare name (must be unambiguous)
 *    { "path": "...", "skipMcpDiscovery": true }
 *    { "name": "...", "skipMcpDiscovery": true }
 */
export interface PluginSpec {
  ref: string;
  /** True when the ref is known to be a filesystem path ("path" object form).
   *  Undefined for string form — inferred from the ref shape. */
  isPath?: boolean;
  skipMcpDiscovery?: boolean;
}

/** Matches the SDK's SdkPluginConfig (type widened at the call site). */
export interface ResolvedPlugin {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
}

/** Shape of ~/.claude/plugins/installed_plugins.json (version 2). */
interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** A ref is a path when it can't be a plugin name: contains a separator or
 *  starts with an explicit path prefix. Bare names never contain "/" (plugin
 *  names are [a-zA-Z0-9_-]; marketplace ids likewise, joined by "@"). */
function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.startsWith("~") || ref.startsWith(".");
}

/** Signals that a directory actually contains plugin components. Some
 *  marketplace plugins define everything (e.g. lspServers) in the marketplace
 *  entry itself, leaving an empty cache dir — passing those to the SDK loads
 *  nothing, which deserves a warning rather than silence. */
const COMPONENT_MARKERS = [
  ".claude-plugin/plugin.json",
  "skills",
  "agents",
  "commands",
  "hooks",
  ".mcp.json",
  "SKILL.md",
  "bin",
];

function hasComponents(dir: string): boolean {
  return COMPONENT_MARKERS.some((m) => existsSync(join(dir, m)));
}

function readInstalledPlugins(claudePluginsDir: string): Record<string, InstalledPluginEntry[]> {
  const file = join(claudePluginsDir, "installed_plugins.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as InstalledPluginsFile;
    return parsed.plugins ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ file, err: String(err) }, "Failed to read installed_plugins.json");
    }
    return {};
  }
}

function pickInstallPath(entries: InstalledPluginEntry[]): string | undefined {
  // Prefer user scope; fall back to any entry with a path. Multiple entries
  // exist when the same plugin is installed at several scopes.
  const user = entries.find((e) => e.scope === "user" && e.installPath);
  return (user ?? entries.find((e) => e.installPath))?.installPath;
}

/** Resolve configured plugin refs into SDK plugin configs.
 *
 *  Called at session spawn (not config load): CLI-installed plugin paths are
 *  version-pinned (cache/<mkt>/<name>/<version>) and change on update, with
 *  old dirs deleted after ~7 days — resolving late keeps a long-running
 *  daemon pointing at live paths. Unresolvable entries are skipped with a
 *  warning; a bad plugin ref should never take sessions down. */
export function resolvePlugins(
  specs: readonly PluginSpec[],
  claudePluginsDir: string = join(homedir(), ".claude", "plugins"),
): ResolvedPlugin[] {
  if (specs.length === 0) return [];
  let installed: Record<string, InstalledPluginEntry[]> | null = null;

  const resolved: ResolvedPlugin[] = [];
  for (const spec of specs) {
    const isPath = spec.isPath ?? looksLikePath(spec.ref);
    let dir: string | undefined;

    if (isPath) {
      const expanded = expandHome(spec.ref);
      dir = isAbsolute(expanded) ? expanded : resolve(expanded);
      if (!existsSync(dir)) {
        log.warn({ plugin: spec.ref, path: dir }, "Plugin path does not exist; skipping");
        continue;
      }
    } else {
      installed ??= readInstalledPlugins(claudePluginsDir);
      const key = spec.ref.includes("@")
        ? (installed[spec.ref] ? spec.ref : undefined)
        : matchBareName(installed, spec.ref);
      if (!key) {
        log.warn(
          { plugin: spec.ref },
          "Plugin not found in ~/.claude/plugins/installed_plugins.json — install it with `claude plugin install`, or use a local path; skipping",
        );
        continue;
      }
      dir = pickInstallPath(installed[key]!);
      if (!dir || !existsSync(dir)) {
        log.warn({ plugin: spec.ref, key, path: dir }, "Installed plugin path missing on disk; skipping");
        continue;
      }
    }

    if (!hasComponents(dir)) {
      log.warn(
        { plugin: spec.ref, path: dir },
        "Plugin directory has no recognizable components (skills/agents/commands/hooks/.mcp.json). If it is defined entirely by its marketplace entry (e.g. lspServers-only plugins), the SDK cannot load it from this path.",
      );
    }

    resolved.push({
      type: "local",
      path: dir,
      ...(spec.skipMcpDiscovery ? { skipMcpDiscovery: true } : {}),
    });
  }
  return resolved;
}

/** Match a bare plugin name against installed ids (`name@marketplace`).
 *  Returns the key only when exactly one marketplace provides the name. */
function matchBareName(
  installed: Record<string, InstalledPluginEntry[]>,
  name: string,
): string | undefined {
  const matches = Object.keys(installed).filter((k) => k === name || k.startsWith(`${name}@`));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    log.warn(
      { plugin: name, matches },
      "Plugin name is ambiguous across marketplaces — use the full `name@marketplace` form; skipping",
    );
  }
  return undefined;
}
