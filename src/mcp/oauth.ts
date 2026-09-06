import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ExternalMcpServerConfig, McpOAuthConfig } from "./external-config.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How often the host should sweep stored tokens for imminent expiry. A live
 * session's Authorization header is minted once, at session build time, so
 * without this sweep a token that expires mid-session is never replaced —
 * with an issuer handing out one-hour tokens that is a broken server every
 * hour. Well under TOKEN_REFRESH_SKEW_MS so the skew window is never missed.
 */
export const TOKEN_REFRESH_SWEEP_INTERVAL_MS = 60 * 1000;
/**
 * Backoff after a refresh that the issuer REJECTED, doubling from one sweep
 * interval up to an hour.
 *
 * The sweep runs every minute and a rejected refresh left no trace at all: a
 * refresh token that has been revoked (or rotated away by a login on another
 * machine) is refused every single time, so the daemon posted the dead
 * credential 1,440 times a day, forever, and said nothing. The failure is now
 * logged and the key is rested, which turns that into roughly thirty attempts
 * a day while still recovering on its own if the issuer was merely having a
 * bad minute. Only the SWEEP backs off — a 401 from a live server and an
 * explicit `/mcp login` are user-visible events and always try.
 */
const REFRESH_BACKOFF_BASE_MS = TOKEN_REFRESH_SWEEP_INTERVAL_MS;
const REFRESH_BACKOFF_MAX_MS = 60 * 60 * 1000;
/**
 * Assumed lifetime for a refreshed access token whose response omitted
 * `expires_in`. RFC 6749 §4.2.2 leaves that case to the client; an hour is the
 * common issuer default and, unlike "unknown", it keeps the token inside the
 * sweep's reach.
 */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
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
  /**
   * Monotonic write counter for this store key, bumped on EVERY write. The
   * compare-and-set token: `updatedAt` is a millisecond clock reading and two
   * writes in the same millisecond are indistinguishable by it, so it is kept
   * for display only. Optional for migration — records written before this
   * field existed read as revision 0 and get a real one on their next write.
   */
  revision?: number;
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
  /** Best-effort notification after a fresh authenticated server config is ready. */
  onServerAuthReady?: (serverName: string, server: McpServerConfig) => void | Promise<void>;
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

/**
 * Result of a non-interactive token refresh. `superseded` means a newer token
 * record was written for the same store key while the exchange was in flight,
 * so ours was discarded.
 */
export type TokenRefreshOutcome = "refreshed" | "failed" | "skipped" | "superseded";

/** Internal result of one refresh-token exchange (see refreshStoredToken). */
type TokenRefreshResult =
  | { outcome: "refreshed"; token: OAuthTokenRecord }
  | { outcome: "superseded"; token: OAuthTokenRecord | undefined }
  | { outcome: "failed"; error: unknown };

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
  private onServerAuthReady?: (serverName: string, server: McpServerConfig) => void | Promise<void>;
  /** One interactive/refresh flow per configured server. Session churn must
   * not open duplicate callback listeners or send duplicate login links. */
  private serverAuthBuilds = new Map<string, ServerAuthBuild>();
  private pendingCallbacks = new Map<string, PendingCallback>();
  private completedCallbackStates = new Map<string, { serverName: string; completedAt: number }>();
  private serverFailures = new Map<string, { error: string; at: number }>();
  private chatCallbackCompletions = new Set<string>();
  /**
   * One refresh-token exchange per TOKEN STORE KEY (not per server), covering
   * EVERY path that can spend one: the background sweep, the 401 backstop and
   * the session-build path inside getFreshToken. Several configured servers
   * may share one `oauth.tokenStoreKey`, and an issuer that rotates refresh
   * tokens invalidates the old one on first use — so two servers refreshing
   * "their own" token would spend the same rotating credential twice and lose
   * it. Single-flighting only the sweep would leave two concurrent
   * `/mcp login`s (or two sibling session builds) racing exactly that way.
   */
  private tokenRefreshes = new Map<string, Promise<TokenRefreshResult>>();
  /** Per store key: how many refreshes in a row the issuer has rejected, and
   *  the time the SWEEP may next spend the refresh token. Cleared by any
   *  successful write to the key (see writeToken), which covers a refresh that
   *  worked and an interactive login that replaced the credential. */
  private refreshBackoff = new Map<string, { failures: number; nextAttemptAt: number }>();

  constructor(options: McpOAuthManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.tokenStorePath = options.tokenStorePath ?? join(options.workspaceDir, "secrets", "mcp-oauth.json");
    this.onServerAuthError = options.onServerAuthError;
    this.onServerAuthReady = options.onServerAuthReady;
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

      const build = this.getOrStartServerAuthBuild(name, entry, servers, sendAuthorizeUrl);
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

    const build = this.getOrStartServerAuthBuild(serverName, entry, servers, async () => {}, true);
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
    servers: Record<string, ExternalMcpServerConfig>,
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
        // Hot-mounting is deliberately detached from the auth build: session
        // creation may itself be awaiting this promise, and a runtime control
        // failure must never turn a successfully stored token into an OAuth
        // failure. The host owns logging and next-session fallback behavior.
        void Promise.resolve()
          .then(() => this.notifyAuthReady(serverName, server, entry, servers))
          .catch(() => {});
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
    return withBearer(entry.server, token.accessToken);
  }

  /**
   * Non-interactive sweep over every OAuth server whose stored access token is
   * at or inside the refresh skew window. Each success re-mints the header and
   * hands it to `onServerAuthReady`, which is what gets the new token into
   * sessions that are ALREADY RUNNING — `buildServersWithAuth` only ever runs
   * at session creation, so nothing else re-reads the token store.
   *
   * Deliberately never escalates to the browser flow: a background timer must
   * not push a login link at the owner unprompted. A rejected refresh is
   * recorded as a server failure and left for the next session build or an
   * explicit `/mcp login`.
   *
   * Returns the names actually refreshed.
   */
  async refreshExpiringTokens(servers: Record<string, ExternalMcpServerConfig>): Promise<string[]> {
    const refreshed: string[] = [];
    const visitedStoreKeys = new Set<string>();
    for (const [name, entry] of Object.entries(servers)) {
      const storeKey = entry.oauth?.tokenStoreKey;
      // One exchange per store key, however many servers share it.
      if (!storeKey || visitedStoreKeys.has(storeKey)) continue;
      visitedStoreKeys.add(storeKey);
      const outcome = await this.refreshServerToken(name, servers, { onlyIfExpiring: true });
      if (outcome === "refreshed") {
        for (const target of serversSharingStoreKey(servers, storeKey)) refreshed.push(target.name);
      }
    }
    return refreshed;
  }

  /**
   * Refresh one store key's token with its refresh token, no browser flow.
   * `onlyIfExpiring` is the timer's mode; the 401 path passes it false so a
   * token the issuer revoked early is still retried.
   *
   * Outcomes are distinguished because the caller's retry budget depends on
   * them: only `refreshed` and `failed` mean a token exchange was actually
   * attempted. `skipped` (nothing to refresh, or an interactive login already
   * owns the key) and `superseded` (someone wrote a newer record while we
   * were exchanging) must not consume a caller's attempt.
   */
  async refreshServerToken(
    serverName: string,
    servers: Record<string, ExternalMcpServerConfig>,
    options: { onlyIfExpiring?: boolean } = {},
  ): Promise<TokenRefreshOutcome> {
    const entry = servers[serverName];
    const oauth = entry?.oauth;
    if (!entry || !oauth || !supportsHeaders(entry.server)) return "skipped";
    const storeKey = oauth.tokenStoreKey;

    // ADOPT an exchange already in flight for this key rather than spending
    // the refresh token a second time: two sibling servers hitting 401
    // together, a 401 landing on top of the sweep, or a 401 landing on top of
    // a BUILD-driven refresh must produce ONE exchange between them and all
    // be told its outcome. Checked before the build guard below, because a
    // build that is merely refreshing is exactly such an exchange.
    const joined = this.tokenRefreshes.get(storeKey);
    let result: TokenRefreshResult;
    if (joined) {
      result = await joined;
    } else {
      // Only an INTERACTIVE flow owns the credential exclusively: it will end
      // in an authorization-code grant that overwrites the key outright, so
      // spending the refresh token alongside it is wasted at best.
      if (this.hasInteractiveAuthBuildForStoreKey(servers, storeKey)) return "skipped";
      const existing = this.readStore().mcpOAuth?.[storeKey];
      if (!existing?.refreshToken) return "skipped";
      if (options.onlyIfExpiring && !this.isExpiring(existing)) return "skipped";
      // Resting after a rejection is the sweep's business only: a 401 from a
      // live server and a hand-run `/mcp login` are things someone is waiting
      // on, and they pass onlyIfExpiring false.
      if (options.onlyIfExpiring && this.isBackingOff(storeKey)) return "skipped";
      result = await this.refreshStoredToken(storeKey, existing, oauth);
    }

    // Every server bound to this key gets the new header, not just the one
    // whose 401 (or sweep slot) triggered the exchange.
    const targets = serversSharingStoreKey(servers, storeKey);
    if (result.outcome === "refreshed") {
      for (const target of targets) {
        this.serverFailures.delete(target.name);
        await this.onServerAuthReady?.(target.name, withBearer(target.server, result.token.accessToken));
      }
      return "refreshed";
    }
    if (result.outcome === "failed") {
      const message = errorMessage(result.error);
      for (const target of targets) this.serverFailures.set(target.name, { error: message, at: this.now() });
      // Counted by the caller that RAN the exchange only. Siblings adopting
      // one joined promise would otherwise multiply a single rejection by the
      // number of servers sharing the key.
      if (!joined) this.noteRefreshFailure(storeKey, serverName, message);
      return "failed";
    }
    return "superseded";
  }

  /** True while the sweep is resting this key after a rejection. */
  private isBackingOff(storeKey: string): boolean {
    const state = this.refreshBackoff.get(storeKey);
    return state !== undefined && this.now() < state.nextAttemptAt;
  }

  /** Record and REPORT a rejected refresh. The log line is the only outward
   *  sign a stored refresh token has died: nothing else on this path is
   *  user-visible until a session build or a 401 surfaces it. */
  private noteRefreshFailure(storeKey: string, serverName: string, message: string): void {
    const failures = (this.refreshBackoff.get(storeKey)?.failures ?? 0) + 1;
    const retryInMs = Math.min(REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1), REFRESH_BACKOFF_MAX_MS);
    this.refreshBackoff.set(storeKey, { failures, nextAttemptAt: this.now() + retryInMs });
    log.warn(
      { server: serverName, storeKey, failures, retryInMs, reason: message },
      "MCP OAuth token refresh failed",
    );
  }

  /**
   * THE ONLY PLACE a stored refresh token is spent. Single-flighted per store
   * key and written compare-and-set, so concurrent callers — sweep, 401
   * backstop, two sibling session builds, two `/mcp login`s on one key —
   * perform exactly one exchange between them and none of them can overwrite
   * a record that moved underneath.
   */
  private refreshStoredToken(
    storeKey: string,
    existing: OAuthTokenRecord,
    oauth: McpOAuthConfig,
  ): Promise<TokenRefreshResult> {
    const inFlight = this.tokenRefreshes.get(storeKey);
    if (inFlight) return inFlight;

    const run = (async (): Promise<TokenRefreshResult> => {
      try {
        const refreshed = await this.refreshToken(existing, oauth);
        // COMPARE-AND-SET. A `/mcp login` (or another writer) may have stored
        // a newer record for this key while our exchange was in flight.
        // Overwriting it would replace a known-good credential with one
        // derived from a refresh token that login very likely just rotated
        // away. Discard our result instead and report the record that won.
        if (!this.writeTokenIfUnchanged(storeKey, refreshed, revisionOf(existing))) {
          return { outcome: "superseded", token: this.readStore().mcpOAuth?.[storeKey] };
        }
        return { outcome: "refreshed", token: refreshed };
      } catch (error) {
        return { outcome: "failed", error };
      } finally {
        this.tokenRefreshes.delete(storeKey);
      }
    })();
    this.tokenRefreshes.set(storeKey, run);
    return run;
  }

  /**
   * Announce a freshly authenticated server, then every SIBLING bound to the
   * same `tokenStoreKey`. One interactive login stores one record that all of
   * them authenticate with, so notifying only the server whose build ran
   * leaves the siblings holding the header they were mounted with. They
   * cannot self-heal from that: the sweep sees a fresh record and skips the
   * key, and an authorization-code grant need not even return a refresh
   * token, so the 401 backstop may have nothing to spend.
   */
  private async notifyAuthReady(
    serverName: string,
    server: McpServerConfig,
    entry: ExternalMcpServerConfig,
    servers: Record<string, ExternalMcpServerConfig>,
  ): Promise<void> {
    await this.onServerAuthReady?.(serverName, server);

    const storeKey = entry.oauth?.tokenStoreKey;
    if (!storeKey || !this.onServerAuthReady) return;
    const token = this.readStore().mcpOAuth?.[storeKey];
    if (!token) return;
    for (const target of serversSharingStoreKey(servers, storeKey)) {
      if (target.name === serverName) continue;
      await this.onServerAuthReady(target.name, withBearer(target.server, token.accessToken));
    }
  }

  /**
   * Is a BROWSER flow running for any server on this store key? A build that
   * is only refreshing does not count — that exchange is joinable, and is
   * adopted rather than skipped.
   */
  private hasInteractiveAuthBuildForStoreKey(
    servers: Record<string, ExternalMcpServerConfig>,
    storeKey: string,
  ): boolean {
    for (const [name, build] of this.serverAuthBuilds) {
      if (servers[name]?.oauth?.tokenStoreKey !== storeKey) continue;
      // `forceInteractive` is an explicit /mcp login; `authorizeUrl` means an
      // ordinary build has already fallen through to the browser flow.
      if (build.forceInteractive || build.authorizeUrl !== undefined) return true;
    }
    return false;
  }

  async getFreshToken(
    serverName: string,
    server: McpServerConfig,
    oauth: McpOAuthConfig,
    sendAuthorizeUrl: (serverName: string, url: string) => Promise<void>,
    forceInteractive = false,
  ): Promise<OAuthTokenRecord> {
    const storeKey = oauth.tokenStoreKey;
    // Another path may already be spending this key's refresh token. Join it
    // rather than starting a second exchange: issuers that rotate refresh
    // tokens invalidate the old one on use. Keyed by store key, so a sibling
    // server sharing the key is recognised as the same race.
    //
    // NOT for an explicit `/mcp login`: the owner asked for a browser flow,
    // and its result supersedes whatever the refresh produces, so making the
    // login queue behind a slow (or stalled) exchange only delays it.
    const inFlight = forceInteractive ? undefined : this.tokenRefreshes.get(storeKey);
    if (inFlight) await inFlight;

    const store = this.readStore();
    const existing = store.mcpOAuth?.[storeKey];
    if (!forceInteractive && existing && !this.isExpiring(existing)) return existing;

    if (!forceInteractive && existing?.refreshToken) {
      const usable = await this.refreshOrAdopt(storeKey, existing, oauth);
      if (usable) return usable;
      // Refresh rejected (or produced nothing usable) — fall through to a
      // full browser auth flow.
    }

    const authorized = await this.runAuthorizationCodeFlow(serverName, server, oauth, existing, sendAuthorizeUrl);
    // An authorization-code grant is a brand-new credential, not a derivative
    // of the stored one, so it overwrites unconditionally. Any refresh still
    // in flight for this key is thereby superseded: its compare-and-set is
    // pinned to the pre-login revision and can no longer match.
    this.writeToken(storeKey, authorized);
    return authorized;
  }

  /**
   * Refresh `existing`, or adopt whatever record beat us to the store — but
   * only if what we end up holding is actually usable.
   *
   * The subtlety is the adoption case. Our exchange can be stalled for
   * minutes; the record that supersedes it may be short-lived, and may even
   * have expired while we were blocked. Returning it unchecked would mount a
   * token we already know is expiring, so the freshness decision is re-run on
   * the winner and one further exchange is allowed to rescue it. Bounded to
   * one retry: two failures mean the browser flow is the honest answer.
   */
  private async refreshOrAdopt(
    storeKey: string,
    existing: OAuthTokenRecord,
    oauth: McpOAuthConfig,
    allowRetry = true,
  ): Promise<OAuthTokenRecord | undefined> {
    const result = await this.refreshStoredToken(storeKey, existing, oauth);
    if (result.outcome === "refreshed") return result.token;
    if (result.outcome !== "superseded" || !result.token) return undefined;

    const winner = result.token;
    if (!this.isExpiring(winner)) return winner;
    if (!allowRetry || !winner.refreshToken) return undefined;
    return this.refreshOrAdopt(storeKey, winner, oauth, false);
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

    const refreshed = normalizeToken(token, this.now(), {
      clientId,
      clientSecret: existing.clientSecret,
      authorizationServer: existing.authorizationServer,
      authorizationEndpoint: existing.authorizationEndpoint,
      tokenEndpoint: existing.tokenEndpoint,
      registrationEndpoint: existing.registrationEndpoint,
      resource: existing.resource,
    });
    return {
      ...existing,
      ...refreshed,
      // `normalizeToken` always CARRIES an `expiresAt` key, so a response
      // without `expires_in` spread `undefined` over a perfectly good stored
      // expiry — and `isExpiring` reads undefined as "never expires". The
      // sweep then stopped looking at the key entirely and the access token
      // died in silence, every call 401ing until the backstop noticed.
      expiresAt: carryForwardExpiry(refreshed.expiresAt, existing.expiresAt, this.now()),
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

  /**
   * Compare-and-set variant of writeToken: stores `token` only if the record
   * under `key` still carries `expectedUpdatedAt`. The read and the write are
   * in one synchronous block, so nothing can interleave between them.
   * Returns false when another writer won the race.
   */
  private writeTokenIfUnchanged(key: string, token: OAuthTokenRecord, expectedRevision: number): boolean {
    const current = this.readStore().mcpOAuth?.[key];
    // A record that VANISHED (revoked, cleared, hand-edited out) must not be
    // resurrected by an exchange that started while it still existed.
    if (!current) return false;
    if (revisionOf(current) !== expectedRevision) return false;
    this.writeToken(key, token);
    return true;
  }

  private writeToken(key: string, token: OAuthTokenRecord): void {
    // Any successful write clears the sweep's rest period: a refresh that
    // worked, and an interactive login that replaced the credential the
    // rejections were about.
    this.refreshBackoff.delete(key);
    // Read-merge-write on the freshest copy, written atomically: a crash
    // mid-write must not truncate a file holding every server's refresh
    // token (readStore treats corrupt JSON as an empty store, so a torn
    // write would otherwise silently discard all stored credentials).
    const store = this.readStore();
    store.mcpOAuth = store.mcpOAuth ?? {};
    // Stamped here rather than by callers so EVERY path — refresh, interactive
    // grant, migration of a pre-revision record — advances it exactly once.
    store.mcpOAuth[key] = { ...token, revision: revisionOf(store.mcpOAuth[key]) + 1 };

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

/**
 * The expiry to store for a refreshed token.
 *
 * Never erases: an omitted `expires_in` means "the issuer did not say", not
 * "this token is immortal". A stored expiry that is still usefully in the
 * future is kept as the best evidence available. One that is not cannot be
 * kept — the token was just issued, and a stale reading would leave the record
 * permanently inside the refresh skew window, re-refreshed every sweep — so
 * the conservative default TTL stands in. Undefined stays undefined: the
 * issuer has never told us, and inventing an expiry would start refreshing a
 * token that was working.
 *
 * "USEFULLY IN THE FUTURE" IS `now + SKEW`, NOT `now`. The cutoff has to be
 * the one {@link McpOAuthManager.isExpiring} uses, because that is what reads
 * the value back: an expiry one minute out is in the future and is ALSO
 * already inside the skew window, so keeping it hands the sweep a record it
 * immediately judges expiring, refreshes, and stores the same near-expiry
 * reading onto again. Up to five minutes of 60s sweeps — around five pointless
 * exchanges against the issuer per refresh, each one a chance to trip a rate
 * limit — before the value finally aged past `now` and the default took over.
 * The same test the past-expiry case gets: anything the sweep would call
 * expiring is replaced rather than carried.
 */
function carryForwardExpiry(fresh: number | undefined, previous: number | undefined, now: number): number | undefined {
  if (fresh !== undefined) return fresh;
  if (previous === undefined) return undefined;
  return previous > now + TOKEN_REFRESH_SKEW_MS ? previous : now + DEFAULT_ACCESS_TOKEN_TTL_MS;
}

function supportsHeaders(server: McpServerConfig): server is Extract<McpServerConfig, { type: "http" | "sse" }> {
  return server.type === "http" || server.type === "sse";
}

/**
 * Every configured server bound to `storeKey`. One stored token can serve
 * several server entries (same upstream, different tool surfaces), and all of
 * them need the refreshed header.
 */
/** Stored revision, treating a missing/pre-migration field as 0. */
function revisionOf(record: OAuthTokenRecord | undefined): number {
  return typeof record?.revision === "number" ? record.revision : 0;
}

function serversSharingStoreKey(
  servers: Record<string, ExternalMcpServerConfig>,
  storeKey: string,
): Array<{ name: string; server: Extract<McpServerConfig, { type: "http" | "sse" }> }> {
  const targets: Array<{ name: string; server: Extract<McpServerConfig, { type: "http" | "sse" }> }> = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.oauth?.tokenStoreKey !== storeKey) continue;
    if (!supportsHeaders(entry.server)) continue;
    targets.push({ name, server: entry.server });
  }
  return targets;
}

function withBearer(
  server: Extract<McpServerConfig, { type: "http" | "sse" }>,
  accessToken: string,
): McpServerConfig {
  return {
    ...server,
    headers: { ...(server.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  };
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

/**
 * The fixed base the callback listener parses its request target against.
 *
 * NOT `req.headers.host`. That header is whatever the client sent — this
 * listener answers on loopback, but anything that can open a socket to it can
 * put an empty, spaced or bracketed value in there, and `new URL(path,
 * \`http://\${host}\`)` throws `Invalid URL` on every one of them. The throw
 * happened inside the 'request' listener, which makes it an uncaughtException:
 * process-handlers.ts logs it and exits 1, so ONE malformed request to a
 * transient OAuth callback port took the whole daemon down. The listener is
 * bound to 127.0.0.1 and routes on the path alone, so the authority in the
 * parse base is bookkeeping — pin it and the header stops mattering.
 */
const CALLBACK_URL_BASE = "http://127.0.0.1";

/**
 * The request target as a URL, or null when it is not one this listener will
 * answer. Origin-form only (`/oauth/callback?...`): a target beginning `//` is
 * protocol-relative and would silently move the authority onto whatever
 * follows it, and absolute-form is a proxy shape that has no business here.
 */
function parseCallbackTarget(target: string | undefined): URL | null {
  if (!target || !target.startsWith("/") || target.startsWith("//")) return null;
  try {
    return new URL(target, CALLBACK_URL_BASE);
  } catch {
    return null;
  }
}

/** Exported for tests — nothing outside this module starts one. */
export async function startCallbackServer(configuredRedirectUri?: string) {
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
    // NOTHING inside here may throw: an exception in a 'request' listener is
    // an uncaughtException, and the daemon's handler for that exits.
    try {
      handleCallbackRequest(req, res);
    } catch (err) {
      log.warn({ err }, "MCP OAuth callback request failed");
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        // The socket is already gone; there is nowhere left to report.
      }
    }
  });

  const handleCallbackRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = parseCallbackTarget(req.url);
    if (!url) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
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
  };

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
