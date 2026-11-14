// Bash write-verb and write-target parsing for the agent-profile guard (moved from permissions.ts).
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { type AgentProfile } from "../config.js";
import { isInsideExact, pathCandidates, abs, isInside, realResolve, realDir, bashTokens } from "./permission-paths.js";

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
export function writeVerbIn(cmd: string): string | null {
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
export function writeTargets(cmd: string, verb: string | null, redirects: string[], cwd: string): WriteTarget[] {
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
export function commandSegments(cmd: string): string[] {
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
export function segmentCwd(tokens: string[], cwd: string): string {
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
export const HARMLESS_REDIRECT_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

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

export function redirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const match of maskQuotedOperators(cmd).matchAll(REDIRECT_TARGET)) {
    const target = match[1].replace(/["'`\\]/g, "");
    if (target && looksLikeRedirectTarget(target)) targets.push(target);
  }
  return targets;
}

/** Absolute, or home-relative and therefore absolute once the shell expands it
 *  — the only two shapes whose destination this code can know. */
export function isAbsoluteish(token: string): boolean {
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
export function pathishTokens(cmd: string): string[] {
  return allPathCandidates(cmd).filter((token) => isAbsoluteish(token) || token.includes("/"));
}

/** Tokens whose destination is knowable, and therefore the only ones the ALLOW
 *  side may judge. See limit 1 in the header. */

/** Leading `~` / `~/`, which the shell expands and `path.resolve` does not —
 *  without this, `cat ~/.ssh/id_rsa` resolves to `<cwd>/~/.ssh/id_rsa` and
 *  misses a `~/.ssh` entry entirely. `~user` is left alone: it is not a form
 *  anything here produces, and the raw-text pass still sees it. */
export function expandTilde(p: string): string {
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
function rootSpellings(root: string, cwd: string, canonical = false): string[] {
  const real = realDir(root, cwd, canonical);
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
export function landsIn(p: string, roots: string[], cwd: string, includeAncestors: boolean): boolean {
  if (roots.length === 0) return false;
  const expanded = expandTilde(p);
  const lexical = abs(expanded, cwd);
  const real = realResolve(expanded, cwd, true);
  return roots.some((root) => rootSpellings(root, cwd, true).some((r) => {
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
export function landsInWriteRoot(p: string, profile: AgentProfile, cwd: string): boolean {
  const real = realResolve(expandTilde(p), cwd);
  if (real === null) return false;
  return profile.writeRoots.some((root) => rootSpellings(root, cwd).some((r) => isInsideExact(real, r)));
}
