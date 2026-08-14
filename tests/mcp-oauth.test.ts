import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpOAuthManager } from "../src/mcp/oauth.js";
import type { ExternalMcpServerConfig } from "../src/mcp/external-config.js";

const TEST_DIR = join(tmpdir(), "tomo-test-mcp-oauth");

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
});
