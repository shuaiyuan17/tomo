import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

type Env = Record<string, string | undefined>;

type RawMcpServer = Record<string, unknown>;

export interface McpOAuthConfig {
  authorizationServer?: string;
  clientId?: string;
  scopes: string[];
  tokenStoreKey: string;
  redirectUri?: string;
  clientName?: string;
}

export interface ExternalMcpServerConfig {
  server: McpServerConfig;
  oauth?: McpOAuthConfig;
}

const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function expandEnvVars(value: string, env: Env = process.env): string {
  return value.replace(ENV_VAR_RE, (_match, braced: string | undefined, bare: string | undefined) => {
    return env[braced ?? bare ?? ""] ?? "";
  });
}

export function parseExternalMcpServers(
  raw: unknown,
  env: Env = process.env,
): Record<string, ExternalMcpServerConfig> {
  if (!isRecord(raw)) return {};

  const servers: Record<string, ExternalMcpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!SERVER_NAME_RE.test(name) || !isRecord(value)) continue;
    if (value.enabled === false || value.disabled === true) continue;

    const server = parseServer(value, env);
    if (server) {
      const oauth = parseOAuthConfig(value.oauth, name, env);
      servers[name] = stripUndefined({ server, oauth }) as ExternalMcpServerConfig;
    }
  }
  return servers;
}

function parseServer(raw: RawMcpServer, env: Env): McpServerConfig | null {
  const type = raw.type === "streamable-http" ? "http" : raw.type;

  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string" || raw.url.trim() === "") return null;
    return stripUndefined({
      type,
      url: expandEnvVars(raw.url.trim(), env),
      headers: parseStringRecord(raw.headers, env),
      tools: parseToolPolicies(raw.tools),
      timeout: parsePositiveNumber(raw.timeout),
      alwaysLoad: typeof raw.alwaysLoad === "boolean" ? raw.alwaysLoad : undefined,
    }) as McpServerConfig;
  }

  if (type === undefined || type === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") return null;
    return stripUndefined({
      type: type === "stdio" ? "stdio" : undefined,
      command: expandEnvVars(raw.command.trim(), env),
      args: Array.isArray(raw.args) ? raw.args.map((arg) => expandEnvVars(String(arg), env)) : undefined,
      env: parseStringRecord(raw.env, env),
      timeout: parsePositiveNumber(raw.timeout),
      alwaysLoad: typeof raw.alwaysLoad === "boolean" ? raw.alwaysLoad : undefined,
    }) as McpServerConfig;
  }

  return null;
}

function parseOAuthConfig(raw: unknown, serverName: string, env: Env): McpOAuthConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.map(String).map((s) => s.trim()).filter(Boolean)
    : typeof raw.scopes === "string"
      ? raw.scopes.split(/\s+/).map((s) => s.trim()).filter(Boolean)
      : [];

  const tokenStoreKey = typeof raw.tokenStoreKey === "string" && raw.tokenStoreKey.trim()
    ? raw.tokenStoreKey.trim()
    : serverName;

  return stripUndefined({
    authorizationServer: typeof raw.authorizationServer === "string" && raw.authorizationServer.trim()
      ? expandEnvVars(raw.authorizationServer.trim(), env)
      : undefined,
    clientId: typeof raw.clientId === "string" && raw.clientId.trim()
      ? expandEnvVars(raw.clientId.trim(), env)
      : undefined,
    scopes,
    tokenStoreKey,
    redirectUri: typeof raw.redirectUri === "string" && raw.redirectUri.trim()
      ? expandEnvVars(raw.redirectUri.trim(), env)
      : undefined,
    clientName: typeof raw.clientName === "string" && raw.clientName.trim()
      ? raw.clientName.trim()
      : "Tomo",
  }) as McpOAuthConfig;
}

function parseStringRecord(raw: unknown, env: Env): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = expandEnvVars(String(value), env);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseToolPolicies(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  const policies = raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.name !== "string") return [];
    const policy = item.permission_policy;
    if (policy !== "always_allow" && policy !== "always_ask" && policy !== "always_deny") return [];
    return [{ name: item.name, permission_policy: policy }];
  });
  return policies.length > 0 ? policies : undefined;
}

function parsePositiveNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
