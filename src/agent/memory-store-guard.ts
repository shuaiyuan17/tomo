// PreToolUse guard: Markdown under memory/ is written by the memory tools only.
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as pathResolve } from "node:path";
import { log } from "../logger.js";
import { abs, bashTokens, foldPath, isInside, pathCandidates, realResolve } from "./permission-paths.js";
import { HOME_WRITE_TOOLS } from "./private-memory-access.js";
import { commandSegments, expandTilde, redirectTargets } from "./bash-write-targets.js";
import { commandWordIndex } from "./todo-store-guard.js";

/**
 * Why memory has a write guard of its own: the memory tools (src/mcp/
 * memory-tools.ts) are the one way memory is written, so that their checks
 * hold — the version check, the old version kept before a loss, the
 * description, the size limits, the audience. A file tool that writes
 * `memory/x.md` directly skips every one of them.
 *
 * Installed on every session except a sub-session (whose own guard keeps it
 * out of all of `memory/`). It applies to the subagents a session starts too:
 * the SDK runs PreToolUse hooks for their tool calls (with `agent_id`).
 *
 * What it refuses, on `memory/**\/*.md` (lexical, symlink-resolved,
 * case-folded; `incoming-*` attachment folders excepted):
 * - Write / Edit / MultiEdit / NotebookEdit;
 * - Bash WRITES: a `>`/`>>` redirection (a heredoc appended with `cat >>`
 *   included), `tee`, `cp`/`mv`/`ln` onto a `.md` (or a `.md` copied into a
 *   memory folder), `rm`/`unlink`/`truncate`/`touch`/`sed -i`/`perl -i`/`dd of=`
 *   on one, and `rm`/`rmdir`/`mv` of a memory folder or of memory/ itself.
 * Reads (Read, Grep, Glob, `cat`) are not judged.
 *
 * Like the todo guard, the Bash arm is a text filter on a shell it does not
 * sandbox: an interpreter can write a path the text never spells. It guards
 * against habit, not against an adversary.
 *
 * `memory.storeGuard` sets the mode: `enforce` (default) denies, `warn`
 * allows and logs who wrote what (to find an install's remaining direct
 * writers before enforcing), `off` does nothing.
 */
export type MemoryStoreGuardMode = "enforce" | "warn" | "off";

export const MEMORY_STORE_WRITE_DENIAL =
  "Markdown files under memory/ are changed with the memory tools (memory_write, memory_str_replace, memory_append, memory_move, memory_delete); people records with upsert_person. If you don't have those tools (as in a subagent), hand what should be saved back to the main conversation.";

const FILE_WRITERS: ReadonlySet<string> = new Set(["tee", "cp", "mv", "rm", "rmdir", "unlink", "ln", "sed -i", "perl -i", "truncate", "dd", "touch"]);
/** Writers that remove what they name, so a folder (or memory/ itself, or an ancestor) counts. */
const DESTRUCTIVE: ReadonlySet<string> = new Set(["rm", "rmdir", "mv"]);

interface Ctx { cwd: string; memoryDir: string }

/** The spellings of memory/ to compare against: as configured, and its real path. */
function memoryRoots(ctx: Ctx): string[] {
  const roots = [abs(ctx.memoryDir, ctx.cwd)];
  const real = realResolve(ctx.memoryDir, ctx.cwd, true);
  if (real !== null && foldPath(real) !== foldPath(roots[0])) roots.push(real);
  return roots;
}

/** `p` relative to memory/ (folded), or undefined when it is not at or under it, by either spelling. */
function underMemory(p: string, ctx: Ctx): string | undefined {
  const expanded = expandTilde(p);
  const candidates = [abs(expanded, ctx.cwd)];
  const real = realResolve(expanded, ctx.cwd, true);
  if (real !== null) candidates.push(real);
  for (const root of memoryRoots(ctx)) {
    for (const c of candidates) {
      if (isInside(c, root)) return foldPath(relative(foldPath(root), foldPath(c)));
    }
  }
  return undefined;
}

/** Is memory/ at or inside `p` (`rm -rf ~/.tomo/workspace`)? */
function containsMemory(p: string, ctx: Ctx): boolean {
  const expanded = expandTilde(p);
  const targets = [abs(expanded, ctx.cwd)];
  const real = realResolve(expanded, ctx.cwd, true);
  if (real !== null) targets.push(real);
  return memoryRoots(ctx).some((root) => targets.some((t) => isInside(root, t)));
}

const isMarkdown = (p: string): boolean => /\.md$/i.test(p.replace(/\/+$/, ""));
/** Inside an attachment folder (`incoming-files/...`): a folder, so a root-level `incoming-x.md` note doesn't count. */
const inIncoming = (rel: string): boolean => rel.includes("/") && rel.split("/")[0].startsWith("incoming-");
/** Is `p` an existing folder (following links)? */
function isDir(p: string, cwd: string): boolean {
  try { return statSync(abs(expandTilde(p), cwd)).isDirectory(); } catch { return false; }
}
/** Could `p` be a folder: one that exists, or a name with no extension. */
function maybeDir(p: string, cwd: string): boolean {
  if (isDir(p, cwd)) return true;
  const last = p.replace(/\/+$/, "").split("/").pop() ?? "";
  return !last.includes(".");
}

/** A memory note this path names: a `.md` under memory/, outside the attachment folders. */
function isMemoryNote(p: string, ctx: Ctx): string | undefined {
  if (!isMarkdown(p)) return undefined;
  const rel = underMemory(p, ctx);
  if (rel === undefined || rel === "" || inIncoming(rel)) return undefined;
  return p;
}

/** For a destructive verb: memory/ itself, an ancestor of it, or a folder in it (not an attachment folder). */
function isMemoryTree(p: string, ctx: Ctx): string | undefined {
  if (containsMemory(p, ctx)) return p;
  const rel = underMemory(p, ctx);
  if (rel === undefined || inIncoming(rel) || rel.split("/")[0].startsWith("incoming-")) return undefined;
  return isMarkdown(p) || maybeDir(p, ctx.cwd) ? p : undefined;
}

/**
 * The memory path this call would write directly, or null. Exported for tests.
 * An input this cannot read is not a write.
 */
export function memoryStoreWriteTarget(toolName: string, toolInput: unknown, ctx: Ctx): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const ti = toolInput as Record<string, unknown>;
  if (HOME_WRITE_TOOLS.has(toolName)) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    return typeof p === "string" ? (isMemoryNote(p, ctx) ?? null) : null;
  }
  if (toolName !== "Bash" || typeof ti.command !== "string") return null;
  return bashMemoryWrite(ti.command, ctx);
}

function bashMemoryWrite(command: string, ctx: Ctx): string | null {
  let cwd = ctx.cwd;
  for (const segment of commandSegments(command.replace(/\$\(|`/g, "\n"))) {
    const tokens = bashTokens(segment);
    if (tokens[0] === "cd") {
      const target = tokens[1];
      if (target === undefined || target === "~") cwd = expandTilde("~");
      else if (target !== "-") cwd = isAbsolute(expandTilde(target)) ? expandTilde(target) : pathResolve(cwd, target);
      continue;
    }
    const here = { cwd, memoryDir: ctx.memoryDir };
    for (const t of [...redirectTargets(segment), ...quotedRedirectTargets(segment)]) {
      const hit = isMemoryNote(t, here);
      if (hit) return hit;
    }
    const at = commandWordIndex(tokens);
    const verb = at === -1 ? null : writerAt(tokens, at);
    if (!verb) continue;
    const args = tokens.slice(at + 1);
    // A quoted operand may hold spaces the word split broke apart: judge it whole as well.
    const operands = [...args.flatMap((word) => pathCandidates(word)), ...quotedStrings(segment)].filter((w) => !w.startsWith("-"));
    if (verb === "dd") {
      for (const of of args.filter((w) => w.startsWith("of=")).map((w) => w.slice(3))) {
        const hit = isMemoryNote(of, here);
        if (hit) return hit;
      }
      continue;
    }
    if (verb === "cp" || verb === "ln") {
      // Only the destination is written: the last operand, or `-t <dir>`.
      const t = args.indexOf("-t");
      const dest = t !== -1 && args[t + 1] !== undefined ? args[t + 1] : operands[operands.length - 1];
      const sources = t !== -1 ? operands.filter((o) => o !== dest) : operands.slice(0, -1);
      if (dest === undefined) continue;
      const hit = isMemoryNote(dest, here) ?? (sources.some((src) => isMarkdown(src) || maybeDir(src, cwd)) ? intoMemoryFolder(dest, here) : undefined);
      if (hit) return hit;
      continue;
    }
    if (verb === "mv") {
      // mv removes its sources and writes its destination.
      const dest = operands[operands.length - 1];
      const sources = operands.slice(0, -1);
      for (const s of sources) {
        const hit = isMemoryTree(s, here);
        if (hit) return hit;
      }
      if (dest !== undefined) {
        const hit = isMemoryNote(dest, here) ?? (sources.some((src) => isMarkdown(src) || maybeDir(src, cwd)) ? intoMemoryFolder(dest, here) : undefined);
        if (hit) return hit;
      }
      continue;
    }
    for (const o of operands) {
      const hit = DESTRUCTIVE.has(verb) ? isMemoryTree(o, here) : isMemoryNote(o, here);
      if (hit) return hit;
    }
  }
  return null;
}

/** Quoted strings in a segment, whole (spaces kept). */
function quotedStrings(segment: string): string[] {
  return [...segment.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
}

/** `> "a b.md"`: a quoted redirection target, which the word-based reading cuts at the space. */
function quotedRedirectTargets(segment: string): string[] {
  return [...segment.matchAll(/>>?\s*(?:"([^"]+)"|'([^']+)')/g)].map((m) => m[1] ?? m[2]);
}

/** A folder under memory/ (not an attachment folder) a `.md` is copied or moved into. */
function intoMemoryFolder(dest: string, ctx: Ctx): string | undefined {
  if (isMarkdown(dest)) return undefined;
  const rel = underMemory(dest, ctx);
  if (rel === undefined || inIncoming(rel)) return undefined;
  return dest;
}

function writerAt(tokens: string[], at: number): string | null {
  const word = tokens[at].split("/").pop() ?? "";
  if (word === "sed" || word === "perl") return tokens.slice(at + 1).some((t) => /^-[a-zA-Z]*i/.test(t)) ? `${word} -i` : null;
  return FILE_WRITERS.has(word) ? word : null;
}

/**
 * Decide one call: the target when it is a direct memory write, else null.
 * When the judgement itself throws, a call whose input names a memory `.md`
 * counts as one, everything else goes through.
 */
export function memoryGuardTarget(toolName: string, toolInput: unknown, ctx: Ctx, judge = memoryStoreWriteTarget): string | null {
  try {
    return judge(toolName, toolInput, ctx);
  } catch (err) {
    let text: string;
    try { text = JSON.stringify(toolInput) ?? ""; } catch { text = String(toolInput); }
    const hits = (text.includes(ctx.memoryDir) || /(^|[^\w-])memory\//.test(text)) && /\.md\b/i.test(text);
    log.warn({ err, tool: toolName, denied: hits }, "Memory-store guard failed to judge a tool call");
    return hits ? "(unreadable call naming memory/)" : null;
  }
}

/** The PreToolUse hook. `mode` and `memoryDir` are read per call. */
export function memoryStoreGuardHooks(sessionKey: string | undefined, cwd: string, workspaceDir: () => string, mode: () => MemoryStoreGuardMode) {
  return {
    PreToolUse: [{
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown; agent_id?: string; agent_type?: string }) => {
        const m = mode();
        if (m === "off") return {};
        const target = memoryGuardTarget(input.tool_name, input.tool_input, { cwd, memoryDir: join(workspaceDir(), "memory") });
        if (target === null) return {};
        const who = { key: sessionKey, tool: input.tool_name, path: target, ...(input.agent_type ? { agentType: input.agent_type } : {}), ...(input.agent_id ? { agentId: input.agent_id } : {}) };
        if (m === "warn") {
          log.warn(who, "Direct write to memory (memory.storeGuard: warn, allowed)");
          return {};
        }
        log.warn(who, "Blocked a direct write to memory");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: MEMORY_STORE_WRITE_DENIAL,
          },
        };
      }],
    }],
  };
}
