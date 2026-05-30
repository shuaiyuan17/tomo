import { describe, expect, it } from "vitest";
import { expandEnvVars, parseExternalMcpServers } from "../src/mcp/external-config.js";

describe("external MCP config", () => {
  it("parses stdio, http, and sse servers", () => {
    const servers = parseExternalMcpServers({
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "$ROOT"],
        env: { TOKEN: "${TOKEN}" },
      },
      docs: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      events: {
        type: "sse",
        url: "https://example.com/sse",
        alwaysLoad: true,
        timeout: 5000,
      },
    }, { ROOT: "/tmp/root", TOKEN: "secret" });

    expect(servers.filesystem.server).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/root"],
      env: { TOKEN: "secret" },
    });
    expect(servers.docs.server).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    expect(servers.events.server).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      alwaysLoad: true,
      timeout: 5000,
    });
  });

  it("skips disabled or malformed servers", () => {
    const servers = parseExternalMcpServers({
      disabled: { type: "http", url: "https://example.com/mcp", enabled: false },
      badName: { type: "http" },
      "bad name": { command: "node", args: ["server.js"] },
      valid: { type: "stdio", command: "node", args: ["server.js"] },
    });

    expect(Object.keys(servers)).toEqual(["valid"]);
    expect(servers.valid.server).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
  });

  it("expands braced and bare environment variables", () => {
    expect(expandEnvVars("Bearer ${TOKEN} from $HOST", { TOKEN: "abc", HOST: "local" })).toBe("Bearer abc from local");
  });

  it("parses harness-only OAuth config without putting it in the SDK server object", () => {
    const servers = parseExternalMcpServers({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        oauth: {
          authorizationServer: "https://${AUTH_HOST}",
          clientId: "client-123",
          scopes: "repo read:user",
          tokenStoreKey: "github-copilot",
          redirectUri: "http://127.0.0.1:3917/callback",
        },
      },
    }, { AUTH_HOST: "github.com/login/oauth" });

    expect(servers.github.server).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    });
    expect(servers.github.oauth).toEqual({
      authorizationServer: "https://github.com/login/oauth",
      clientId: "client-123",
      scopes: ["repo", "read:user"],
      tokenStoreKey: "github-copilot",
      redirectUri: "http://127.0.0.1:3917/callback",
      clientName: "Tomo",
    });
  });
});
