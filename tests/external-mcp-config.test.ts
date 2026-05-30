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

    expect(servers.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/root"],
      env: { TOKEN: "secret" },
    });
    expect(servers.docs).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    });
    expect(servers.events).toEqual({
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
    expect(servers.valid).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
  });

  it("expands braced and bare environment variables", () => {
    expect(expandEnvVars("Bearer ${TOKEN} from $HOST", { TOKEN: "abc", HOST: "local" })).toBe("Bearer abc from local");
  });
});
