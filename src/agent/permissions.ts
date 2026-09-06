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

/** The same directory as {@link SKILLS_DIR} without its trailing slash — the
 *  containment root, which `path.relative` needs unsuffixed. */
const SKILLS_ROOT = `${config.workspaceDir}/.claude/skills`;

/** The trees the SDK protects under `bypassPermissions`, and therefore the
 *  ones a call routed here may be trying to reach. `skills/` is carved out of
 *  the first of them; nothing else in either is ever auto-approved. */
const PROTECTED_ROOTS = [`${config.workspaceDir}/.claude`, `${config.workspaceDir}/.git`];

/** SDK canUseTool callback. The SDK auto-approves most tools under
 *  `bypassPermissions`, but writes to `.claude/`, `.git/`, etc. are protected
 *  and fall through to canUseTool. We narrowly re-allow `.claude/skills/` so
 *  tomo can manage its own skill library; every other protected path stays
 *  denied. See https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes.
 *
 *  CONTAINMENT, NOT `startsWith`/`includes`. This is an ALLOW predicate, so a
 *  string test that over-matches hands back exactly what the SDK protected:
 *  `<ws>/.claude/skills/../settings.local.json` starts with the skills prefix
 *  and lands in `.claude/`, and a Bash command that merely MENTIONS the skills
 *  path — in a comment, in an echo, after the `rm` that does the damage — was
 *  approved whole. Paths go through {@link realResolve} (which collapses `..`
 *  and follows symlinks, including a link whose target does not exist yet, the
 *  normal case for a file about to be written) and then an exact containment
 *  test. */
export async function skillsCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const filePath = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (filePath && landsInSkills(filePath)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Bash mkdir / touch / etc. — allow only if every path the command names is
  // inside the skills dir. See bashStaysInSkills.
  if (toolName === "Bash" && typeof input.command === "string" && bashStaysInSkills(input.command)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Permission required for ${toolName}${filePath ? ` on ${filePath}` : ""} — only ${SKILLS_DIR}** is auto-approved at this step.`,
  };
}

/**
 * Containment, CASE-SENSITIVE — the opposite of {@link isInside}, deliberately.
 *
 * This side is an ALLOW predicate: a comparison that fails to establish
 * containment DENIES, which is merely conservative, while one that over-matches
 * grants a write the SDK had protected. So `.claude/SKILLS/` is not treated as
 * `.claude/skills/`: on a case-sensitive volume it is a different directory
 * that must not be auto-approved, and on a case-insensitive one the caller
 * loses nothing by spelling it the way it is spelled on disk.
 */
function isInsideExact(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Does `p` really land at-or-inside `<ws>/.claude/skills`? Both sides are
 *  real-resolved, since the workspace may sit under a symlinked prefix. */
function landsInSkills(p: string): boolean {
  const real = realResolve(p, config.workspaceDir);
  if (real === null) return false;
  return isInsideExact(real, realDir(SKILLS_ROOT, config.workspaceDir) ?? SKILLS_ROOT);
}

/** Does `p` really land in a protected tree OUTSIDE the skills carve-out? */
function landsInProtectedNonSkills(p: string): boolean {
  const real = realResolve(p, config.workspaceDir);
  if (real === null) return false;
  if (landsInSkills(p)) return false;
  return PROTECTED_ROOTS.some((root) => isInsideExact(real, realDir(root, config.workspaceDir) ?? root));
}

/** Words that move the shell's working directory. Every relative token after
 *  one of these is resolved against a cwd this predicate does not know, so a
 *  command containing any of them is refused outright — the same call `$`,
 *  backtick and `~` already get. */
const CHANGES_DIRECTORY = new Set(["cd", "pushd", "popd", "chdir"]);

/** A token with `..` as a path SEGMENT — `../x`, `a/../../b`, a bare `..`.
 *  Not a substring test: `..foo` and `a..b` are ordinary names. */
function hasDotDotSegment(token: string): boolean {
  return token.split("/").includes("..");
}

/**
 * May this Bash command be auto-approved as skill-library housekeeping?
 *
 * Three conditions, all required. At least one token has to really land inside
 * the skills dir (otherwise there is nothing to re-allow), no token may land
 * anywhere else in a protected tree (`.claude/skills/../settings.local.json`,
 * `.git/config`), and the command must contain no `$`, no backtick and no `~`
 * — each of which produces a word this cannot see, and the last of which is
 * how a mention of the skills path smuggles a `~/.claude/...` target past a
 * token scan. Everything else is denied, which costs the caller a permission
 * prompt rather than a capability.
 *
 * TWO MORE WORDS THIS CANNOT SEE, and they belong in that same list.
 *
 * `cd` moves the cwd, and every relative token is resolved here against the
 * WORKSPACE — a fixed root that has nothing to do with where the command will
 * actually run. `cd /ws/.claude/skills && rm -rf ../settings.local.json` was
 * ALLOWED: the first token lands in skills, and `../settings.local.json`
 * resolved against `/ws` is `/settings.local.json`, which is in no protected
 * tree at all. Run for real it deletes the permissions file the SDK routed
 * this callback here to protect. Any `cd`/`pushd`/`popd` is now refused.
 *
 * And `..` in any token, whatever the cwd turns out to be. A traversal that
 * happens to land back inside a protected tree is already caught by
 * `landsInProtectedNonSkills`, but that check only answers for the one root
 * this predicate guessed; a `..` token is by construction a path whose target
 * depends on a directory this code does not know, which is exactly the class
 * of word the paragraph above refuses.
 */
function bashStaysInSkills(cmd: string): boolean {
  if (/[$`~]/.test(cmd)) return false;
  let touchesSkills = false;
  for (const word of bashTokens(cmd)) {
    if (CHANGES_DIRECTORY.has(word)) return false;
    for (const token of pathCandidates(word)) {
      if (hasDotDotSegment(token)) return false;
      if (landsInSkills(token)) {
        touchesSkills = true;
        continue;
      }
      if (landsInProtectedNonSkills(token)) return false;
    }
  }
  return touchesSkills;
}

/**
 * The path-ish parts of one shell word.
 *
 * "Starts with `-`, so it names no path" is true of `-r` and `--recursive` and
 * false of the form every long option actually uses to carry an argument.
 * `--flag=value` is ONE word, and the whole of it was skipped — so
 * `tar -xf /ws/.claude/skills/x.tar --directory=/ws/.claude` and
 * `cp /ws/.claude/skills/a.md --target-directory=/ws/.claude/agents` were
 * ALLOWED on the strength of their source path alone, with the destination
 * never looked at. The word is split at its first `=` and the right-hand side
 * judged as a path like any other.
 *
 * The two-token form (`-C ../.claude`, `--directory /ws/.claude`) never needed
 * this: the value is its own word, does not start with `-`, and the loop above
 * has always judged it — the `..` spelling now on the strength of the segment
 * rule, the absolute one on containment.
 *
 * A non-flag word is offered whole AND split, so a `NAME=path` assignment is
 * judged on its value too rather than on the nonsense path `NAME=/x` resolves
 * to. Extra candidates only ever make this ALLOW predicate stricter.
 */
function pathCandidates(word: string): string[] {
  if (word === "#") return [];
  const eq = word.indexOf("=");
  const afterEq = eq === -1 ? [] : [word.slice(eq + 1)].filter((v) => v.length > 0);
  if (word.startsWith("-")) return afterEq;
  return [word, ...afterEq];
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
 *    `memory/pri*\/*.md` is denied just like `memory/private/*.md`. The root
 *    is judged both as SPELLED and as it REALLY resolves — see
 *    {@link searchFrames}. Probes are
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
 * `Read memory/PRIVATE/secret.md` read the file. ({@link isInsideExact}, used
 * by the `.claude/skills/` re-allow at the top of this file, folds the other
 * way for the same reason: there a failed comparison DENIES, so preserved
 * casing is merely conservative. Same observation, opposite consequence —
 * hence the two helpers.)
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
 * Shared with the `.claude/skills/` re-allow at the top of this file, which
 * needs exactly the same "resolve a path that may not exist yet" behaviour on
 * the allow side of the decision.
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
 * The real path of a guard-relevant directory, resolved once per distinct
 * spelling.
 *
 * `realResolve` walks the tree and can lstat several levels; it ran on every
 * guarded call for a value that does not change. Cached only once the
 * directory actually EXISTS: before that, `realResolve` is re-attaching a
 * not-yet-created tail and the answer can still change when `start.ts` creates
 * the workspace, so caching then would pin a pre-creation guess for the life
 * of the process.
 */
const realDirCache = new Map<string, string>();
function realDir(dir: string, cwd: string): string | null {
  const cached = realDirCache.get(dir);
  if (cached !== undefined) return cached;
  const real = realResolve(dir, cwd);
  if (real !== null && existsSync(dir)) realDirCache.set(dir, real);
  return real;
}

function realPrivateDir(ctx: { cwd: string; privateDir: string }): string | null {
  return realDir(ctx.privateDir, ctx.cwd);
}

function realMemoryDir(ctx: { cwd: string; memoryDir: string }): string | null {
  return realDir(ctx.memoryDir, ctx.cwd);
}

/**
 * The (root, memoryDir, privateDir) triples a Glob/Grep call has to be judged
 * in — the paths as SPELLED, and, when a symlink makes them differ, the paths
 * the kernel will actually walk.
 *
 * The lexical frame alone fails open on a link that never spells either name.
 * `landsInPrivate` real-resolves, but only against `private/`, so a link
 * pointing at `memory/` ITSELF (`<ws>/notes -> <ws>/memory`) is not
 * at-or-inside private/ and passes — and then every containment test below ran
 * on the lexical root, for which `relative("<ws>/notes", "<ws>/memory/private")`
 * is `../memory/private`, i.e. "private/ is not reachable from here". A
 * recursive `Grep({ path: "notes" })` read the whole private tree.
 *
 * The two dirs are resolved ALONGSIDE the root rather than mixed with it: a
 * real root has to be compared against real dirs, since the private dir may
 * itself sit under a symlinked prefix (`/tmp` -> `/private/tmp` on macOS) and
 * a mixed comparison would fail open in the other direction.
 */
interface SearchFrame {
  root: string;
  memoryDir: string;
  privateDir: string;
}

function searchFrames(rootRaw: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): SearchFrame[] {
  const lexical: SearchFrame = { root: abs(rootRaw, ctx.cwd), memoryDir: ctx.memoryDir, privateDir: ctx.privateDir };
  const real = realResolve(rootRaw, ctx.cwd);
  if (real === null || real === lexical.root) return [lexical];
  const realMemory = realMemoryDir(ctx);
  const realPrivate = realPrivateDir(ctx);
  if (realMemory === null || realPrivate === null) return [lexical];
  return [lexical, { root: real, memoryDir: realMemory, privateDir: realPrivate }];
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
  rootRaw: string,
  pattern: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  const frames = searchFrames(rootRaw, ctx);
  if (frames.some((frame) => isInside(frame.root, frame.memoryDir))) return true;
  if (!pattern) return false;
  // ABSOLUTE PATTERNS ARE CHECKED FIRST, AND INDEPENDENTLY OF THE ROOT. An
  // absolute pattern anchors itself: `Glob({ path: "/tmp", pattern:
  // "/ws/memory/private/*.md" })` reaches private/ from a root that is not
  // even an ancestor of it, so the root-relative probes below never see it and
  // the `isRelativeDescendant` short-circuit would return "unreachable".
  if (matchesAnyProbe(absolutePrivateProbes(ctx), pattern)) return true;
  for (const frame of frames) {
    const relPrivate = relative(frame.root, frame.privateDir);
    if (!isRelativeDescendant(relPrivate)) continue;
    // A pattern that steers UPWARD out of the root can re-enter the memory tree
    // by a route the probes cannot model (`../ws/memory/private/*.md` matches
    // neither the relative nor the absolute probe). While private/ is reachable
    // from the root at all, refuse rather than model it.
    if (hasTraversalSegment(pattern)) return true;
    if (matchesAnyProbe(relativePrivateProbes(relPrivate), pattern)) return true;
  }
  return false;
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
  rootRaw: string,
  glob: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  const frames = searchFrames(rootRaw, ctx);
  if (frames.some((frame) => isInside(frame.root, frame.memoryDir))) return true;
  // Absolute filters anchor themselves — see globReachesPrivate.
  if (glob && matchesAnyProbe(absolutePrivateProbes(ctx), glob)) return true;
  for (const frame of frames) {
    const relPrivate = relative(frame.root, frame.privateDir);
    if (!isRelativeDescendant(relPrivate)) continue;
    // No glob filter ⇒ unrestricted recursion ⇒ reaches private/.
    if (!glob) return true;
    // Basename glob (no `/`) is anchored only by file basename; if private/ is
    // reachable from root, ripgrep will scan it and apply the filter there too.
    if (!glob.includes("/")) return true;
    if (hasTraversalSegment(glob)) return true;
    // Path-style glob: probe like Glob does.
    if (matchesAnyProbe(relativePrivateProbes(relPrivate), glob)) return true;
  }
  return false;
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
 * Eight shapes are denied. The first two are the literal ones; the rest exist
 * because a reviewer walked straight through the literal ones:
 *
 *  1. Any absolute reference to the memory or private dir.
 *  2. `memory` or `private` as a path segment, however quoted — tested on the
 *     raw command AND on each token with its quotes stripped, because
 *     adjacent-string concatenation (`cat "mem""ory"/private/x.md`) spells
 *     neither name at a word boundary until the shell glues the halves.
 *     "Quotes" INCLUDES the backslash, which quotes one character rather than
 *     a run: `cat mem\ory/priv\ate/x.md` reads the file in real bash and
 *     spells neither name until the token is dequoted. See {@link bashTokens}.
 *  3. A GLOB whose literal prefix could expand into either name —
 *     `mem*\/priv*`, `memor?/privat?`, `m[e]mory`. A segment whose glob prefix
 *     is a prefix of "memory"/"private" is denied, and the empty prefix (`*`,
 *     `*.md`) is a prefix of everything, so a bare glob anywhere in the
 *     command is denied too. `ls sk*\/x` still works: "sk" is a prefix of
 *     neither.
 *  4. `find … -exec/-execdir/-ok`, which reads arbitrary files through a
 *     helper that names no path at all — and `find` handing its results to a
 *     reader some other way: `find … | xargs cat`, `find … | while read`,
 *     `cat $(find …)`. The pipe or the substitution carries the paths.
 *  5. Recursive grep. The Grep TOOL is guarded precisely above; `grep -r
 *     <phrase> $HOME` is how you get around that, and so is `grep -rn` — the
 *     flag is matched inside a bundled cluster, not only on its own. `rg`,
 *     `ag` and `ack` recurse from `.` BY DEFAULT, so a bare `rg <phrase>` is
 *     the recursive grep and every invocation of those three is refused.
 *  6. Archive and encode commands (tar/zip/base64/xxd/…), which turn "read a
 *     tree" into one command that names only `.`.
 *  7. BRACE EXPANSION — see {@link GLOB_META}. Not globbing, and it needs no
 *     matching file to fire: `cat {m,}emory/{p,}rivate/x.md` expands to
 *     `memory/private/x.md` and spells neither name anywhere.
 *  8. `$` and backticks — the shell writes the path, the caller does not.
 *     Command substitution runs arbitrary code to produce a word
 *     (`cat $(echo memory/private/x)`, named in the paragraph above as
 *     something this cannot parse), and parameter expansion assembles one out
 *     of pieces no rule here can see (`d=memory e=private; cat $d/$e/x`).
 *     Both are refused outright rather than modelled, which is the same call
 *     shapes 3-6 make; `$HOME`-style conveniences are the cost.
 *
 * Shapes 3-8 are the accepted false-positive cost: on a barred turn they are
 * not distinguishable from the exfiltration they enable.
 */
function bashTouchesMemory(cmd: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  if (cmd.includes(ctx.memoryDir) || cmd.includes(ctx.privateDir)) return true;
  if (MEMORY_SEGMENT.test(cmd)) return true;
  if (SHELL_EXPANSION.test(cmd)) return true;
  if (BULK_READ_COMMAND.test(cmd)) return true;
  if (FIND_EXEC.test(cmd)) return true;
  if (FIND_FED_TO_READER.test(cmd)) return true;
  if (RECURSIVE_GREP.test(cmd)) return true;
  if (RECURSIVE_BY_DEFAULT_GREP.test(cmd)) return true;
  const tokens = bashTokens(cmd);
  // The SAME segment rule, re-applied to each token once its quotes are gone.
  // `"mem""ory"/private/x.md` is one word to the shell and two quoted runs
  // to the regex above, where neither `memory` nor `private` sits at a word
  // border — dequoting the token puts them back at one.
  if (tokens.some((token) => MEMORY_SEGMENT.test(token))) return true;
  return tokens.some(globCouldExpandToMemory);
}

/** `memory` or `private` as a path segment: bordered by /, quote, whitespace,
 *  shell operator, or string boundary. Catches `memory/x`, `./memory`,
 *  `cd memory`, `ls memory/private`, `cat private/foo`, etc. */
const MEMORY_SEGMENT = /(^|[\s'"`=()|&;></])(memory|private)(\/|$|[\s'"`=()|&;><])/i;

/** Command substitution, backticks and parameter expansion: the word the shell
 *  ends up with is not the word this hook was handed. Shape 8 above. */
const SHELL_EXPANSION = /[$`]/;

/** Archive/encode commands: one invocation reads a whole tree while naming
 *  only `.`, so no path-shaped rule sees it. */
const BULK_READ_COMMAND = /(^|[\s'"`=()|&;></])(tar|zip|unzip|gzip|bzip2|xz|base64|uuencode|xxd|od|cpio|shar)(\s|$)/i;

/** `find … -exec cat {} +` — the path is named by the helper, not the find. */
const FIND_EXEC = /(^|[\s'"`=()|&;></])find(\s|$)[\s\S]*?\s-(exec|execdir|ok|okdir)\b/i;

/** `find … | xargs cat`, `find … | while read f; do cat "$f"; done`,
 *  `cat $(find …)`, `` cat `find …` ``: the same shape as FIND_EXEC with the
 *  helper on the other side of a pipe or a substitution. A `find` that only
 *  prints (no pipe, no substitution) is left alone. */
const FIND_FED_TO_READER = /(^|[\s'"`=()|&;></])find(\s|$)[^|;&]*\||(\$\(|`)\s*find(\s|$)/i;

/** Recursive grep of anything. The Grep tool arm is the precise one; this is
 *  the shell route around it. The `r`/`R` is matched anywhere inside a short
 *  flag cluster (`-rn`, `-ri`, `-rl`, `-inR`) — a `\b` after a lone `r`
 *  missed every one of those — and GNU grep's `-d recurse` /
 *  `--directories=recurse` spellings are the same thing. */
const RECURSIVE_GREP = /(^|[\s'"`=()|&;></])(grep|egrep|fgrep)(?=\s)[^|;&]*?\s(-[a-z]*r[a-z]*|--(dereference-)?recursive|-d\s*recurse|--directories=recurse)(\s|=|$)/i;

/** `rg`, `ag` and `ack` recurse from the current directory by default, so a
 *  bare `rg <term>` IS the recursive grep: any invocation is refused, flag or
 *  no flag. */
const RECURSIVE_BY_DEFAULT_GREP = /(^|[\s'"`=()|&;></])(rg|ag|ack)(\s|$)/i;

/** Split a command into path-ish tokens: shell operators and whitespace are
 *  separators, and quoting is stripped rather than honoured (a quoted glob is
 *  still a glob to us — we are not modelling when the shell expands it).
 *
 *  BACKSLASH IS A QUOTING OPERATOR TOO — and it was the one left in the token.
 *  `\` quotes the single character that follows it, so `cat mem\ory/priv\ate/x.md`
 *  and `cd mem\ory && cat priv\ate/x.md` open exactly the files those two names
 *  spell (real bash prints the contents), while {@link MEMORY_SEGMENT} was
 *  handed `mem\ory` and found neither name at a word border. It is stripped
 *  alongside the quotes so every rule below runs on the word the shell will
 *  build rather than the one the caller typed. */
function bashTokens(cmd: string): string[] {
  return cmd
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/["'`\\]/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * Where a token stops being the path the shell will use.
 *
 * `{` is in here because BRACE EXPANSION is not globbing: it fires whether or
 * not anything matches on disk, so `cat {m,}emory/{p,}rivate/x.md` reaches the
 * file having spelled neither `memory` nor `private` anywhere in the command.
 * A `{` yields an empty literal prefix for its segment, which is a prefix of
 * everything — so, like a bare `*`, any brace in a path-ish token is denied.
 */
const GLOB_META = /[*?[{]/;

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
