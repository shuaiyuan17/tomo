import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isSecretFieldName, scrubSecretValues } from "../redact.js";
import { WebError, type WebConfigField, type WebConfigView, type WebMcpServer } from "./protocol.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_FIELDS = 500;
const MAX_DEPTH = 8;
/** MCP server keys whose values are shown. Everything else in a server entry
 *  (command, args, env, headers, url, oauth, unknown extensions) can carry a
 *  credential under any name, so it is only ever "set" / "not set". */
const SAFE_MCP_KEYS = new Set(["type", "enabled", "disabled", "timeout", "alwaysLoad"]);
const MCP_TYPES = new Set(["stdio", "http", "sse", "streamable-http"]);

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
/** A string the shared log scrubber would alter, or a URL carrying userinfo / a query. */
function secretShaped(value: string): boolean {
  if (scrubSecretValues(value) !== value) return true;
  try { const url = new URL(value); return !!(url.username || url.password || url.search); } catch { return false; }
}

/**
 * The ONLY config paths whose string values are shown (`*` = any one
 * segment). An allowlist, not a denylist of secret-looking names: names that
 * hide a credential cannot be enumerated (`accesskey`, `signingkey`, …), so a
 * string anywhere else — including any field added later — shows as masked.
 * Picked from the fields `config.ts` reads: models, modes, channel / chat /
 * session identifiers, time zone, paths and tool names. A string on this list
 * is still masked if it looks like a credential.
 */
export const SHOWN_STRING_PATHS = [
  "model", "effort", "city", "timezone", "workspaceDir",
  "sessionModelOverrides.*",
  "owner.name", "owner.telegram", "owner.imessage", "owner.timezone",
  "identities.*.name", "identities.*.replyPolicy", "identities.*.channels.*",
  "channels.*.provider", "channels.*.cliPath", "channels.*.dbPath", "channels.*.allowlist", "channels.*.passiveGroups",
  "lcm.groupCompactStyle", "litellm.mode",
  "web.ownerIdentity", "web.externalOrigin",
  "writeRoots", "denyPaths", "denyReadPaths", "groupShellAllowlist", "mcpAllowedTools",
  "agentProfiles.*.bash", "agentProfiles.*.writeRoots", "agentProfiles.*.denyPaths", "agentProfiles.*.denyReadPaths",
  "plugins", "plugins.*", "plugins.*.path", "plugins.*.name",
  "continuityScript", "continuityScript.path",
  "mcpServers.*.type", "mcp.servers.*.type",
].map((pattern) => pattern.split("."));
function matches(pattern: string[], path: string[]): boolean {
  return pattern.length === path.length && pattern.every((part, i) => part === "*" || part === path[i]);
}
export function showsStringAt(path: string[]): boolean {
  return SHOWN_STRING_PATHS.some((pattern) => matches(pattern, path));
}
/** A credential-looking name: numbers and booleans under such a name stay masked too. */
function secretName(segment: string): boolean {
  return isSecretFieldName(segment) || /key|token|secret|pass|pwd|auth|credential|cookie|dsn|signature|bearer/i.test(segment);
}
/** Per leaf. Strings: shown only on an allowlisted path and not credential-shaped.
 *  Numbers / booleans: shown unless a path segment names a credential or it
 *  is an opaque MCP value. Objects that reach the depth limit: masked. */
function masked(path: string[], value: unknown): boolean {
  if (mcpServerPath(path) && !SAFE_MCP_KEYS.has(path[path[0] === "mcp" ? 3 : 2])) return true;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item === "string")) {
    return !showsStringAt(path) || values.some((item) => typeof item === "string" && secretShaped(item));
  }
  return path.some(secretName);
}
function mcpServerPath(path: string[]): boolean {
  return (path[0] === "mcpServers" && path.length >= 3) || (path[0] === "mcp" && path[1] === "servers" && path.length >= 4);
}
function isSet(value: unknown): boolean { return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length); }

export function configFields(value: Record<string, unknown>): { fields: WebConfigField[]; truncated: boolean } {
  const fields: WebConfigField[] = []; let truncated = false;
  const visit = (current: unknown, path: string[]) => {
    if (fields.length >= MAX_FIELDS) { truncated = true; return; }
    const leafArray = Array.isArray(current) && current.every(scalar);
    if ((record(current) || (Array.isArray(current) && !leafArray)) && path.length < MAX_DEPTH) {
      const entries = Array.isArray(current) ? current.map((item, i) => [String(i), item] as const) : Object.entries(current);
      if (!entries.length) { fields.push({ path, secret: false, set: false, value: Array.isArray(current) ? [] : {} }); return; }
      for (const [key, child] of entries) visit(child, [...path, key]);
      return;
    }
    const secret = masked(path, current) || (!scalar(current) && !leafArray);
    // A masked string tells its length (a hint that it is set and roughly what), never its content.
    const length = secret && typeof current === "string" ? current.length : undefined;
    fields.push({ path, secret, set: isSet(current), ...(length !== undefined ? { length } : {}), ...(secret ? {} : { value: current as WebConfigField["value"] }) });
  };
  for (const [key, child] of Object.entries(value)) visit(child, [key]);
  return { fields, truncated };
}

export function mcpServers(value: Record<string, unknown>): WebMcpServer[] {
  const saved = value.mcpServers ?? (record(value.mcp) ? value.mcp.servers : undefined);
  if (!record(saved)) return [];
  return Object.entries(saved).slice(0, 128).map(([name, server]) => {
    const entry = record(server) ? server : {};
    const type = typeof entry.type === "string" && MCP_TYPES.has(entry.type) ? entry.type : entry.url !== undefined ? "http" : "stdio";
    return { name: name.slice(0, 128), enabled: entry.enabled !== false && entry.disabled !== true, type,
      oauth: entry.oauth !== undefined, timeout: typeof entry.timeout === "number" ? entry.timeout : null,
      alwaysLoad: entry.alwaysLoad === true, configured: Object.keys(entry).filter((key) => !SAFE_MCP_KEYS.has(key)).sort().slice(0, 32) };
  });
}

/**
 * The saved config.json, for display only. Read in the web process (never
 * the daemon thread), bounded, without following a symlink. Secrets appear
 * only as set / not set; no value derived from them crosses the API.
 */
export class WebConfigReader {
  constructor(private readonly tomoHome: string) {}
  async read(): Promise<{ value: Record<string, unknown> | null; modifiedAt: number | null }> {
    let file;
    try { file = await open(join(this.tomoHome, "config.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, modifiedAt: null };
      throw new WebError(503, "config_unavailable");
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new WebError(503, "config_unavailable");
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) throw new WebError(503, "config_unavailable");
      let value: unknown;
      // A parse error is never echoed: its message can quote the file.
      try { value = JSON.parse(bytes.toString("utf8", 0, bytesRead)); } catch { throw new WebError(503, "config_invalid"); }
      if (!record(value)) throw new WebError(503, "config_invalid");
      return { value, modifiedAt: stat.mtimeMs };
    } finally { await file.close(); }
  }
  async view(): Promise<WebConfigView> {
    const { value, modifiedAt } = await this.read();
    if (!value) return { missing: true, modifiedAt: null, fields: [], truncated: false };
    return { missing: false, modifiedAt, ...configFields(value) };
  }
  async mcp(): Promise<{ missing: boolean; servers: WebMcpServer[] }> {
    const { value } = await this.read();
    return { missing: !value, servers: value ? mcpServers(value) : [] };
  }
}
