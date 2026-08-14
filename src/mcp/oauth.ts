import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../fs-utils.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ExternalMcpServerConfig, McpOAuthConfig } from "./external-config.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const MCP_INITIALIZE_PROBE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tomo", version: "1.0" },
  },
};

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
  onServerAuthError?: (serverName: string, err: unknown) => void | Promise<void>;
}

export interface BuildServersWithAuthOptions {
  /**
   * Maximum time session creation may wait for an OAuth-enabled server.
   * When the deadline wins, authorization keeps running in the background and
   * the server is omitted from this session; a later session picks up the
   * stored token. Undefined preserves the blocking behavior for explicit
   * callers and tests.
   */
  authorizationWaitMs?: number;
}

export interface ExternalMcpServerStatus {
  name: string;
  state: "connected" | "auth-pending" | "auth-failed" | "not-mounted";
  oauth: boolean;
  mounted: boolean;
  authRequired?: boolean;
  expiresAt?: number;
  updatedAt?: number;
  startedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface McpLoginStart {
  url: string;
  reused: boolean;
  startedAt: number;
}

export type McpCallbackCompletion =
  | { status: "not-matched" }
  | { status: "unknown-state" }
  | { status: "ambiguous" }
  | { status: "already-completed"; serverName: string }
  | { status: "completed"; serverName: string; expiresAt?: number }
  | { status: "failed"; serverName: string; error: string };

type AuthBuildOutcome =
  | { status: "ready"; server: McpServerConfig }
  | { status: "failed" }
  | { status: "pending" };

interface ServerAuthBuild {
  promise: Promise<McpServerConfig>;
  startedAt: number;
  forceInteractive: boolean;
  authorizeUrl?: string;
  authorizeUrlReady: Promise<string | undefined>;
  resolveAuthorizeUrl: (url: string | undefined) => void;
}

interface PendingCallback {
  serverName: string;
  tokenStoreKey: string;
  startedAt: number;
  complete(code: string, state: string): boolean;
}

export class McpOAuthManager {
  private fetchImpl: typeof fetch;
  private now: () => number;
  private tokenStorePath: string;
  private onServerAuthError?: (serverName: string, err: unknown) => void | Promise<void>;
  /** One interactive/refresh flow per configured server. Session churn must
   * not open duplicate callback listeners or send duplicate login links. */
  private serverAuthBuilds = new Map<string, ServerAuthBuild>();
  private pendingCallbacks = new Map<string, PendingCallback>();
  private completedCallbackStates = new Map<string, { serverName: string; completedAt: number }>();
  private serverFailures = new Map<string, { error: string; at: number }>();
  private chatCallbackCompletions = new Set<string>();

  constructor(options: McpOAuthManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.tokenStorePath = options.tokenStorePath ?? join(options.workspaceDir, "secrets", "mcp-oauth.json");
    this.onServerAuthError = options.onServerAuthError;
  }

  async buildServersWithAuth(
    servers: Record<string, ExternalMcpServerConfig>,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
    options: BuildServersWithAuthOptions = {},
  ): Promise<Record<string, McpServerConfig>> {
    const result: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry.oauth) {
        result[name] = entry.server;
        continue;
      }

      const build = this.getOrStartServerAuthBuild(name, entry, sendAuthorizeUrl);
      const outcome = options.authorizationWaitMs === undefined
        ? await this.waitForAuthBuild(build.promise)
        : await this.waitForAuthBuild(build.promise, options.authorizationWaitMs);
      if (outcome.status === "ready") result[name] = outcome.server;
    }
    return result;
  }

  getServerStatuses(
    servers: Record<string, ExternalMcpServerConfig>,
    mountedServerNames: ReadonlySet<string> = new Set(),
  ): ExternalMcpServerStatus[] {
    const store = this.readStore();
    return Object.entries(servers).map(([name, entry]) => {
      const mounted = mountedServerNames.has(name);
      const failure = this.serverFailures.get(name);
      if (!entry.oauth) {
        return {
          name,
          state: mounted ? "connected" : "not-mounted",
          oauth: false,
          mounted,
        };
      }

      const build = this.serverAuthBuilds.get(name);
      const token = store.mcpOAuth?.[entry.oauth.tokenStoreKey];
      const authRequired = !token || this.isExpiring(token);
      const shared = {
        name,
        oauth: true,
        mounted,
        authRequired,
        ...(token?.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
        ...(token?.updatedAt !== undefined ? { updatedAt: token.updatedAt } : {}),
        ...(failure ? { lastError: failure.error, lastErrorAt: failure.at } : {}),
      };
      if (build) return { ...shared, state: "auth-pending" as const, startedAt: build.startedAt };
      if (failure && authRequired) return { ...shared, state: "auth-failed" as const };
      return { ...shared, state: mounted ? "connected" as const : "not-mounted" as const };
    });
  }

  async startLogin(
    serverName: string,
    servers: Record<string, ExternalMcpServerConfig>,
  ): Promise<McpLoginStart> {
    const entry = servers[serverName];
    if (!entry) throw new Error(`Unknown external MCP server "${serverName}"`);
    if (!entry.oauth) throw new Error(`MCP server "${serverName}" does not use OAuth`);
    if (!supportsHeaders(entry.server)) throw new Error(`MCP server "${serverName}" cannot use OAuth headers`);

    const existing = this.serverAuthBuilds.get(serverName);
    if (existing) {
      const url = existing.authorizeUrl ?? await existing.authorizeUrlReady;
      if (url) return { url, reused: true, startedAt: existing.startedAt };
      // A refresh may have completed while /mcp login was being requested.
      // The explicit command still means "start browser auth", so fall
      // through to a forced interactive build after the old single-flight
      // record has settled and removed itself.
      try {
        await existing.promise;
      } catch {
        // A failed background build is diagnostic history, not a latch. The
        // explicit retry below must start fresh on its first attempt.
      }
    }

    const build = this.getOrStartServerAuthBuild(serverName, entry, async () => {}, true);
    const url = build.authorizeUrl ?? await build.authorizeUrlReady;
    if (!url) {
      await build.promise;
      throw new Error(`MCP server "${serverName}" did not start an interactive OAuth flow`);
    }
    return { url, reused: false, startedAt: build.startedAt };
  }

  async completeAuthorizationFromChat(text: string): Promise<McpCallbackCompletion> {
    this.pruneCompletedCallbackStates();
    const parsed = parsePastedCallback(text);
    if (!parsed) return { status: "not-matched" };

    let state = parsed.state;
    if (!state) {
      if (this.pendingCallbacks.size !== 1) {
        return this.pendingCallbacks.size > 1 ? { status: "ambiguous" } : { status: "unknown-state" };
      }
      state = this.pendingCallbacks.keys().next().value as string;
    }

    const completed = this.completedCallbackStates.get(state);
    if (completed) return { status: "already-completed", serverName: completed.serverName };

    const pending = this.pendingCallbacks.get(state);
    if (!pending) return { status: "unknown-state" };
    if (!pending.complete(parsed.code, state)) {
      return { status: "already-completed", serverName: pending.serverName };
    }
    this.completedCallbackStates.set(state, { serverName: pending.serverName, completedAt: this.now() });

    const build = this.serverAuthBuilds.get(pending.serverName);
    if (!build) return { status: "failed", serverName: pending.serverName, error: "OAuth flow ended before token exchange" };
    this.chatCallbackCompletions.add(pending.serverName);
    try {
      await build.promise;
      const token = this.readStore().mcpOAuth?.[pending.tokenStoreKey];
      return {
        status: "completed",
        serverName: pending.serverName,
        ...(token?.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      };
    } catch (err) {
      return {
        status: "failed",
        serverName: pending.serverName,
        error: errorMessage(err),
      };
    } finally {
      this.chatCallbackCompletions.delete(pending.serverName);
    }
  }

  private getOrStartServerAuthBuild(
    serverName: string,
    entry: ExternalMcpServerConfig,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
    forceInteractive = false,
  ): ServerAuthBuild {
    const existing = this.serverAuthBuilds.get(serverName);
    if (existing) return existing;

    let resolveAuthorizeUrl!: (url: string | undefined) => void;
    const authorizeUrlReady = new Promise<string | undefined>((resolve) => { resolveAuthorizeUrl = resolve; });
    const build: ServerAuthBuild = {
      promise: Promise.resolve(entry.server),
      startedAt: this.now(),
      forceInteractive,
      authorizeUrlReady,
      resolveAuthorizeUrl,
    };
    const raw = Promise.resolve().then(() => this.withOAuthHeader(
      serverName,
      entry,
      async (name, url) => {
        build.authorizeUrl = url;
        build.resolveAuthorizeUrl(url);
        await sendAuthorizeUrl(name, url);
      },
      forceInteractive,
    ));
    const tracked = raw
      .then((server) => {
        this.serverFailures.delete(serverName);
        return server;
      })
      .catch(async (err) => {
        this.serverFailures.set(serverName, { error: errorMessage(err), at: this.now() });
        if (!this.chatCallbackCompletions.has(serverName)) {
          await this.onServerAuthError?.(serverName, err);
        }
        throw err;
      })
      .finally(() => {
        if (this.serverAuthBuilds.get(serverName) === build) this.serverAuthBuilds.delete(serverName);
        build.resolveAuthorizeUrl(undefined);
      });
    // A zero-wait session intentionally leaves this promise running. Observe
    // its rejection here so a ten-minute unattended login timeout never turns
    // into an unhandled rejection; the configured callback above still logs
    // and notifies exactly once.
    void tracked.catch(() => {});
    build.promise = tracked;
    this.serverAuthBuilds.set(serverName, build);
    return build;
  }

  private async waitForAuthBuild(
    build: Promise<McpServerConfig>,
    waitMs?: number,
  ): Promise<AuthBuildOutcome> {
    const settled = build.then<AuthBuildOutcome, AuthBuildOutcome>(
      (server) => ({ status: "ready", server }),
      () => ({ status: "failed" }),
    );
    if (waitMs === undefined) return settled;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        settled,
        new Promise<AuthBuildOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ status: "pending" }), Math.max(0, waitMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async withOAuthHeader(
    serverName: string,
    entry: ExternalMcpServerConfig,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
    forceInteractive = false,
  ): Promise<McpServerConfig> {
    if (!entry.oauth || !supportsHeaders(entry.server)) return entry.server;

    const token = await this.getFreshToken(serverName, entry.server, entry.oauth, sendAuthorizeUrl, forceInteractive);
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
    forceInteractive = false,
  ): Promise<OAuthTokenRecord> {
    const store = this.readStore();
    const existing = store.mcpOAuth?.[oauth.tokenStoreKey];
    if (!forceInteractive && existing && !this.isExpiring(existing)) return existing;

    if (!forceInteractive && existing?.refreshToken) {
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

      this.pendingCallbacks.set(state, {
        serverName,
        tokenStoreKey: oauth.tokenStoreKey,
        startedAt: this.now(),
        complete: (code, callbackState) => callback.complete(code, callbackState),
      });
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
      for (const [state, pending] of this.pendingCallbacks) {
        if (pending.serverName === serverName) this.pendingCallbacks.delete(state);
      }
      await callback.close();
    }
  }

  private pruneCompletedCallbackStates(): void {
    const cutoff = this.now() - AUTH_TIMEOUT_MS;
    for (const [state, completed] of this.completedCallbackStates) {
      if (completed.completedAt < cutoff) this.completedCallbackStates.delete(state);
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

    const res = await this.fetchImpl(server.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(MCP_INITIALIZE_PROBE),
    });
    const header = res.headers.get("www-authenticate") ?? "";
    const metadataUrl = parseResourceMetadataUrl(header) ?? protectedResourceMetadataUrl(server.url);

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
    // Read-merge-write on the freshest copy, written atomically: a crash
    // mid-write must not truncate a file holding every server's refresh
    // token (readStore treats corrupt JSON as an empty store, so a torn
    // write would otherwise silently discard all stored credentials).
    const store = this.readStore();
    store.mcpOAuth = store.mcpOAuth ?? {};
    store.mcpOAuth[key] = token;

    mkdirSync(dirname(this.tokenStorePath), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.tokenStorePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  }
}

function parsePastedCallback(text: string): { code: string; state?: string } | null {
  const trimmed = text.trim();
  let params: URLSearchParams;
  let urlForm = false;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      urlForm = true;
      params = new URL(trimmed).searchParams;
    } else if (/^\??code=/i.test(trimmed)) {
      params = new URLSearchParams(trimmed.replace(/^\?/, ""));
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const code = params.get("code");
  if (!code) return null;
  const state = params.get("state") ?? undefined;
  // A random link with ?code= is ordinary chat content. Only a full OAuth
  // redirect carrying its routing state is callback-shaped; the state-less
  // convenience form is deliberately limited to an explicit bare `code=`.
  if (urlForm && !state) return null;
  return { code, state };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
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
  let callbackSettled = false;

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
      if (!callbackSettled) {
        callbackSettled = true;
        rejectCallback?.(new Error(error));
      }
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Missing OAuth code. You can close this tab.");
      if (!callbackSettled) {
        callbackSettled = true;
        rejectCallback?.(new Error("Missing OAuth code"));
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Tomo received the OAuth login. You can close this tab.");
    complete(code, url.searchParams.get("state"));
  });

  const complete = (code: string, state: string | null): boolean => {
    if (callbackSettled) return false;
    callbackSettled = true;
    resolveCallback?.({ code, state });
    return true;
  };

  const host = configured?.hostname ?? "127.0.0.1";
  const port = configured?.port ? Number(configured.port) : 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  // OAuth authorization is allowed to outlive the session spawn that started
  // it, but it must not keep an otherwise-stopped daemon process alive.
  server.unref();

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
    complete: (code: string, state: string) => complete(code, state),
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
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
