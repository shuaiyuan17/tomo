import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkMcpServer, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// The REAL Agent SDK builds the CLI command line here; only the process spawn
// is intercepted, so the argv asserted on is exactly what `ps` would show.

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LiveSession } = await import("../src/agent/live-session.js");
type LiveSessionOptions = ConstructorParameters<typeof LiveSession>[0];

const ACCESS_TOKEN = "tok-live-oauth-access-token-0123456789";
const STDIO_SECRET = "stdio-api-key-9876543210";

const sessions: Array<InstanceType<typeof LiveSession>> = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

function startSession(): Promise<SpawnOptions> {
  return new Promise<SpawnOptions>((resolve) => {
    const options = {
      cwd: process.cwd(),
      settingSources: [],
      mcpServers: {
        remote: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
        local: { type: "stdio", command: "some-mcp", env: { API_KEY: STDIO_SECRET } },
        tomo: createSdkMcpServer({ name: "tomo", tools: [] }),
      },
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
        resolve(spawnOptions);
        // A stand-in child that never answers: the session stays un-initialized
        // until the test closes it.
        return spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
      },
    } as unknown as LiveSessionOptions;
    sessions.push(new LiveSession(options, "dm:test"));
  });
}

function mcpConfigPath(args: string[]): string {
  const values = args
    .map((arg, i) => (arg === "--mcp-config" ? args[i + 1] : undefined))
    .filter((value): value is string => value !== undefined);
  expect(values).toHaveLength(1);
  expect(values[0].trimStart().startsWith("{")).toBe(false);
  return values[0];
}

describe("LiveSession: external MCP configs stay off the CLI argv", () => {
  it("never puts a bearer token (or a stdio server's env) on the spawned command line", async () => {
    const spawned = await startSession();
    const argv = [spawned.command, ...spawned.args].join(" ");

    expect(argv).not.toContain(ACCESS_TOKEN);
    expect(argv).not.toContain("Authorization");
    expect(argv).not.toContain(STDIO_SECRET);
  });

  it("hands the external servers to the CLI in a 0600 file it removes when the session ends", async () => {
    const spawned = await startSession();
    const path = mcpConfigPath(spawned.args);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const staged = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    // The in-process server is registered over the SDK's initialize request,
    // not through this file.
    expect(Object.keys(staged.mcpServers).sort()).toEqual(["local", "remote"]);
    expect(staged.mcpServers.remote.headers?.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    sessions.splice(0).forEach((session) => session.close());
    expect(existsSync(path)).toBe(false);
  });
});
