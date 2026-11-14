// Does a path, Glob, Grep or Bash command reach memory/private/? (moved from permissions.ts).
import { isAbsolute, relative } from "node:path";
import { minimatch } from "minimatch";
import { escapesUpward, abs, foldPath, isInside, hasTraversalSegment, realResolve, realDir, bashTokens } from "./permission-paths.js";

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
export function landsInPrivate(p: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  const lexical = abs(p, ctx.cwd);
  if (isInside(lexical, ctx.privateDir)) return true;
  if (hasTraversalSegment(p) && isInside(lexical, ctx.memoryDir)) return true;
  const real = realResolve(p, ctx.cwd, true);
  const realPrivate = realPrivateDir(ctx);
  return real !== null && realPrivate !== null && isInside(real, realPrivate);
}

function realPrivateDir(ctx: { cwd: string; privateDir: string }): string | null {
  return realDir(ctx.privateDir, ctx.cwd, true);
}

function realMemoryDir(ctx: { cwd: string; memoryDir: string }): string | null {
  return realDir(ctx.memoryDir, ctx.cwd, true);
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
  // Every frame is FOLDED (see foldPath): `relative()` below compares strings,
  // and a root spelled `<ws>/memorſ…` or in another case must not read as
  // "private/ is not reachable from here".
  const lexical: SearchFrame = {
    root: foldPath(abs(rootRaw, ctx.cwd)),
    memoryDir: foldPath(ctx.memoryDir),
    privateDir: foldPath(ctx.privateDir),
  };
  const real = realResolve(rootRaw, ctx.cwd, true);
  if (real === null || foldPath(real) === lexical.root) return [lexical];
  const realMemory = realMemoryDir(ctx);
  const realPrivate = realPrivateDir(ctx);
  if (realMemory === null || realPrivate === null) return [lexical];
  return [lexical, { root: foldPath(real), memoryDir: foldPath(realMemory), privateDir: foldPath(realPrivate) }];
}

/** True when `rel` represents a non-empty path that doesn't escape upward —
 *  i.e. it points to a descendant of the reference dir. Used to short-circuit
 *  glob/grep checks when private/ isn't reachable from the search root. */
function isRelativeDescendant(rel: string): boolean {
  return rel !== "" && !escapesUpward(rel) && !isAbsolute(rel);
}

/** Decide whether a Glob call rooted at `root` with pattern `pattern` could
 *  surface anything at-or-inside the private memory dir.
 *
 *  Earlier versions split the pattern at its first wildcard and compared the
 *  literal prefix only — that missed `memory/pri*\/*.md`, which expands into
 *  `memory/private/...` at match time. We test the pattern against three
 *  synthetic probe paths anchored under private/ using minimatch. */
export function globReachesPrivate(
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
  // `nocase` does not fold `ſ` (nor NFD against NFC), and the filesystem
  // opens a literal `memory/priſate/` prefix as `memory/private/`. Fold both
  // sides the way {@link isInside} does.
  const folded = foldPath(pattern);
  return probes.some((probe) => minimatch(foldPath(probe), folded, opts));
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
export function grepReachesPrivate(
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
export function bashTouchesMemory(cmd: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
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
