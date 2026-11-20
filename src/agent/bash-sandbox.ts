import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { log } from "../logger.js";
import type { GroupPathPolicy } from "./group-fs-policy.js";
import { isEnoent } from "../fs-utils.js";

/**
 * Kernel-level scoping for the shell on a private-memory-barred turn.
 *
 * THE PROBLEM THIS REPLACES. `memory/private/` is DM-only, and on a barred turn
 * (a group session, or a dm: session a summoned group is steering) the
 * PreToolUse guard in `permissions.ts` used to deny Bash OUTRIGHT, because
 * filtering the command TEXT is not a guard: the argument to an interpreter is a
 * program, and `node -e '…readFileSync("mem"+"ory/pri"+"vate/x")'` spells no
 * token a regex can find. That reasoning was right about the text and wrong
 * about the conclusion — the text is the wrong layer, not the only layer. Every
 * task from a group that needed a shell was impossible, and `lcm_rollup` exists
 * only because of it.
 *
 * WHAT IT DOES INSTEAD. The command still runs, inside a macOS `sandbox-exec`
 * profile that denies the private directory in the KERNEL. What the command
 * text says stops mattering: an assembled path, a symlink planted in `/tmp`, a
 * script written on an earlier turn and a `python3 -c` one-liner all get
 * `EPERM`, because the check happens at `open(2)` on the resolved path rather
 * than on the string the model typed.
 *
 * THE PROFILE IS PASSED INLINE (`-p`), NEVER AS A FILE. This is the whole of the
 * reason: a profile FILE is a file, and the sandboxed shell runs as the same uid
 * under `(allow default)`. An earlier version wrote the profile once per process
 * to `<tomoHome>/data/bash-sandbox.sb`, which is outside the deny set, and
 * trusted the memo on later calls — so three commands in one turn were enough to
 * walk out: read denied, `echo '(version 1)(allow default)' > …/bash-sandbox.sb`,
 * read succeeds. `rm -f` on the same path was a denial-of-service with the same
 * root cause. Re-reading or re-writing the file per call would only narrow the
 * race; the fix is to have no file at all. `-p` puts the policy in this
 * process's argv, where the sandboxed command cannot reach it.
 *
 * DEFAULT DENY, NOT A FEW DENIES. The profile used to be `(allow default)`
 * plus denies for private memory, Tomo's data/ and a write deny on the home —
 * which left the shell free to read the config file, the logs, `secrets/`, the
 * keychain and everything else the owner's account can. It is now an
 * allowlist: system directories read-only, the temp dirs and the workspace
 * read-write, plus whatever the group's entry adds, with the permanent denies
 * of `./group-fs-policy.ts` emitted LAST so no allow can reach past them.
 * The same policy decides the file tools, so the two cannot disagree. The
 * write half of every deny is not decoration: with reads denied alone, `mv
 * memory/private /tmp/p && cat /tmp/p/note.txt` walks the files OUT of the
 * denied subpath. Verified by running it.
 *
 * THE REWRITE IS NOT THE LAST WORD, SO A FOREIGN HOOK WITHHOLDS THE SHELL. The
 * CLI takes the last `updatedInput` any PreToolUse hook produces, and hooks from
 * project settings and plugins arrive through its own merge rather than ours — a
 * foreign hook that echoes `tool_input` back can restore the unsandboxed command
 * after we have answered. Registering our rewrite last in our own array does not
 * reach that. So `foreignPreToolUseHookSource` looks for any such hook and the
 * guard withholds Bash when it finds one.
 *
 * FAIL CLOSED. Anything that makes the wrap unavailable, its scope uncertain, or
 * its survival uncertain — no `sandbox-exec`, no `/bin/zsh`, a non-string
 * command, a private path whose real location cannot be established, a foreign
 * PreToolUse hook — returns `null`, and the guard falls back to the old
 * behaviour: Bash withheld, with the existing denial text. Never to an
 * unsandboxed shell.
 */

/** Absolute by design: a PATH lookup for the thing enforcing the boundary is a
 *  way round the boundary. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** The shell the wrapped command is handed to, also absolute.
 *
 *  Started with `-f` (no start-up files) and `-c`, NOT as a login shell: the
 *  owner's `~/.zshenv` / `~/.zprofile` run as the owner and can export
 *  credentials straight back into an environment `env -i` just emptied. PATH
 *  comes from the Bash tool's own shell through the env allowlist instead. */
export const SANDBOX_SHELL_PATH = "/bin/zsh";

/** The inner shell's flags: no start-up files, run the script. */
export const SANDBOX_SHELL_FLAGS: readonly string[] = ["-f", "-c"];

/**
 * Mach services a group shell may not look up, though `mach-lookup` is
 * otherwise open.
 *
 * WHY A DENY LIST AND NOT AN ALLOW LIST. A narrow allow list was tried: node,
 * python and git kept working, but the system `curl` failed TLS (exit 60) and
 * the missing service was not found. So lookups stay open and the services
 * that reach OUTSIDE the sandbox are refused: the keychain daemon (the file
 * deny on the keychain directory already stops `security`; this is the second
 * lock), Apple Events and LaunchServices (driving another app, `open`), the
 * pasteboard, TCC, and the window server / screen capture.
 */
export const SANDBOX_MACH_DENY: readonly string[] = [
  "com.apple.SecurityServer",
  "com.apple.coreservices.appleevents",
  "com.apple.coreservices.launchservicesd",
  "com.apple.lsd.mapdb",
  "com.apple.CoreServices.coreservicesd",
  "com.apple.pasteboard.1",
  "com.apple.tccd",
  "com.apple.tccd.system",
  "com.apple.windowserver.active",
  "com.apple.ScreenCaptureKit.service",
];

/** A {@link GroupPathPolicy} with every path resolved the way the kernel sees it. */
export interface ResolvedSandboxPolicy {
  readDirs: readonly string[];
  readFiles: readonly string[];
  writeDirs: readonly string[];
  denyDirs: readonly string[];
  /** Read + write denies of every path starting with one of these. */
  denyPrefixes: readonly string[];
  writeDenyDirs: readonly string[];
}

/**
 * The sandbox profile for a group turn's shell: DEFAULT DENY.
 *
 * ORDER IS THE POLICY. SBPL applies the LAST rule that matches — measured: a
 * `deny` followed by an `allow` of its parent reads the file, the other order
 * does not. So every allow comes first (system read-only dirs, start-up files,
 * the workspace and temp dirs, the group's extras) and the permanent denies
 * come last, where no allow can reach past them.
 *
 * NETWORK. Outbound IP is open, except to localhost — which on macOS also
 * covers this machine's own LAN address (measured). Unix sockets are closed
 * except the resolver's. Daemons on this machine (build servers, the web UI,
 * MCP servers, ssh-agent) run OUTSIDE the sandbox, so a socket to one is a
 * way out of it.
 *
 * `file-read-metadata` is open everywhere: `stat` of a parent is what `ls`,
 * `realpath` and git's repository discovery do, and it reveals that a file
 * exists, never what is in it.
 */
export function sandboxProfileText(policy: ResolvedSandboxPolicy): string {
  const sub = (dir: string) => `(subpath ${sandboxLiteral(dir)})`;
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    "(allow system-socket)",
    "(allow file-read-metadata)",
    "(allow mach-lookup)",
    `(allow file-read* (literal "/"))`,
    ...policy.readDirs.map((dir) => `(allow file-read* ${sub(dir)})`),
    ...policy.readFiles.map((file) => `(allow file-read* (literal ${sandboxLiteral(file)}))`),
    ...policy.writeDirs.map((dir) => `(allow file-read* file-write* ${sub(dir)})`),
    `(allow network-outbound (remote ip "*:*"))`,
    `(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`,
    `(deny network-outbound (remote ip "localhost:*"))`,
    // ---- permanent denies: LAST, so nothing above can re-allow them ----
    ...policy.denyDirs.flatMap((dir) => [
      `(deny file-read* ${sub(dir)})`,
      `(deny file-write* ${sub(dir)})`,
    ]),
    ...policy.denyPrefixes.flatMap((prefix) => [
      `(deny file-read* (prefix ${sandboxLiteral(prefix)}))`,
      `(deny file-write* (prefix ${sandboxLiteral(prefix)}))`,
    ]),
    ...policy.writeDenyDirs.map((dir) => `(deny file-write* ${sub(dir)})`),
    // The ANCESTORS of every denied path may not themselves be written —
    // renamed, removed, re-moded — or `mv memory moved && cat moved/private/x`
    // walks the denied tree out from under its path. `literal`, so creating
    // and writing their other children is unaffected (verified).
    ...denyAncestors(policy).map((dir) => `(deny file-write* (literal ${sandboxLiteral(dir)}))`),
    ...SANDBOX_MACH_DENY.map((name) => `(deny mach-lookup (global-name ${sandboxLiteral(name)}))`),
    "",
  ].join("\n");
}

/** Every directory above a denied path (prefixes: above their directory, and
 *  that directory itself), deduplicated, `/` included. */
export function denyAncestors(policy: Pick<ResolvedSandboxPolicy, "denyDirs" | "denyPrefixes" | "writeDenyDirs">): string[] {
  const out = new Set<string>();
  const climb = (start: string) => {
    let cur = start;
    for (;;) {
      out.add(cur);
      const parent = dirname(cur);
      if (parent === cur) return;
      cur = parent;
    }
  };
  for (const dir of [...policy.denyDirs, ...policy.writeDenyDirs]) {
    const parent = dirname(dir);
    if (parent !== dir) climb(parent);
  }
  for (const prefix of policy.denyPrefixes) climb(dirname(prefix));
  return [...out];
}

/** A path as a TinyScheme string literal for the profile: backslash and double
 *  quote escaped. A workspace path containing `"` would otherwise close the
 *  literal early and leave a profile that either fails to parse (fail closed,
 *  survivable) or denies the wrong subpath (fail OPEN, not survivable). */
function sandboxLiteral(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `s` as one POSIX shell word.
 *
 * The whole command — heredocs, newlines, nested quotes, `$(…)`, the lot — goes
 * inside a single pair of single quotes, where the shell expands nothing. The
 * only character that cannot appear in a single-quoted string is `'` itself, so
 * each one closes the quote, emits an escaped literal quote and reopens:
 * `'` → `'\''`. Nothing else needs touching, which is precisely why this
 * scheme survives command shapes a per-character escaper would mangle.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment variables a group shell keeps. Everything else the SDK
 * process carries is dropped — an API key, a gateway token, `SSH_AUTH_SOCK`,
 * whatever the daemon was started with — because a sandbox that hides the
 * config file but hands its secrets over in `env` hides nothing.
 *
 * An ALLOWLIST, for the same reason the profile is one: names that carry a
 * credential cannot be enumerated. The kept ones locate things (PATH, HOME,
 * TMPDIR), describe the terminal and locale, or scope Tomo's own CLI to the
 * session (`TOMO_SESSION_KEY`, `TOMO_DAEMON_PID` — identifiers, not secrets).
 */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "COLORTERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "TZ", "TOMO_SESSION_KEY", "TOMO_DAEMON_PID",
];

/**
 * `/usr/bin/env -i` plus each allowed variable, expanded by the OUTER shell
 * (the Bash tool's), so the values never appear in the command text.
 * `${V+"V=$V"}` yields the assignment only when `V` is set — an unset variable
 * stays unset rather than becoming empty.
 */
export const ENV_ALLOWLIST_PREFIX = [
  "/usr/bin/env",
  "-i",
  ...SANDBOX_ENV_ALLOWLIST.map((name) => "${" + name + "+\"" + name + "=$" + name + "\"}"),
  // git reads ~/.gitconfig on every run and stops when it cannot; the owner's
  // home is not readable, so point it at nothing.
  "GIT_CONFIG_GLOBAL=/dev/null",
].join(" ");

/**
 * `command`, rewritten to run under `profileText` with only the allowlisted
 * environment. Pure, and the profile travels as an ARGUMENT — there is no file
 * for the sandboxed command to edit.
 *
 * `--` before the command is load-bearing. `zsh -lc '-n …'` is
 * `zsh: bad option string` — zsh reads a leading `-` as its own flag, so any
 * command whose first word starts with a dash died before it ran (verified).
 * `--` ends zsh's option list, and everything after it is the script.
 */
export function wrapWithSandbox(command: string, profileText: string): string {
  return [
    ENV_ALLOWLIST_PREFIX,
    SANDBOX_EXEC_PATH,
    "-p",
    shellSingleQuote(profileText),
    SANDBOX_SHELL_PATH,
    ...SANDBOX_SHELL_FLAGS,
    "--",
    shellSingleQuote(command),
  ].join(" ");
}

/** Is `p` itself a symlink? `lstatSync`, so the link is inspected rather than
 *  followed — a dangling link exists as an entry even though `realpathSync`
 *  cannot resolve it. A path that cannot be lstat'd at all is not a symlink. */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * `realpath(3)`, NOT node's JS reimplementation.
 *
 * `fs.realpathSync` normalizes `..` LEXICALLY before traversing links, and
 * `realpath(3)` applies it to wherever the traversal has actually arrived. With
 * one `..` after a symlink the two disagree, and the kernel sides with
 * `realpath(3)` — so the JS answer names a directory the sandbox would deny while
 * `open(2)` goes somewhere else entirely. Measured on macOS 26:
 *
 *     hop           -> /w/target/deep
 *     memory/private -> ../hop/../secret
 *
 *     fs.realpathSync        → /w/secret          (denied, and irrelevant)
 *     fs.realpathSync.native → /w/target/secret   (what cat actually opens)
 *
 * The shorter demonstration of the same disagreement: `realpathSync("/tmp/..")`
 * is `/`, `realpathSync.native("/tmp/..")` is `/private`.
 *
 * So the boundary is computed with the kernel's own resolver, everywhere. A deny
 * predicate that resolves paths differently from the thing doing the opening is
 * not a deny predicate.
 */
function realpathNative(p: string): string {
  return realpathSync.native(p);
}

/** Does the spelled path contain a `..` segment? Such a path is refused outright
 *  rather than resolved: the ancestor walk below is lexical (`dirname`), so a
 *  `..` in a part of the path that does NOT exist yet would be folded by the
 *  wrong rules — the same disagreement as above, reintroduced one level up.
 *  Nothing in the harness spells `PRIVATE_MEMORY_DIR` with `..`, so refusing
 *  costs nothing and removes the class. */
function hasDotDotSegment(p: string): boolean {
  return p.split(sep).includes("..");
}

/**
 * The private dir as the KERNEL will see it, or `null` when that cannot be
 * established — in which case the caller must withhold the shell.
 *
 * `realpathSync` because the sandbox matches resolved paths: with a symlinked
 * workspace (`~/.tomo` → somewhere else, or a `/tmp` workspace in a test, where
 * macOS makes `/tmp` a link to `/private/tmp`) a profile naming the spelled path
 * denies a subpath nothing resolves into, and the deny silently covers nothing.
 *
 * The directory need not EXIST yet — a fresh workspace has no `memory/private/`
 * until the first private note is written, and the boundary has to hold before
 * then. So a plain `ENOENT` on a path that is not a symlink walks up to the
 * deepest existing ancestor, resolves that, and re-appends the tail. Denying a
 * path that does not exist yet is exactly right: it is the path the file will
 * have.
 *
 * EVERY OTHER FAILURE IS FATAL, and the distinction is the point. A DANGLING
 * SYMLINK at `memory/private` used to be swallowed by the same walk: the link
 * resolved to nothing, the ancestor walk returned the link's own path, the
 * profile denied a path no read would ever go through, and the real target — the
 * place the files would actually land the moment the link's target appeared —
 * was never denied. A background command spawned by the turn could simply wait
 * for it. So a symlink that will not resolve fails closed, as does `ELOOP`,
 * `EACCES`, or running out of path to walk.
 */
export function resolvedDenyDir(privateDir: string): string | null {
  if (hasDotDotSegment(privateDir)) return null;
  const tail: string[] = [];
  let cur = privateDir;
  for (;;) {
    try {
      return join(realpathNative(cur), ...tail);
    } catch (err) {
      // A link whose target cannot be resolved names a place we cannot deny.
      if (isSymlink(cur)) return null;
      if (!isEnoent(err)) return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * A `PreToolUse` hook that is NOT ours and could rewrite the sandbox away, named
 * for the log — or `null` when there is none.
 *
 * WHY THIS EXISTS. Registering our rewrite last in the hook array is not enough.
 * The CLI merges every PreToolUse producer's result and takes the last
 * `updatedInput` it sees; the hooks do not run strictly in array order, so a
 * foreign hook that returns `updatedInput` — even just echoing `tool_input`
 * back — can land after ours and restore the UNSANDBOXED command. Project
 * settings and plugins both contribute PreToolUse hooks through the CLI's own
 * merge, which our `mergeHooks` never sees.
 *
 * So on a barred turn, the presence of any foreign PreToolUse hook withholds the
 * shell. This is the fail-closed reading of a boundary we cannot hold: we cannot
 * prove a hook we did not write will not rewrite a Bash command, so we do not
 * run one.
 *
 * DELIBERATELY COARSE, on two counts:
 *
 *  - Any `PreToolUse` entry counts, not only one whose `matcher` mentions Bash.
 *    A matcher is a pattern, and deciding which patterns match "Bash" means
 *    reimplementing the CLI's matching — the same class of mistake as filtering
 *    command text. An empty or absent matcher already means "every tool".
 *  - A plugin that ships a `hooks/` directory at all counts, without reading
 *    what is in it.
 *
 *  An unreadable or unparseable settings file counts too: absence of a hook has
 *  to be established, not assumed.
 *
 * RE-READ ON EVERY CALL, never memoized. The profile now denies writes to the
 * workspace's `.claude/`, but a group's extra write dirs, an unsandboxed
 * group, or the owner's own turns can still WRITE a settings file or drop a
 * `hooks/` directory into a plugin. Caching this answer would mean command 1
 * installs a racing hook and command 2 is still told there is none; re-reading
 * means command 2 is withheld instead. The files are small and this runs once
 * per Bash call on a barred turn only.
 */
export function foreignPreToolUseHookSource(scan: {
  settingsFiles: readonly string[];
  pluginDirs: readonly string[];
}): string | null {
  for (const file of scan.settingsFiles) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return `${file} (unreadable, so its hooks cannot be ruled out)`;
    }
    const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
    const pre = hooks?.PreToolUse;
    if (Array.isArray(pre) ? pre.length > 0 : pre !== undefined) {
      return `${file} (hooks.PreToolUse)`;
    }
  }
  for (const dir of scan.pluginDirs) {
    if (existsSync(join(dir, "hooks"))) return `${dir}/hooks`;
    const manifest = join(dir, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { hooks?: unknown } | null;
      if (parsed?.hooks !== undefined) return `${manifest} (hooks)`;
    } catch {
      return `${manifest} (unreadable, so its hooks cannot be ruled out)`;
    }
  }
  return null;
}

/** One warning line per process for the fail-closed path, not one per call — a
 *  turn that keeps reaching for the shell would otherwise fill the log with the
 *  same sentence. */
let warned = false;

function warnOnce(reason: string): null {
  if (!warned) {
    warned = true;
    log.warn(
      { reason, sandboxExec: SANDBOX_EXEC_PATH },
      "Cannot sandbox Bash for a private-memory-barred turn; withholding the shell instead",
    );
  }
  return null;
}

/** Forget the warned-once latch. Tests only — it is a process-lifetime latch by
 *  design. */
export function resetBashSandboxForTests(): void {
  warned = false;
}

/**
 * `command` rewritten to run sandboxed under `policy`, or `null` to fall back
 * to withholding the shell. The one function the PreToolUse guard calls.
 *
 * Recomputed from scratch on every call. There is nothing worth caching: the
 * profile text is string interpolation, and the thing an earlier version
 * cached — a path to a file on disk — was the bypass.
 *
 * DENIES FAIL CLOSED, ALLOWS FAIL QUIET. A deny whose real location cannot be
 * established withholds the shell (it would deny a path nothing opens). An
 * allow that cannot be resolved is left out: a missing grant only narrows the
 * box.
 *
 * No "is it already wrapped?" shortcut, on purpose. The model is free to type
 * its own `sandbox-exec -p <permissive profile>` prefix, and a shortcut keyed on
 * the text would hand it an unsandboxed shell for the price of a guess. Our wrap
 * always goes on the OUTSIDE, and a nested `sandbox_apply` inside an existing
 * sandbox fails (`sandbox-exec: sandbox_apply: Operation not permitted`) —
 * verified by running it — so the outer profile cannot be relaxed from within.
 */
export function sandboxedBashCommand(
  command: string,
  policy: GroupPathPolicy,
  scan?: { settingsFiles: readonly string[]; pluginDirs: readonly string[] },
): string | null {
  if (!existsSync(SANDBOX_EXEC_PATH)) return warnOnce("sandbox-exec is not present on this host");
  if (!existsSync(SANDBOX_SHELL_PATH)) return warnOnce(`${SANDBOX_SHELL_PATH} is not present on this host`);

  // A foreign PreToolUse hook can overwrite our rewrite — see
  // `foreignPreToolUseHookSource`. Checked before the wrap is built, because the
  // answer is "no shell", not "a different shell".
  if (policy.unresolvable) return warnOnce(policy.unresolvable);
  const foreign = scan ? foreignPreToolUseHookSource(scan) : null;
  if (foreign) {
    return warnOnce(`a foreign PreToolUse hook could rewrite the sandbox away: ${foreign}`);
  }

  const denyDirs: string[] = [];
  for (const dir of policy.denyDirs) {
    const resolved = resolvedDenyDir(dir);
    if (resolved === null) return warnOnce(`cannot resolve the real path of ${dir}, so its subpath cannot be denied`);
    denyDirs.push(resolved);
  }
  // A prefix is resolved through its directory: the kernel matches the real
  // path, and the last component is a name prefix, not a directory.
  const denyPrefixes: string[] = [];
  for (const prefix of policy.denyPrefixes) {
    const dir = resolvedDenyDir(dirname(prefix));
    if (dir === null) return warnOnce(`cannot resolve the real path of ${dirname(prefix)}, so ${basename(prefix)}* cannot be denied`);
    denyPrefixes.push(join(dir, basename(prefix)));
  }
  const writeDenyDirs: string[] = [];
  for (const dir of policy.writeDenyDirs) {
    const resolved = resolvedDenyDir(dir);
    if (resolved === null) return warnOnce(`cannot resolve the real path of ${dir}, so writes under it cannot be denied`);
    writeDenyDirs.push(resolved);
  }
  const allow = (dirs: readonly string[]) => dirs.flatMap((dir) => {
    const resolved = resolvedDenyDir(dir);
    return resolved === null ? [] : [resolved];
  });
  try {
    return wrapWithSandbox(command, sandboxProfileText({
      readDirs: allow(policy.readDirs),
      readFiles: allow(policy.readFiles),
      writeDirs: allow(policy.writeDirs),
      denyDirs,
      denyPrefixes,
      writeDenyDirs,
    }));
  } catch {
    return warnOnce("could not build the sandboxed command");
  }
}
