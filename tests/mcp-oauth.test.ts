import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { McpOAuthManager, startCallbackServer } from "../src/mcp/oauth.js";
import { log } from "../src/logger.js";
import type { ExternalMcpServerConfig } from "../src/mcp/external-config.js";

const TEST_DIR = join(tmpdir(), "tomo-test-mcp-oauth");

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function resetDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

describe("McpOAuthManager", () => {
  it("writes refreshed OAuth tokens to mcp-oauth.json and leaves keychain.json untouched", async () => {
    resetDir();
    const secretsDir = join(TEST_DIR, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const keychainPath = join(secretsDir, "keychain.json");
    const oauthPath = join(secretsDir, "mcp-oauth.json");
    const keychainContent = JSON.stringify({ _meta: {}, entries: [{ service: "login" }] }, null, 2);
    writeFileSync(keychainPath, keychainContent);
    writeFileSync(oauthPath, JSON.stringify({
      mcpOAuth: {
        github: {
          accessToken: "old-access",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          expiresAt: 1_000_000 + 1_000,
          clientId: "client-123",
          tokenEndpoint: "https://auth.example/token",
          updatedAt: 999_000,
        },
      },
    }));

    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      now: () => 1_000_000,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "fresh-access",
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await manager.withOAuthHeader("github", {
      server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "github" },
    }, async () => {
      throw new Error("auth should not be requested");
    });

    expect(readFileSync(keychainPath, "utf-8")).toBe(keychainContent);
    const stored = JSON.parse(readFileSync(oauthPath, "utf-8"));
    expect(stored.mcpOAuth.github.accessToken).toBe("fresh-access");
    expect((statSync(oauthPath).mode & 0o777)).toBe(0o600);
  });

  it("preserves static headers when no OAuth block is configured", async () => {
    resetDir();
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const servers = await manager.buildServersWithAuth({
      docs: {
        server: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { "X-Static": "yes" },
        },
      },
    }, async () => {
      throw new Error("auth should not be requested");
    });

    expect(servers.docs).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-Static": "yes" },
    });
  });

  it("notifies the host when an authenticated server config becomes ready", async () => {
    resetDir();
    const tokenStorePath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(tokenStorePath, JSON.stringify({
      mcpOAuth: {
        docs: {
          accessToken: "fresh-access",
          tokenType: "Bearer",
          expiresAt: 4_600_000,
          updatedAt: 1_000_000,
        },
      },
    }));
    const onServerAuthReady = vi.fn();
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath,
      now: () => 1_000_000,
      fetchImpl: async () => { throw new Error("fetch should not be called"); },
      onServerAuthReady: (name, server) => {
        onServerAuthReady(name, server);
        signalReady();
      },
    });

    await expect(manager.buildServersWithAuth({
      docs: {
        server: { type: "http", url: "https://docs.example/mcp" },
        oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "docs" },
      },
    }, async () => {})).resolves.toMatchObject({
      docs: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer fresh-access" },
      },
    });
    await ready;
    expect(onServerAuthReady).toHaveBeenCalledWith("docs", expect.objectContaining({
      headers: { Authorization: "Bearer fresh-access" },
    }));
  });

  it("isolates per-server auth failures and returns working servers", async () => {
    resetDir();
    const errors: Array<{ name: string; message: string }> = [];
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      onServerAuthError: (name, err) => {
        errors.push({ name, message: err instanceof Error ? err.message : String(err) });
      },
    });

    const servers = await manager.buildServersWithAuth({
      static: {
        server: {
          type: "http",
          url: "https://static.example/mcp",
          headers: { Authorization: "Bearer long-lived" },
        },
      },
      broken: {
        server: { type: "http", url: "https://broken.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: [],
          tokenStoreKey: "broken",
        },
      },
      stdio: {
        server: { command: "node", args: ["server.js"] },
      },
    }, async () => {
      throw new Error("auth url should not be forwarded after discovery failure");
    });

    expect(servers).toEqual({
      static: {
        type: "http",
        url: "https://static.example/mcp",
        headers: { Authorization: "Bearer long-lived" },
      },
      stdio: {
        command: "node",
        args: ["server.js"],
      },
    });
    expect(errors).toEqual([{ name: "broken", message: "network down" }]);
    expect(manager.getServerStatuses({
      broken: {
        server: { type: "http", url: "https://broken.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: [],
          tokenStoreKey: "broken",
        },
      },
    })[0]).toMatchObject({
      state: "auth-failed",
      authRequired: true,
      lastError: "network down",
    });
  });

  it("refreshes near-expiry access tokens and injects Authorization without dropping static headers", async () => {
    resetDir();
    const tokenStorePath = join(TEST_DIR, "secrets", "keychain.json");
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(tokenStorePath, JSON.stringify({
      mcpOAuth: {
        github: {
          accessToken: "old-access",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          expiresAt: 1_000_000 + 1_000,
          clientId: "client-123",
          tokenEndpoint: "https://auth.example/token",
          updatedAt: 999_000,
        },
      },
    }));

    const seenBodies: string[] = [];
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath,
      now: () => 1_000_000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://auth.example/token");
        seenBodies.push(String(init?.body));
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const entry: ExternalMcpServerConfig = {
      server: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { "X-Static": "yes" },
      },
      oauth: {
        clientId: "client-123",
        scopes: ["repo"],
        tokenStoreKey: "github",
      },
    };

    const server = await manager.withOAuthHeader("github", entry, async () => {
      throw new Error("browser auth should not be requested for refreshable token");
    });

    expect(server).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        "X-Static": "yes",
        Authorization: "Bearer fresh-access",
      },
    });
    expect(seenBodies[0]).toContain("grant_type=refresh_token");
    expect(seenBodies[0]).toContain("refresh_token=refresh-token");

    const stored = JSON.parse(readFileSync(tokenStorePath, "utf-8"));
    expect(stored.mcpOAuth.github.accessToken).toBe("fresh-access");
    expect(stored.mcpOAuth.github.refreshToken).toBe("fresh-refresh");
    expect(stored.mcpOAuth.github.expiresAt).toBe(1_000_000 + 3_600_000);
    expect((statSync(tokenStorePath).mode & 0o777)).toBe(0o600);
  });

  it("does not read keychain.json as an OAuth store", async () => {
    resetDir();
    const secretsDir = join(TEST_DIR, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const keychainPath = join(secretsDir, "keychain.json");
    writeFileSync(keychainPath, JSON.stringify({
      _meta: { source: "keychain-export" },
      entries: [{ service: "example", account: "user" }],
    }));

    const errors: string[] = [];
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async () => {
        throw new Error("no OAuth token store exists");
      },
      onServerAuthError: (_name, err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });

    const servers = await manager.buildServersWithAuth({
      github: {
        server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        oauth: { authorizationServer: "https://auth.example", clientId: "client-123", scopes: [], tokenStoreKey: "github" },
      },
    }, async () => {});

    expect(servers).toEqual({});
    expect(errors).toEqual(["no OAuth token store exists"]);
    expect(existsSync(join(secretsDir, "mcp-oauth.json"))).toBe(false);
    expect(readFileSync(keychainPath, "utf-8")).toContain("\"entries\"");
  });

  it("discovers protected-resource metadata via POST probe and RFC 9728 well-known fallback", async () => {
    resetDir();
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: String(init?.body ?? "") });
        if (String(input) === "https://agent.robinhood.com/mcp/trading") {
          return new Response("", { status: 401 });
        }
        if (String(input) === "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading") {
          return new Response(JSON.stringify({
            resource: "https://agent.robinhood.com/mcp/trading",
            authorization_servers: ["https://auth.robinhood.com"],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(input) === "https://auth.robinhood.com/.well-known/oauth-authorization-server") {
          return new Response(JSON.stringify({
            authorization_endpoint: "https://auth.robinhood.com/authorize",
            token_endpoint: "https://auth.robinhood.com/token",
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      },
    });

    await expect(manager.withOAuthHeader("robinhood", {
      server: { type: "http", url: "https://agent.robinhood.com/mcp/trading" },
      oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "robinhood" },
    }, async () => {
      throw new Error("stop before waiting for callback");
    })).rejects.toThrow("stop before waiting for callback");

    expect(calls[0]).toEqual({
      url: "https://agent.robinhood.com/mcp/trading",
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "tomo", version: "1.0" },
        },
      }),
    });
    expect(calls.map((c) => c.url)).toContain("https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading");
    expect(calls.some((c) => c.method === "GET" && c.url === "https://agent.robinhood.com/mcp/trading")).toBe(false);
  });

  it("uses an unexpired stored token without refreshing", async () => {
    resetDir();
    const tokenStorePath = join(TEST_DIR, "secrets", "keychain.json");
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(tokenStorePath, JSON.stringify({
      mcpOAuth: {
        robinhood: {
          accessToken: "still-good",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          expiresAt: 1_000_000 + 600_000,
          updatedAt: 999_000,
        },
      },
    }));

    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath,
      now: () => 1_000_000,
      fetchImpl: async () => {
        throw new Error("fetch should not be called for unexpired token");
      },
    });

    const server = await manager.withOAuthHeader("robinhood", {
      server: { type: "sse", url: "https://agent.robinhood.com/mcp/trading" },
      oauth: { scopes: [], tokenStoreKey: "robinhood" },
    }, async () => {
      throw new Error("auth should not be requested");
    });

    expect(server).toEqual({
      type: "sse",
      url: "https://agent.robinhood.com/mcp/trading",
      headers: { Authorization: "Bearer still-good" },
    });

    // The non-blocking session-spawn mode must still include servers whose
    // token is already ready; only refresh/browser waits are omitted.
    await expect(manager.buildServersWithAuth({
      robinhood: {
        server: { type: "sse", url: "https://agent.robinhood.com/mcp/trading" },
        oauth: { scopes: [], tokenStoreKey: "robinhood" },
      },
    }, async () => {
      throw new Error("auth should not be requested");
    }, { authorizationWaitMs: 0 })).resolves.toEqual({
      robinhood: {
        type: "sse",
        url: "https://agent.robinhood.com/mcp/trading",
        headers: { Authorization: "Bearer still-good" },
      },
    });
  });

  it("does not block session startup on interactive auth and dedupes the background login", async () => {
    resetDir();
    let authorizeStarted!: () => void;
    const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
    let rejectAuthorize!: (err: Error) => void;
    const authorizeGate = new Promise<void>((_resolve, reject) => { rejectAuthorize = reject; });
    let authError!: (value: { name: string; message: string }) => void;
    const authFailed = new Promise<{ name: string; message: string }>((resolve) => { authError = resolve; });
    let authorizeCalls = 0;

    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://auth.example/.well-known/oauth-authorization-server");
        return new Response(JSON.stringify({
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      onServerAuthError: (name, err) => {
        authError({ name, message: err instanceof Error ? err.message : String(err) });
      },
    });
    const servers: Record<string, ExternalMcpServerConfig> = {
      "cloudflare-api": {
        server: { type: "http", url: "https://api.cloudflare.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: [],
          tokenStoreKey: "cloudflare-api",
        },
      },
    };
    const sendAuthorizeUrl = async () => {
      authorizeCalls++;
      authorizeStarted();
      await authorizeGate;
    };

    // Both session builds return without waiting for the browser callback.
    // The second one joins the first background flow rather than opening a
    // second callback listener or sending another authorization link.
    await expect(manager.buildServersWithAuth(servers, sendAuthorizeUrl, { authorizationWaitMs: 0 }))
      .resolves.toEqual({});
    await started;
    await expect(manager.buildServersWithAuth(servers, sendAuthorizeUrl, { authorizationWaitMs: 0 }))
      .resolves.toEqual({});
    expect(authorizeCalls).toBe(1);

    rejectAuthorize(new Error("login abandoned"));
    await expect(authFailed).resolves.toEqual({ name: "cloudflare-api", message: "login abandoned" });
  });

  it("completes a remote localhost callback pasted into chat and rejects replay", async () => {
    resetDir();
    const tokenStorePath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    const servers: Record<string, ExternalMcpServerConfig> = {
      "cloudflare-api": {
        server: { type: "http", url: "https://api.cloudflare.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: ["account:read"],
          tokenStoreKey: "cloudflare-api",
        },
      },
    };
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath,
      now: () => 1_000_000,
      fetchImpl: async (input, init) => {
        if (String(input) === "https://auth.example/.well-known/oauth-authorization-server") {
          return new Response(JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (String(input) === "https://auth.example/token") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("code_verifier")).toBeTruthy();
          return new Response(JSON.stringify({
            access_token: `access-${body.get("code")}`,
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      },
    });

    let resolveAuthorize!: (url: string) => void;
    const authorizeUrl = new Promise<string>((resolve) => { resolveAuthorize = resolve; });
    await manager.buildServersWithAuth(servers, async (_name, url) => resolveAuthorize(url), {
      authorizationWaitMs: 0,
    });
    const url = new URL(await authorizeUrl);
    const state = url.searchParams.get("state");
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "remote-code");
    redirect.searchParams.set("state", state!);

    expect(manager.getServerStatuses(servers)[0]).toMatchObject({
      name: "cloudflare-api",
      state: "auth-pending",
      mounted: false,
    });
    const ordinaryUrl = "https://github.com/login/device?code=promo-code";
    await expect(manager.completeAuthorizationFromChat(ordinaryUrl)).resolves.toEqual({
      status: "not-matched",
    });
    expect(manager.getServerStatuses(servers)[0]?.state).toBe("auth-pending");
    const wrongRedirect = new URL(redirect);
    wrongRedirect.searchParams.set("state", "not-the-pending-state");
    await expect(manager.completeAuthorizationFromChat(wrongRedirect.toString())).resolves.toEqual({
      status: "unknown-state",
    });
    expect(manager.getServerStatuses(servers)[0]?.state).toBe("auth-pending");
    await expect(manager.completeAuthorizationFromChat(redirect.toString())).resolves.toEqual({
      status: "completed",
      serverName: "cloudflare-api",
      expiresAt: 4_600_000,
    });
    expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth["cloudflare-api"].accessToken)
      .toBe("access-remote-code");
    expect(manager.getServerStatuses(servers, new Set(["cloudflare-api"]))[0]).toMatchObject({
      state: "connected",
      mounted: true,
      authRequired: false,
      expiresAt: 4_600_000,
    });
    await expect(manager.completeAuthorizationFromChat(redirect.toString())).resolves.toEqual({
      status: "already-completed",
      serverName: "cloudflare-api",
    });
  });

  it("forces per-server re-login and accepts a bare code when exactly one flow is pending", async () => {
    resetDir();
    const tokenStorePath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(tokenStorePath, JSON.stringify({
      mcpOAuth: {
        docs: {
          accessToken: "still-valid",
          tokenType: "Bearer",
          expiresAt: 9_000_000,
          updatedAt: 900_000,
        },
      },
    }));
    const servers: Record<string, ExternalMcpServerConfig> = {
      docs: {
        server: { type: "http", url: "https://docs.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: [],
          tokenStoreKey: "docs",
        },
      },
    };
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath,
      now: () => 1_000_000,
      fetchImpl: async (input, init) => {
        if (String(input).includes(".well-known/oauth-authorization-server")) {
          return new Response(JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (String(input) === "https://auth.example/token") {
          const body = new URLSearchParams(String(init?.body));
          return new Response(JSON.stringify({
            access_token: `replacement-${body.get("code")}`,
            token_type: "Bearer",
            expires_in: 7200,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      },
    });

    const login = await manager.startLogin("docs", servers);
    expect(login.reused).toBe(false);
    expect(login.url).toContain("https://auth.example/authorize");
    await expect(manager.startLogin("docs", servers)).resolves.toMatchObject({
      url: login.url,
      reused: true,
    });

    await expect(manager.completeAuthorizationFromChat("code=trimmed-code")).resolves.toEqual({
      status: "completed",
      serverName: "docs",
      expiresAt: 8_200_000,
    });
    expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.docs.accessToken)
      .toBe("replacement-trimmed-code");
  });

  it("starts a fresh explicit login immediately after a failed background build", async () => {
    resetDir();
    const servers: Record<string, ExternalMcpServerConfig> = {
      docs: {
        server: { type: "http", url: "https://docs.example/mcp" },
        oauth: {
          authorizationServer: "https://auth.example",
          clientId: "client-123",
          scopes: [],
          tokenStoreKey: "docs",
        },
      },
    };
    let metadataCalls = 0;
    let signalFailure!: () => void;
    const failureSeen = new Promise<void>((resolve) => { signalFailure = resolve; });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      fetchImpl: async (input, init) => {
        if (String(input).includes(".well-known/oauth-authorization-server")) {
          metadataCalls++;
          if (metadataCalls === 1) throw new Error("transient discovery failure");
          return new Response(JSON.stringify({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (String(input) === "https://auth.example/token") {
          const body = new URLSearchParams(String(init?.body));
          return new Response(JSON.stringify({
            access_token: `fresh-${body.get("code")}`,
            token_type: "Bearer",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      },
      onServerAuthError: async () => {
        signalFailure();
        await failureGate;
      },
    });

    await manager.buildServersWithAuth(servers, async () => {}, { authorizationWaitMs: 0 });
    await failureSeen;

    const retry = manager.startLogin("docs", servers);
    releaseFailure();
    await expect(retry).resolves.toMatchObject({
      reused: false,
      url: expect.stringContaining("https://auth.example/authorize"),
    });
    expect(metadataCalls).toBe(2);

    await expect(manager.completeAuthorizationFromChat("code=retry-code")).resolves.toMatchObject({
      status: "completed",
      serverName: "docs",
    });
  });

  // Issue #299 defect 1: getFreshToken only runs at session-build time, so a
  // token that expires while a session is live was never refreshed. The sweep
  // is the only thing that re-reads the store for a running daemon.
  describe("proactive refresh sweep", () => {
    function seedStore(token: Record<string, unknown>): string {
      resetDir();
      const secretsDir = join(TEST_DIR, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      const tokenStorePath = join(secretsDir, "mcp-oauth.json");
      writeFileSync(tokenStorePath, JSON.stringify({ mcpOAuth: { cloudflare: token } }));
      return tokenStorePath;
    }

    const servers: Record<string, ExternalMcpServerConfig> = {
      "cloudflare-api": {
        server: { type: "http", url: "https://api.example/mcp", headers: { "X-Static": "yes" } },
        oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
      },
    };

    const NOW = 2_000_000;

    it("refreshes a token inside the expiry skew and hot-mounts the new header", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        // 60s left: expired for all practical purposes, inside the 5min skew.
        expiresAt: NOW + 60_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_540_000,
      });
      const ready: Array<{ name: string; server: unknown }> = [];
      const tokenCalls: URLSearchParams[] = [];
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe("https://auth.example/token");
          tokenCalls.push(new URLSearchParams(String(init?.body)));
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-2",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        onServerAuthReady: (name, server) => { ready.push({ name, server }); },
      });

      await expect(manager.refreshExpiringTokens(servers)).resolves.toEqual(["cloudflare-api"]);

      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0].get("grant_type")).toBe("refresh_token");
      expect(tokenCalls[0].get("refresh_token")).toBe("refresh-1");
      expect(ready).toEqual([{
        name: "cloudflare-api",
        server: {
          type: "http",
          url: "https://api.example/mcp",
          headers: { "X-Static": "yes", Authorization: "Bearer fresh-access" },
        },
      }]);
      const stored = JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare;
      expect(stored.accessToken).toBe("fresh-access");
      expect(stored.refreshToken).toBe("refresh-2");
      expect(stored.expiresAt).toBe(NOW + 3_600_000);
    });

    it("leaves a token with plenty of life alone", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW + 30 * 60_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW,
      });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => { throw new Error("fetch should not be called"); },
        onServerAuthReady: () => { throw new Error("no hot-mount expected"); },
      });

      await expect(manager.refreshExpiringTokens(servers)).resolves.toEqual([]);
    });

    it("refreshes on demand after a 401, even before the skew window opens", async () => {
      const tokenStorePath = seedStore({
        accessToken: "revoked-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW + 30 * 60_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW,
      });
      const ready: string[] = [];
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => new Response(JSON.stringify({
          access_token: "fresh-access",
          token_type: "Bearer",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
        onServerAuthReady: (name) => { ready.push(name); },
      });

      await expect(manager.refreshServerToken("cloudflare-api", servers)).resolves.toBe("refreshed");
      expect(ready).toEqual(["cloudflare-api"]);
      expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare.accessToken)
        .toBe("fresh-access");
    });

    it("never opens a browser flow when the sweep's refresh is rejected", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "revoked",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (input) => {
          if (String(input) === "https://auth.example/token") {
            return new Response("invalid_grant", { status: 400 });
          }
          throw new Error(`unexpected fetch ${String(input)}`);
        },
        onServerAuthReady: () => { throw new Error("no hot-mount expected"); },
      });

      await expect(manager.refreshExpiringTokens(servers)).resolves.toEqual([]);
      // The stored record is untouched, and the failure is visible in /mcp.
      expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare.accessToken)
        .toBe("old-access");
      expect(manager.getServerStatuses(servers)).toMatchObject([{
        name: "cloudflare-api",
        state: "auth-failed",
        lastError: expect.stringContaining("400"),
      }]);
    });

    it("does nothing for a server with no stored refresh token", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => { throw new Error("fetch should not be called"); },
      });

      await expect(manager.refreshExpiringTokens(servers)).resolves.toEqual([]);
      await expect(manager.refreshServerToken("cloudflare-api", servers)).resolves.toBe("skipped");
    });

    // Codex review, objection 1: serialization was keyed by server name, so
    // two servers sharing one tokenStoreKey could each spend the same
    // rotating refresh token.
    it("spends one refresh token once for two servers sharing a tokenStoreKey", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const shared: Record<string, ExternalMcpServerConfig> = {
        "cloudflare-api": {
          server: { type: "http", url: "https://api.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
        "cloudflare-docs": {
          server: { type: "http", url: "https://docs.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
      };
      const refreshTokensSent: string[] = [];
      const ready: Array<{ name: string; auth: string }> = [];
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (_input, init) => {
          refreshTokensSent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        onServerAuthReady: (name, server) => {
          ready.push({
            name,
            auth: (server as { headers?: Record<string, string> }).headers?.Authorization ?? "",
          });
        },
      });

      const names = await manager.refreshExpiringTokens(shared);

      // ONE exchange for the shared credential...
      expect(refreshTokensSent).toEqual(["refresh-1"]);
      // ...but BOTH servers are re-mounted with the new header.
      expect(names.sort()).toEqual(["cloudflare-api", "cloudflare-docs"]);
      expect(ready).toEqual([
        { name: "cloudflare-api", auth: "Bearer fresh-access" },
        { name: "cloudflare-docs", auth: "Bearer fresh-access" },
      ]);
    });

    it("serializes a concurrent refresh across two servers on the same tokenStoreKey", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const shared: Record<string, ExternalMcpServerConfig> = {
        alpha: {
          server: { type: "http", url: "https://alpha.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
        beta: {
          server: { type: "http", url: "https://beta.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
      };
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      let exchanges = 0;
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => {
          exchanges++;
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      const first = manager.refreshServerToken("alpha", shared);
      const second = manager.refreshServerToken("beta", shared);
      releaseToken();

      await expect(first).resolves.toBe("refreshed");
      await expect(second).resolves.toBe("refreshed");
      expect(exchanges).toBe(1);
      expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare.refreshToken)
        .toBe("rotated-refresh");
    });

    // Codex review, objection 1: a slow refresh must not clobber a fresher
    // record written for the same key while it was in flight.
    it("discards a refresh whose store record moved under it", async () => {
      const tokenStorePath = seedStore({
        revision: 3,
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => {
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "stale-refresh-result",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        onServerAuthReady: () => { throw new Error("a superseded refresh must not re-mount"); },
      });

      const inFlight = manager.refreshServerToken("cloudflare-api", servers);
      // A /mcp login lands while the exchange is out. Any real writer goes
      // through writeToken, so it advances the revision.
      writeFileSync(tokenStorePath, JSON.stringify({
        mcpOAuth: {
          cloudflare: {
            revision: 4,
            accessToken: "login-access",
            refreshToken: "login-refresh",
            tokenType: "Bearer",
            expiresAt: NOW + 3_600_000,
            clientId: "client-123",
            tokenEndpoint: "https://auth.example/token",
            updatedAt: NOW,
          },
        },
      }));
      releaseToken();

      await expect(inFlight).resolves.toBe("superseded");
      const stored = JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare;
      expect(stored.accessToken).toBe("login-access");
      expect(stored.refreshToken).toBe("login-refresh");
    });

    // Codex round 3, finding 1: the build path (getFreshToken) never
    // registered its own exchange, so two sibling session builds could spend
    // the same rotating refresh token concurrently.
    it("performs one exchange when two servers sharing a key are built concurrently", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const alpha: Record<string, ExternalMcpServerConfig> = {
        alpha: {
          server: { type: "http", url: "https://alpha.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
      };
      const beta: Record<string, ExternalMcpServerConfig> = {
        beta: {
          server: { type: "http", url: "https://beta.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
      };
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      const refreshTokensSent: string[] = [];
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (_input, init) => {
          refreshTokensSent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      // Two sessions building sibling servers at the same instant.
      const building = Promise.all([
        manager.buildServersWithAuth(alpha, async () => { throw new Error("no browser flow expected"); }),
        manager.buildServersWithAuth(beta, async () => { throw new Error("no browser flow expected"); }),
      ]);
      releaseToken();
      const [alphaServers, betaServers] = await building;

      expect(refreshTokensSent).toEqual(["refresh-1"]);
      expect(alphaServers.alpha).toMatchObject({ headers: { Authorization: "Bearer fresh-access" } });
      expect(betaServers.beta).toMatchObject({ headers: { Authorization: "Bearer fresh-access" } });
      expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare.refreshToken)
        .toBe("rotated-refresh");
    });

    // Codex round 3, finding 2.
    it("hot-mounts every server sharing the key when one of them completes a login", async () => {
      resetDir();
      const secretsDir = join(TEST_DIR, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      const tokenStorePath = join(secretsDir, "mcp-oauth.json");
      const shared: Record<string, ExternalMcpServerConfig> = {
        alpha: {
          server: { type: "http", url: "https://alpha.example/mcp" },
          oauth: {
            authorizationServer: "https://auth.example",
            clientId: "client-123",
            scopes: [],
            tokenStoreKey: "cloudflare",
          },
        },
        beta: {
          server: { type: "http", url: "https://beta.example/mcp", headers: { "X-Static": "yes" } },
          oauth: {
            authorizationServer: "https://auth.example",
            clientId: "client-123",
            scopes: [],
            tokenStoreKey: "cloudflare",
          },
        },
      };
      const ready: Array<{ name: string; auth: string }> = [];
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (input) => {
          if (String(input).includes(".well-known/oauth-authorization-server")) {
            return new Response(JSON.stringify({
              authorization_endpoint: "https://auth.example/authorize",
              token_endpoint: "https://auth.example/token",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (String(input) === "https://auth.example/token") {
            // An authorization-code grant need not return a refresh token —
            // which is exactly why beta cannot self-heal from a 401 later.
            return new Response(JSON.stringify({
              access_token: "login-access",
              token_type: "Bearer",
              expires_in: 3600,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          throw new Error(`unexpected fetch ${String(input)}`);
        },
        onServerAuthReady: (name, server) => {
          ready.push({
            name,
            auth: (server as { headers?: Record<string, string> }).headers?.Authorization ?? "",
          });
        },
      });

      await manager.startLogin("alpha", shared);
      await expect(manager.completeAuthorizationFromChat("code=login-code")).resolves.toMatchObject({
        status: "completed",
        serverName: "alpha",
      });
      // The notification is detached from the build promise.
      await vi.waitFor(() => expect(ready).toHaveLength(2));

      expect(ready).toEqual([
        { name: "alpha", auth: "Bearer login-access" },
        { name: "beta", auth: "Bearer login-access" },
      ]);
      // Sibling keeps its own static headers alongside the new bearer.
      const betaReady = ready.find((r) => r.name === "beta");
      expect(betaReady).toBeDefined();
    });

    // Codex round 4, finding 1: `updatedAt` is a millisecond clock reading, so
    // a login written in the same millisecond as the refresh's expectation was
    // indistinguishable from no write at all.
    it("discards a refresh superseded by a login written in the same millisecond", async () => {
      resetDir();
      const secretsDir = join(TEST_DIR, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      const tokenStorePath = join(secretsDir, "mcp-oauth.json");
      // updatedAt === NOW, and the manager's clock is pinned to NOW, so every
      // write in this test carries the identical timestamp.
      writeFileSync(tokenStorePath, JSON.stringify({
        mcpOAuth: {
          cloudflare: {
            revision: 1,
            accessToken: "old-access",
            refreshToken: "refresh-1",
            tokenType: "Bearer",
            expiresAt: NOW - 1_000,
            clientId: "client-123",
            tokenEndpoint: "https://auth.example/token",
            updatedAt: NOW,
          },
        },
      }));
      const loginServers: Record<string, ExternalMcpServerConfig> = {
        "cloudflare-api": {
          server: { type: "http", url: "https://api.example/mcp" },
          oauth: {
            authorizationServer: "https://auth.example",
            clientId: "client-123",
            scopes: [],
            tokenStoreKey: "cloudflare",
          },
        },
      };
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async (input, init) => {
          if (String(input).includes(".well-known/oauth-authorization-server")) {
            return new Response(JSON.stringify({
              authorization_endpoint: "https://auth.example/authorize",
              token_endpoint: "https://auth.example/token",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          const grant = new URLSearchParams(String(init?.body)).get("grant_type");
          if (grant === "refresh_token") {
            await refreshGate;
            return new Response(JSON.stringify({
              access_token: "stale-refresh-result",
              token_type: "Bearer",
              expires_in: 3600,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({
            access_token: "login-access",
            refresh_token: "login-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      const refreshing = manager.refreshServerToken("cloudflare-api", loginServers);
      // A real /mcp login completes while the refresh exchange is stalled.
      await manager.startLogin("cloudflare-api", loginServers);
      await expect(manager.completeAuthorizationFromChat("code=login-code")).resolves.toMatchObject({
        status: "completed",
      });
      releaseRefresh();

      await expect(refreshing).resolves.toBe("superseded");
      const stored = JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare;
      expect(stored.accessToken).toBe("login-access");
      expect(stored.updatedAt).toBe(NOW);
    });

    it("does not resurrect a token record deleted while its refresh was in flight", async () => {
      const tokenStorePath = seedStore({
        revision: 2,
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => {
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "resurrected",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        onServerAuthReady: () => { throw new Error("a discarded refresh must not re-mount") },
      });

      const inFlight = manager.refreshServerToken("cloudflare-api", servers);
      // The credential is revoked/cleared while the exchange is out.
      writeFileSync(tokenStorePath, JSON.stringify({ mcpOAuth: {} }));
      releaseToken();

      await expect(inFlight).resolves.toBe("superseded");
      expect(JSON.parse(readFileSync(tokenStorePath, "utf-8")).mcpOAuth.cloudflare).toBeUndefined();
    });

    // Codex round 4, finding 2.
    it("does not adopt a superseding record that is itself expiring", async () => {
      let clock = NOW;
      const tokenStorePath = seedStore({
        revision: 1,
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const accessTokensIssued: string[] = [];
      let exchanges = 0;
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => clock,
        fetchImpl: async () => {
          exchanges++;
          if (exchanges === 1) await firstGate;
          const access = `rescued-${exchanges}`;
          accessTokensIssued.push(access);
          return new Response(JSON.stringify({
            access_token: access,
            refresh_token: `rotated-${exchanges}`,
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      // A session build starts a refresh, which stalls.
      const building = manager.buildServersWithAuth(servers, async () => {
        throw new Error("no browser flow expected");
      });
      // Let it read the store and reach the gated exchange before anything
      // else touches the record — otherwise it never races at all.
      await flushMicrotasks(20);
      expect(exchanges).toBe(1);
      // Meanwhile a short-lived record (60 s) wins the store...
      writeFileSync(tokenStorePath, JSON.stringify({
        mcpOAuth: {
          cloudflare: {
            revision: 9,
            accessToken: "short-lived-winner",
            refreshToken: "winner-refresh",
            tokenType: "Bearer",
            expiresAt: NOW + 60_000,
            clientId: "client-123",
            tokenEndpoint: "https://auth.example/token",
            updatedAt: NOW,
          },
        },
      }));
      // ...and by the time the stalled exchange returns, it has expired.
      clock = NOW + 120_000;
      releaseFirst();
      const built = await building;

      // The winner is expiring, so it is refreshed rather than mounted.
      expect(built["cloudflare-api"]).toMatchObject({
        headers: { Authorization: "Bearer rescued-2" },
      });
      expect(exchanges).toBe(2);
    });

    // Codex round 4, finding 3.
    it("lets a sibling 401 adopt a build-driven refresh instead of skipping", async () => {
      const tokenStorePath = seedStore({
        revision: 1,
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      const shared: Record<string, ExternalMcpServerConfig> = {
        alpha: {
          server: { type: "http", url: "https://alpha.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
        beta: {
          server: { type: "http", url: "https://beta.example/mcp" },
          oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "cloudflare" },
        },
      };
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      let exchanges = 0;
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => {
          exchanges++;
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      // alpha's session build owns an in-flight refresh...
      const building = manager.buildServersWithAuth(
        { alpha: shared.alpha! },
        async () => { throw new Error("no browser flow expected"); },
      );
      await flushMicrotasks();
      // ...and beta's live session hits a 401 while it is out.
      const sibling = manager.refreshServerToken("beta", shared);
      releaseToken();

      // The sibling learns the outcome instead of being told "skipped".
      await expect(sibling).resolves.toBe("refreshed");
      await building;
      expect(exchanges).toBe(1);
    });

    it("coalesces a concurrent sweep and 401 into a single token exchange", async () => {
      const tokenStorePath = seedStore({
        accessToken: "old-access",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: NOW - 1_000,
        clientId: "client-123",
        tokenEndpoint: "https://auth.example/token",
        updatedAt: NOW - 3_600_000,
      });
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
      let exchanges = 0;
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        tokenStorePath,
        now: () => NOW,
        fetchImpl: async () => {
          exchanges++;
          await tokenGate;
          return new Response(JSON.stringify({
            access_token: "fresh-access",
            token_type: "Bearer",
            expires_in: 3600,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });

      const sweep = manager.refreshExpiringTokens(servers);
      const onDemand = manager.refreshServerToken("cloudflare-api", servers);
      releaseToken();
      await expect(sweep).resolves.toEqual(["cloudflare-api"]);
      await expect(onDemand).resolves.toBe("refreshed");
      expect(exchanges).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The loopback callback listener. `req.headers.host` is whatever the client
// sent, and `new URL(path, `http://${host}`)` throws on a malformed one —
// inside a 'request' listener, which makes it an uncaughtException and takes
// the daemon with it.
// ---------------------------------------------------------------------------

describe("OAuth callback listener", () => {
  /** Speak raw HTTP so the Host header can be malformed on purpose — no
   *  client library will send these. Resolves with the status line. */
  function rawRequest(port: number, lines: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(lines));
      let seen = "";
      socket.setTimeout(5_000, () => {
        socket.destroy();
        reject(new Error("callback listener never answered"));
      });
      socket.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        socket.end();
      });
      socket.on("close", () => resolve(seen.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
  }

  function portOf(redirectUri: string): number {
    return Number(new URL(redirectUri).port);
  }

  it("answers a request whose Host header cannot be parsed", async () => {
    const callback = await startCallbackServer();
    const port = portOf(callback.redirectUri);
    try {
      // Every one of these makes `new URL(url, `http://${host}`)` throw
      // "Invalid URL" — including the empty value, which the old
      // `?? "127.0.0.1"` fallback did not cover because "" is not nullish.
      for (const host of ["]", "a b", "%%%", "", "x:99999999"]) {
        const status = await rawRequest(
          port,
          `GET /oauth/callback?code=abc&state=xyz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
        expect(status, host).toMatch(/^HTTP\/1\.1 200/);
      }
      // ...and the callback still resolved with the code, from the first one.
      await expect(callback.waitForCallback("xyz")).resolves.toEqual({ code: "abc", state: "xyz" });
    } finally {
      await callback.close();
    }
  });

  it("answers 400 for a request target it will not parse", async () => {
    const callback = await startCallbackServer();
    const port = portOf(callback.redirectUri);
    try {
      // Protocol-relative: `new URL("//evil/oauth/callback", base)` moves the
      // authority onto `evil` and keeps the pathname, so it would otherwise
      // route as a genuine callback.
      const status = await rawRequest(
        port,
        "GET //evil/oauth/callback?code=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(status).toMatch(/^HTTP\/1\.1 400/);
    } finally {
      await callback.close();
    }
  });

  it("still routes a well-formed callback", async () => {
    const callback = await startCallbackServer();
    const port = portOf(callback.redirectUri);
    try {
      const status = await rawRequest(
        port,
        "GET /oauth/callback?code=good&state=st HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(status).toMatch(/^HTTP\/1\.1 200/);
      await expect(callback.waitForCallback("st")).resolves.toEqual({ code: "good", state: "st" });
      const notFound = await rawRequest(
        port,
        "GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(notFound).toMatch(/^HTTP\/1\.1 404/);
    } finally {
      await callback.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A refresh the issuer REJECTS. The sweep runs every minute and used to leave
// no trace of one: a revoked refresh token was posted 1,440 times a day in
// total silence.
// ---------------------------------------------------------------------------

describe("McpOAuthManager — rejected refreshes", () => {
  const servers = (): Record<string, ExternalMcpServerConfig> => ({
    github: {
      server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "github" },
    },
  });

  function seedExpiringToken(oauthPath: string, now: number) {
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(oauthPath, JSON.stringify({
      mcpOAuth: {
        github: {
          accessToken: "old-access",
          refreshToken: "revoked-refresh-token",
          tokenType: "Bearer",
          expiresAt: now + 1_000,
          clientId: "client-123",
          tokenEndpoint: "https://auth.example/token",
          updatedAt: now - 1_000,
        },
      },
    }));
  }

  it("logs the failure and rests the key instead of posting every minute", async () => {
    resetDir();
    const oauthPath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    let clock = 1_000_000;
    seedExpiringToken(oauthPath, clock);

    let exchanges = 0;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        now: () => clock,
        fetchImpl: async () => {
          exchanges++;
          return new Response("revoked", { status: 400 });
        },
      });

      // Twenty minutes of the real sweep interval.
      for (let tick = 0; tick < 20; tick++) {
        await manager.refreshExpiringTokens(servers());
        clock += 60_000;
      }

      // Unbounded, this is one POST per tick.
      expect(exchanges).toBeGreaterThan(0);
      expect(exchanges).toBeLessThanOrEqual(6);
      // ...and every one of them said so.
      const refreshWarnings = warn.mock.calls.filter((c) => c[1] === "MCP OAuth token refresh failed");
      expect(refreshWarnings).toHaveLength(exchanges);
      expect(refreshWarnings[0][0]).toMatchObject({ storeKey: "github", server: "github", failures: 1 });
      expect((refreshWarnings[0][0] as { retryInMs: number }).retryInMs).toBe(60_000);
      // Exponential, capped at an hour.
      const delays = refreshWarnings.map((c) => (c[0] as { retryInMs: number }).retryInMs);
      expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 960_000].slice(0, delays.length));
    } finally {
      warn.mockRestore();
    }
  });

  it("still refreshes on a 401 backstop while the sweep is resting", async () => {
    resetDir();
    const oauthPath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    let clock = 1_000_000;
    seedExpiringToken(oauthPath, clock);

    let exchanges = 0;
    let reject = true;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const manager = new McpOAuthManager({
        workspaceDir: TEST_DIR,
        now: () => clock,
        fetchImpl: async () => {
          exchanges++;
          if (reject) return new Response("revoked", { status: 400 });
          return new Response(JSON.stringify({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await manager.refreshExpiringTokens(servers());
      expect(exchanges).toBe(1);
      // The sweep is resting...
      clock += 1_000;
      await manager.refreshExpiringTokens(servers());
      expect(exchanges).toBe(1);
      // ...but the 401 backstop is a user-visible event and always tries.
      reject = false;
      await expect(manager.refreshServerToken("github", servers())).resolves.toBe("refreshed");
      expect(exchanges).toBe(2);
      // A success clears the rest period: the very next sweep tries again
      // rather than sitting out the remainder of the old backoff.
      clock += 1_000;
      reject = true;
      const store = JSON.parse(readFileSync(oauthPath, "utf-8"));
      store.mcpOAuth.github.expiresAt = clock + 1_000;
      writeFileSync(oauthPath, JSON.stringify(store));
      await manager.refreshExpiringTokens(servers());
      expect(exchanges).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the stored expiry when a refresh response omits expires_in", async () => {
    resetDir();
    const oauthPath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    const clock = 1_000_000;
    // Comfortably outside the 5-minute refresh skew, so a record that keeps
    // it is not "expiring" and a record that loses it is not either — the
    // assertion has to read the stored value, not just isExpiring().
    const storedExpiry = clock + 10 * 60 * 1000;
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(oauthPath, JSON.stringify({
      mcpOAuth: {
        github: {
          accessToken: "old-access",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          expiresAt: storedExpiry,
          clientId: "client-123",
          tokenEndpoint: "https://auth.example/token",
          updatedAt: clock - 1_000,
        },
      },
    }));

    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      now: () => clock,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "fresh-access",
        token_type: "Bearer",
        // No expires_in — legal, and what spread `undefined` over the stored
        // value. `isExpiring` then read the record as "never expires", the
        // sweep stopped looking at it, and the access token died in silence.
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(manager.refreshServerToken("github", {
      github: {
        server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "github" },
      },
    })).resolves.toBe("refreshed");

    const stored = JSON.parse(readFileSync(oauthPath, "utf-8")).mcpOAuth.github;
    expect(stored.accessToken).toBe("fresh-access");
    expect(stored.expiresAt).toBe(storedExpiry);
    expect(manager.isExpiring(stored)).toBe(false);
  });

  it("replaces an already-past expiry rather than keeping it", async () => {
    resetDir();
    const oauthPath = join(TEST_DIR, "secrets", "mcp-oauth.json");
    const clock = 1_000_000;
    mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
    writeFileSync(oauthPath, JSON.stringify({
      mcpOAuth: {
        github: {
          accessToken: "old-access",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          expiresAt: clock - 60_000,
          clientId: "client-123",
          tokenEndpoint: "https://auth.example/token",
          updatedAt: clock - 1_000,
        },
      },
    }));

    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      now: () => clock,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "fresh-access",
        token_type: "Bearer",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await expect(manager.refreshServerToken("github", {
      github: {
        server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        oauth: { clientId: "client-123", scopes: [], tokenStoreKey: "github" },
      },
    })).resolves.toBe("refreshed");

    // Keeping the stale reading would leave it permanently inside the skew
    // window; erasing it would make it immortal. Neither.
    const stored = JSON.parse(readFileSync(oauthPath, "utf-8")).mcpOAuth.github;
    expect(stored.expiresAt).toBe(clock + 60 * 60 * 1000);
  });
});
