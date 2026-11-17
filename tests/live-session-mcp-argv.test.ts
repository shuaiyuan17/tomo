import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkMcpServer, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// The REAL Agent SDK builds the CLI command line and the initialize request
// here; only the process spawn is intercepted, so the argv asserted on is
// exactly what `ps` would show, and the stdin is exactly what the CLI reads.

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { LiveSession } = await import("../src/agent/live-session.js");
type LiveSessionOptions = ConstructorParameters<typeof LiveSession>[0];

const ACCESS_TOKEN = "tok-live-oauth-access-token-0123456789";
const STDIO_SECRET = "stdio-api-key-9876543210";

const sessions: Array<InstanceType<typeof LiveSession>> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts a session whose stand-in CLI copies everything it reads on stdin to a file. */
function startSession(): Promise<{ spawned: SpawnOptions; stdinFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tomo-mcp-argv-"));
  dirs.push(dir);
  const stdinFile = join(dir, "stdin.jsonl");
  return new Promise((resolve) => {
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
        resolve({ spawned: spawnOptions, stdinFile });
        // Never answers, so the session stays un-initialized until closed.
        return spawn(
          process.execPath,
          ["-e", "const f=require('fs').createWriteStream(process.argv[1]);process.stdin.pipe(f)", stdinFile],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
      },
    } as unknown as LiveSessionOptions;
    sessions.push(new LiveSession(options, "dm:test"));
  });
}

async function readInitialize(stdinFile: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    let text = "";
    try {
      text = readFileSync(stdinFile, "utf8");
    } catch {
      // not created yet
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { type?: string; request?: { subtype?: string } };
      if (msg.type === "control_request" && msg.request?.subtype === "initialize") return msg.request as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no initialize request reached the CLI's stdin");
}

describe("LiveSession: external MCP configs stay off the CLI argv", () => {
  it("never puts a bearer token, a stdio server's env, or any --mcp-config on the command line", async () => {
    const { spawned } = await startSession();
    const argv = [spawned.command, ...spawned.args].join(" ");

    expect(argv).not.toContain(ACCESS_TOKEN);
    expect(argv).not.toContain("Authorization");
    expect(argv).not.toContain(STDIO_SECRET);
    expect(spawned.args).not.toContain("--mcp-config");
  });

  it("hands the external servers to the CLI over stdin in the initialize request", async () => {
    const { stdinFile } = await startSession();
    const init = JSON.stringify(await readInitialize(stdinFile));

    expect(init).toContain(`Bearer ${ACCESS_TOKEN}`);
    expect(init).toContain(STDIO_SECRET);
    expect(init).toContain("https://mcp.example.test/mcp");
  });
});
