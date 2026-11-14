// Path resolution and containment shared by the permission guards (moved from permissions.ts).
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as pathResolve } from "node:path";

/**
 * Does a `path.relative` result climb OUT of its base? Only a `..` SEGMENT
 * does: `..` itself, or `../…`. A NAME that merely starts with two dots —
 * `..notes.md`, `...`, `..hidden/` — is a child like any other. The old
 * `rel.startsWith("..")` read `memory/private/..notes.md` as outside private/,
 * so the hidden file was readable from a barred turn.
 */
export function escapesUpward(rel: string): boolean {
  // `/` only. On macOS (POSIX) `\` is an ordinary filename character:
  // `..\secret.png` is a file named that, inside the dir, not a step out.
  return rel === ".." || rel.startsWith("../");
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
export function isInsideExact(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !escapesUpward(rel) && !isAbsolute(rel);
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
export function pathCandidates(word: string): string[] {
  if (word === "#") return [];
  const eq = word.indexOf("=");
  const afterEq = eq === -1 ? [] : [word.slice(eq + 1)].filter((v) => v.length > 0);
  if (word.startsWith("-")) return afterEq;
  return [word, ...afterEq];
}

/** Resolve `p` to an absolute, normalized path against `cwd` if relative. */
export function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? pathResolve(p) : pathResolve(cwd, p);
}

/**
 * The spelling a DENY comparison is made in: NFKC, then lower-cased, then NFKC
 * again (lower-casing can leave a string that is no longer normalised).
 *
 * `toLowerCase()` alone was not a fold. APFS matches names under its own
 * case/normalisation-insensitive rules, which are wider than JS lower-casing:
 * `ſ` (U+017F LATIN SMALL LETTER LONG S) is ALREADY lower case, so
 * `toLowerCase()` leaves it alone, while the filesystem opens
 * `<ws>/memory/priſate/x.md` as `<ws>/memory/private/x.md` — the guard
 * compared two different strings and allowed the read. NFKC maps `ſ` to `s`
 * (and the Kelvin sign to `K`, the `ﬁ` ligature to `fi`, …), and composes NFD
 * input, so an `é` typed as `e` + U+0301 compares equal to the precomposed one.
 *
 * NFKC over-matches some names the filesystem would treat as distinct (a
 * full-width `／` becomes `/`). This is a deny predicate: that is the safe
 * direction. The real-path arm ({@link realResolve}, `realpathSync.native`) is
 * the one that reads the filesystem's own answer; this fold is what covers the
 * segments that do not exist yet and so cannot be resolved.
 */
export function foldPath(p: string): string {
  return p.normalize("NFKC").toLowerCase().normalize("NFKC");
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
export function isInside(child: string, parent: string): boolean {
  const c = foldPath(child);
  const p = foldPath(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && !escapesUpward(rel) && !isAbsolute(rel);
}

/** How many symlink hops to follow before giving up, so a link cycle cannot
 *  spin here forever. Well above any real path. */
const MAX_SYMLINK_HOPS = 32;

/** Does `p` contain a `..` segment as SPELLED, before any normalisation? */
export function hasTraversalSegment(p: string): boolean {
  // `/` only — see escapesUpward.
  return p.split("/").includes("..");
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
 * name files that are about to exist — so the walk ({@link walkReal}) resolves
 * every existing prefix and attaches the rest below it, and follows a DANGLING
 * symlink through its target: `realpathSync` reports ENOENT for a link whose
 * target is missing, indistinguishable from "not there", and judging the
 * link's own path (outside private/) would allow a write that follows the
 * link into it.
 */
export function realResolve(p: string, cwd: string, canonical = false): string | null {
  // `canonical` (every DENY caller) uses `.native`: the JS realpath walks the
  // path with lstat and keeps the CALLER'S spelling of every component, so
  // `realpathSync("/Uſers/x/workſpace")` came back as typed and the
  // containment test never saw the canonical name. The native call is
  // realpath(3), which returns the names as stored on disk. The ALLOW callers
  // keep the JS spelling-preserving form on purpose: there a failed comparison
  // denies, which is the conservative direction (see isInsideExact).
  const rp = canonical ? realpathSync.native : realpathSync;
  // NOT `abs()`: `path.resolve` collapses `..` LEXICALLY, before any symlink
  // is followed, and the kernel does the opposite. `link/../secret.png` with
  // `link -> memory/private/sub` is `<ws>/secret.png` to path.resolve and
  // `memory/private/secret.png` to open(2). The walk below resolves in the
  // kernel's order instead.
  return walkReal(isAbsolute(p) ? p : `${cwd}/${p}`, rp, { hops: 0 });
}

/**
 * Resolve `raw` (absolute, NOT normalised) segment by segment, the way the
 * kernel does: each existing prefix is real-pathed before the next segment is
 * applied, so a `..` steps to the parent of where a symlink really LANDED, not
 * to the parent of its name. Once a prefix does not exist the rest is attached
 * lexically — that is a path about to be created (Write/Edit), where there is
 * nothing further to follow. A DANGLING symlink (realpath reports ENOENT, the
 * same error as "no such name") is followed through its target, with the
 * remaining segments re-attached below it, so a write that follows the link
 * into private/ is judged by where it lands.
 */
function walkReal(
  raw: string,
  rp: (p: string) => string,
  state: { hops: number },
): string | null {
  // `/` only: on POSIX `\` is part of a name, never a separator.
  const segs = raw.split(/\/+/).filter((s) => s !== "" && s !== ".");
  let current = "/";
  let exists = true;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "..") {
      // `current` is already real while it exists, so this is the parent of
      // the real directory — exactly what the kernel's `..` lookup returns.
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
    if (!exists) {
      current = next;
      continue;
    }
    try {
      current = rp(next);
      continue;
    } catch {
      // Absent, not a directory, or a dangling link — see below.
    }
    let link: string | null = null;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // Genuinely absent.
    }
    if (link !== null) {
      if (++state.hops > MAX_SYMLINK_HOPS) return null;
      const target = isAbsolute(link) ? link : `${current}/${link}`;
      const rest = segs.slice(i + 1).join("/");
      return walkReal(rest ? `${target}/${rest}` : target, rp, state);
    }
    exists = false;
    current = next;
  }
  return current;
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
export function realDir(dir: string, cwd: string, canonical = false): string | null {
  const cacheKey = `${canonical ? "native" : "js"}\u0000${dir}`;
  const cached = realDirCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const real = realResolve(dir, cwd, canonical);
  if (real !== null && existsSync(dir)) realDirCache.set(cacheKey, real);
  return real;
}

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
export function bashTokens(cmd: string): string[] {
  return cmd
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/["'`\\]/g, ""))
    .filter((t) => t.length > 0);
}
