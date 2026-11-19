import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expandTilde } from "./bash-write-targets.js";
import { abs, isInside, isInsideExact, realResolve } from "./permission-paths.js";
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

/** Files under the home directory a login shell and git read at start-up. */
const HOME_STARTUP_FILES: readonly string[] = [".zshenv", ".zprofile", ".zlogin", ".gitconfig"];

export interface GroupPathPolicy {
  /** Read-only allows. */
  readDirs: string[];
  /** Read-only allows of single files. */
  readFiles: string[];
  /** Read + write allows. */
  writeDirs: string[];
  /** Permanent read + write denies; emitted after every allow. */
  denyDirs: string[];
  /** Permanent write denies; emitted after every allow. */
  writeDenyDirs: string[];
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

export function groupPathPolicy(input: GroupPathPolicyInput): GroupPathPolicy {
  const home = input.userHome ?? homedir();
  const keep = (p: string) => isValidExtraPath(p, home) && !reachesTomoHome(expandTilde(p), input.tomoHome, input.workspaceDir);
  const extraRead = (input.entry?.extraRead ?? []).filter(keep).map(expandTilde);
  const extraWrite = (input.entry?.extraWrite ?? []).filter(keep).map(expandTilde);
  return {
    readDirs: [...SYSTEM_READ_DIRS, join(home, ".config", "git"), ...extraRead],
    readFiles: HOME_STARTUP_FILES.map((f) => join(home, f)),
    writeDirs: ["/dev", ...(input.tempDirs ?? defaultTempDirs()), input.workspaceDir, ...extraWrite],
    // FIXED PATHS, never an enumeration of what exists now: a deny list built
    // from `readdir` misses whatever is created after it is built. Everything
    // else under Tomo's home is out of reach because nothing grants it (the
    // profile denies by default and `reachesTomoHome` drops any extra over it).
    denyDirs: [
      input.privateDir,
      join(input.workspaceDir, "secrets"),
      ...input.dataDirs,
      ...(input.tomoHome ? [join(input.tomoHome, "config.json"), join(input.tomoHome, "logs"), join(input.tomoHome, "data")] : []),
      join(home, "Library", "Keychains"),
      join(home, ".ssh"),
    ],
    writeDenyDirs: [input.homeSceneDir, join(input.workspaceDir, ".claude")],
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
  writeDeny: string[];
}

export function resolveGroupPathPolicy(policy: GroupPathPolicy, cwd: string): ResolvedGroupPathPolicy {
  return {
    read: resolvedAllowDirs([...policy.readDirs, ...policy.writeDirs], cwd),
    readFiles: resolvedAllowDirs(policy.readFiles, cwd),
    write: resolvedAllowDirs(policy.writeDirs, cwd),
    deny: resolvedDenyDirs(policy.denyDirs, cwd),
    writeDeny: resolvedDenyDirs(policy.writeDenyDirs, cwd),
  };
}

/** Why `p` may not be read on this group turn, or null when it may. */
function readDenial(p: string, cwd: string, r: ResolvedGroupPathPolicy): string | null {
  const s = spellingsOf(p, cwd);
  if (s === null) return `${p} could not be resolved`;
  if (hitsDeny(s, r.deny)) return `${p} is never readable from a group turn`;
  if (!inAllow(s, r.read, r.readFiles)) return `${p} is outside what this group may read`;
  return null;
}

function writeDenial(p: string, cwd: string, r: ResolvedGroupPathPolicy): string | null {
  const s = spellingsOf(p, cwd);
  if (s === null) return `${p} could not be resolved`;
  if (hitsDeny(s, r.deny) || hitsDeny(s, r.writeDeny)) return `${p} is never writable from a group turn`;
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
  const r = resolveGroupPathPolicy(policy, cwd);
  if (pathTool) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return null;
    return WRITE_TOOLS.has(toolName) ? writeDenial(p, cwd, r) : readDenial(p, cwd, r);
  }
  if (isSearch) {
    if (barredSearch(toolName, toolInput, { cwd, barredDirs: policy.denyDirs })) {
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
