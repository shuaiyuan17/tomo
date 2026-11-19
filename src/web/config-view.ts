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

/** Value checks for allowlisted paths that contain a wildcard. */
const MODEL_ID = (v: string) => v.length <= 64 && /^(claude-)?[a-z0-9][a-z0-9.\-[\]]*$/.test(v);
const LOWER_WORD = (v: string) => /^[a-z]+$/.test(v);
const POLICY = (v: string) => /^[a-z][a-z-]{0,31}$/.test(v);
const PERSON_NAME = (v: string) => /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u.test(v);
/** A Telegram / iMessage chat or user id: a number, a phone number, or an email address. */
const CHAT_ID = (v: string) => /^[+-]?\d{1,20}$/.test(v) || (v.length <= 128 && /^[^\s@:/]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v));
const FILE_PATH = (v: string) => v.length <= 512 && /^[~./A-Za-z0-9_ -][A-Za-z0-9_ ./@+-]*$/.test(v) && !v.includes("..");
const PACKAGE_NAME = (v: string) => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,128}$/.test(v);
const BASH_MODE = (v: string) => ["none", "readonly", "worktree", "full"].includes(v);
const MCP_TYPE = (v: string) => ["stdio", "http", "sse", "streamable-http"].includes(v);

interface ShownPath {
  pattern: string[];
  /** Required on a wildcard path: its values are shown only when every one passes. */
  value?: (v: string) => boolean;
  /** Required on a wildcard path: every segment the `*` matched must pass. */
  key?: (k: string) => boolean;
}
const shown = (pattern: string, value?: ShownPath["value"], key?: ShownPath["key"]): ShownPath => ({ pattern: pattern.split("."), value, key });
const ANY_INDEX_OR_WORD = (k: string) => /^\d{1,4}$/.test(k) || /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k);
const SESSION_KEY = (k: string) => k.length <= 128 && /^[a-z]+:[A-Za-z0-9_.@+:-]+$/.test(k);

/**
 * The ONLY config paths whose string values are shown. An allowlist, not a
 * denylist of secret-looking names: names that hide a credential cannot be
 * enumerated (`accesskey`, `signingkey`, …), so a string anywhere else —
 * including any field added later — shows as masked. Picked from the fields
 * `config.ts` reads. A path with a wildcard (`*`, any one segment) shows its
 * keys, but its values only when they pass the path's value check (a model
 * id, a chat id, a file path, …); a wildcard path without one never shows a
 * value. Every shown string is also masked if it looks like a credential.
 */
export const SHOWN_STRING_PATHS: ShownPath[] = [
  shown("model"), shown("effort"), shown("city"), shown("timezone"), shown("workspaceDir"),
  shown("owner.name"), shown("owner.telegram"), shown("owner.imessage"), shown("owner.timezone"),
  shown("lcm.groupCompactStyle"), shown("litellm.mode"), shown("web.ownerIdentity"), shown("web.externalOrigin"),
  shown("writeRoots"), shown("denyPaths"), shown("denyReadPaths"), shown("groupShellAllowlist"), shown("mcpAllowedTools"),
  shown("continuityScript"), shown("continuityScript.path"), shown("plugins"),
  shown("sessionModelOverrides.*", MODEL_ID, SESSION_KEY),
  shown("identities.*.name", PERSON_NAME, ANY_INDEX_OR_WORD),
  shown("identities.*.replyPolicy", POLICY, ANY_INDEX_OR_WORD),
  shown("identities.*.channels.*", CHAT_ID, (k) => ANY_INDEX_OR_WORD(k)),
  shown("channels.*.provider", LOWER_WORD, LOWER_WORD),
  shown("channels.*.cliPath", FILE_PATH, LOWER_WORD),
  shown("channels.*.dbPath", FILE_PATH, LOWER_WORD),
  shown("channels.*.allowlist", CHAT_ID, LOWER_WORD),
  shown("channels.*.passiveGroups", CHAT_ID, LOWER_WORD),
  shown("agentProfiles.*.bash", BASH_MODE, ANY_INDEX_OR_WORD),
  shown("agentProfiles.*.writeRoots", FILE_PATH, ANY_INDEX_OR_WORD),
  shown("groupSandbox.groups.*.extraRead", FILE_PATH, SESSION_KEY),
  shown("groupSandbox.groups.*.extraWrite", FILE_PATH, SESSION_KEY),
  shown("agentProfiles.*.denyPaths", FILE_PATH, ANY_INDEX_OR_WORD),
  shown("agentProfiles.*.denyReadPaths", FILE_PATH, ANY_INDEX_OR_WORD),
  shown("plugins.*", (v) => FILE_PATH(v) || PACKAGE_NAME(v), (k) => /^\d{1,4}$/.test(k)),
  shown("plugins.*.path", FILE_PATH, (k) => /^\d{1,4}$/.test(k)),
  shown("plugins.*.name", PACKAGE_NAME, (k) => /^\d{1,4}$/.test(k)),
  shown("mcpServers.*.type", MCP_TYPE, (k) => /^[A-Za-z0-9._-]{1,128}$/.test(k)),
  shown("mcp.servers.*.type", MCP_TYPE, (k) => /^[A-Za-z0-9._-]{1,128}$/.test(k)),
];
/** True when every string value at `path` may be shown. */
export function showsStringAt(path: string[], values: string[]): boolean {
  return SHOWN_STRING_PATHS.some(({ pattern, value, key }) => {
    if (pattern.length !== path.length || !pattern.every((part, i) => part === "*" || part === path[i])) return false;
    const wild = pattern.flatMap((part, i) => part === "*" ? [path[i]] : []);
    if (!wild.length) return true;
    // A wildcard path without both checks never shows a value.
    return !!value && !!key && wild.every(key) && values.every(value);
  });
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
    const strings = values.filter((item): item is string => typeof item === "string");
    return !showsStringAt(path, strings) || strings.some(secretShaped);
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
      if (!entries.length) { fields.push({ path: path.map((segment) => secretShaped(segment) ? "•••" : segment), secret: false, set: false, value: Array.isArray(current) ? [] : {} }); return; }
      for (const [key, child] of entries) visit(child, [...path, key]);
      return;
    }
    const secret = masked(path, current) || (!scalar(current) && !leafArray);
    // A masked string tells its length (a hint that it is set and roughly what), never its content.
    const length = secret && typeof current === "string" ? current.length : undefined;
    // A key can be a credential too (an id-keyed map); never echo one that looks like it.
    const shownPath = path.map((segment) => secretShaped(segment) ? "•••" : segment);
    fields.push({ path: shownPath, secret, set: isSet(current), ...(length !== undefined ? { length } : {}), ...(secret ? {} : { value: current as WebConfigField["value"] }) });
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
