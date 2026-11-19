import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { expandTilde } from "./bash-write-targets.js";
import { abs, foldPath, isInside, isInsideExact, realResolve } from "./permission-paths.js";
import { attachmentPathsIn, barredSearch, effectiveSearchRoot, SEARCH_TOOLS, SEND_MESSAGE_TOOL } from "./private-memory-access.js";

/**
 * The ONE path policy for a group turn, shared by the Bash sandbox profile
 * (`./bash-sandbox.ts`) and the file-tool guard (`./private-memory-guard.ts`).
 *
 * DEFAULT DENY. A group turn may read the system directories a shell needs,
 * read and write the workspace and the temp dirs, and touch whatever its group
 * entry in `groupSandbox` adds. Everything else is out of reach — the owner's
 * home directory, Tomo's own config, logs and state, other checkouts.
 *
 * PERMANENT DENIES WIN over every allow, the group's extras included: private
 * memory, the workspace's `secrets/`, Tomo's config file, logs and state, the
 * login keychains and `~/.ssh` — fixed paths, so nothing depends on what exists
 * when the policy is built. The rest of Tomo's home is unreachable because no
 * allow covers it: an extra that would is dropped ({@link reachesTomoHome}). The workspace's `home/` (the
 * scene) and `.claude/` (settings, hooks, skills the CLI loads) are read-only.
 *
 * WHY ONE POLICY. With the shell boxed in and the file tools not, a group could
 * `Write` the config file and flip itself to unsandboxed; with the file tools
 * boxed in and the shell not, the same through `echo >`. Both enforcement
 * points therefore ask this module, so they cannot disagree.
 *
 * Paths here are as SPELLED; the profile builder and {@link groupPathDenial}
 * resolve them (the kernel matches resolved paths).
 */

/** One group's entry in `groupSandbox.groups`. */
export interface GroupSandboxEntry {
  /** Extra directories the group may read. */
  extraRead: string[];
  /** Extra directories the group may read and write. */
  extraWrite: string[];
  /** Full trust: Bash runs unsandboxed and the file tools keep only the
   *  private-memory guards (the old `groupShellAllowlist` behaviour). */
  unsandboxed: boolean;
}

export interface GroupSandboxConfig {
  groups: Record<string, GroupSandboxEntry>;
}

/**
 * The group config in force: `groupSandbox`, plus every key of the legacy
 * `groupShellAllowlist` not already listed there, mapped to `unsandboxed: true`
 * — exactly what that list meant. Computed on read, so an old config file keeps
 * working unchanged and nothing is written back.
 */
export function effectiveGroupSandbox(
  groupSandbox: GroupSandboxConfig | undefined,
  legacyAllowlist: readonly string[] | undefined,
): GroupSandboxConfig {
  const groups: Record<string, GroupSandboxEntry> = { ...(groupSandbox?.groups ?? {}) };
  for (const key of legacyAllowlist ?? []) {
    if (!(key in groups)) groups[key] = { extraRead: [], extraWrite: [], unsandboxed: true };
  }
  return { groups };
}

/** Is `p` acceptable as an extra directory? Absolute (or `~`-rooted), no `..`
 *  segment, and not `/` or the home directory itself — granting either would
 *  make the allowlist meaningless. */
export function isValidExtraPath(p: string, home: string = homedir()): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (/^~\/*$/.test(p)) return false;
  const expanded = expandTilde(p);
  if (!isAbsolute(expanded)) return false;
  if (expanded.split("/").includes("..")) return false;
  const trimmed = expanded.replace(/\/+$/, "") || "/";
  return trimmed !== "/" && trimmed !== home.replace(/\/+$/, "");
}

/** Read-only for every group turn: what python, node, git, curl and sqlite
 *  need to start. `/opt` covers Homebrew. */
export const SYSTEM_READ_DIRS: readonly string[] = [
  "/usr", "/bin", "/sbin", "/System", "/Library", "/opt",
  "/private/etc", "/private/var/db/timezone", "/private/var/select",
  "/Applications/Xcode.app",
];

/**
 * Names directly in Tomo's home that are denied BY PREFIX: each file Tomo
 * writes there, together with the siblings its writers create — the config's
 * `.bak` and hand-made `.bak-*` copies, the atomic writer's `<name>.<pid>.<uuid>.tmp`,
 * and the `<name>.lock` directories. A prefix, so a sibling made later is
 * covered without being listed. `data/` and `logs/` are denied as subpaths.
 *
 * Normally Tomo's home is outside every allow and these are a second lock. When
 * the workspace IS Tomo's home (or contains it), they are the only lock.
 */
export const TOMO_HOME_DENY_PREFIXES: readonly string[] = [
  "config.json", "web-token", "web-access.log", "web-status.json", "tomo.pid", "watch.sock",
];

export interface GroupPathPolicy {
  /** Read-only allows. */
  readDirs: string[];
  /** Read-only allows of single files. */
  readFiles: string[];
  /** Read + write allows. */
  writeDirs: string[];
  /** Permanent read + write denies; emitted after every allow. */
  denyDirs: string[];
  /** Permanent read + write denies of every path STARTING WITH one of these. */
  denyPrefixes: string[];
  /** Permanent write denies; emitted after every allow. */
  writeDenyDirs: string[];
  /** Set when a protected entry is a symlink whose target cannot be
   *  established: the turn gets no shell and no file tools (fail closed). */
  unresolvable?: string;
}

export interface GroupPathPolicyInput {
  workspaceDir: string;
  privateDir: string;
  homeSceneDir: string;
  /** Tomo's home (`~/.tomo`): everything in it but the workspace is denied. */
  tomoHome?: string;
  /** Tomo's state dirs (data/, sessions), denied even when relocated. */
  dataDirs: readonly string[];
  entry?: Pick<GroupSandboxEntry, "extraRead" | "extraWrite">;
  /** Overridable for tests. */
  userHome?: string;
  tempDirs?: readonly string[];
}

/** `/private/tmp` and the per-user temp dir, as the kernel sees them. */
export function defaultTempDirs(): string[] {
  const dirs = new Set<string>(["/private/tmp"]);
  try {
    dirs.add(realpathSync.native(tmpdir()));
  } catch {
    // No usable TMPDIR: /private/tmp alone.
  }
  return [...dirs];
}

/** `p` resolved the way the kernel sees it (unfolded), or its absolute
 *  spelling when it cannot be resolved. */
function realOrSpelled(p: string): string {
  return realResolve(p, "/", true) ?? abs(p, "/");
}

/**
 * Would granting `extra` reach into Tomo's home outside the workspace? True for
 * Tomo's home itself, any directory above it, and anything inside it that is
 * not inside the workspace. Such an extra is DROPPED, not narrowed: the
 * default-deny profile is what keeps the config file, logs, state and anything
 * created there later out of reach, and an extra over that tree would undo it
 * for every path the fixed denies do not name.
 */
export function reachesTomoHome(extra: string, tomoHome: string | undefined, workspaceDir: string): boolean {
  if (!tomoHome) return false;
  const e = realOrSpelled(extra);
  const home = realOrSpelled(tomoHome);
  const ws = realOrSpelled(workspaceDir);
  if (isInside(home, e)) return true;
  return isInside(e, home) && !isInside(e, ws);
}

/**
 * The targets of protected entries in Tomo's home that are SYMLINKS.
 *
 * A prefix deny is matched against the path the kernel opens, and a symlink is
 * opened at its target: `~/.tomo/config.json -> <workspace>/x` would leave the
 * config readable through the workspace allow. So every entry a prefix covers
 * is lstat'd, and a link's real target is denied too. A link whose target
 * cannot be resolved (dangling, a loop), or a home that cannot be listed,
 * yields `unresolvable`: no shell, no file tools, rather than a deny that
 * might name the wrong place. A missing home has nothing to protect.
 */
export function protectedLinkTargets(tomoHome: string | undefined): { targets: string[]; unresolvable?: string } {
  if (!tomoHome) return { targets: [] };
  let names: string[];
  try {
    names = readdirSync(tomoHome);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { targets: [] };
    return { targets: [], unresolvable: `Tomo's home (${tomoHome}) cannot be listed` };
  }
  const targets: string[] = [];
  for (const name of names) {
    // Case-INSENSITIVE, like every deny: on a case-insensitive volume
    // `Config.json` is opened by `config.json`, and the kernel matches the
    // name as stored, which the exact-case prefix would miss. Such an entry
    // is denied by its own path.
    const lower = name.toLowerCase();
    if (!TOMO_HOME_DENY_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))) continue;
    const entry = join(tomoHome, name);
    if (!TOMO_HOME_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) targets.push(entry);
    let link: boolean;
    try {
      link = lstatSync(entry).isSymbolicLink();
    } catch {
      continue; // gone since readdir
    }
    if (!link) continue;
    try {
      targets.push(realpathSync.native(entry));
    } catch {
      return { targets, unresolvable: `${entry} is a symlink whose target cannot be resolved` };
    }
  }
  return { targets };
}

export function groupPathPolicy(input: GroupPathPolicyInput): GroupPathPolicy {
  const home = input.userHome ?? homedir();
  const links = protectedLinkTargets(input.tomoHome);
  const keep = (p: string) => isValidExtraPath(p, home) && !reachesTomoHome(expandTilde(p), input.tomoHome, input.workspaceDir);
  const extraRead = (input.entry?.extraRead ?? []).filter(keep).map(expandTilde);
  const extraWrite = (input.entry?.extraWrite ?? []).filter(keep).map(expandTilde);
  return {
    readDirs: [...SYSTEM_READ_DIRS, ...extraRead],
    // Nothing from the owner's home: a login shell's start-up files can export
    // credentials, so the group shell is started without them (`zsh -f`), and
    // git is pointed away from ~/.gitconfig (GIT_CONFIG_GLOBAL=/dev/null).
    readFiles: [],
    writeDirs: ["/dev", ...(input.tempDirs ?? defaultTempDirs()), input.workspaceDir, ...extraWrite],
    // FIXED PATHS, never an enumeration of what exists now: a deny list built
    // from `readdir` misses whatever is created after it is built. Everything
    // else under Tomo's home is out of reach because nothing grants it (the
    // profile denies by default and `reachesTomoHome` drops any extra over it).
    denyDirs: [
      input.privateDir,
      join(input.workspaceDir, "secrets"),
      ...input.dataDirs,
      ...(input.tomoHome ? [join(input.tomoHome, "logs"), join(input.tomoHome, "data")] : []),
      join(home, "Library", "Keychains"),
      join(home, ".ssh"),
      ...links.targets,
    ],
    denyPrefixes: input.tomoHome ? TOMO_HOME_DENY_PREFIXES.map((name) => join(input.tomoHome!, name)) : [],
    writeDenyDirs: [input.homeSceneDir, join(input.workspaceDir, ".claude")],
    ...(links.unresolvable ? { unresolvable: links.unresolvable } : {}),
  };
}

// ---------------------------------------------------------------------------
// The file-tool side
// ---------------------------------------------------------------------------

const READ_TOOLS: ReadonlySet<string> = new Set(["Read"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * `p` as spelled (absolute) and as the kernel resolves it; null when it cannot
 * be resolved (a symlink loop), which every caller reads as "no". The real path
 * keeps the on-disk spelling (realpath(3)), so the ALLOW side can compare it
 * exactly.
 */
function spellingsOf(p: string, cwd: string): { spelled: string; real: string } | null {
  const expanded = expandTilde(p);
  const real = realResolve(expanded, cwd, true);
  if (real === null) return null;
  return { spelled: abs(expanded, cwd), real };
}

/** Deny dirs, each as spelled and as resolved. */
function resolvedDenyDirs(dirs: readonly string[], cwd: string): string[] {
  return dirs.flatMap((d) => {
    const s = spellingsOf(d, cwd);
    return s ? [...new Set([s.spelled, s.real])] : [abs(d, cwd)];
  });
}

/** Allow dirs, resolved only: an allow that cannot be resolved grants nothing. */
function resolvedAllowDirs(dirs: readonly string[], cwd: string): string[] {
  return dirs.flatMap((d) => {
    const s = spellingsOf(d, cwd);
    return s ? [s.real] : [];
  });
}

/** Inside a permanent deny, as spelled OR as resolved? CASE-FOLDED: over-matching
 *  a deny only refuses more, which is the safe direction. */
function hitsDeny(p: { spelled: string; real: string }, denies: readonly string[]): boolean {
  return denies.some((d) => isInside(p.spelled, d) || isInside(p.real, d));
}

/**
 * Inside an allow? Judged on the RESOLVED path only (a symlink in the workspace
 * pointing out of it opens the target, not the link), and EXACTLY: on a
 * case-sensitive volume `/work/Project` and `/work/project` are different
 * directories, and granting one must not grant the other. On a case-insensitive
 * volume realpath(3) returns the on-disk spelling for both sides, so nothing
 * is lost there.
 */
function inAllow(p: { real: string }, dirs: readonly string[], files: readonly string[] = []): boolean {
  return dirs.some((d) => isInsideExact(p.real, d)) || files.some((f) => p.real === f);
}

export interface ResolvedGroupPathPolicy {
  read: string[];
  readFiles: string[];
  write: string[];
  deny: string[];
  denyPrefixes: string[];
  writeDeny: string[];
}

export function resolveGroupPathPolicy(policy: GroupPathPolicy, cwd: string): ResolvedGroupPathPolicy {
  return {
    read: resolvedAllowDirs([...policy.readDirs, ...policy.writeDirs], cwd),
    readFiles: resolvedAllowDirs(policy.readFiles, cwd),
    write: resolvedAllowDirs(policy.writeDirs, cwd),
    deny: resolvedDenyDirs(policy.denyDirs, cwd),
    denyPrefixes: policy.denyPrefixes.flatMap((p) => resolvedDenyDirs([dirname(p)], cwd).map((d) => foldPath(join(d, basename(p))))),
    writeDeny: resolvedDenyDirs(policy.writeDenyDirs, cwd),
  };
}

/** Starts with a denied prefix, as spelled OR as resolved? Case-folded, like
 *  every deny. */
function hitsDenyPrefix(p: { spelled: string; real: string }, prefixes: readonly string[]): boolean {
  const spelled = foldPath(p.spelled);
  const real = foldPath(p.real);
  return prefixes.some((pre) => spelled.startsWith(pre) || real.startsWith(pre));
}

/** Why `p` may not be read on this group turn, or null when it may. */
function readDenial(p: string, cwd: string, r: ResolvedGroupPathPolicy): string | null {
  const s = spellingsOf(p, cwd);
  if (s === null) return `${p} could not be resolved`;
  if (hitsDeny(s, r.deny) || hitsDenyPrefix(s, r.denyPrefixes)) return `${p} is never readable from a group turn`;
  if (!inAllow(s, r.read, r.readFiles)) return `${p} is outside what this group may read`;
  return null;
}

function writeDenial(p: string, cwd: string, r: ResolvedGroupPathPolicy): string | null {
  const s = spellingsOf(p, cwd);
  if (s === null) return `${p} could not be resolved`;
  if (hitsDeny(s, r.deny) || hitsDenyPrefix(s, r.denyPrefixes) || hitsDeny(s, r.writeDeny)) return `${p} is never writable from a group turn`;
  // Nor is a directory ABOVE a denied path: overwriting or replacing it would
  // move the protected tree out from under its name.
  if ([...r.deny, ...r.writeDeny].some((d) => isInside(d, s.spelled) || isInside(d, s.real))) return `${p} contains a protected path and is not writable from a group turn`;
  if (!inAllow(s, r.write)) return `${p} is outside what this group may write`;
  return null;
}

/**
 * Why this file-tool call is refused on a (sandboxed) group turn, or null when
 * the group policy allows it. Bash is the sandbox profile's job, not this one's.
 *
 * - Read: the path must be readable.
 * - Edit / Write / MultiEdit / NotebookEdit: the path must be writable.
 * - Glob / Grep / LS: the search's effective root must be readable, and no
 *   permanent deny may sit at, inside or above it (the same structural rule as
 *   `barredSearch`).
 * - send_message: every `MEDIA:` / `STICKER:` path must be readable — the
 *   attachment IS a read.
 */
export function groupPathDenial(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  policy: GroupPathPolicy,
): string | null {
  const ti = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
  const pathTool = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
  const isSearch = SEARCH_TOOLS.has(toolName);
  if (!pathTool && !isSearch && toolName !== SEND_MESSAGE_TOOL) return null;
  if (policy.unresolvable) return `the sandbox for this turn cannot be established (${policy.unresolvable})`;
  const r = resolveGroupPathPolicy(policy, cwd);
  if (pathTool) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return null;
    return WRITE_TOOLS.has(toolName) ? writeDenial(p, cwd, r) : readDenial(p, cwd, r);
  }
  if (isSearch) {
    if (barredSearch(toolName, toolInput, { cwd, barredDirs: [...policy.denyDirs, ...policy.denyPrefixes] })) {
      return "the search would reach a directory that is never readable from a group turn";
    }
    return readDenial(effectiveSearchRoot(toolName, toolInput, cwd), cwd, r);
  }
  const message = ti.message;
  if (typeof message !== "string") return null;
  for (const p of attachmentPathsIn(message)) {
    const denial = readDenial(p, cwd, r);
    if (denial) return `an attachment is not readable: ${denial}`;
  }
  return null;
}

/** Denial text for a file-tool call the group policy refuses. */
export function groupPathDenialReason(detail: string): string {
  return `Not available on this turn: ${detail}. A group turn can read and write the workspace (except memory/private/ and secrets/), read system directories, and use the temp dirs; anything else needs the owner to add it to this group's sandbox config. Do not retry with a different spelling of the path.`;
}
