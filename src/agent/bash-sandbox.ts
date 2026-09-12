import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { log } from "../logger.js";
import { PRIVATE_MEMORY_DIR } from "../workspace/index.js";

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
 * DENY SCOPE IS EXACTLY THE PRIVATE DIR — the same boundary the Read/Grep/Glob
 * arms of the guard already enforce, no wider. Both `file-read*` and
 * `file-write*` are denied, which is also what the file-tool arms do (they cover
 * `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, not just `Read`). The write half is
 * not decoration: with reads denied alone, `mv memory/private /tmp/p && cat
 * /tmp/p/note.txt` walks the files OUT of the denied subpath and reads them at a
 * path the profile says nothing about. Verified by running it.
 *
 * FAIL CLOSED. Anything that makes the wrap unavailable or its scope uncertain —
 * no `sandbox-exec`, no `/bin/zsh`, a non-string command, a private path whose
 * real location cannot be established — returns `null`, and the guard falls back
 * to the old behaviour: Bash withheld, with the existing denial text. Never to
 * an unsandboxed shell.
 */

/** Absolute by design: a PATH lookup for the thing enforcing the boundary is a
 *  way round the boundary. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** The shell the wrapped command is handed to, also absolute.
 *
 *  `-l` and not just `-c`: the Bash tool's own shell is a login shell, and a
 *  command that resolves a tool through `~/.zprofile`'s PATH must keep
 *  resolving it. Non-interactive, so `~/.zshrc` is not read and nothing
 *  interactive can print into the captured output. */
export const SANDBOX_SHELL_PATH = "/bin/zsh";

/** Sandbox profile denying every read and write at-or-under `denyDir`.
 *
 * `(allow default)` and one deny, deliberately: this is not a general-purpose
 * jail and must not become one. A barred turn is otherwise a normal turn — git,
 * gh, curl, npm and the rest have to keep working, or the change trades one
 * impossible task for a hundred — so the profile states the single boundary the
 * harness already enforces everywhere else and nothing more.
 *
 * `subpath` covers the directory itself as well as everything under it, which is
 * what makes `ls memory/private` and `mv memory/private …` fail and not only
 * `cat memory/private/x`.
 */
export function sandboxProfileText(denyDir: string): string {
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* (subpath ${sandboxLiteral(denyDir)}))`,
    `(deny file-write* (subpath ${sandboxLiteral(denyDir)}))`,
    "",
  ].join("\n");
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
 * `command`, rewritten to run under `profileText`. Pure, and the profile travels
 * as an ARGUMENT — there is no file for the sandboxed command to edit.
 *
 * `--` before the command is load-bearing. `zsh -lc '-n …'` is
 * `zsh: bad option string` — zsh reads a leading `-` as its own flag, so any
 * command whose first word starts with a dash died before it ran (verified).
 * `--` ends zsh's option list, and everything after it is the script.
 */
export function wrapWithSandbox(command: string, profileText: string): string {
  return [
    SANDBOX_EXEC_PATH,
    "-p",
    shellSingleQuote(profileText),
    SANDBOX_SHELL_PATH,
    "-lc",
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
  const tail: string[] = [];
  let cur = privateDir;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch (err) {
      // A link whose target cannot be resolved names a place we cannot deny.
      if (isSymlink(cur)) return null;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
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
 * `command` rewritten to run sandboxed, or `null` to fall back to withholding
 * the shell. The one function the PreToolUse guard calls.
 *
 * Recomputed from scratch on every call. There is nothing worth caching: the
 * profile text is two string interpolations, and the thing an earlier version
 * cached — a path to a file on disk — was the bypass.
 *
 * No "is it already wrapped?" shortcut, on purpose. The model is free to type
 * its own `sandbox-exec -p <permissive profile>` prefix, and a shortcut keyed on
 * the text would hand it an unsandboxed shell for the price of a guess. Our wrap
 * always goes on the OUTSIDE, and a nested `sandbox_apply` inside an existing
 * sandbox fails (`sandbox-exec: sandbox_apply: Operation not permitted`) —
 * verified by running it — so the outer deny cannot be relaxed from within.
 */
export function sandboxedBashCommand(
  command: string,
  privateDir: string = PRIVATE_MEMORY_DIR,
): string | null {
  if (!existsSync(SANDBOX_EXEC_PATH)) return warnOnce("sandbox-exec is not present on this host");
  if (!existsSync(SANDBOX_SHELL_PATH)) return warnOnce(`${SANDBOX_SHELL_PATH} is not present on this host`);

  const denyDir = resolvedDenyDir(privateDir);
  if (denyDir === null) {
    return warnOnce(`cannot resolve the real path of ${privateDir}, so its subpath cannot be denied`);
  }
  try {
    return wrapWithSandbox(command, sandboxProfileText(denyDir));
  } catch {
    return warnOnce("could not build the sandboxed command");
  }
}
