import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ExternalMcpServerConfig, McpOAuthConfig } from "./external-config.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

export interface OAuthTokenRecord {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  authorizationServer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  resource?: string;
  updatedAt: number;
}

interface TokenStoreFile {
  mcpOAuth?: Record<string, OAuthTokenRecord>;
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface McpOAuthManagerOptions {
  workspaceDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  tokenStorePath?: string;
}

export class McpOAuthManager {
  private fetchImpl: typeof fetch;
  private now: () => number;
  private tokenStorePath: string;

  constructor(options: McpOAuthManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.tokenStorePath = options.tokenStorePath ?? join(options.workspaceDir, "secrets", "keychain.json");
  }

  async buildServersWithAuth(
    servers: Record<string, ExternalMcpServerConfig>,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
  ): Promise<Record<string, McpServerConfig>> {
    const result: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry.oauth) {
        result[name] = entry.server;
        continue;
      }

      result[name] = await this.withOAuthHeader(name, entry, sendAuthorizeUrl);
    }
    return result;
  }

  async withOAuthHeader(
    serverName: string,
    entry: ExternalMcpServerConfig,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
  ): Promise<McpServerConfig> {
    if (!entry.oauth || !supportsHeaders(entry.server)) return entry.server;

    const token = await this.getFreshToken(serverName, entry.server, entry.oauth, sendAuthorizeUrl);
    return {
      ...entry.server,
      headers: {
        ...(entry.server.headers ?? {}),
        Authorization: `Bearer ${token.accessToken}`,
      },
    };
  }

  async getFreshToken(
    serverName: string,
    server: McpServerConfig,
    oauth: McpOAuthConfig,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
  ): Promise<OAuthTokenRecord> {
    const store = this.readStore();
    const existing = store.mcpOAuth?.[oauth.tokenStoreKey];
    if (existing && !this.isExpiring(existing)) return existing;

    if (existing?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(existing, oauth);
        this.writeToken(oauth.tokenStoreKey, refreshed);
        return refreshed;
      } catch {
        // Fall through to a full browser auth flow when refresh is rejected.
      }
    }

    const authorized = await this.runAuthorizationCodeFlow(serverName, server, oauth, existing, sendAuthorizeUrl);
    this.writeToken(oauth.tokenStoreKey, authorized);
    return authorized;
  }

  isExpiring(token: Pick<OAuthTokenRecord, "expiresAt">): boolean {
    return typeof token.expiresAt === "number" && token.expiresAt <= this.now() + TOKEN_REFRESH_SKEW_MS;
  }

  private async runAuthorizationCodeFlow(
    serverName: string,
    server: McpServerConfig,
    oauth: McpOAuthConfig,
    existing: OAuthTokenRecord | undefined,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
  ): Promise<OAuthTokenRecord> {
    const callback = await startCallbackServer(oauth.redirectUri);
    try {
      const discovery = await this.discover(server, oauth, existing);
      const client = await this.resolveClient(discovery, oauth, callback.redirectUri, existing);
      const verifier = base64Url(randomBytes(32));
      const challenge = base64Url(createHash("sha256").update(verifier).digest());
      const state = base64Url(randomBytes(24));
      const scope = oauth.scopes.length > 0
        ? oauth.scopes.join(" ")
        : (discovery.resource.scopes_supported ?? discovery.auth.scopes_supported ?? []).join(" ");

      const authUrl = new URL(discovery.auth.authorization_endpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.clientId);
      authUrl.searchParams.set("redirect_uri", callback.redirectUri);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      if (scope) authUrl.searchParams.set("scope", scope);
      if (discovery.resource.resource) authUrl.searchParams.set("resource", discovery.resource.resource);

      await sendAuthorizeUrl(serverName, authUrl.toString());
      const callbackResult = await callback.waitForCallback(state);

      const token = await this.exchangeToken(discovery.auth.token_endpoint, {
        grant_type: "authorization_code",
        code: callbackResult.code,
        redirect_uri: callback.redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        ...(discovery.resource.resource ? { resource: discovery.resource.resource } : {}),
      });

      return normalizeToken(token, this.now(), {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authorizationServer: discovery.authorizationServer,
        authorizationEndpoint: discovery.auth.authorization_endpoint,
        tokenEndpoint: discovery.auth.token_endpoint,
        registrationEndpoint: discovery.auth.registration_endpoint,
        resource: discovery.resource.resource,
      });
    } finally {
      await callback.close();
    }
  }

  private async refreshToken(existing: OAuthTokenRecord, oauth: McpOAuthConfig): Promise<OAuthTokenRecord> {
    if (!existing.refreshToken) throw new Error("No refresh token");
    const tokenEndpoint = existing.tokenEndpoint;
    const clientId = existing.clientId ?? oauth.clientId;
    if (!tokenEndpoint || !clientId) throw new Error("Missing token endpoint or client id");

    const token = await this.exchangeToken(tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: existing.refreshToken,
      client_id: clientId,
      ...(existing.clientSecret ? { client_secret: existing.clientSecret } : {}),
      ...(existing.resource ? { resource: existing.resource } : {}),
      ...(oauth.scopes.length > 0 ? { scope: oauth.scopes.join(" ") } : {}),
    });

    return {
      ...existing,
      ...normalizeToken(token, this.now(), {
        clientId,
        clientSecret: existing.clientSecret,
        authorizationServer: existing.authorizationServer,
        authorizationEndpoint: existing.authorizationEndpoint,
        tokenEndpoint: existing.tokenEndpoint,
        registrationEndpoint: existing.registrationEndpoint,
        resource: existing.resource,
      }),
      refreshToken: String(token.refresh_token ?? existing.refreshToken),
    };
  }

  private async discover(server: McpServerConfig, oauth: McpOAuthConfig, existing?: OAuthTokenRecord) {
    const resource = await this.discoverProtectedResource(server, oauth, existing);
    const authorizationServer = oauth.authorizationServer
      ?? existing?.authorizationServer
      ?? resource.authorization_servers?.[0];
    if (!authorizationServer) throw new Error("MCP OAuth discovery did not find an authorization server");

    const auth = await this.fetchAuthorizationServerMetadata(authorizationServer);
    return { resource, auth, authorizationServer };
  }

  private async discoverProtectedResource(
    server: McpServerConfig,
    oauth: McpOAuthConfig,
    existing?: OAuthTokenRecord,
  ): Promise<ProtectedResourceMetadata> {
    if (!supportsHeaders(server)) return {};
    if (existing?.resource) return { resource: existing.resource };
    if (oauth.authorizationServer) return {};

    const res = await this.fetchImpl(server.url, { method: "GET", headers: { Accept: "application/json" } });
    const header = res.headers.get("www-authenticate") ?? "";
    const metadataUrl = parseResourceMetadataUrl(header);
    if (!metadataUrl) return {};

    const metadataRes = await this.fetchImpl(metadataUrl, { method: "GET", headers: { Accept: "application/json" } });
    if (!metadataRes.ok) throw new Error(`Failed to fetch MCP protected-resource metadata: ${metadataRes.status}`);
    return await metadataRes.json() as ProtectedResourceMetadata;
  }

  private async fetchAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata> {
    const urls = authorizationServerMetadataUrls(issuer);
    for (const url of urls) {
      const res = await this.fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const metadata = await res.json() as Partial<AuthorizationServerMetadata>;
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        return metadata as AuthorizationServerMetadata;
      }
    }
    throw new Error(`Failed to discover OAuth authorization server metadata for ${issuer}`);
  }

  private async resolveClient(
    discovery: { auth: AuthorizationServerMetadata },
    oauth: McpOAuthConfig,
    redirectUri: string,
    existing?: OAuthTokenRecord,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    if (existing?.clientId) return { clientId: existing.clientId, clientSecret: existing.clientSecret };
    if (oauth.clientId) return { clientId: oauth.clientId };
    if (!discovery.auth.registration_endpoint) {
      throw new Error("OAuth client_id is required because dynamic client registration is unavailable");
    }

    const response = await this.fetchImpl(discovery.auth.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: oauth.clientName ?? "Tomo",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: oauth.scopes.join(" "),
      }),
    });
    if (!response.ok) throw new Error(`Dynamic client registration failed: ${response.status}`);
    const body = await response.json() as { client_id?: string; client_secret?: string };
    if (!body.client_id) throw new Error("Dynamic client registration did not return client_id");
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }

  private async exchangeToken(tokenEndpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(params);
    const response = await this.fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }

  private readStore(): TokenStoreFile {
    if (!existsSync(this.tokenStorePath)) return {};
    try {
      return JSON.parse(readFileSync(this.tokenStorePath, "utf-8")) as TokenStoreFile;
    } catch {
      return {};
    }
  }

  private writeToken(key: string, token: OAuthTokenRecord): void {
    const store = this.readStore();
    store.mcpOAuth = store.mcpOAuth ?? {};
    store.mcpOAuth[key] = token;

    mkdirSync(dirname(this.tokenStorePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenStorePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.tokenStorePath, 0o600);
  }
}

function normalizeToken(
  token: Record<string, unknown>,
  now: number,
  extra: Omit<Partial<OAuthTokenRecord>, "accessToken" | "refreshToken" | "tokenType" | "expiresAt" | "updatedAt">,
): OAuthTokenRecord {
  const accessToken = token.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("OAuth token response did not include access_token");
  const expiresIn = Number(token.expires_in);
  return {
    accessToken,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
    tokenType: typeof token.token_type === "string" ? token.token_type : "Bearer",
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: typeof token.scope === "string" ? token.scope : undefined,
    ...extra,
    updatedAt: now,
  };
}

function supportsHeaders(server: McpServerConfig): server is Extract<McpServerConfig, { type: "http" | "sse" }> {
  return server.type === "http" || server.type === "sse";
}

function parseResourceMetadataUrl(header: string): string | null {
  const match = /resource_metadata=(?:"([^"]+)"|([^,\s]+))/i.exec(header);
  return match ? (match[1] ?? match[2]) : null;
}

function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
  ];
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function startCallbackServer(configuredRedirectUri?: string) {
  const configured = configuredRedirectUri ? new URL(configuredRedirectUri) : undefined;
  if (configured && configured.hostname !== "127.0.0.1" && configured.hostname !== "localhost") {
    throw new Error("Configured OAuth redirectUri must use localhost or 127.0.0.1 so Tomo can capture the callback");
  }

  const expectedPath = configured?.pathname || "/oauth/callback";
  let resolveCallback: ((value: { code: string; state: string | null }) => void) | null = null;
  let rejectCallback: ((err: Error) => void) | null = null;

  const callbackPromise = new Promise<{ code: string; state: string | null }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== expectedPath) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400);
      res.end("OAuth failed. You can close this tab.");
      rejectCallback?.(new Error(error));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Missing OAuth code. You can close this tab.");
      rejectCallback?.(new Error("Missing OAuth code"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Tomo received the OAuth login. You can close this tab.");
    resolveCallback?.({ code, state: url.searchParams.get("state") });
  });

  const host = configured?.hostname ?? "127.0.0.1";
  const port = configured?.port ? Number(configured.port) : 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const redirectUri = configured?.toString() ?? `http://127.0.0.1:${actualPort}${expectedPath}`;

  return {
    redirectUri,
    waitForCallback: async (expectedState: string) => {
      const result = await withTimeout(callbackPromise, AUTH_TIMEOUT_MS);
      if (result.state !== expectedState) throw new Error("OAuth state mismatch");
      return result;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OAuth login timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
