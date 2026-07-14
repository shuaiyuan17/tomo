import { existsSync, readFileSync, statSync } from "node:fs";
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

/** statSync follows symlinks, so a symlink to a directory passes. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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
  ".lsp.json",
  "output-styles",
];

function hasComponents(dir: string): boolean {
  return COMPONENT_MARKERS.some((m) => existsSync(join(dir, m)));
}

function readInstalledPlugins(claudePluginsDir: string): Record<string, InstalledPluginEntry[]> {
  const file = join(claudePluginsDir, "installed_plugins.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as InstalledPluginsFile;
    const plugins = parsed.plugins;
    return typeof plugins === "object" && plugins !== null ? plugins : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ file, err: String(err) }, "Failed to read installed_plugins.json");
    }
    return {};
  }
}

function pickInstallPath(entries: unknown): string | undefined {
  // Tolerate shape drift in a file we don't own: entries may be missing, a
  // bare object, or contain nulls / non-string paths in future CLI versions.
  const list = (Array.isArray(entries) ? entries : [entries]).filter(
    (e): e is InstalledPluginEntry => typeof e === "object" && e !== null,
  );
  const valid = list.filter((e) => typeof e.installPath === "string" && e.installPath.length > 0);
  // Prefer user scope; fall back to any entry with a path. Multiple entries
  // exist when the same plugin is installed at several scopes.
  return (valid.find((e) => e.scope === "user") ?? valid[0])?.installPath;
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
  /** Base for relative local paths. Defaults to ~/.tomo so "./x" means the
   *  same directory regardless of where the daemon was launched. */
  relativeBase: string = join(homedir(), ".tomo"),
): ResolvedPlugin[] {
  if (specs.length === 0) return [];
  let installed: Record<string, InstalledPluginEntry[]> | null = null;
  const getInstalled = () => (installed ??= readInstalledPlugins(claudePluginsDir));

  const resolved: ResolvedPlugin[] = [];
  for (const spec of specs) {
    try {
      const plugin = resolveOne(spec, getInstalled, relativeBase);
      if (plugin) resolved.push(plugin);
    } catch (err) {
      // Defensive scope: one malformed entry (or unexpected CLI state-file
      // shape) must never take session spawn down with it.
      log.warn({ plugin: spec.ref, err: String(err) }, "Plugin resolution failed; skipping");
    }
  }
  return resolved;
}

function resolveOne(
  spec: PluginSpec,
  getInstalled: () => Record<string, InstalledPluginEntry[]>,
  relativeBase: string,
): ResolvedPlugin | null {
  const isPath = spec.isPath ?? looksLikePath(spec.ref);
  let dir: string;

  if (isPath) {
    const expanded = expandHome(spec.ref);
    dir = isAbsolute(expanded) ? expanded : resolve(relativeBase, expanded);
    if (!isDirectory(dir)) {
      log.warn({ plugin: spec.ref, path: dir }, "Plugin path is not a directory; skipping");
      return null;
    }
  } else {
    const installed = getInstalled();
    const key = spec.ref.includes("@")
      ? (installed[spec.ref] ? spec.ref : undefined)
      : matchBareName(installed, spec.ref);
    if (!key) {
      log.warn(
        { plugin: spec.ref },
        "Plugin not found in ~/.claude/plugins/installed_plugins.json — install it with `claude plugin install`, or use a local path; skipping",
      );
      return null;
    }
    const installPath = pickInstallPath(installed[key]);
    if (!installPath || !isDirectory(installPath)) {
      log.warn({ plugin: spec.ref, key, path: installPath }, "Installed plugin path missing on disk; skipping");
      return null;
    }
    dir = installPath;
  }

  if (!hasComponents(dir)) {
    log.warn(
      { plugin: spec.ref, path: dir },
      "Plugin directory has no recognizable components (skills/agents/commands/hooks/.mcp.json). If it is defined entirely by its marketplace entry (e.g. lspServers-only plugins), the SDK cannot load it from this path.",
    );
  }

  return {
    type: "local",
    path: dir,
    ...(spec.skipMcpDiscovery ? { skipMcpDiscovery: true } : {}),
  };
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
