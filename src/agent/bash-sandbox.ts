import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../config.js";
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
 * DENY SCOPE IS EXACTLY THE PRIVATE DIR — the same boundary the Read/Grep/Glob
 * arms of the guard already enforce, no wider. Both `file-read*` and
 * `file-write*` are denied, which is also what the file-tool arms do (they cover
 * `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, not just `Read`). The write half is
 * not decoration: with reads denied alone, `mv memory/private /tmp/p && cat
 * /tmp/p/note.txt` walks the files OUT of the denied subpath and reads them at a
 * path the profile says nothing about. Verified by running it.
 *
 * FAIL CLOSED. Anything that makes the wrap unavailable — no `sandbox-exec`, no
 * `/bin/zsh`, an unwritable profile path, a non-string command — returns `null`,
 * and the guard falls back to the old behaviour: Bash withheld, with the
 * existing denial text. Never to an unsandboxed shell.
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

/** `command`, rewritten to run under `profilePath`. Pure — the profile file's
 *  existence is the caller's problem, which is what makes this unit-testable. */
export function wrapWithSandbox(command: string, profilePath: string): string {
  return [
    SANDBOX_EXEC_PATH,
    "-f",
    shellSingleQuote(profilePath),
    SANDBOX_SHELL_PATH,
    "-lc",
    shellSingleQuote(command),
  ].join(" ");
}

/**
 * The private dir as the KERNEL will see it.
 *
 * `realpathSync` because the sandbox matches resolved paths: with a symlinked
 * workspace (`~/.tomo` → somewhere else, or a `/tmp` workspace in a test, where
 * macOS makes `/tmp` a link to `/private/tmp`) a profile naming the spelled path
 * denies a subpath nothing resolves into, and the deny silently covers nothing.
 *
 * The directory need not exist yet — a fresh workspace has no `memory/private/`
 * until the first private note is written, and the boundary has to hold before
 * then. So resolve the deepest ancestor that does exist and re-append the tail,
 * walking up until something resolves. Denying a path that does not exist yet is
 * exactly right: it is the path the file will have.
 */
export function resolvedDenyDir(privateDir: string): string {
  const tail: string[] = [];
  let cur = privateDir;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return privateDir;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Where the profile is written. `tomoHome` may be absent under a stubbed
 *  config (unit tests), in which case there is no tomo data dir to speak of and
 *  the OS temp dir is the honest answer. */
function profileDir(): string {
  const home = (config as { tomoHome?: string }).tomoHome;
  return home ? join(home, "data") : join(process.env.TMPDIR || "/tmp", "tomo");
}

/** Written once per process, and again only if the resolved deny dir changes. */
let cached: { denyDir: string; profilePath: string } | null = null;
/** One warning line per process for the fail-closed path, not one per call — a
 *  turn that keeps reaching for the shell would otherwise fill the log with the
 *  same sentence. */
let warned = false;

function warnOnce(reason: string, err?: unknown): null {
  if (!warned) {
    warned = true;
    log.warn(
      { err, reason, sandboxExec: SANDBOX_EXEC_PATH },
      "Cannot sandbox Bash for a private-memory-barred turn; withholding the shell instead",
    );
  }
  return null;
}

/** Forget the memoized profile and the warned-once latch. Tests only — the
 *  module is a process-lifetime singleton by design. */
export function resetBashSandboxForTests(): void {
  cached = null;
  warned = false;
}

/**
 * Path to a profile file denying the private memory dir, or `null` if one
 * cannot be had (see the fail-closed note in the module header).
 *
 * Mode `0600`: the file names a directory worth hiding, and it is the input to
 * the thing enforcing the boundary — a profile another user could rewrite is
 * not a boundary. Rewritten on every miss rather than trusted if present, so a
 * tampered or truncated file from an earlier process is replaced, not reused.
 */
export function ensureSandboxProfile(privateDir: string = PRIVATE_MEMORY_DIR): string | null {
  if (!existsSync(SANDBOX_EXEC_PATH)) return warnOnce("sandbox-exec is not present on this host");
  if (!existsSync(SANDBOX_SHELL_PATH)) return warnOnce(`${SANDBOX_SHELL_PATH} is not present on this host`);

  const denyDir = resolvedDenyDir(privateDir);
  if (cached && cached.denyDir === denyDir) return cached.profilePath;

  const dir = profileDir();
  const profilePath = join(dir, "bash-sandbox.sb");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(profilePath, sandboxProfileText(denyDir), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    return warnOnce(`could not write the sandbox profile to ${profilePath}`, err);
  }
  cached = { denyDir, profilePath };
  log.info({ profilePath, denyDir }, "Wrote the Bash sandbox profile for private-memory-barred turns");
  return profilePath;
}

/**
 * `command` rewritten to run sandboxed, or `null` to fall back to withholding
 * the shell. The one function the PreToolUse guard calls.
 *
 * No "is it already wrapped?" shortcut, on purpose. The model is free to type
 * its own `sandbox-exec -f <permissive profile>` prefix, and a shortcut keyed on
 * the text would hand it an unsandboxed shell for the price of a guess. Our wrap
 * always goes on the OUTSIDE, and a nested `sandbox_apply` inside an existing
 * sandbox fails (`sandbox-exec: sandbox_apply: Operation not permitted`) —
 * verified by running it — so the outer deny cannot be relaxed from within.
 */
export function sandboxedBashCommand(
  command: string,
  privateDir: string = PRIVATE_MEMORY_DIR,
): string | null {
  const profilePath = ensureSandboxProfile(privateDir);
  if (!profilePath) return null;
  try {
    return wrapWithSandbox(command, profilePath);
  } catch (err) {
    return warnOnce("could not build the sandboxed command", err);
  }
}
