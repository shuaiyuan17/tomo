import { extractAttachments } from "./text-utils.js";
import { landsInPrivate, globReachesPrivate, grepReachesPrivate, bashTouchesMemory } from "./private-memory-reach.js";
import { expandTilde } from "./bash-write-targets.js";

/*
 * The #464 private-memory predicate for one tool call, in a module free of
 * config and logging so the web process can ask it too (it hides the output
 * of a call that reached memory/private). See private-memory-guard.ts for the
 * full rationale; it re-exports these.
 */

/**
 * The `send_message` tool AS A HOOK SEES IT.
 *
 * Spelled out rather than imported from `mcp/internal-server.ts`: that module
 * pulls the whole tool surface (the SDK, zod, the cron store, the people
 * registry) into this file's import graph, and this file is loaded by the
 * permission hooks and unit-tested against a stub config. `tests/permissions.
 * test.ts` asserts this string against the real `TOMO_INTERNAL_MCP_NAME`, so
 * the two cannot drift apart unnoticed.
 */
export const SEND_MESSAGE_TOOL = "mcp__tomo-internal__send_message";

/** Every value a composed message would hand a channel to OPEN AND SHIP: the
 *  `MEDIA:` paths and the `STICKER:` values — the same extraction the delivery
 *  paths run, so guard and sender agree on what counts as a tag.
 *
 *  STICKERS ARE FILES TOO. On Telegram a sticker value is a `file_id` and names
 *  nothing on disk, but on iMessage it IS a local path (`sendSticker` expands a
 *  leading `~` and, when the native sticker RPC is unavailable, falls back to a
 *  plain `send { file }`), so `STICKER:~/.tomo/workspace/memory/private/x.md`
 *  shipped the file as an attachment from a turn that could not Read it. A
 *  `file_id` judged as a path resolves under the workspace and lands nowhere
 *  near private/, so checking every sticker value costs Telegram nothing. */
export function attachmentPathsIn(message: string): string[] {
  const { mediaPaths, stickerIds } = extractAttachments(message);
  return [...mediaPaths, ...stickerIds];
}

/** File tools that WRITE a path: the ones barred from Tomo's home on a barred turn. */
export const HOME_WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Would this file-tool call WRITE at-or-inside Tomo's home (`<ws>/home/`)?
 *
 * The second barred directory, write-only: a scene is not private, so reading
 * it stays open, but the home is the owner conversation's alone. Judged by
 * {@link landsInPrivate} with the home as both the tree and the barred dir, so
 * the same three rules hold: lexical containment, the symlink-resolved path,
 * and any `..` under the home refused outright. Shell writes are the sandbox
 * profile's job (`./bash-sandbox.ts`), not this predicate's.
 */
export function isHomeWrite(toolName: string, toolInput: unknown, ctx: { cwd: string; homeDir: string }): boolean {
  if (!HOME_WRITE_TOOLS.has(toolName) || !toolInput || typeof toolInput !== "object") return false;
  const ti = toolInput as Record<string, unknown>;
  const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
  if (typeof p !== "string") return false;
  return landsInPrivate(p, { cwd: ctx.cwd, memoryDir: ctx.homeDir, privateDir: ctx.homeDir });
}

export function isPrivateMemoryAccess(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (!toolInput || typeof toolInput !== "object") return false;
  const ti = toolInput as Record<string, unknown>;

  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p = ti.file_path;
      if (typeof p !== "string") return false;
      return landsInPrivate(p, ctx);
    }
    case "NotebookEdit": {
      const p = ti.notebook_path;
      if (typeof p !== "string") return false;
      return landsInPrivate(p, ctx);
    }
    case "Glob": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      // A search rooted AT private/ (or reached through a symlink into it) is
      // denied on the root alone, whatever the pattern says.
      if (landsInPrivate(rootRaw, ctx)) return true;
      const pattern = typeof ti.pattern === "string" ? ti.pattern : "";
      return globReachesPrivate(rootRaw, pattern, ctx);
    }
    case "Grep": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      if (landsInPrivate(rootRaw, ctx)) return true;
      const glob = typeof ti.glob === "string" ? ti.glob : "";
      return grepReachesPrivate(rootRaw, glob, ctx);
    }
    case "Bash": {
      const cmd = ti.command;
      if (typeof cmd !== "string") return false;
      return bashTouchesMemory(cmd, ctx);
    }
    case SEND_MESSAGE_TOOL: {
      const message = ti.message;
      if (typeof message !== "string") return false;
      return attachmentPathsIn(message).some((p) => landsInPrivate(expandTilde(p), ctx));
    }
    default:
      return false;
  }
}
