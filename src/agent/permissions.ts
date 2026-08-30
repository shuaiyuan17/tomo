import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as pathResolve } from "node:path";
import { minimatch } from "minimatch";
import { config } from "../config.js";
import { log } from "../logger.js";
import { MEMORY_DIR, PRIVATE_MEMORY_DIR, PRIVATE_MEMORY_SUBDIR } from "../workspace/index.js";

// ---------------------------------------------------------------------------
// canUseTool: re-allow `.claude/skills/` under bypassPermissions
// ---------------------------------------------------------------------------

/**
 * The skills root as SPELLED — resolved lexically, no symlinks followed.
 *
 * Kept alongside the real path because the two can differ (`/tmp` is a symlink
 * to `/private/tmp` on macOS) and each answers a different question: this one
 * is what a caller's string is compared against to decide whether it is
 * CLAIMING to target the skills dir, and {@link realSkillsRoot} is what decides
 * whether it actually lands there.
 */
const SKILLS_ROOT = pathResolve(config.workspaceDir, ".claude", "skills");
const SKILLS_DIR = `${SKILLS_ROOT}/`;
// No separate `.claude` / `.git` constants any more: the Bash arm requires
// every path to be INSIDE the skills tree, which excludes both by
// construction. Enumerating protected siblings was a symptom of the old
// deny-the-bad-shapes approach — it only caught the outside paths someone had
// thought to list, and let `cp <skills>/a /etc/x` through.

/**
 * Resolve to a REAL path, tolerating a target that does not exist yet.
 *
 * `realpathSync` is the only containment check that survives a symlink, but it
 * throws on a path that has not been created — and Write/mkdir name files that
 * are about to exist. So: realpath the deepest ancestor that does exist, then
 * re-attach the segments below it. `<skills>/escape/x.md` where `escape` is a
 * symlink to `/tmp/evil` resolves to `/tmp/evil/x.md` whether or not `x.md` is
 * there yet.
 *
 * This is also what makes the comparison correct on a case-insensitive volume:
 * `realpathSync` returns the on-disk casing, so both sides of the containment
 * check are normalised the same way.
 */
function realResolve(p: string): string {
  const target = abs(p, config.workspaceDir);
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? pathResolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The skills root with symlinks and casing resolved. Recomputed per call: the
 *  directory is created by `start.ts` after this module is imported. */
function realSkillsRoot(): string {
  return realResolve(SKILLS_ROOT);
}

/**
 * Does `p` contain a `..` segment?
 *
 * Denied outright rather than normalised. `path.resolve` collapses `..`
 * LEXICALLY, before any symlink is followed, so `<skills>/link/../x` normalises
 * to `<skills>/x` — inside — while the real path is `<link-target>/../x`,
 * outside. Refusing `..` closes that without needing to resolve the shell's
 * and the kernel's disagreement, and costs nothing: a caller that wants a
 * skills path can spell it directly, and a deny here only means the tool call
 * falls back to the SDK's normal permission flow.
 */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).includes("..");
}

/** True when `p` really lands at or under the skills root. */
function landsInSkills(p: string): boolean {
  return isInside(realResolve(p), realSkillsRoot());
}

/** SDK canUseTool callback. The SDK auto-approves most tools under
 *  `bypassPermissions`, but writes to `.claude/`, `.git/`, etc. are protected
 *  and fall through to canUseTool. We narrowly re-allow `.claude/skills/` so
 *  tomo can manage its own skill library; every other protected path stays
 *  denied. See https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes.
 *
 *  Containment is decided on the REAL path, and `..` is refused outright. A raw
 *  `startsWith` on the skills prefix accepted
 *  `<workspace>/.claude/skills/../../.claude/settings.json`, which is exactly
 *  one of the protected paths the SDK deferred to this callback — the narrow
 *  re-allow became a hole through the whole protection, and
 *  `.claude/settings.json` is where permissions and hooks live, so the escape
 *  landed on the file governing the sandbox itself. A lexical-only fix would
 *  still have been escapable through a symlink planted inside the skills tree
 *  (which the agent is allowed to create). */
export async function skillsCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const filePath = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (filePath && !hasTraversalSegment(filePath) && landsInSkills(filePath)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Bash — a strict allowlist of simple, fully-pathed commands inside the
  // skills tree. See bashStaysInSkills for why this is an allowlist and not a
  // parser.
  if (toolName === "Bash" && typeof input.command === "string" && bashStaysInSkills(input.command)) {
    return { behavior: "allow", updatedInput: input };
  }
  // DENY, NOT `null`. There is no "no opinion" return: `PermissionResult` is
  // `allow | deny`, and the SDK reserves `null` for a consumer that has
  // already sent the control_response out of band — returning it here would
  // send no response at all and, in the SDK's own words, leave "the tool
  // blocked indefinitely" with no park deadline. A deny hands the model a
  // message it can act on; a null would wedge the turn.
  return {
    behavior: "deny",
    message: `Permission required for ${toolName}${filePath ? ` on ${filePath}` : ""} — only ${SKILLS_DIR}** is auto-approved at this step.`,
  };
}

/**
 * Programs the Bash arm will auto-allow.
 *
 * Bounded on purpose. Everything here either reads or manipulates files whose
 * paths are given as arguments, so the containment check below can see every
 * path the command will touch. Notably absent: `sh`, `bash`, `env`, `xargs`,
 * `find -exec`'s cousins, and anything that takes a program to run — those
 * make the reachable set unbounded again. `cd` and `sudo` are absent for the
 * same reason and are therefore refused by this list alone.
 */
const SKILLS_BASH_ALLOWED_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc",
  "mkdir", "cp", "mv", "rm", "rmdir", "touch", "chmod", "stat",
  "find", "grep",
]);

/**
 * Shell syntax that makes the command more than ONE simple command, or that
 * produces text this cannot see.
 *
 * `$` is rejected wholesale rather than just `$(` and `${`: `$VAR` expands at
 * run time too, and a filename containing a literal `$` is not worth the
 * carve-out. Backslash escapes are rejected by the tokenizer.
 */
const SHELL_CONTROL_RE = /\|\||&&|[;|&<>\n\r`$]/;

/** A leading `FOO=bar` assignment, which changes the command's environment. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split one simple command into words, honouring single and double quotes.
 *
 * Returns null — meaning "no auto-allow" — for anything it cannot read
 * unambiguously: an unterminated quote, or a backslash escape. Quoting is the
 * whole reason this exists rather than a `split(/\s+/)`: splitting on
 * whitespace made `touch "<workspace>/.claude/skills dir/x"` look like two
 * words, neither of which resembled the sibling directory it actually names,
 * and `touch /workspace/".claude"/settings.json` hid a protected path inside
 * quotes that a raw split left glued to its neighbours.
 */
function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      // Escapes inside double quotes have their own rules; refuse rather than
      // reimplement them.
      if (ch === "\\") return null;
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") return null;
    if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * One argument: an absolute path that really lands inside the skills tree.
 *
 * Absolute is required because a relative path is resolved against the SHELL's
 * working directory, which this hook does not know and cannot bound — `cd` is
 * refused, but so is any other way the cwd could differ from the workspace.
 */
function skillsPathArgument(token: string): boolean {
  if (!token) return false;
  // `~` is expanded by the shell, after this hook runs.
  if (token.includes("~")) return false;
  if (!isAbsolute(token)) return false;
  if (hasTraversalSegment(token)) return false;
  return isInside(realResolve(token), realSkillsRoot());
}

/**
 * Decide whether a Bash command may ride the skills re-allow.
 *
 * A STRICT ALLOWLIST, NOT A PARSER. The previous two attempts tried to read an
 * arbitrary command and rule out the dangerous shapes; that does not converge.
 * `input.command.includes(SKILLS_DIR)` approved anything containing the path
 * as a substring. Tightening it to per-word containment still let through
 * quoted words with spaces, quotes embedded mid-path
 * (`/workspace/".claude"/settings.json`), relative paths after
 * `cd <skills> &&`, and any unclaimed outside path that was not under
 * `.claude`/`.git` (`cp <skills>/a /etc/x`). Each fix revealed the next gap,
 * because the question "what will this shell command touch" cannot be answered
 * from outside the shell.
 *
 * So the question is inverted. A command is auto-allowed only if it is
 * unambiguously simple AND every path it names is unambiguously inside the
 * skills tree:
 *
 *   - one simple command: no `&&`, `||`, `;`, `|`, `&`, newline, redirection,
 *     backtick, `$`, backslash escape, or leading `FOO=bar` assignment;
 *   - the program is one of {@link SKILLS_BASH_ALLOWED_PROGRAMS} (which
 *     excludes `cd`, `sudo`, and every program that runs another program);
 *   - every non-flag word is an ABSOLUTE path, free of `..` and `~`, whose
 *     realpath lands at or inside the resolved skills root;
 *   - a flag containing `/` must be `--name=<path>` and its value must pass
 *     the same check;
 *   - at least one path actually lands in the tree, so a command that names
 *     none of it is not auto-allowed by default.
 *
 * THE RESIDUAL, ACCEPTED DELIBERATELY. This refuses plenty of legitimate skill
 * management: `grep pattern <skills>/x` (the pattern is not a path),
 * `chmod +x <skills>/x` (`+x` is neither), anything with a pipe, and every
 * relative path. Those now go through the SDK's ordinary permission handling
 * instead of being waved through, which is the intended trade — this callback
 * exists to widen a deliberately narrow hole, and a hole that cannot be
 * described precisely should not be widened at all.
 */
function bashStaysInSkills(command: string): boolean {
  if (SHELL_CONTROL_RE.test(command)) return false;

  const tokens = tokenizeSimpleCommand(command);
  if (!tokens || tokens.length === 0) return false;

  const [program, ...args] = tokens;
  if (ENV_ASSIGNMENT_RE.test(program)) return false;
  if (!SKILLS_BASH_ALLOWED_PROGRAMS.has(program)) return false;

  let landsInSkills = false;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      // A bare flag names no path. One carrying a `/` does, and is only
      // readable in the `--name=<value>` form.
      if (!arg.includes("/")) continue;
      const eq = arg.indexOf("=");
      if (eq < 0) return false;
      if (!skillsPathArgument(arg.slice(eq + 1))) return false;
      landsInSkills = true;
      continue;
    }
    if (!skillsPathArgument(arg)) return false;
    landsInSkills = true;
  }

  return landsInSkills;
}

// ---------------------------------------------------------------------------
// Group-session guard for memory/private/
// ---------------------------------------------------------------------------

/** PreToolUse hook that denies tool calls that could surface DM-only memory
 *  in a group session. Per SDK docs, PreToolUse denies bypass canUseTool, so
 *  this enforces even in bypassPermissions mode. See {@link isPrivateMemoryAccess}
 *  for per-tool rules — substring matching wasn't enough since parent-dir
 *  scans, alternate relative paths, and shell `cd` tricks reach private/
 *  without spelling the full path. */
export function privateMemoryGuardHooks(sessionKey?: string) {
  const ctx = { cwd: config.workspaceDir, memoryDir: MEMORY_DIR, privateDir: PRIVATE_MEMORY_DIR };
  return {
    PreToolUse: [{
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        if (!isPrivateMemoryAccess(input.tool_name, input.tool_input, ctx)) return {};
        log.warn({ key: sessionKey, tool: input.tool_name }, "Blocked group-session access to private memory");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is DM-only and not accessible from group sessions. Scans rooted at \`memory/\` are also blocked — use Read on a specific public memory file.`,
          },
        };
      }],
    }],
  };
}

/** Per-tool predicate for the group-session private-memory guard. Exported for
 *  testing. The rules are intentionally conservative:
 *
 *  - File ops (Read/Edit/Write/MultiEdit/NotebookEdit): deny when the resolved
 *    file_path lands at-or-inside the private dir.
 *  - Glob: deny when the search root is at-or-inside MEMORY_DIR, or when the
 *    pattern joined to the root could match any path at-or-inside private/.
 *    Wildcard segments like `pri*` are evaluated by minimatch against synthetic
 *    probe paths under private/, so `memory/pri*\/*.md` is denied just like
 *    `memory/private/*.md`.
 *  - Grep: same logic against the `glob` filter when present, plus a root
 *    check that mirrors ripgrep's default-recursive behaviour.
 *  - Bash: deny any command that names `memory` as a path segment. The Bash
 *    surface area is too wide to reason about — shell expansion happens after
 *    the hook fires, `cd` rewrites the working dir, and command substitution
 *    can hide paths. Group sessions don't need Bash for memory ops; the agent
 *    can Read public memory files by name (MEMORY.md is in its prompt).
 *
 *  False positives in groups are tolerable for the same reason — the agent
 *  always has an alternative path through Read on a named public file. */
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
      return isInside(abs(p, ctx.cwd), ctx.privateDir);
    }
    case "NotebookEdit": {
      const p = ti.notebook_path;
      if (typeof p !== "string") return false;
      return isInside(abs(p, ctx.cwd), ctx.privateDir);
    }
    case "Glob": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      const root = abs(rootRaw, ctx.cwd);
      const pattern = typeof ti.pattern === "string" ? ti.pattern : "";
      return globReachesPrivate(root, pattern, ctx);
    }
    case "Grep": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      const root = abs(rootRaw, ctx.cwd);
      const glob = typeof ti.glob === "string" ? ti.glob : "";
      return grepReachesPrivate(root, glob, ctx);
    }
    case "Bash": {
      const cmd = ti.command;
      if (typeof cmd !== "string") return false;
      return bashTouchesMemory(cmd, ctx);
    }
    default:
      return false;
  }
}

/** Resolve `p` to an absolute, normalized path against `cwd` if relative. */
function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? pathResolve(p) : pathResolve(cwd, p);
}

/** True when `child` equals `parent` or sits inside it. Both must be absolute. */
function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when `rel` represents a non-empty path that doesn't escape upward —
 *  i.e. it points to a descendant of the reference dir. Used to short-circuit
 *  glob/grep checks when private/ isn't reachable from the search root. */
function isRelativeDescendant(rel: string): boolean {
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Decide whether a Glob call rooted at `root` with pattern `pattern` could
 *  surface anything at-or-inside the private memory dir.
 *
 *  Earlier versions split the pattern at its first wildcard and compared the
 *  literal prefix only — that missed `memory/pri*\/*.md`, which expands into
 *  `memory/private/...` at match time. We test the pattern against three
 *  synthetic probe paths anchored under private/ using minimatch. */
function globReachesPrivate(
  root: string,
  pattern: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (isInside(root, ctx.memoryDir)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  const probes = [relPrivate, `${relPrivate}/probe.md`, `${relPrivate}/sub/probe.md`];
  // `nocase: true` covers case-insensitive filesystems (macOS, Windows).
  // `dot: true` so leading-dot files inside private/ aren't given a free pass.
  const opts = { dot: true, nocase: true } as const;
  return probes.some((probe) => minimatch(probe, pattern, opts));
}

/** Decide whether a Grep call rooted at `root` with optional `glob` filter
 *  could surface anything inside the private memory dir.
 *
 *  ripgrep recurses by default. The `glob` filter narrows the file set, but
 *  its semantics differ from a typical glob library:
 *  - If the glob has no `/`, it's a basename filter that matches files at any
 *    depth (e.g. `-g '*.md'` matches `memory/private/x.md`). Path-style
 *    matching would miss this — we deny outright when the root could reach
 *    private/.
 *  - If the glob has `/`, it's a path-style pattern; use minimatch probes.
 *  Without a glob filter, treat the search as fully recursive. */
function grepReachesPrivate(
  root: string,
  glob: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (isInside(root, ctx.memoryDir)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  // No glob filter ⇒ unrestricted recursion ⇒ reaches private/.
  if (!glob) return true;
  // Basename glob (no `/`) is anchored only by file basename; if private/ is
  // reachable from root, ripgrep will scan it and apply the filter there too.
  if (!glob.includes("/")) return true;
  // Path-style glob: probe like Glob does.
  const probes = [relPrivate, `${relPrivate}/probe.md`, `${relPrivate}/sub/probe.md`];
  const opts = { dot: true, nocase: true } as const;
  return probes.some((probe) => minimatch(probe, glob, opts));
}

/** Bash guard for group sessions. Shell expansion happens after the hook
 *  fires, so we can't reliably predict which paths a command will actually
 *  touch — `cat memory/pri*\/*.md`, `$(echo memory/private/x)`, and
 *  `cd memory && cat private/x.md` all reach private/ without spelling it
 *  literally. Rather than chase every shell construct, we deny anything that
 *  names `memory` (or `private`) as a path segment, plus any absolute path
 *  that lands inside the memory tree.
 *
 *  Group sessions don't need Bash for memory ops — Read works on named public
 *  files, and the MEMORY.md index is already in the system prompt. */
function bashTouchesMemory(cmd: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  if (cmd.includes(ctx.memoryDir) || cmd.includes(ctx.privateDir)) return true;
  // `memory` or `private` as a path segment: bordered by /, quote, whitespace,
  // shell operator, or string boundary. Catches `memory/x`, `./memory`,
  // `cd memory`, `ls memory/private`, `cat private/foo`, etc.
  const memorySegment = /(^|[\s'"`=()|&;></])(memory|private)(\/|$|[\s'"`=()|&;><])/i;
  return memorySegment.test(cmd);
}
