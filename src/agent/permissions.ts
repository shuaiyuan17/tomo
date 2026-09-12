import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as pathResolve } from "node:path";
import { minimatch } from "minimatch";
import { config, RESERVED_AGENT_TYPE, type AgentProfile } from "../config.js";
import { log } from "../logger.js";
import { MEMORY_DIR, PRIVATE_MEMORY_DIR, PRIVATE_MEMORY_SUBDIR } from "../workspace/index.js";
import { extractAttachments } from "./text-utils.js";
import { sandboxedBashCommand } from "./bash-sandbox.js";

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

/**
 * The ONE place the bar is decided, so every enforcement point agrees.
 *
 * Three enforcement points now read it: the PreToolUse hook (sdk-options.ts),
 * the reply-delivery attachment check (delivery-pipeline.ts) and — through the
 * hook — the `send_message` tool. A second, independently-written copy of this
 * rule is how one of them ends up open while the others are shut.
 *
 * `isGroup` rather than the session key, deliberately: this module has no
 * business parsing session keys (that is `sessions/keys.ts`), and taking the
 * answer as a parameter keeps its import graph small enough that the guard can
 * be unit-tested without booting the world.
 */
export function privateMemoryBarFor(
  isGroup: boolean,
  isOwnAudienceTurn?: () => boolean,
): PrivateMemoryBar | null {
  if (isGroup) return "group-session";
  if (isOwnAudienceTurn && !isOwnAudienceTurn()) return "summoned-turn";
  return null;
}

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

/**
 * Why the shell is withheld when it cannot be SANDBOXED — the fallback, no
 * longer the rule.
 *
 * Filtering the command TEXT was never the answer, and still isn't.
 * {@link bashTouchesMemory} is a token scan over what the model typed, and any
 * interpreter writes a path that text never spells:
 *
 *     node -e 'process.stdout.write(require("node:fs")
 *       .readFileSync("mem"+"ory/pri"+"vate/note.txt","utf8"))'
 *
 * — no `memory`, no `private`, no `$`, no backtick, no glob, nothing for a
 * regex to find. `python -c`, `perl -e`, `osascript -e`, `bash ./script.sh`,
 * and any script the agent wrote on an earlier turn are the same shape, and
 * they are not a list that can be completed: the argument to an interpreter is
 * a program, and deciding what a program reads is not a job for a regex.
 *
 * The text was the wrong LAYER, though, not the only one. A barred turn now gets
 * its shell, wrapped in a `sandbox-exec` profile that denies
 * `memory/private/` in the kernel — see `./bash-sandbox.ts`. The assembled path
 * above gets `EPERM` at `open(2)`, where the path is resolved and the spelling
 * has stopped mattering.
 *
 * This text is what remains for the case where that wrap is unavailable (no
 * `sandbox-exec`, an unwritable profile, a malformed tool input): the shell is
 * withheld, exactly as before. The fallback is WITHHOLD, never an unsandboxed
 * shell, so a host without the sandbox is no worse off than it was and a host
 * with it is not trusted to have it.
 */
export const PRIVATE_MEMORY_BASH_WITHHELD =
  `The Bash tool is not available on this turn. It normally runs inside a \`sandbox-exec\` profile that makes \`memory/${PRIVATE_MEMORY_SUBDIR}/\` unreadable at the kernel level, but that sandbox could not be set up on this host — and an unsandboxed shell is not offered as a substitute, because no filter over command text can scope a shell away from a directory (any interpreter can assemble a path the text never spells). Use Read on a named public file (MEMORY.md is already in your prompt), or Glob/Grep outside the memory tree.`;

/** The reason handed back for a denied Bash call: why the shell is gone, then
 *  why this turn is barred at all (and, for a summoned turn, the way round). */
export function privateMemoryBashDenial(bar: PrivateMemoryBar): string {
  return `${PRIVATE_MEMORY_BASH_WITHHELD}\n\n${privateMemoryDenialReason(bar)}`;
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
 *  life of the session.
 *
 *  BASH IS REWRITTEN, NOT DENIED, while the bar is up. The command is wrapped in
 *  a `sandbox-exec` profile that denies `memory/private/` in the kernel
 *  (`./bash-sandbox.ts`) and handed back through the hook's `updatedInput`, so
 *  the turn keeps its shell and the directory stays unreachable however the path
 *  is spelled. `updatedInput` is the SDK's documented seam for this
 *  ("`updatedInput` - Modified tool input (PreToolUse only)") and is returned
 *  WITHOUT a `permissionDecision`: the CLI collects the rewritten input
 *  independently of the decision, so a bare rewrite neither approves the call
 *  nor suppresses the other PreToolUse guards — `deny` from any of them still
 *  wins. Only when the wrap is unavailable does the old outright deny stand;
 *  see {@link PRIVATE_MEMORY_BASH_WITHHELD}.
 *
 *  SUBAGENTS GO THROUGH HERE TOO. The SDK propagates the session's hooks into
 *  Agent-tool children, so a delegated `Bash` call on a barred turn reaches
 *  this same PreToolUse callback and is sandboxed by the same arm. That matters:
 *  `agentProfileGuardHooks` below fails OPEN for a subagent type with no
 *  profile, so a subagent is not a way round the bar only because this guard is
 *  not scoped to the main thread. */
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
        const isBash = input.tool_name === "Bash";
        if (isBash) {
          const sandboxed = sandboxedBashInput(input.tool_input);
          if (sandboxed) {
            log.info(
              { key: sessionKey, bar: reason },
              "Sandboxed Bash on a private-memory-barred turn",
            );
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                updatedInput: sandboxed,
              },
            };
          }
        } else if (!isPrivateMemoryAccess(input.tool_name, input.tool_input, ctx)) {
          return {};
        }
        log.warn(
          { key: sessionKey, tool: input.tool_name, bar: reason },
          isBash ? "Blocked Bash on a private-memory-barred turn" : "Blocked access to private memory",
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: isBash
              ? privateMemoryBashDenial(reason)
              : privateMemoryDenialReason(reason),
          },
        };
      }],
    }],
  };
}

/**
 * A `Bash` tool input with its `command` rewritten to run sandboxed, or `null`
 * to fall back to withholding the shell.
 *
 * The rest of the input is carried through unchanged (`description`, `timeout`,
 * `run_in_background`): the CLI validates `updatedInput` against the tool's full
 * schema and drops a rewrite that fails it, so returning `{ command }` alone
 * would quietly lose whichever other fields the model set.
 *
 * A non-string `command` returns `null` rather than being coerced — a shape this
 * code does not recognise is a shape it cannot prove it has sandboxed.
 */
export function sandboxedBashInput(toolInput: unknown): Record<string, unknown> | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const ti = toolInput as Record<string, unknown>;
  if (typeof ti.command !== "string") return null;
  const command = sandboxedBashCommand(ti.command);
  return command === null ? null : { ...ti, command };
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
 *  - `send_message`: deny when a `MEDIA:` tag in the composed message names a
 *    path that lands in private/. THE ATTACHMENT IS THE READ — the file is
 *    opened by the channel and its contents go to the target chat, so a tool
 *    that never touches `file_path` was the way to ship `memory/private/x` into
 *    a group from a turn that could not Read it. Relative paths resolve against
 *    the workspace, the same cwd the agent runs in.
 *  - Bash: see {@link bashTouchesMemory}. NOT THE DECIDING ARM — the hook
 *    sandboxes every Bash call while the bar is up (`./bash-sandbox.ts`), and
 *    withholds the shell only if it cannot (see
 *    {@link PRIVATE_MEMORY_BASH_WITHHELD}). Shell expansion and, worse,
 *    interpreter arguments happen after the hook fires, so the tokens here are
 *    not the paths the command will touch; the kernel sees those. Kept as a
 *    described-shape predicate for callers that want to ask the narrower
 *    question.
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
    case SEND_MESSAGE_TOOL: {
      const message = ti.message;
      if (typeof message !== "string") return false;
      return mediaPathsIn(message).some((p) => landsInPrivate(p, ctx));
    }
    default:
      return false;
  }
}

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

/** The `MEDIA:` paths a composed message would ship as attachments — the same
 *  extraction the delivery paths run, so guard and sender agree on what counts
 *  as a tag. */
function mediaPathsIn(message: string): string[] {
  return extractAttachments(message).mediaPaths;
}

/**
 * Would attaching `p` surface private memory? For the outbound side, where the
 * caller has already decided the turn is barred.
 *
 * Shares {@link landsInPrivate} with the tool guard — lexical containment, the
 * `..`-anywhere-under-memory rule, AND the symlink-resolved comparison, so a
 * link parked under a public directory that points into private/ is caught by
 * the path it really opens rather than the one it is spelled with. The two
 * sides of the fence must answer the same question the same way, or the model
 * learns that what it cannot read it can still send.
 */
export function isPrivateAttachmentPath(p: string): boolean {
  return landsInPrivate(p, {
    cwd: config.workspaceDir,
    memoryDir: MEMORY_DIR,
    privateDir: PRIVATE_MEMORY_DIR,
  });
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
 * precise and safe, so it is not precise.
 *
 * It is also no longer what holds the line. A barred turn's shell runs inside a
 * `sandbox-exec` profile that denies the private dir in the KERNEL
 * (`./bash-sandbox.ts`), which is the precise arm a token scan can never be —
 * the check lands on the resolved path at `open(2)`, after every expansion this
 * function cannot model. What remains here is a described-shape predicate for
 * callers asking the narrower "does this command MENTION the memory tree?"
 * question, and the over-broad answers below cost nothing now that no tool call
 * is decided by them.
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

// ---------------------------------------------------------------------------
// Per-agent permission scoping (config `agentProfiles`)
// ---------------------------------------------------------------------------

/**
 * POLICY, NOT A SANDBOX. Read this before trusting anything below.
 *
 * Every session runs `permissionMode: "bypassPermissions"` (sdk-options.ts) and
 * the SDK propagates that mode into subagents, so a subagent inherits the
 * daemon owner's entire machine. `AgentDefinition` scopes TOOLS but has no
 * notion of a path, so `tools: Read, Grep, Glob, Bash` on a "read-only
 * reviewer" is a full shell.
 *
 * These hooks close the accident-shaped part of that hole. They do NOT close
 * the adversarial-shaped part. The checks run in the daemon and the thing they
 * constrain is a CLI child process, which is the wrong side of a trust boundary
 * for a real sandbox — and by deliberate decision `readonly` allows `$(…)`,
 * backticks and pipes, any of which can assemble a command no token scan here
 * can see. An agent that wants out gets out.
 *
 * THREE LIMITS WORTH KNOWING BEFORE YOU RELY ON THIS.
 *
 *  1. THE DAEMON DOES NOT KNOW A SUBAGENT'S CWD. The Agent tool's
 *     `isolation: "worktree"` never reports the worktree path back, so a
 *     RELATIVE token is a path whose destination is unknowable here. It is
 *     therefore never judged on the ALLOW side — `mkdir -p Sources/New` and
 *     `rm -rf build/Old` pass in `worktree` mode, which is the point of that
 *     mode — and on the DENY side it is resolved against the WORKSPACE, which
 *     is the cwd a subagent inherits when it has no worktree of its own. That
 *     is what catches `rm -rf memory`, `rm -rf *` and `git clean -fdx`. What
 *     it does not catch, and cannot, is an agent destroying its own worktree.
 *  2. `denyPaths` IS A WRITE FENCE, NOT A READ FENCE. A reviewer's job is to
 *     read the checkouts it must never modify. `denyReadPaths` is the separate,
 *     blunter list for the paths where reading is itself the harm.
 *  3. THE VERB LIST IS A LIST. It is long and it will still be incomplete;
 *     every entry is a command someone noticed. Treat a gap as a bug report,
 *     not as a security boundary that failed.
 *  4. A REDIRECTION INSIDE A QUOTED SUB-SHELL IS INVISIBLE.
 *     `sh -c 'cat x > /etc/passwd'` and `bash -c "… >> …"` put the whole
 *     command inside one quoted run, and {@link maskQuotedOperators} blanks
 *     shell operators inside quotes — which is exactly what it must do for
 *     `awk '$1 > 5' f`, and exactly wrong here. The two are the same bytes;
 *     telling them apart means knowing that `sh -c` re-parses its argument as
 *     a command, i.e. writing the shell parser this file has declined to
 *     write. `sh`/`bash`/`zsh` are not on the verb list either, so this is a
 *     hole, and it is the same hole as `$(…)`: an agent that reaches for
 *     `sh -c` to get a redirection past the guard is jailbreaking, which is
 *     v2's problem (a real sandbox), not a token scan's.
 *
 * Why PreToolUse and not `canUseTool`: `canUseTool` is handed an opaque
 * `agentID` with no `agent_type` (sdk.d.ts), so it cannot tell WHICH profile
 * applies — and a PreToolUse denial bypasses `canUseTool` anyway, the same
 * property the private-memory bar above relies on.
 */

/** Tools whose whole job is to write one named file. */
const AGENT_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Tool-input fields that can name a path. `content` is deliberately absent:
 *  prose that happens to quote a protected path is not an access. */
const PATH_BEARING_INPUTS = ["file_path", "notebook_path", "path", "pattern", "glob", "command"] as const;

/** How much of a subagent's Bash command goes into the audit line. Enough to
 *  identify the command, short enough that a log shipper is not carrying whole
 *  heredocs. */
const BASH_AUDIT_CHARS = 120;

/** The shape of the PreToolUse payload this guard reads. `agent_id` is the
 *  documented way to tell a subagent call from a main-thread one — it is
 *  ABSENT on the main thread even in `--agent` sessions, while `agent_type` is
 *  present in both — so the main-thread test keys off `agent_id` alone. */
interface AgentHookInput {
  tool_name: string;
  tool_input: unknown;
  agent_id?: string;
  agent_type?: string;
}

/**
 * PreToolUse hook that applies the calling subagent's `agentProfiles` entry.
 *
 * Three populations, three outcomes:
 *  - MAIN THREAD (no `agent_id`) — returns `{}` before anything else runs. The
 *    owner's own turn is not scoped by this and never has been.
 *  - A SUBAGENT WITH NO PROFILE — fail-OPEN, plus one `log.warn` per
 *    (session, agent_type) naming the tool. The set lives in this closure and
 *    the closure is built once per live session, so "once per session per type"
 *    is structural rather than a counter someone has to maintain. The point of
 *    the warning is measurement: nobody knows the real tool surface of
 *    `general-purpose` / `Explore` / ad-hoc delegations, and fail-closed would
 *    break all of them on turn one. Flip the default once the logs say what it
 *    would cost.
 *  - A SUBAGENT WITH A PROFILE — {@link agentProfileDenial} decides.
 *
 * Every subagent Bash call is logged at info regardless of the decision, so the
 * audit trail covers the fail-open population too — that is where the surface
 * being measured actually lives.
 *
 * `lookup` is a FUNCTION, not the map: it is resolved per tool call, so a
 * profile change does not have to wait for every live session to be recycled.
 */
export function agentProfileGuardHooks(
  sessionKey: string | undefined,
  lookup: (agentType: string) => AgentProfile | undefined,
) {
  const cwd = config.workspaceDir;
  const warnedTypes = new Set<string>();
  return {
    PreToolUse: [{
      hooks: [async (input: AgentHookInput) => {
        if (!input.agent_id) return {};
        const agentType = input.agent_type ?? RESERVED_AGENT_TYPE;

        if (input.tool_name === "Bash") {
          const command = (input.tool_input as { command?: unknown } | null | undefined)?.command;
          log.info(
            {
              key: sessionKey,
              agentType,
              agentId: input.agent_id,
              command: typeof command === "string" ? command.slice(0, BASH_AUDIT_CHARS) : undefined,
            },
            "Subagent Bash call",
          );
        }

        const profile = lookup(agentType);
        if (!profile) {
          if (!warnedTypes.has(agentType)) {
            warnedTypes.add(agentType);
            log.warn(
              { key: sessionKey, agentType, tool: input.tool_name },
              "Subagent has no agentProfiles entry — allowing unscoped (fail-open)",
            );
          }
          return {};
        }

        const reason = agentProfileDenial(profile, input.tool_name, input.tool_input, cwd);
        if (!reason) return {};
        log.warn(
          { key: sessionKey, agentType, tool: input.tool_name, reason },
          "Blocked by agent permission profile",
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              `Blocked by the "${agentType}" agent permission profile: ${reason}`,
          },
        };
      }],
    }],
  };
}

/**
 * Why this tool call is refused under `profile` — or null when it is allowed.
 * Exported for testing.
 *
 * `denyReadPaths` is checked for EVERY tool, including Read/Grep/Glob.
 * Everything else is a write rule and only the write tools and Bash reach it.
 */
export function agentProfileDenial(
  profile: AgentProfile,
  toolName: string,
  toolInput: unknown,
  cwd: string,
): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const ti = toolInput as Record<string, unknown>;

  const secret = secretMentionDenial(profile, toolName, ti, cwd);
  if (secret) return secret;

  if (AGENT_WRITE_TOOLS.has(toolName)) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return null;
    return writeDenial(profile, p, cwd, toolName);
  }
  if (toolName === "Bash") {
    const cmd = ti.command;
    if (typeof cmd !== "string") return null;
    return bashDenial(profile, cmd, cwd);
  }
  return null;
}

/**
 * `denyReadPaths` — the secrets list. ANY mention by ANY tool.
 *
 * Two passes, because each catches what the other misses. The RAW SUBSTRING
 * pass sees a path named somewhere the tokenizer does not look (inside a
 * heredoc body, inside a `--flag=…` cluster split some other way). The
 * RESOLUTION pass sees a path the raw text does not spell: `~/.ssh/id_rsa`,
 * a symlink into the private memory tree, `memory/private/x` relative to the
 * workspace the subagent inherited its cwd from.
 */
function secretMentionDenial(
  profile: AgentProfile,
  toolName: string,
  ti: Record<string, unknown>,
  cwd: string,
): string | null {
  if (profile.denyReadPaths.length === 0) return null;
  for (const field of PATH_BEARING_INPUTS) {
    const value = ti[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const spelled = profile.denyReadPaths.find((deny) => value.includes(deny));
    if (spelled) {
      return `\`${spelled}\` is on this agent's denyReadPaths, and ${toolName}'s \`${field}\` names it.`;
    }
    const candidates = field === "command" ? pathishTokens(value) : [value];
    const hit = candidates.find((c) => landsIn(c, profile.denyReadPaths, cwd, false));
    if (hit !== undefined) return `\`${hit}\` is on this agent's denyReadPaths (not readable by this agent).`;
  }
  return null;
}

/**
 * A write tool's target.
 *
 * `denyPaths` first, so a path inside both a denyPath and a writeRoot reports
 * the rule that decided it. Then `writeRoots` — UNLESS the mode is `full`,
 * which switches writeRoots off for the file tools exactly as it does for Bash:
 * a profile that says "this agent may run any command anywhere except these
 * paths" and then refuses its `Write` calls is incoherent, and the incoherence
 * was invisible because the two halves lived in different functions.
 */
function writeDenial(profile: AgentProfile, p: string, cwd: string, toolName: string): string | null {
  if (landsIn(p, profile.denyPaths, cwd, false)) {
    return `\`${p}\` is on this agent's denyPaths (readable, but not writable by this agent).`;
  }
  if (profile.bash === "full") return null;
  if (!landsInWriteRoot(p, profile, cwd)) {
    return profile.writeRoots.length === 0
      ? `this agent has no writeRoots, so ${toolName} is denied everywhere.`
      : `\`${p}\` is outside this agent's writeRoots (${profile.writeRoots.join(", ")}).`;
  }
  return null;
}

/**
 * Bash, by mode. NOT A SHELL PARSER — see the header above.
 *
 * The order matters and is not arbitrary:
 *
 *  1. `none` refuses everything, before any parsing.
 *  2. `denyPaths` bind WRITES ONLY, so they are consulted only for a command
 *     that names a write verb or carries a redirection. `cat`, `git log` and
 *     `git -C <denyPath> worktree list` are reads and are allowed. (The read
 *     fence is `denyReadPaths`, applied to every tool one level up.)
 *  3. `full` stops here — the deny lists are its whole policy.
 *  4. Redirections are the write no verb scan can see (`echo x > y` names no
 *     write command at all), so they are checked against `writeRoots`.
 *  5. A write VERB is held to the writeRoots by the same test in both surviving
 *     modes, differing in one clause. See {@link writeVerbTargetDenial}.
 *
 * READONLY USED TO REFUSE THE VERB OUTRIGHT, AND CONTRADICTED ITSELF DOING IT.
 * A `readonly` profile with `/tmp` in its writeRoots allowed
 * `Write /tmp/ok` and `echo hi > /tmp/ok`, and refused `touch /tmp/marker`,
 * `mkdir -p /tmp/dd`, `cp /tmp/a /tmp/b` and `rm -rf /tmp/scratch` — the same
 * write, to the same permitted directory, decided three different ways
 * depending on which surface expressed it. The bar was not even a bar: `cat a >
 * b` walked round it, because a redirection names no verb. `readonly` now means
 * what its writeRoots say it means.
 */
function bashDenial(profile: AgentProfile, cmd: string, cwd: string): string | null {
  if (profile.bash === "none") {
    return "the Bash tool is not available to this agent type (bash: \"none\").";
  }

  const verb = writeVerbIn(cmd);
  const redirects = redirectTargets(cmd);

  const blocked = writeTargets(cmd, verb, redirects, cwd)
    .find((target) => landsIn(target.path, profile.denyPaths, cwd, true));
  if (blocked) {
    return `${blocked.why} \`${blocked.path}\`, which is on this agent's denyPaths (readable, but not writable by this agent).`;
  }

  if (profile.bash === "full") return null;

  for (const target of redirects) {
    if (HARMLESS_REDIRECT_TARGET.test(target)) continue;
    // A relative target lands somewhere this code cannot know — not judged on
    // the allow side. It was already judged on the deny side above.
    if (!isAbsoluteish(target)) continue;
    if (!landsInWriteRoot(target, profile, cwd)) {
      return `the redirection target \`${target}\` is outside this agent's writeRoots.`;
    }
  }

  return verb ? writeVerbTargetDenial(profile, cmd, verb, cwd) : null;
}

/**
 * Hold a write verb's targets to the writeRoots. ONE TEST, TWO MODES, ONE
 * CLAUSE OF DIFFERENCE.
 *
 * Both modes require every ABSOLUTE path token to land inside a writeRoot;
 * relative tokens are not judged, because the daemon does not know the cwd they
 * resolve against (limit 1 in the header).
 *
 * `readonly` adds the clause: at least one absolute token must be PRESENT. That
 * is the whole of the distinction between the two modes, and it is the right
 * shape for it. A `readonly` agent may write only where it can name the place
 * out loud — `touch /tmp/marker` is a write to a directory its profile grants,
 * while `rm -rf x` and `rm -rf *` name a destination nobody in this process can
 * locate, so they stay refused. A `worktree` agent is trusted with its own
 * unnamed cwd and keeps `rm -rf build/Old`.
 */
function writeVerbTargetDenial(
  profile: AgentProfile,
  cmd: string,
  verb: string,
  cwd: string,
): string | null {
  for (const segment of commandSegments(cmd)) {
    const segVerb = writeVerbIn(segment);
    if (!segVerb) continue;
    const tokens = bashTokens(segment);
    const segCwd = segmentCwd(tokens, cwd);
    // `/dev/null` and friends are sinks, not places: `… > /dev/null` in the
    // same segment as `rm -rf /tmp/scratch` must not hold `rm` to `/dev/null`.
    const absolute = tokens
      .flatMap(pathCandidates)
      .filter(isAbsoluteish)
      .filter((token) => !HARMLESS_REDIRECT_TARGET.test(token));
    // A git segment repointed at an absolute worktree names its place out loud
    // even when its pathspecs are relative — that is what `-C` is for.
    if (profile.bash === "readonly" && absolute.length === 0 && segCwd === cwd) {
      return `\`${segVerb}\` writes, and in "readonly" mode a write has to name an absolute path inside this agent's writeRoots (${profile.writeRoots.join(", ") || "none configured"}).`;
    }
    const outside = absolute.find((token) => !landsInWriteRoot(token, profile, segCwd));
    if (outside !== undefined) {
      return `\`${segVerb}\` writes and \`${outside}\` is outside this agent's writeRoots.`;
    }
    if (segCwd !== cwd && !landsInWriteRoot(segCwd, profile, cwd)) {
      return `\`${segVerb}\` writes under \`${segCwd}\` (git -C / --work-tree), which is outside this agent's writeRoots.`;
    }
  }
  void verb;
  return null;
}

// ---------------------------------------------------------------------------
// The verb list.
//
// Every entry is a command that WRITES. It is long, it is still incomplete, and
// it is matched by whole TOKEN anywhere in the command rather than in command
// position — `echo x | tee /etc/hosts` puts the write on the far side of a
// pipe, and tracking command position means parsing the shell. The cost is that
// a command merely mentioning one of these words is refused under `readonly`;
// on a mode whose whole promise is "this agent does not write", that is the
// right direction to be wrong in.
//
// `kill`/`killall`/`pkill` are NOT here. They are how a reviewer clears a hung
// simulator, and a signal is not a filesystem write.
// ---------------------------------------------------------------------------

/** Single-token commands that write. */
const WRITE_VERBS = new Set([
  "rm", "rmdir", "mv", "cp", "tee", "dd", "chmod", "chown", "ln", "mkdir",
  "touch", "truncate", "install", "brew", "launchctl", "unlink", "shred",
  "ditto", "chflags",
  // wget writes its download to disk with no flag asked for.
  "wget",
]);

/** A token this rule needs to see. A RegExp where the flag has spellings that
 *  a literal compare misses — `sed -i.bak`, `sed -i''`. */
type TokenMatch = string | RegExp;

/**
 * Rules of the form "all of these tokens are present ⇒ this command writes".
 *
 * ADJACENCY IS NOT REQUIRED, deliberately: `git -C /repo push` puts a flag
 * between head and subcommand, `xcrun simctl erase` puts another command in
 * front, and `curl -sSL -o out` separates the two by a cluster. That is also
 * why `git log $(git merge-base main HEAD)` survives — `git` is present, but
 * `merge-base` is not `merge`.
 *
 * The cost is over-matching on a command that merely names both tokens
 * (`git log --grep merge`). Same call as the single-token list above.
 */
const WRITE_TOKEN_SETS: Array<{ label: string; tokens: TokenMatch[] }> = [
  { label: "git push", tokens: ["git", "push"] },
  { label: "git commit", tokens: ["git", "commit"] },
  { label: "git checkout", tokens: ["git", "checkout"] },
  { label: "git reset", tokens: ["git", "reset"] },
  { label: "git rebase", tokens: ["git", "rebase"] },
  { label: "git stash", tokens: ["git", "stash"] },
  { label: "git clean", tokens: ["git", "clean"] },
  { label: "git merge", tokens: ["git", "merge"] },
  { label: "git apply", tokens: ["git", "apply"] },
  { label: "git worktree remove", tokens: ["git", "worktree", "remove"] },
  { label: "git worktree prune", tokens: ["git", "worktree", "prune"] },
  { label: "git config --global", tokens: ["git", "config", "--global"] },
  { label: "git config --system", tokens: ["git", "config", "--system"] },
  { label: "npm install", tokens: ["npm", "install"] },
  { label: "npm publish", tokens: ["npm", "publish"] },
  { label: "npm ci", tokens: ["npm", "ci"] },
  { label: "defaults write", tokens: ["defaults", "write"] },
  // `xcrun simctl …` and a bare `simctl …` are the same command.
  { label: "simctl delete", tokens: ["simctl", "delete"] },
  { label: "simctl erase", tokens: ["simctl", "erase"] },
  { label: "simctl shutdown", tokens: ["simctl", "shutdown"] },
  { label: "simctl boot", tokens: ["simctl", "boot"] },
  { label: "xcodebuild clean", tokens: ["xcodebuild", "clean"] },
  { label: "swift package reset", tokens: ["swift", "package", "reset"] },
  { label: "swift package clean", tokens: ["swift", "package", "clean"] },
  { label: "find -delete", tokens: ["find", "-delete"] },
  // `-i`, `-i.bak`, `-i''` are all in-place edits.
  { label: "sed -i", tokens: ["sed", /^-i/] },
  { label: "perl -i", tokens: ["perl", /^-i/] },
  { label: "rsync --delete", tokens: ["rsync", /^--delete/] },
  { label: "curl -o", tokens: ["curl", /^(-[a-zA-Z]*[oO]|--output)$/] },
  { label: "gh pr merge", tokens: ["gh", "pr", "merge"] },
  { label: "gh pr close", tokens: ["gh", "pr", "close"] },
  { label: "xattr -w", tokens: ["xattr", "-w"] },
  { label: "xattr -d", tokens: ["xattr", "-d"] },
];

/**
 * Write verbs whose BARE (separator-free) arguments are usually paths.
 *
 * Only these resolve a bare token against the workspace for the deny check.
 * The alternative — resolving bare tokens for EVERY write verb — denies
 * `git commit -m memory`, because `memory` is then a path that lands on a
 * denyPath. The four accidents this rule exists for (`rm -rf memory`,
 * `rm -rf *`, `git clean -fdx`, `rm -rf .`) are all in here, and a token with
 * a `/` in it is resolved for every write verb regardless.
 */
const BARE_ARG_IS_PATH = new Set([
  "rm", "rmdir", "mv", "cp", "tee", "dd", "truncate", "shred", "unlink",
  "ditto", "chmod", "chown", "ln", "touch", "mkdir", "install", "chflags",
  "git clean", "git checkout", "git reset", "git apply",
  "xcodebuild clean", "swift package clean", "swift package reset",
  "find -delete", "sed -i", "perl -i", "rsync --delete", "curl -o",
]);

/** Tokens that mean "everything under the current directory". As the target of
 *  a write verb they are the most destructive thing a confused agent types, and
 *  they name no path at all — so for the deny check they stand in for the cwd
 *  the subagent inherited, which is the workspace. */
const CWD_TARGETS = new Set(["*", ".", "./", "..", "../", "*/", "*.*"]);

/** The first write verb this command names, or null. */
function writeVerbIn(cmd: string): string | null {
  const tokens = bashTokens(cmd);
  const bare = tokens.find((token) => WRITE_VERBS.has(token));
  if (bare !== undefined) return bare;
  const rule = WRITE_TOKEN_SETS.find(({ tokens: needed }) => needed.every(
    (match) => tokens.some((token) => (typeof match === "string" ? token === match : match.test(token))),
  ));
  return rule ? rule.label : null;
}

/** A path a command is about to WRITE to, with the phrasing its denial needs. */
interface WriteTarget {
  path: string;
  why: string;
}

/**
 * Everything this command may write to, for the `denyPaths` check only.
 *
 * Relative tokens are included HERE and nowhere else: on the deny side they are
 * resolved against the workspace, which is the cwd a subagent inherits when it
 * has no worktree of its own, and that is what turns `rm -rf memory` — typed by
 * an agent that thought it was somewhere else — into a denial instead of a
 * restore-from-backup.
 */
function writeTargets(cmd: string, verb: string | null, redirects: string[], cwd: string): WriteTarget[] {
  const targets: WriteTarget[] = redirects
    .filter((target) => !HARMLESS_REDIRECT_TARGET.test(target))
    .map((target) => ({ path: target, why: "the redirection target is" }));
  if (!verb) return targets;

  // Judged PER SEGMENT. The whole-line scan held `rm -rf /tmp/scratch` to every
  // token of `xcodebuild … | sed 's/^/  /'` before it — and `sed`'s lone `/`
  // is an ancestor of every denyPath, so the compound was refused as "`rm`
  // writes to `/`". A verb's targets are the words of its own segment.
  for (const segment of commandSegments(cmd)) {
    const segVerb = writeVerbIn(segment);
    if (!segVerb) continue;
    const tokens = bashTokens(segment);
    const segCwd = segmentCwd(tokens, cwd);
    const bareArePaths = BARE_ARG_IS_PATH.has(segVerb);
    for (const word of tokens) {
      for (const token of pathCandidates(word)) {
        if (CWD_TARGETS.has(token)) {
          // `rm -rf *` names no path; the thing it destroys is the cwd.
          targets.push({ path: segCwd, why: `\`${segVerb}\` targets the working directory` });
          continue;
        }
        if (token.includes("/") || token.startsWith("~") || bareArePaths) {
          targets.push({ path: isAbsoluteish(token) ? token : pathResolve(segCwd, token), why: `\`${segVerb}\` writes to` });
        }
      }
    }
    // Two commands that destroy the tree while naming neither a path nor a `*`.
    // `git reset --hard` is the twin of `git clean -fdx`: it throws away every
    // uncommitted change under the cwd, which for a subagent that never moved
    // is the workspace. Both push the segment's cwd — which `git -C <dir>` /
    // `--work-tree=<dir>` may have repointed (segmentCwd); without that flag
    // they push the process cwd, which is the conservative direction.
    if (segVerb === "git clean" && /(^|\s)-[a-zA-Z]*[xf]/.test(segment)) {
      targets.push({ path: segCwd, why: "`git clean` targets the working directory" });
    }
    if (segVerb === "git reset" && /(^|\s)--(hard|merge)\b/.test(segment)) {
      targets.push({ path: segCwd, why: "`git reset --hard` discards the working directory" });
    }
  }
  return targets;
}

/**
 * The command split at `;`, `|`, `&&`, `||` and newlines — outside quotes,
 * since `maskQuotedOperators` has already blanked the operators inside them.
 * Each piece is judged on its own verb and its own words.
 */
function commandSegments(cmd: string): string[] {
  return maskQuotedOperators(cmd)
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * The directory a git segment actually operates in: `git -C <dir>` and
 * `--work-tree=<dir>` repoint it, and a worktree agent lives in exactly that
 * shape (`git -C /tmp/wt commit`). Without the flag, the process cwd.
 */
function segmentCwd(tokens: string[], cwd: string): string {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-C" && tokens[i + 1] !== undefined && isAbsoluteish(tokens[i + 1])) {
      return expandTilde(tokens[i + 1]);
    }
    const wt = /^--work-tree=(.+)$/.exec(tokens[i]);
    if (wt && isAbsoluteish(wt[1])) return expandTilde(wt[1]);
  }
  return cwd;
}

/**
 * `>` / `>>` targets.
 *
 * Two guards, because each lets through what the other stops. QUOTED regions
 * have their operators blanked, so `echo 'a > b'` and `awk '$1 > 5' f` carry no
 * redirection — the `>` is data, not syntax. And the captured target must LOOK
 * like a path, which stops `cmd 2>3` and any other numeric target from being
 * read as a filename. `2>&1` yields nothing on its own: the character class
 * excludes `&`, so a file-descriptor duplication has no target to match.
 */
const REDIRECT_TARGET = /\d?>>?\s*\|?\s*([^\s;|&<>()]+)/g;

/** Redirection targets that write nowhere a policy can care about. Without
 *  these, `… > /dev/null` — the most common redirection there is — would need
 *  `/dev` in every writeRoots list. */
const HARMLESS_REDIRECT_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Contains a `/`, a `.` or a `~`, or starts with a letter or a `$`. `5` and
 * `3` do not; `out.log`, `/tmp/x`, `outlog` and `$OUT` do.
 *
 * REDUNDANT WITH {@link maskQuotedOperators}, AND KEPT ANYWAY. Every
 * non-path-shaped target this rejects (`awk '$1 > 5'`, `cmd 2>3`) is either
 * already inside quotes, where the mask has blanked the operator, or relative,
 * where the allow side declines to judge it. There is no test that goes red on
 * this line alone, and that is the honest status of it: a second, cheap guard
 * on a parse that is a regex over a shell grammar, not a parser.
 */
function looksLikeRedirectTarget(token: string): boolean {
  return /[/.~]/.test(token) || /^[A-Za-z$]/.test(token);
}

/**
 * Blank out shell OPERATORS that sit inside quotes, leaving the quoted text
 * itself alone.
 *
 * Deleting the whole quoted run would lose `> "/tmp/out"`'s target; leaving the
 * run untouched keeps `echo 'a > b'`'s `>` as a redirection. Blanking only the
 * operator characters is the one option that gets both of those right.
 *
 * AND IT IS WRONG FOR A QUOTED SUB-SHELL, WHICH IS THE SAME BYTES.
 * `sh -c 'cat x > /etc/passwd'` is a quoted run containing a `>` that IS a
 * redirection, and this blanks it. There is no way to tell that from
 * `awk '$1 > 5' f` without knowing that `sh -c` re-parses its argument as a
 * command — a shell parser, which is the thing this file exists to avoid
 * needing. Recorded as limit 4 in the header rather than papered over: it is
 * the `$(…)` hole wearing different clothes, and it belongs to the sandbox
 * that does not exist yet.
 */
function maskQuotedOperators(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      out += "<>|&;".includes(ch) ? " " : ch;
      continue;
    }
    if (ch === "'" || ch === "\"") quote = ch;
    out += ch;
  }
  return out;
}

function redirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const match of maskQuotedOperators(cmd).matchAll(REDIRECT_TARGET)) {
    const target = match[1].replace(/["'`\\]/g, "");
    if (target && looksLikeRedirectTarget(target)) targets.push(target);
  }
  return targets;
}

/** Absolute, or home-relative and therefore absolute once the shell expands it
 *  — the only two shapes whose destination this code can know. */
function isAbsoluteish(token: string): boolean {
  return token.startsWith("/") || token.startsWith("~");
}

/** Every path-ish part of every word in the command. */
function allPathCandidates(cmd: string): string[] {
  const out: string[] = [];
  for (const word of bashTokens(cmd)) {
    for (const token of pathCandidates(word)) out.push(token);
  }
  return out;
}

/** Tokens that name a path relatively or absolutely — used by the read fence,
 *  which is a deny rule and can afford to resolve a relative token against the
 *  workspace. */
function pathishTokens(cmd: string): string[] {
  return allPathCandidates(cmd).filter((token) => isAbsoluteish(token) || token.includes("/"));
}

/** Tokens whose destination is knowable, and therefore the only ones the ALLOW
 *  side may judge. See limit 1 in the header. */

/** Leading `~` / `~/`, which the shell expands and `path.resolve` does not —
 *  without this, `cat ~/.ssh/id_rsa` resolves to `<cwd>/~/.ssh/id_rsa` and
 *  misses a `~/.ssh` entry entirely. `~user` is left alone: it is not a form
 *  anything here produces, and the raw-text pass still sees it. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Both spellings of a configured root: as the operator wrote it, and as the
 * kernel resolves it. `/tmp` is a symlink to `/private/tmp` on macOS and
 * `$TMPDIR` sits under `/var` (itself a link to `/private/var`), so a root
 * compared in one spelling against a path resolved in the other never matches
 * — which fails OPEN on a writeRoot and fails open on a deny list too.
 */
function rootSpellings(root: string, cwd: string): string[] {
  const real = realDir(root, cwd);
  return real !== null && real !== root ? [root, real] : [root];
}

/**
 * Does `p` land on or inside one of `roots`?
 *
 * A DENY predicate, so it uses the case-folded {@link isInside} and tests both
 * the lexical path and the real one: a symlink into `~/.ssh` is denied even
 * though nothing in the path spells it, and a path that cannot be resolved at
 * all is still judged on its lexical form rather than passing for free.
 *
 * `includeAncestors` adds the containment the other way round, and it belongs
 * only on the WRITE side. `rm -rf ~/Developer` is not "inside" the denyPath
 * `~/Developer/bloom`, and it destroys it anyway; a `cat` of an ancestor
 * directory does nothing of the kind.
 */
function landsIn(p: string, roots: string[], cwd: string, includeAncestors: boolean): boolean {
  if (roots.length === 0) return false;
  const expanded = expandTilde(p);
  const lexical = abs(expanded, cwd);
  const real = realResolve(expanded, cwd);
  return roots.some((root) => rootSpellings(root, cwd).some((r) => {
    if (isInside(lexical, r)) return true;
    if (real !== null && isInside(real, r)) return true;
    if (!includeAncestors) return false;
    return isInside(r, lexical) || (real !== null && isInside(r, real));
  }));
}

/**
 * Does `p` land on or inside one of the profile's writeRoots?
 *
 * An ALLOW predicate, so it uses the case-SENSITIVE {@link isInsideExact} and
 * an unresolvable path answers false — the same conservative fold the
 * `.claude/skills/` re-allow at the top of this file makes, and for the same
 * reason: a comparison that fails here costs a denial, while one that
 * over-matches hands out a write. Folding the case here would accept
 * `<root>/../OTHER` spellings on a case-sensitive volume that are genuinely
 * different directories.
 */
function landsInWriteRoot(p: string, profile: AgentProfile, cwd: string): boolean {
  const real = realResolve(expandTilde(p), cwd);
  if (real === null) return false;
  return profile.writeRoots.some((root) => rootSpellings(root, cwd).some((r) => isInsideExact(real, r)));
}
