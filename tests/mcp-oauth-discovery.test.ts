import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpOAuthManager } from "../src/mcp/oauth.js";
import { parseExternalMcpServers, type ExternalMcpServerConfig } from "../src/mcp/external-config.js";

const TEST_DIR = join(tmpdir(), "tomo-test-mcp-oauth-discovery");
const TOKEN_STORE = join(TEST_DIR, "secrets", "mcp-oauth.json");

function resetDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "secrets"), { recursive: true });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A spec-style MCP server: 401 + Bearer challenge, RFC 9728 + RFC 8414 metadata, DCR. */
function specServerFetch(calls: string[], opts: { challenge?: boolean; header?: string } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://grub.example/mcp") {
      if (opts.challenge === false) return json({ jsonrpc: "2.0", id: 1, result: {} });
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": opts.header ??
            'Bearer realm="OAuth", resource_metadata="https://grub.example/.well-known/oauth-protected-resource/mcp", scope="spots:read spots:write"',
        },
      });
    }
    if (url === "https://grub.example/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: "https://grub.example/mcp", authorization_servers: ["https://grub.example"] });
    }
    if (url === "https://grub.example/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://grub.example/authorize",
        token_endpoint: "https://grub.example/token",
        registration_endpoint: "https://grub.example/register",
      });
    }
    if (url === "https://grub.example/register") return json({ client_id: "dcr-client" }, 201);
    if (url === "https://grub.example/token") {
      const body = new URLSearchParams(String(init?.body));
      return json({ access_token: `tok-${body.get("code")}`, token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const grub = (extra: Partial<ExternalMcpServerConfig> = {}): Record<string, ExternalMcpServerConfig> => ({
  grub: { server: { type: "http", url: "https://grub.example/mcp" }, ...extra },
});

describe("MCP OAuth discovery for servers without an oauth block", () => {
  it("/mcp login discovers OAuth from a Bearer challenge, then later sessions mount with the token", async () => {
    resetDir();
    const calls: string[] = [];
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath: TOKEN_STORE,
      now: () => 1_000_000,
      fetchImpl: specServerFetch(calls),
    });

    const login = await manager.startLogin("grub", grub());
    const authorize = new URL(login.url);
    expect(authorize.origin + authorize.pathname).toBe("https://grub.example/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("dcr-client");
    expect(authorize.searchParams.get("scope")).toBe("spots:read spots:write");

    await expect(manager.completeAuthorizationFromChat("code=abc")).resolves.toMatchObject({
      status: "completed",
      serverName: "grub",
    });
    expect(JSON.parse(readFileSync(TOKEN_STORE, "utf-8")).mcpOAuth.grub.accessToken).toBe("tok-abc");

    // A fresh process (no in-memory discovery) still treats it as OAuth via the stored token.
    const restarted = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath: TOKEN_STORE,
      now: () => 1_000_000,
      fetchImpl: specServerFetch([]),
    });
    const built = await restarted.buildServersWithAuth(grub(), async () => {});
    expect(built.grub).toMatchObject({ headers: { Authorization: "Bearer tok-abc" } });
    expect(restarted.getServerStatuses(grub())[0]).toMatchObject({ name: "grub", oauth: true, authRequired: false });
  });

  it("finds a Bearer challenge that is not the first one and reads its own scope", async () => {
    resetDir();
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath: TOKEN_STORE,
      fetchImpl: specServerFetch([], {
        header: 'Basic realm="legacy", scope="basic-only", Bearer resource_metadata="https://grub.example/.well-known/oauth-protected-resource/mcp", scope="spots:read"',
      }),
    });
    const login = await manager.startLogin("grub", grub());
    expect(new URL(login.url).searchParams.get("scope")).toBe("spots:read");
  });

  it("does not mistake a scheme that merely starts with 'bearer' or a param value for a Bearer challenge", async () => {
    resetDir();
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath: TOKEN_STORE,
      fetchImpl: specServerFetch([], { header: 'BearerX realm="a", Basic realm="Bearer"' }),
    });
    await expect(manager.startLogin("grub", grub())).rejects.toThrow("does not use OAuth");
  });

  it("still reports 'does not use OAuth' when the server sends no Bearer challenge", async () => {
    resetDir();
    const manager = new McpOAuthManager({
      workspaceDir: TEST_DIR,
      tokenStorePath: TOKEN_STORE,
      fetchImpl: specServerFetch([], { challenge: false }),
    });
    await expect(manager.startLogin("grub", grub())).rejects.toThrow('MCP server "grub" does not use OAuth');
  });

  it("never probes a server opted out with oauth: false or carrying its own Authorization header", async () => {
    resetDir();
    const calls: string[] = [];
    const manager = new McpOAuthManager({ workspaceDir: TEST_DIR, tokenStorePath: TOKEN_STORE, fetchImpl: specServerFetch(calls) });
    await expect(manager.startLogin("grub", grub({ oauthDisabled: true }))).rejects.toThrow("does not use OAuth");
    const withHeader: Record<string, ExternalMcpServerConfig> = {
      grub: { server: { type: "http", url: "https://grub.example/mcp", headers: { authorization: "Bearer pat" } } },
    };
    await expect(manager.startLogin("grub", withHeader)).rejects.toThrow("does not use OAuth");
    expect(calls).toEqual([]);
  });

  it("leaves an unconfigured server unauthenticated at session build until someone logs in", async () => {
    resetDir();
    writeFileSync(TOKEN_STORE, JSON.stringify({ mcpOAuth: {} }));
    const calls: string[] = [];
    const manager = new McpOAuthManager({ workspaceDir: TEST_DIR, tokenStorePath: TOKEN_STORE, fetchImpl: specServerFetch(calls) });
    const built = await manager.buildServersWithAuth(grub(), async () => {});
    expect(built.grub).toEqual({ type: "http", url: "https://grub.example/mcp" });
    expect(calls).toEqual([]);
  });

  it("parses oauth: false as an explicit opt-out", () => {
    const servers = parseExternalMcpServers({
      grub: { type: "http", url: "https://grub.example/mcp" },
      plain: { type: "http", url: "https://plain.example/mcp", oauth: false },
    });
    expect(servers.grub.oauthDisabled).toBeUndefined();
    expect(servers.plain.oauthDisabled).toBe(true);
    expect(servers.plain.oauth).toBeUndefined();
  });
});
