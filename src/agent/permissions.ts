import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as pathResolve } from "node:path";
import { minimatch } from "minimatch";
import { config } from "../config.js";
import { log } from "../logger.js";
import { MEMORY_DIR, PRIVATE_MEMORY_DIR, PRIVATE_MEMORY_SUBDIR } from "../workspace/index.js";

// ---------------------------------------------------------------------------
// canUseTool: re-allow `.claude/skills/` under bypassPermissions
// ---------------------------------------------------------------------------

const SKILLS_DIR = `${config.workspaceDir}/.claude/skills/`;

/** SDK canUseTool callback. The SDK auto-approves most tools under
 *  `bypassPermissions`, but writes to `.claude/`, `.git/`, etc. are protected
 *  and fall through to canUseTool. We narrowly re-allow `.claude/skills/` so
 *  tomo can manage its own skill library; every other protected path stays
 *  denied. See https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes. */
export async function skillsCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const filePath = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (filePath && filePath.startsWith(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Bash mkdir / touch / etc. — allow if command targets the skills dir.
  if (toolName === "Bash" && typeof input.command === "string" && input.command.includes(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Permission required for ${toolName}${filePath ? ` on ${filePath}` : ""} — only ${SKILLS_DIR}** is auto-approved at this step.`,
  };
}

// ---------------------------------------------------------------------------
// Group-session guard for memory/private/
// ---------------------------------------------------------------------------

/**
 * Why the turn in flight may not reach `memory/private/` — or `null` when it
 * may.
 *
 * Two bars, not one, because the session key is not the whole story. A GROUP
 * session is barred for its whole life. A `dm:` session is barred only for the
 * duration of a SUMMONED turn: `/summon` routes a group's messages onto the
 * owner's dm: session (router `summonGroup`), so `isGroupSessionKey("dm:x")`
 * is false for turns that any participant of that group can steer.
 */
export type PrivateMemoryBar = "group-session" | "summoned-turn";

/** Denial text for a group session — the session is barred for its lifetime. */
export const PRIVATE_MEMORY_GROUP_DENIAL =
  `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is DM-only and not accessible from group sessions. Scans rooted at \`memory/\` are also blocked — use Read on a specific public memory file.`;

/**
 * Denial text for a summoned turn. Names the reason and the way round it, so
 * the model can say why rather than retrying with a different spelling of the
 * same path. Deliberately does NOT say the file exists.
 */
export const PRIVATE_MEMORY_SUMMONED_DENIAL =
  `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is unavailable during a summoned turn. This turn's messages come from a group summoned into this session (or span several audiences), so the owner's private memory is not readable from it — the session key says "private DM", but a group is steering. Scans rooted at \`memory/\` are blocked for the same reason: use Read on a specific public memory file, or ask again in the owner's own DM (\`/dismiss\` ends the summon).`;

export function privateMemoryDenialReason(bar: PrivateMemoryBar): string {
  return bar === "group-session" ? PRIVATE_MEMORY_GROUP_DENIAL : PRIVATE_MEMORY_SUMMONED_DENIAL;
}

/** PreToolUse hook that denies tool calls that could surface DM-only memory
 *  in a session that is not entitled to it. Per SDK docs, PreToolUse denies
 *  bypass canUseTool, so this enforces even in bypassPermissions mode. See
 *  {@link isPrivateMemoryAccess} for per-tool rules — substring matching wasn't
 *  enough since parent-dir scans, alternate relative paths, and shell `cd`
 *  tricks reach private/ without spelling the full path.
 *
 *  `bar` is a GETTER, resolved on every tool call, not a boolean fixed when the
 *  hook is built. The hook is installed once per live session
 *  (live-session-manager.ts), but a dm: session's entitlement changes turn to
 *  turn while a group is summoned into it — a fixed boolean would either leave
 *  the summoned window open or lock the owner out of their own memory for the
 *  life of the session. */
export function privateMemoryGuardHooks(
  sessionKey: string | undefined,
  bar: () => PrivateMemoryBar | null,
) {
  const ctx = { cwd: config.workspaceDir, memoryDir: MEMORY_DIR, privateDir: PRIVATE_MEMORY_DIR };
  return {
    PreToolUse: [{
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        // Cheap check first: `bar()` is a map lookup, `isPrivateMemoryAccess`
        // can hit the filesystem. Order does not affect the outcome.
        const reason = bar();
        if (!reason) return {};
        if (!isPrivateMemoryAccess(input.tool_name, input.tool_input, ctx)) return {};
        log.warn(
          { key: sessionKey, tool: input.tool_name, bar: reason },
          "Blocked access to private memory",
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: privateMemoryDenialReason(reason),
          },
        };
      }],
    }],
  };
}

/** Per-tool predicate for the private-memory guard. Exported for testing. The
 *  rules are intentionally conservative:
 *
 *  - File ops (Read/Edit/Write/MultiEdit/NotebookEdit): deny when the file_path
 *    lands at-or-inside the private dir — lexically, OR after symlinks are
 *    resolved, OR because it steers through a `..` segment anywhere in the
 *    memory tree. See {@link landsInPrivate}.
 *  - Glob: deny when the search root is at-or-inside MEMORY_DIR, or when the
 *    pattern could match any path at-or-inside private/. Wildcard segments
 *    like `pri*` are evaluated by minimatch against synthetic probe paths, so
 *    `memory/pri*\/*.md` is denied just like `memory/private/*.md`. Probes are
 *    spelled both relatively and ABSOLUTELY, because an absolute pattern
 *    anchors itself and is reachable from a root that is not private/'s
 *    ancestor; a pattern containing `..` under a memory-reachable root is
 *    refused outright rather than modelled.
 *  - Grep: same logic against the `glob` filter when present, plus a root
 *    check that mirrors ripgrep's default-recursive behaviour.
 *  - Bash: see {@link bashTouchesMemory}. Deliberately over-broad, and the only
 *    arm that is DEFENCE IN DEPTH rather than a decision: shell expansion
 *    happens after the hook fires, so the tokens here are not the paths the
 *    command will touch.
 *
 *  Containment is case-folded throughout — see {@link isInside}. False
 *  positives are tolerable because the agent always has an alternative path
 *  through Read on a named public file. */
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
      const root = abs(rootRaw, ctx.cwd);
      const pattern = typeof ti.pattern === "string" ? ti.pattern : "";
      return globReachesPrivate(root, pattern, ctx);
    }
    case "Grep": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      if (landsInPrivate(rootRaw, ctx)) return true;
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

/**
 * True when `child` equals `parent` or sits inside it. Both must be absolute.
 *
 * CASE-FOLDED, UNCONDITIONALLY. This is a *deny* predicate: failing to
 * establish containment means the call is ALLOWED, so any spelling that slips
 * past the comparison is a bypass, not a false negative. macOS ships APFS
 * case-insensitive by default and `realpathSync` PRESERVES the caller's
 * spelling rather than normalising it — `realpathSync("<ws>/memory/PRIVATE")`
 * returns `.../PRIVATE`, so an exact compare against `.../private` failed and
 * `Read memory/PRIVATE/secret.md` read the file. (The `.claude/skills/`
 * re-allow in #305 folds the other way for the same reason: there a failed
 * comparison DENIES, so preserved casing is merely conservative. Same
 * observation, opposite consequence — hence the different treatment.)
 *
 * Folding over-matches on a case-SENSITIVE volume, where `memory/PRIVATE/` is
 * a genuinely different directory that would now be denied. That is the safe
 * direction, and it costs a caller nothing: this guard only runs where reading
 * a named public file is the intended route anyway.
 */
function isInside(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** How many symlink hops to follow before giving up, so a link cycle cannot
 *  spin here forever. Well above any real path. */
const MAX_SYMLINK_HOPS = 32;

/** Does `p` contain a `..` segment as SPELLED, before any normalisation? */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).includes("..");
}

/**
 * Resolve `p` to a REAL path, tolerating a target that does not exist yet.
 * Returns null when nothing resolves (which callers read as "no extra
 * evidence", never as "allowed").
 *
 * Same shape as the containment helper in the `.claude/skills/` re-allow
 * (PR #305) — copied rather than imported because that one is private to its
 * own arm and lives on an unmerged branch; when it lands, both should share
 * one helper.
 *
 * `realpathSync` throws on a path that has not been created, and Write/Edit
 * name files that are about to exist — so realpath the deepest ancestor that
 * DOES exist and re-attach the segments below it. The ENOENT branch also asks
 * `lstat` whether the name is a DANGLING symlink: `realpathSync` reports
 * ENOENT for a link whose target is missing, indistinguishable from "not
 * there", and a plain parent-walk would then report the link's own path
 * (outside private/) for a write that follows the link into it.
 */
function realResolve(p: string, cwd: string): string | null {
  let current = abs(p, cwd);
  const tail: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? pathResolve(real, ...tail.reverse()) : real;
    } catch {
      let link: string | null = null;
      try {
        if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
      } catch {
        // Genuinely absent — fall through to the parent walk.
      }
      if (link !== null) {
        if (++hops > MAX_SYMLINK_HOPS) return null;
        // Re-resolve the target with the SAME tail, so segments below the link
        // stay attached below its destination.
        current = pathResolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Does `p` land at-or-inside the private memory dir?
 *
 * Three rules, each closing a different escape:
 *
 *  1. LEXICAL. `path.resolve` collapses `.` and `..`, so `memory/../memory/
 *     private/x` and `./memory/private/x` are the same path as the plain one.
 *  2. REAL. A symlink planted anywhere the agent may write (`memory/notes ->
 *     memory/private`) defeats rule 1 entirely — the lexical path never spells
 *     `private`. Compared after resolving BOTH sides, since the private dir
 *     itself may sit under a symlinked prefix (`/tmp` -> `/private/tmp` on
 *     macOS), which would otherwise make every comparison fail open.
 *  3. `..` ANYWHERE IN THE MEMORY TREE. `..` is collapsed lexically, BEFORE any
 *     symlink is followed, so `memory/link/../x` normalises to `memory/x`
 *     (fine) while the kernel walks `<link-target>/../x` (not fine). Rather
 *     than reconcile the two, refuse `..` outright once the path is anywhere
 *     under `memory/`. The cost is a false positive on `memory/../memory/
 *     public.md`, which a caller can simply spell directly — and this guard
 *     only ever runs where a Read on a named public file is the intended
 *     route anyway.
 */
function landsInPrivate(p: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  const lexical = abs(p, ctx.cwd);
  if (isInside(lexical, ctx.privateDir)) return true;
  if (hasTraversalSegment(p) && isInside(lexical, ctx.memoryDir)) return true;
  const real = realResolve(p, ctx.cwd);
  const realPrivate = realPrivateDir(ctx);
  return real !== null && realPrivate !== null && isInside(real, realPrivate);
}

/**
 * The real private dir, resolved once per distinct `privateDir`.
 *
 * `realResolve` walks the tree and can lstat several levels; it ran on every
 * guarded call for a value that does not change. Cached only once the
 * directory actually EXISTS: before that, `realResolve` is re-attaching a
 * not-yet-created tail and the answer can still change when `start.ts` creates
 * the workspace, so caching then would pin a pre-creation guess for the life
 * of the process.
 */
const realPrivateDirCache = new Map<string, string>();
function realPrivateDir(ctx: { cwd: string; privateDir: string }): string | null {
  const cached = realPrivateDirCache.get(ctx.privateDir);
  if (cached !== undefined) return cached;
  const real = realResolve(ctx.privateDir, ctx.cwd);
  if (real !== null && existsSync(ctx.privateDir)) realPrivateDirCache.set(ctx.privateDir, real);
  return real;
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
  if (!pattern) return false;
  // ABSOLUTE PATTERNS ARE CHECKED FIRST, AND INDEPENDENTLY OF THE ROOT. An
  // absolute pattern anchors itself: `Glob({ path: "/tmp", pattern:
  // "/ws/memory/private/*.md" })` reaches private/ from a root that is not
  // even an ancestor of it, so the root-relative probes below never see it and
  // the `isRelativeDescendant` short-circuit would return "unreachable".
  if (matchesAnyProbe(absolutePrivateProbes(ctx), pattern)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  // A pattern that steers UPWARD out of the root can re-enter the memory tree
  // by a route the probes cannot model (`../ws/memory/private/*.md` matches
  // neither the relative nor the absolute probe). While private/ is reachable
  // from the root at all, refuse rather than model it.
  if (hasTraversalSegment(pattern)) return true;
  return matchesAnyProbe(relativePrivateProbes(relPrivate), pattern);
}

/** Synthetic paths standing in for "something at or under private/", relative
 *  to a search root. A pattern that matches any of them can surface private
 *  content. */
function relativePrivateProbes(relPrivate: string): string[] {
  return [relPrivate, `${relPrivate}/probe.md`, `${relPrivate}/sub/probe.md`];
}

/** The same probes spelled absolutely, for patterns that anchor themselves.
 *  Includes the symlink-resolved dir, since an absolute pattern may be written
 *  through either spelling. */
function absolutePrivateProbes(ctx: { cwd: string; privateDir: string }): string[] {
  const roots = new Set([ctx.privateDir]);
  const real = realPrivateDir(ctx);
  if (real !== null) roots.add(real);
  return [...roots].flatMap(relativePrivateProbes);
}

/** `nocase: true` covers case-insensitive filesystems (macOS, Windows).
 *  `dot: true` so leading-dot files inside private/ aren't given a free pass. */
function matchesAnyProbe(probes: string[], pattern: string): boolean {
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
  // Absolute filters anchor themselves — see globReachesPrivate.
  if (glob && matchesAnyProbe(absolutePrivateProbes(ctx), glob)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  // No glob filter ⇒ unrestricted recursion ⇒ reaches private/.
  if (!glob) return true;
  // Basename glob (no `/`) is anchored only by file basename; if private/ is
  // reachable from root, ripgrep will scan it and apply the filter there too.
  if (!glob.includes("/")) return true;
  if (hasTraversalSegment(glob)) return true;
  // Path-style glob: probe like Glob does.
  return matchesAnyProbe(relativePrivateProbes(relPrivate), glob);
}

/**
 * Bash guard. DEFENCE IN DEPTH, NOT A PARSER — and deliberately over-broad.
 *
 * Shell expansion happens AFTER this hook fires, so the tokens here are not
 * the paths the command will touch: `cat memory/pri*\/*.md`,
 * `$(echo memory/private/x)` and `cd memory && cat private/x.md` all reach
 * private/ without spelling it. There is no version of this that is both
 * precise and safe, so it is not precise: on a barred turn Bash is a
 * convenience the model does not need. It can Read named public files
 * (MEMORY.md is in its prompt), and the Read/Glob/Grep arms above are the
 * precise ones.
 *
 * Six shapes are denied. The first two are the literal ones; the rest exist
 * because a reviewer walked straight through the literal ones:
 *
 *  1. Any absolute reference to the memory or private dir.
 *  2. `memory` or `private` as a path segment, however quoted.
 *  3. A GLOB whose literal prefix could expand into either name —
 *     `mem*\/priv*`, `memor?/privat?`, `m[e]mory`. A segment whose glob prefix
 *     is a prefix of "memory"/"private" is denied, and the empty prefix (`*`,
 *     `*.md`) is a prefix of everything, so a bare glob anywhere in the
 *     command is denied too. `ls sk*\/x` still works: "sk" is a prefix of
 *     neither.
 *  4. `find … -exec/-execdir/-ok`, which reads arbitrary files through a
 *     helper that names no path at all.
 *  5. Recursive grep/rg/ag/ack. The Grep TOOL is guarded precisely above;
 *     `grep -r <phrase> $HOME` is how you get around that.
 *  6. Archive and encode commands (tar/zip/base64/xxd/…), which turn "read a
 *     tree" into one command that names only `.`.
 *
 * Shapes 3-6 are the accepted false-positive cost: on a barred turn they are
 * not distinguishable from the exfiltration they enable.
 */
function bashTouchesMemory(cmd: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  if (cmd.includes(ctx.memoryDir) || cmd.includes(ctx.privateDir)) return true;
  // `memory` or `private` as a path segment: bordered by /, quote, whitespace,
  // shell operator, or string boundary. Catches `memory/x`, `./memory`,
  // `cd memory`, `ls memory/private`, `cat private/foo`, etc.
  const memorySegment = /(^|[\s'"`=()|&;></])(memory|private)(\/|$|[\s'"`=()|&;><])/i;
  if (memorySegment.test(cmd)) return true;
  if (BULK_READ_COMMAND.test(cmd)) return true;
  if (FIND_EXEC.test(cmd)) return true;
  if (RECURSIVE_GREP.test(cmd)) return true;
  return bashTokens(cmd).some(globCouldExpandToMemory);
}

/** Archive/encode commands: one invocation reads a whole tree while naming
 *  only `.`, so no path-shaped rule sees it. */
const BULK_READ_COMMAND = /(^|[\s'"`=()|&;></])(tar|zip|unzip|gzip|bzip2|xz|base64|uuencode|xxd|od|cpio|shar)(\s|$)/i;

/** `find … -exec cat {} +` — the path is named by the helper, not the find. */
const FIND_EXEC = /(^|[\s'"`=()|&;></])find(\s|$)[\s\S]*?\s-(exec|execdir|ok|okdir)\b/i;

/** Recursive grep of anything. The Grep tool arm is the precise one; this is
 *  the shell route around it. */
const RECURSIVE_GREP = /(^|[\s'"`=()|&;></])(grep|egrep|fgrep|rg|ag|ack)(?=\s)[^|;&]*?\s-{1,2}(r|R|recursive)\b/i;

/** Split a command into path-ish tokens: shell operators and whitespace are
 *  separators, and quoting is stripped rather than honoured (a quoted glob is
 *  still a glob to us — we are not modelling when the shell expands it). */
function bashTokens(cmd: string): string[] {
  return cmd
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/["'`]/g, ""))
    .filter((t) => t.length > 0);
}

const GLOB_META = /[*?[]/;

/**
 * Could this token's glob expand into `memory` or `private`?
 *
 * Per SEGMENT, on the literal text before the first metacharacter: `mem*`
 * yields "mem" (a prefix of "memory" → deny), `sk*` yields "sk" (a prefix of
 * neither → allow), and `*.md` yields "" — a prefix of everything, which is
 * why any bare glob is denied. That last case is intentional over-matching:
 * a shell glob's expansion is not knowable here, and `cat *` is exactly as
 * dangerous as `cat memory/private/*`.
 */
function globCouldExpandToMemory(token: string): boolean {
  if (!GLOB_META.test(token)) return false;
  return token.split(/[/\\]/).some((segment) => {
    const meta = GLOB_META.exec(segment);
    if (!meta) return false;
    const literalPrefix = segment.slice(0, meta.index).toLowerCase();
    return "memory".startsWith(literalPrefix) || "private".startsWith(literalPrefix);
  });
}
