// canUseTool: re-allow `.claude/skills/` under bypassPermissions (moved from permissions.ts).
import { config } from "../config.js";
import { isInsideExact, pathCandidates, realResolve, realDir, bashTokens } from "./permission-paths.js";

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
