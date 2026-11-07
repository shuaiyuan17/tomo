import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
 * as the child has answered the SDK's initialize request (see LiveSession),
 * again when the session ends, and on process exit. Staging lives under a
 * private per-user root, and each new staging sweeps entries left there by a
 * process that was killed before it could clean up.
 * Token refresh is unaffected: a refreshed header reaches a running session
 * through `setMcpServers`, a control request on the child's stdin.
 */

type McpServers = NonNullable<Options["mcpServers"]>;

export interface StagedMcpConfig<T extends { mcpServers?: McpServers; extraArgs?: Options["extraArgs"] }> {
  options: T;
  /** Remove the staged file. Idempotent, retried until it succeeds; never throws. */
  dispose: () => void;
}

/**
 * Staging whose owner PID is still running (or cannot be told) is swept only
 * once older than this — a backstop for PID reuse after a crash. The CLI reads
 * its file within seconds of spawning, so a live sibling's staging is never
 * this old.
 */
export const STALE_STAGING_MS = 10 * 60 * 1000;

/** Staged directories not yet removed — retried on dispose and on process exit. */
const pending = new Set<string>();
let exitHookInstalled = false;

/** True when the directory is gone afterwards. */
function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    pending.delete(dir);
    return true;
  } catch {
    // Kept in `pending` so a later dispose or the exit hook tries again.
    return false;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of [...pending]) removeDir(dir);
  });
}

/**
 * A per-user 0700 directory that holds nothing but staged configs, so stale
 * ones can be found and swept. Falls back to the bare temp dir when the root
 * is not a private directory we own (never trust a pre-planted one).
 */
function stagingRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const root = join(tmpdir(), `tomo-mcp-config${uid === undefined ? "" : `-${uid}`}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = lstatSync(root);
    const owned = uid === undefined || st.uid === uid;
    if (st.isDirectory() && !st.isSymbolicLink() && owned && (st.mode & 0o077) === 0) return root;
  } catch {
    // Fall through to the shared temp dir.
  }
  return tmpdir();
}

const STAGING_PREFIX = "tomo-mcp-";

/** Is the process that staged this directory gone? Unknown counts as alive. */
function ownerIsDead(name: string): boolean {
  const pid = Number(/^tomo-mcp-(\d+)-/.exec(name)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Remove staging left behind by a process that died before cleaning up:
 * immediately when its owner PID is gone, otherwise once it is older than
 * STALE_STAGING_MS. Only our own prefix, only directories, only ours.
 */
function sweepStale(root: string, now: number): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const dir = join(root, name);
    if (pending.has(dir)) continue;
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      if (ownerIsDead(name) || now - st.mtimeMs > STALE_STAGING_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Raced with its owner's own cleanup, or unreadable: leave it.
    }
  }
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

  const root = stagingRoot();
  sweepStale(root, Date.now());
  const dir = mkdtempSync(join(root, `${STAGING_PREFIX}${process.pid}-`));
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

  let removed = false;
  return {
    options: {
      ...options,
      mcpServers: inProcess,
      extraArgs: { ...(options.extraArgs ?? {}), "mcp-config": path },
    },
    dispose: () => {
      if (!removed) removed = removeDir(dir);
    },
  };
}
