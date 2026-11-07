import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Keep external MCP server configs OFF the `claude` child's argv.
 *
 * The Agent SDK serializes `options.mcpServers` into `--mcp-config <json>` on
 * the command line of the CLI child it spawns. For an OAuth-authenticated MCP
 * server that JSON carries `headers.Authorization: Bearer <access token>`
 * (and a stdio server's `env` may carry API keys), and argv is readable by
 * every local process through `ps`.
 *
 * The CLI also accepts `--mcp-config <path>`, and repeated `--mcp-config`
 * flags are merged. So every non-`sdk` server moves into a JSON file in a
 * fresh 0700 temp directory, written 0600, and only its PATH goes on argv via
 * `extraArgs`. In-process (`type: "sdk"`) servers stay in `mcpServers`: the
 * SDK has to see them to route their tool calls, and they carry no secrets.
 *
 * The CLI parses the file once, at startup, so the caller deletes it as soon
 * as the child has answered the SDK's initialize request (see LiveSession).
 * Token refresh is unaffected: a refreshed header reaches a running session
 * through `setMcpServers`, a control request on the child's stdin.
 */

type McpServers = NonNullable<Options["mcpServers"]>;

export interface StagedMcpConfig<T extends { mcpServers?: McpServers; extraArgs?: Options["extraArgs"] }> {
  options: T;
  /** Remove the staged file. Idempotent; never throws. */
  dispose: () => void;
}

/** Staged directories not yet disposed — removed on process exit as a backstop. */
const pending = new Set<string>();
let exitHookInstalled = false;

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover in the per-user temp dir is not worth a crash.
  }
  pending.delete(dir);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of [...pending]) removeDir(dir);
  });
}

export function stageExternalMcpServers<T extends { mcpServers?: McpServers; extraArgs?: Options["extraArgs"] }>(
  options: T,
): StagedMcpConfig<T> {
  const servers = options.mcpServers ?? {};
  const inProcess: McpServers = {};
  const external: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "sdk") inProcess[name] = server;
    else external[name] = server;
  }
  if (Object.keys(external).length === 0) return { options, dispose: () => {} };

  const dir = mkdtempSync(join(tmpdir(), "tomo-mcp-"));
  pending.add(dir);
  installExitHook();
  const path = join(dir, "mcp-config.json");
  try {
    // `wx`: never follow or reuse something already at the path.
    writeFileSync(path, JSON.stringify({ mcpServers: external }), { mode: 0o600, flag: "wx" });
  } catch (err) {
    removeDir(dir);
    throw err;
  }

  let disposed = false;
  return {
    options: {
      ...options,
      mcpServers: inProcess,
      extraArgs: { ...(options.extraArgs ?? {}), "mcp-config": path },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      removeDir(dir);
    },
  };
}
