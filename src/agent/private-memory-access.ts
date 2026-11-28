import { extractAttachments } from "./text-utils.js";
import { landsInPrivate, globReachesPrivate, grepReachesPrivate, bashTouchesMemory } from "./private-memory-reach.js";
import { expandTilde } from "./bash-write-targets.js";
import { readdirSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { abs, foldPath, hasTraversalSegment, isInside, realDir, realResolve } from "./permission-paths.js";

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

/**
 * Would this tool call reach one of `dataDirs` — Tomo's own state under
 * `~/.tomo/data/` (session transcripts, the inbox, the usage ledger, running
 * agents, …)? Barred for reads AND writes on a barred turn, like private
 * memory: those files hold every conversation's content, DMs included, and a
 * group gets what it needs from them through harness tools, never by reading
 * them. Same predicates as private memory, with each data dir as both the
 * tree and the barred dir (so a scan rooted at or above it is refused, and any
 * `..` under it). Bash is the sandbox profile's job and is not decided here.
 */
export function isHarnessDataAccess(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; dataDirs: readonly string[] },
): boolean {
  if (toolName === "Bash") return false;
  return ctx.dataDirs.some((dir) => isPrivateMemoryAccess(toolName, toolInput, { cwd: ctx.cwd, memoryDir: dir, privateDir: dir }));
}

/** Tools that search a tree from a root. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep", "LS"]);

/**
 * `p` as spelled (made absolute) and as the kernel resolves it, folded; null
 * when it cannot be resolved (a symlink loop), which a deny caller must treat
 * as a refusal.
 */
function spellings(p: string, cwd: string): string[] | null {
  const real = realResolve(p, cwd, true);
  if (real === null) return null;
  return [...new Set([foldPath(abs(p, cwd)), foldPath(real)])];
}

/**
 * The base directory the CLI really searches for an ABSOLUTE Glob pattern,
 * which REPLACES the `path` argument: everything before the last `/` that
 * precedes the first glob character (`/`, if that is the only one), or the
 * pattern's parent when it has no glob character at all. Mirrors Claude Code
 * 2.1.325's own split (its `extractGlobBaseDirectory`), so the guard judges
 * the directory the search walks, not the one it was told about.
 */
export function absoluteGlobBaseDir(pattern: string): string {
  const firstGlob = pattern.search(/[*?[{]/);
  if (firstGlob === -1) return dirname(pattern);
  const literal = pattern.slice(0, firstGlob);
  const cut = literal.lastIndexOf("/");
  return cut <= 0 ? "/" : literal.slice(0, cut);
}

/**
 * The directory a search really walks, `~`-expanded but not resolved: for a
 * Glob with an absolute pattern, the pattern's base directory (which REPLACES
 * `path`); otherwise `path`, or the cwd.
 */
export function effectiveSearchRoot(toolName: string, toolInput: unknown, cwd: string): string {
  const ti = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
  const pattern = toolName === "Glob" ? ti.pattern : undefined;
  const spelledPattern = typeof pattern === "string" && pattern ? expandTilde(pattern) : "";
  const pathArg = typeof ti.path === "string" && ti.path ? expandTilde(ti.path) : cwd;
  return toolName === "Glob" && isAbsolute(spelledPattern) ? absoluteGlobBaseDir(spelledPattern) : pathArg;
}

/**
 * Would this search walk a barred directory? On a barred turn the test is the
 * search's EFFECTIVE ROOT alone: at, inside, or ABOVE a barred directory is
 * refused without asking whether the pattern could reach the barred tree.
 * Deciding that from a pattern is the arm that kept leaking —
 * `Grep({ path: "~/.tomo", glob: "data/usage/*.ndjson" })` matched none of the
 * probe paths, and `~` was never expanded at all — so a barred turn searches
 * a specific subdirectory or not at all.
 *
 * The effective root is what the CLI walks: for a Glob with an absolute
 * pattern that is the pattern's base directory (see absoluteGlobBaseDir), not
 * `path`; otherwise `path`, or the cwd. It is `~`-expanded and compared both
 * as spelled and as it REALLY resolves — `Glob({ pattern:
 * "/tmp/ok/link/**\/*.md" })` with `link -> memory/private` searches private/
 * — as is each barred dir. A root that cannot be resolved is refused. A
 * pattern that climbs with `..` is refused, and so is a Grep filter whose
 * absolute literal prefix could reach a barred dir.
 */
export function barredSearch(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; barredDirs: readonly string[] },
): boolean {
  if (!SEARCH_TOOLS.has(toolName)) return false;
  const ti = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
  const pattern = toolName === "Glob" ? ti.pattern : toolName === "Grep" ? ti.glob : undefined;
  const spelledPattern = typeof pattern === "string" && pattern ? expandTilde(pattern) : "";
  const rootRaw = effectiveSearchRoot(toolName, toolInput, ctx.cwd);
  const roots = spellings(rootRaw, ctx.cwd);
  if (roots === null) return true;
  const dirs = ctx.barredDirs.flatMap((dir) => spellings(dir, ctx.cwd) ?? [foldPath(abs(dir, ctx.cwd))]);
  if (roots.some((root) => dirs.some((dir) => isInside(root, dir) || isInside(dir, root)))) return true;
  if (!spelledPattern) return false;
  if (hasTraversalSegment(spelledPattern)) return true;
  if (toolName !== "Grep" || !isAbsolute(spelledPattern)) return false;
  const literal = foldPath(spelledPattern.split(/[*?[{]/, 1)[0]);
  return dirs.some((dir) => isInside(literal, dir) || dir.startsWith(literal));
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

/**
 * The folders under `memory/groups/` that belong to some group other than
 * `ownDir` (relative to memory/, `groups/<dir>`; undefined: the turn has no
 * single group, so every one is another's). Absolute. Read per call: a group
 * folder appears the first time that group saves something.
 */
/** The file paths a file-tool call or a composed message names (not search roots). */
function namedPaths(toolName: string, toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const ti = toolInput as Record<string, unknown>;
  if (toolName === SEND_MESSAGE_TOOL) return typeof ti.message === "string" ? attachmentPathsIn(ti.message).map(expandTilde) : [];
  const p = toolName === "NotebookEdit" ? ti.notebook_path : HOME_WRITE_TOOLS.has(toolName) || toolName === "Read" ? ti.file_path : undefined;
  return typeof p === "string" ? [p] : [];
}

/**
 * Under `memory/groups/<g>/` (or directly in groups/) for a `g` that is not
 * the turn's own folder spelled exactly: on a case-sensitive disk a case
 * variant is another folder. Judged as spelled and as the kernel would
 * resolve it (a link to groups/ itself, the folder named not existing yet).
 */
function spelledInOtherGroup(p: string, ctx: { cwd: string; memoryDir: string; ownGroupDir?: string }): boolean {
  const own = ctx.ownGroupDir?.split("/")[1];
  const expanded = expandTilde(p);
  const groupsDirs = [join(ctx.memoryDir, "groups"), realDir(join(ctx.memoryDir, "groups"), ctx.cwd, true)]
    .filter((d): d is string => d !== null);
  const paths = [abs(expanded, ctx.cwd), realResolve(expanded, ctx.cwd, true)];
  // An unresolvable path (a link loop) is refused, as everywhere else in the guard.
  if (paths[1] === null) return true;
  return paths.some((path) => groupsDirs.some((groups) => {
    if (!isInside(path!, groups) || foldPath(path!) === foldPath(groups)) return false;
    const segments = path!.split(sep);
    const depth = groups.split(sep).length;
    return segments.length === depth + 1 || segments[depth] !== own;
  }));
}

export function otherGroupMemoryDirs(memoryDir: string, ownDir: string | undefined): string[] {
  const groupsDir = join(memoryDir, "groups");
  let names: string[];
  try { names = readdirSync(groupsDir); } catch { return []; }
  const own = ownDir?.split("/")[1];
  return names.filter((name) => name !== own).map((name) => join(groupsDir, name));
}

/**
 * Would this file-tool call (or search, or attachment) reach another group's
 * memory folder? Each such folder is judged exactly as private/ is (lexical,
 * real path, `..` under memory/, a search rooted at, in or above it), so a
 * link or a scan over groups/ does not get round it. Bash is not decided
 * here: its sandbox closes private/ only, and what another group said is
 * that group's words, not the owner's private matters (accepted).
 */
export function isOtherGroupMemoryAccess(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; memoryDir: string; ownGroupDir?: string; otherGroupDirs: readonly string[] },
): boolean {
  if (toolName === "Bash") return false;
  // As spelled, whether or not the folder exists yet: a path under groups/
  // in a folder not the turn's own (a file the tool would create included).
  if (namedPaths(toolName, toolInput).some((p) => spelledInOtherGroup(p, ctx))) return true;
  if (ctx.otherGroupDirs.length === 0) return false;
  if (ctx.otherGroupDirs.some((dir) => isPrivateMemoryAccess(toolName, toolInput, { cwd: ctx.cwd, memoryDir: ctx.memoryDir, privateDir: dir }))) return true;
  return SEARCH_TOOLS.has(toolName) && barredSearch(toolName, toolInput, { cwd: ctx.cwd, barredDirs: ctx.otherGroupDirs });
}
