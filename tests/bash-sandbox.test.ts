import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// The `sandbox-exec` wrap that lets a private-memory-barred turn keep its
// shell. Three layers, tested separately because they fail differently:
//
//  - the PURE wrapper (quoting + profile text), where a bug is a mangled
//    command or a deny clause naming the wrong subpath;
//  - the FAIL-CLOSED path, where a bug hands the model an unsandboxed shell;
//  - the REAL KERNEL, run under `sandbox-exec` on macOS, because every claim
//    in the first two layers is worthless if the profile does not actually
//    deny the read.
// ---------------------------------------------------------------------------

/** Paths `existsSync` should pretend are absent — how the fail-closed tests
 *  simulate a host without `sandbox-exec` without needing one. Consulted by the
 *  `node:fs` mock below, which is otherwise the real module. */
const MISSING = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      MISSING.has(String(p)) ? false : actual.existsSync(p),
  };
});

/** Where the DELETED file-based implementation would have written its profile:
 *  `<config.tomoHome>/data/bash-sandbox.sb`. `bash-sandbox.ts` no longer imports
 *  config at all, so this mock is inert for the code under test — it exists so
 *  the bypass tests below can plant a permissive profile at the exact path the
 *  old code read, which is what makes their revert-to-red claim true rather than
 *  merely plausible. */
const OLD_TOMO_HOME = realpathSync(mkdtempSync(join(tmpdir(), "tomo-sbx-oldhome-")));
vi.mock("../src/config.js", () => ({ config: { workspaceDir: "/ws", tomoHome: OLD_TOMO_HOME } }));

vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: "/ws/memory",
  PRIVATE_MEMORY_DIR: "/ws/memory/private",
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import("../src/logger.js");
const {
  AGENT_BROWSER_CHROME_FLAGS,
  AGENT_BROWSER_ENV_INJECT,
  SANDBOX_EXEC_PATH,
  SANDBOX_SHELL_PATH,
  foreignPreToolUseHookSource,
  resetBashSandboxForTests,
  resolvedDenyDir,
  sandboxProfileText,
  sandboxedBashCommand,
  shellSingleQuote,
  wrapWithSandbox,
} = await import("../src/agent/bash-sandbox.js");

const scratch: string[] = [OLD_TOMO_HOME];
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  MISSING.clear();
  resetBashSandboxForTests();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The pure wrapper
// ---------------------------------------------------------------------------

describe("wrapWithSandbox — the exact command the Bash tool will run", () => {
  // A stand-in for the real profile: short, and it still carries the newlines
  // and double quotes that make the inline form worth testing.
  const PROFILE = `(version 1)\n(deny file-read* (subpath "/ws/p"))\n`;
  const QUOTED = `'(version 1)\n(deny file-read* (subpath "/ws/p"))\n'`;

  /** Build the expected single-quoted command: env inject + semicolon + the
   *  original command, then single-quote the lot. */
  function expectedCmd(cmd: string): string {
    return shellSingleQuote(`${AGENT_BROWSER_ENV_INJECT}; ${cmd}`);
  }

  it("passes the profile INLINE with -p, so there is no file to tamper with", () => {
    // The bypass this replaces: the profile used to be a FILE, sitting outside
    // the deny set, owned by the same uid, under `(allow default)`. One
    // `echo > …/bash-sandbox.sb` from the sandboxed shell and the next command
    // of the same turn ran unsandboxed. `-p` puts the policy in this process's
    // argv, where the sandboxed command cannot reach it at all.
    const wrapped = wrapWithSandbox("ls -la /tmp", PROFILE);
    expect(wrapped).toBe(`/usr/bin/sandbox-exec -p ${QUOTED} /bin/zsh -lc -- ${expectedCmd("ls -la /tmp")}`);
    expect(wrapped).not.toContain("-f ");
    expect(wrapped).not.toContain(".sb");
  });

  it("ends zsh's option list with -- so a dash-leading command still runs", () => {
    // Without it, `zsh -lc '-n …'` is `zsh: bad option string` and the command
    // never runs at all — zsh reads the leading dash as one of its own flags.
    // The env inject prefix now means the first character is never a dash.
    expect(wrapWithSandbox("-n true || echo fell-through", PROFILE))
      .toBe(`/usr/bin/sandbox-exec -p ${QUOTED} /bin/zsh -lc -- ${expectedCmd("-n true || echo fell-through")}`);
  });

  it("escapes single quotes by closing, quoting and reopening", () => {
    // `'` → `'\''`: the only character a single-quoted shell word cannot hold.
    const wrapped = wrapWithSandbox(`echo 'hi there'`, PROFILE);
    expect(wrapped).toBe(
      `/usr/bin/sandbox-exec -p ${QUOTED} /bin/zsh -lc -- ${expectedCmd("echo 'hi there'")}`,
    );
  });

  it("carries a multi-line heredoc through unchanged", () => {
    const heredoc = ["cat <<'EOF'", "line one with 'quotes'", "  line two", "EOF"].join("\n");
    const wrapped = wrapWithSandbox(heredoc, PROFILE);
    expect(wrapped).toBe(
      `/usr/bin/sandbox-exec -p ${QUOTED} /bin/zsh -lc -- ${expectedCmd(heredoc)}`,
    );
  });

  it("single-quotes the profile so its newlines survive as one shell word", () => {
    // The rewrite is handed back as a command LINE, not an argv, so the whole
    // multi-line profile has to reach the outer shell as a single word.
    const wrapped = wrapWithSandbox("true", sandboxProfileText("/ws/memory/private"));
    expect(wrapped).toContain(`-p '(version 1)\n(allow default)\n`);
    expect(wrapped.split(`' ${SANDBOX_SHELL_PATH} `)).toHaveLength(2);
  });

  it("leaves $, backticks and backslashes for the inner shell, not the outer one", () => {
    // Inside single quotes the outer shell expands nothing, so the inner shell
    // sees the command byte for byte. A scheme that escaped `$` would change
    // the meaning of the command it is supposed to be transporting.
    expect(shellSingleQuote('echo $HOME `id -u` "a\\b"')).toBe(`'echo $HOME \`id -u\` "a\\b"'`);
  });

  it("injects AGENT_BROWSER_ARGS so Chrome runs inside sandbox-exec", () => {
    // Chrome's own sandbox collides with sandbox-exec; the env var tells
    // agent-browser to launch Chrome with --no-sandbox --disable-gpu.
    const wrapped = wrapWithSandbox("echo hi", PROFILE);
    expect(wrapped).toContain("AGENT_BROWSER_ARGS");
    expect(wrapped).toContain(AGENT_BROWSER_CHROME_FLAGS);
  });
});

/** The shells the round-trip below runs through.
 *
 *  `/bin/sh -c` ALWAYS, and it is not a weaker test of the thing that matters:
 *  the quoting is POSIX single-quoting, `'` → `'\''`, whose semantics are
 *  identical in every POSIX shell. Linux CI has no zsh (`spawnSync /bin/zsh
 *  ENOENT` — the round-trip cases were the CI failure), and a test that only
 *  runs on the maintainer's laptop is a test that stops running.
 *
 *  `/bin/zsh -lc --` AS WELL when it exists, which on macOS — the only platform
 *  the sandbox itself runs on — is always. That case exercises the exact shell
 *  and exact flags production uses, so the portable case never becomes the only
 *  evidence on the machine that matters. */
const ROUNDTRIP_SHELLS: Array<[string, string[]]> = [
  ["/bin/sh", ["-c", "--"]],
  ...(existsSync(SANDBOX_SHELL_PATH)
    ? [[SANDBOX_SHELL_PATH, ["-lc", "--"]] as [string, string[]]]
    : []),
];

describe("shellSingleQuote — round-tripped through a real shell", () => {
  // The strongest available statement about the quoting: run the quoted word
  // and compare against the command run directly. A mangled escape shows up as
  // different bytes, not as a passing string comparison.
  const shapes: Array<[string, string]> = [
    ["simple", "printf 'a-b-c'"],
    ["single quotes", `printf '%s' "it's here"`],
    ["nested quotes", `printf '%s' 'a'"'"'b'`],
    ["dollar and backtick", "printf '%s' '$NOT_EXPANDED `not run`'"],
    ["heredoc", ["cat <<'EOF'", "x'y", "$z", "EOF"].join("\n")],
    ["multi-line script", "set -e\nv=1\nprintf '%s' \"v=$v\"\n"],
    ["trailing newline", "printf 'done'\n"],
  ];

  const cases = ROUNDTRIP_SHELLS.flatMap(([shell, flags]) =>
    shapes.map(([name, command]) => [`${name} via ${shell}`, shell, flags, command] as const),
  );

  it.each(cases)("%s survives the wrap", (_name, shell, flags, command) => {
    const direct = execFileSync(shell, [...flags, command], { encoding: "utf8" });
    const viaQuote = execFileSync(
      shell,
      [...flags, `${shell} ${flags.join(" ")} ${shellSingleQuote(command)}`],
      { encoding: "utf8" },
    );
    expect(viaQuote).toBe(direct);
  });
});

describe("sandboxProfileText", () => {
  it("denies reads AND writes under exactly the named subpath", () => {
    expect(sandboxProfileText("/ws/memory/private")).toBe(
      [
        "(version 1)",
        "(allow default)",
        `(deny file-read* (subpath "/ws/memory/private"))`,
        `(deny file-write* (subpath "/ws/memory/private"))`,
        "",
      ].join("\n"),
    );
  });

  it("escapes a quote in the path rather than closing the literal early", () => {
    expect(sandboxProfileText(`/ws/me"mo\\ry`)).toContain(`(subpath "/ws/me\\"mo\\\\ry")`);
  });
});

describe("resolvedDenyDir", () => {
  it("resolves a symlinked workspace to the path the kernel will check", () => {
    const root = scratchDir("tomo-sbx-real-");
    mkdirSync(join(root, "real", "memory", "private"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(resolvedDenyDir(join(root, "link", "memory", "private")))
      .toBe(join(root, "real", "memory", "private"));
  });

  it("resolves through the deepest existing ancestor when the dir is not there yet", () => {
    // A fresh workspace has no memory/private/ until the first private note is
    // written, and the boundary has to hold before then.
    const root = scratchDir("tomo-sbx-absent-");
    mkdirSync(join(root, "real", "memory"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(resolvedDenyDir(join(root, "link", "memory", "private")))
      .toBe(join(root, "real", "memory", "private"));
  });

  // THE FAIL-OPEN THIS CLOSES. A dangling symlink at `memory/private` used to be
  // swallowed by the ancestor walk: the link resolved to nothing, the walk
  // returned the LINK's own path, the profile denied a path no read would ever go
  // through, and the target the files would land in was never denied at all — a
  // background command spawned by the turn could just wait for it to appear.
  it("fails closed when the private path is a symlink whose target does not exist", () => {
    const root = scratchDir("tomo-sbx-dangling-");
    symlinkSync(join(root, "nowhere"), join(root, "private"));
    expect(resolvedDenyDir(join(root, "private"))).toBeNull();
  });

  it("fails closed on a symlink loop rather than walking up past it", () => {
    const root = scratchDir("tomo-sbx-loop-");
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(resolvedDenyDir(join(root, "a"))).toBeNull();
  });

  // THE `..` FAIL-OPEN. `fs.realpathSync` folds `..` lexically before following
  // links; `realpath(3)` — and therefore `open(2)` — applies it after. One `..`
  // behind a symlink makes them disagree, and the JS answer names a directory the
  // profile would deny while the kernel opens a different one. Red against the JS
  // resolver: it returns `<root>/secret`, the kernel opens `<root>/target/secret`.
  it("resolves .. the way the kernel does, not the way the JS resolver does", () => {
    const root = scratchDir("tomo-sbx-dotdot-");
    mkdirSync(join(root, "target", "deep"), { recursive: true });
    mkdirSync(join(root, "target", "secret"), { recursive: true });
    mkdirSync(join(root, "secret"), { recursive: true });
    mkdirSync(join(root, "memory"), { recursive: true });
    symlinkSync(join(root, "target", "deep"), join(root, "hop"));
    symlinkSync("../hop/../secret", join(root, "memory", "private"));

    const spelled = join(root, "memory", "private");
    // What the kernel will really open, asked of the kernel's own resolver.
    expect(resolvedDenyDir(spelled)).toBe(realpathSync.native(spelled));
    expect(resolvedDenyDir(spelled)).toBe(join(root, "target", "secret"));
    // And NOT what the JS resolver says, which is the whole point.
    expect(realpathSync(spelled)).toBe(join(root, "secret"));
    expect(resolvedDenyDir(spelled)).not.toBe(realpathSync(spelled));
  });

  it("refuses a spelled path containing a .. segment outright", () => {
    // The ancestor walk is lexical, so a `..` in a not-yet-existing part of the
    // path would be folded by the wrong rules. Nothing in the harness spells the
    // private dir that way, so refusing costs nothing.
    const root = scratchDir("tomo-sbx-spelled-dotdot-");
    mkdirSync(join(root, "memory", "private"), { recursive: true });
    // Built by concatenation, not `join`, which would normalize the `..` away
    // before the function ever saw it — as it does for the real caller, which is
    // why refusing this spelling costs nothing.
    expect(resolvedDenyDir(`${root}/memory/../memory/private`)).toBeNull();
  });

  it("still resolves a symlink that points somewhere real", () => {
    const root = scratchDir("tomo-sbx-livelink-");
    mkdirSync(join(root, "target"), { recursive: true });
    symlinkSync(join(root, "target"), join(root, "private"));
    expect(resolvedDenyDir(join(root, "private"))).toBe(join(root, "target"));
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe("sandboxedBashCommand — fail closed, never to an unsandboxed shell", () => {
  it("returns null when sandbox-exec is absent", () => {
    MISSING.add(SANDBOX_EXEC_PATH);
    expect(sandboxedBashCommand("ls", scratchDir("tomo-sbx-nosbx-"))).toBeNull();
  });

  it("returns null when the shell is absent", () => {
    MISSING.add(SANDBOX_SHELL_PATH);
    expect(sandboxedBashCommand("ls", scratchDir("tomo-sbx-nosh-"))).toBeNull();
  });

  it("returns null when the deny dir cannot be resolved", () => {
    // Same dangling-symlink case, now at the level the guard actually calls:
    // an unresolvable scope must withhold the shell, not sandbox it loosely.
    const root = scratchDir("tomo-sbx-unresolvable-");
    symlinkSync(join(root, "nowhere"), join(root, "private"));
    expect(sandboxedBashCommand("ls", join(root, "private"))).toBeNull();
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
    // WHICH reason is logged depends on the host: off macOS the `sandbox-exec`
    // preflight refuses first and never reaches the resolver, which is why the
    // assertion below is gated rather than unconditional (it was the other half
    // of the Linux CI failure). The `null` above is the invariant, and it holds
    // on every platform — every path out of here is fail-closed.
    if (sandboxRuns) {
      expect(vi.mocked(log.warn).mock.calls[0][0]).toMatchObject({
        reason: expect.stringContaining("cannot resolve the real path"),
      });
    }
  });

  it("returns null when a foreign PreToolUse hook could rewrite the sandbox away", () => {
    // Registering our rewrite last does not make it final: the CLI keeps the
    // last `updatedInput` it sees, and project/plugin hooks arrive through its
    // merge, not ours. We cannot prove a hook we did not write leaves the
    // command alone, so we do not run one.
    const root = scratchDir("tomo-sbx-foreign-");
    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    }));
    expect(sandboxedBashCommand("ls", scratchDir("tomo-sbx-foreign-priv-"), {
      settingsFiles: [settings],
      pluginDirs: [],
    })).toBeNull();
  });

  it("logs the fallback exactly once, however many commands are refused", () => {
    MISSING.add(SANDBOX_EXEC_PATH);
    const dir = scratchDir("tomo-sbx-warnonce-");
    for (let i = 0; i < 4; i++) expect(sandboxedBashCommand("ls", dir)).toBeNull();
    expect(vi.mocked(log.warn).mock.calls).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls[0][1]).toContain("withholding the shell instead");
  });

  it("wraps when the sandbox is available, with the profile inline", () => {
    if (!existsSync(SANDBOX_EXEC_PATH) || !existsSync(SANDBOX_SHELL_PATH)) return;
    const dir = scratchDir("tomo-sbx-ok-");
    expect(sandboxedBashCommand("echo hi", dir))
      .toBe(wrapWithSandbox("echo hi", sandboxProfileText(dir)));
  });

  it("puts the whole policy in the command, and nothing on disk", () => {
    if (!existsSync(SANDBOX_EXEC_PATH) || !existsSync(SANDBOX_SHELL_PATH)) return;
    const dir = scratchDir("tomo-sbx-nofile-");
    const wrapped = sandboxedBashCommand("echo hi", dir)!;
    // Every deny clause travels in the argv, so there is no second place the
    // policy could be read from — and therefore none to overwrite.
    for (const clause of ["(allow default)", `(deny file-read* (subpath "${dir}"))`]) {
      expect(wrapped).toContain(clause);
    }
    expect(wrapped).not.toContain(".sb");
    // The file version logged once on write; nothing is written now.
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Foreign PreToolUse hooks
//
// Registering our rewrite last in our own hook array does not make it final: the
// CLI keeps the last `updatedInput` any PreToolUse hook produces, and hooks from
// project settings and plugins reach it through its own merge. A foreign hook
// that echoes `tool_input` back therefore restores the unsandboxed command. We
// cannot hold that boundary, so we decline to run instead.
// ---------------------------------------------------------------------------

describe("foreignPreToolUseHookSource", () => {
  const none = { settingsFiles: [], pluginDirs: [] };

  it("finds nothing when there are no settings files and no plugins", () => {
    expect(foreignPreToolUseHookSource(none)).toBeNull();
  });

  it("ignores a settings file that does not exist", () => {
    const root = scratchDir("tomo-sbx-nosettings-");
    expect(foreignPreToolUseHookSource({
      settingsFiles: [join(root, "settings.json")],
      pluginDirs: [],
    })).toBeNull();
  });

  const settingsWith = (body: unknown): string => {
    const file = join(scratchDir("tomo-sbx-settings-"), "settings.json");
    writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("names a settings file carrying a PreToolUse hook", () => {
    const file = settingsWith({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    });
    expect(foreignPreToolUseHookSource({ settingsFiles: [file], pluginDirs: [] }))
      .toContain("hooks.PreToolUse");
  });

  it("counts a PreToolUse hook whose matcher never mentions Bash", () => {
    // A matcher is a pattern. Deciding which patterns match "Bash" means
    // reimplementing the CLI's matching, which is the mistake this whole change
    // exists to stop making — so any PreToolUse entry counts.
    const file = settingsWith({
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "true" }] }] },
    });
    expect(foreignPreToolUseHookSource({ settingsFiles: [file], pluginDirs: [] })).not.toBeNull();
  });

  it("allows a settings file with hooks for other events only", () => {
    const file = settingsWith({
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    });
    expect(foreignPreToolUseHookSource({ settingsFiles: [file], pluginDirs: [] })).toBeNull();
  });

  it("allows a settings file with no hooks key at all", () => {
    expect(foreignPreToolUseHookSource({
      settingsFiles: [settingsWith({ permissions: { allow: ["Bash"] } })],
      pluginDirs: [],
    })).toBeNull();
  });

  it("refuses a settings file it cannot parse — absence has to be established", () => {
    const file = join(scratchDir("tomo-sbx-badsettings-"), "settings.json");
    writeFileSync(file, "{ this is not json");
    expect(foreignPreToolUseHookSource({ settingsFiles: [file], pluginDirs: [] }))
      .toContain("unreadable");
  });

  it("names a plugin that ships a hooks directory, without reading it", () => {
    const dir = scratchDir("tomo-sbx-plugin-hooks-");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    expect(foreignPreToolUseHookSource({ settingsFiles: [], pluginDirs: [dir] }))
      .toContain("hooks");
  });

  it("names a plugin whose manifest declares hooks", () => {
    const dir = scratchDir("tomo-sbx-plugin-manifest-");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "p", hooks: { PreToolUse: [] },
    }));
    expect(foreignPreToolUseHookSource({ settingsFiles: [], pluginDirs: [dir] })).not.toBeNull();
  });

  it("allows a plugin that ships only skills and commands", () => {
    // The realistic case, and the one that decides whether this feature works at
    // all for anyone with a plugin installed: no hooks dir, no hooks in the
    // manifest, so nothing here can displace the rewrite.
    const dir = scratchDir("tomo-sbx-plugin-plain-");
    mkdirSync(join(dir, "skills"), { recursive: true });
    mkdirSync(join(dir, "commands"), { recursive: true });
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p" }));
    expect(foreignPreToolUseHookSource({ settingsFiles: [], pluginDirs: [dir] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

const sandboxRuns = process.platform === "darwin"
  && existsSync(SANDBOX_EXEC_PATH)
  && existsSync(SANDBOX_SHELL_PATH);

describe.runIf(sandboxRuns)("under a real sandbox-exec", () => {
  /** A workspace-shaped tree: one private file, one public sibling. */
  function workspace(): { priv: string; pub: string; dir: string } {
    const dir = scratchDir("tomo-sbx-kernel-");
    mkdirSync(join(dir, "memory", "private"), { recursive: true });
    writeFileSync(join(dir, "memory", "private", "note.txt"), "SECRET\n");
    writeFileSync(join(dir, "memory", "MEMORY.md"), "PUBLIC\n");
    return { priv: join(dir, "memory", "private"), pub: join(dir, "memory", "MEMORY.md"), dir };
  }

  /** Run `command` the way the Bash tool would once the hook has rewritten it.
   *  `/bin/zsh -lc` on the OUTSIDE too, because `updatedInput` hands the tool a
   *  command LINE, not an argv. */
  function runSandboxed(command: string, privateDir: string): { code: number; out: string } {
    const wrapped = sandboxedBashCommand(command, privateDir);
    expect(wrapped).not.toBeNull();
    try {
      return {
        code: 0,
        out: execFileSync("/bin/zsh", ["-lc", wrapped!], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("denies a direct read of a file under the private dir", () => {
    const { priv } = workspace();
    const r = runSandboxed(`cat ${join(priv, "note.txt")}`, priv);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Operation not permitted/);
    expect(r.out).not.toContain("SECRET");
  });

  it("reads a public sibling file normally", () => {
    const { priv, pub } = workspace();
    const r = runSandboxed(`cat ${pub}`, priv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PUBLIC");
  });

  it("denies listing the private dir itself", () => {
    const { priv } = workspace();
    expect(runSandboxed(`ls ${priv}`, priv).out).toMatch(/Operation not permitted/);
  });

  it("denies a path ASSEMBLED inside an interpreter, which no text filter sees", () => {
    const { priv, dir } = workspace();
    if (!existsSync("/usr/bin/python3")) return;
    const a = `${join(dir, "memory")}/pri`;
    const r = runSandboxed(`python3 -c "print(open('${a}' + 'vate/note.txt').read())"`, priv);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Operation not permitted|PermissionError/);
    expect(r.out).not.toContain("SECRET");
  });

  it("denies a read through a symlink planted outside the private dir", () => {
    const { priv, dir } = workspace();
    symlinkSync(priv, join(dir, "link"));
    const r = runSandboxed(`cat ${join(dir, "link", "note.txt")}`, priv);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("SECRET");
  });

  it("denies moving the private dir OUT of the denied subpath", () => {
    // The read-only profile this replaced allowed `mv private /tmp/p && cat
    // /tmp/p/note.txt`: the files left the denied subpath without ever being
    // read from inside it. This is why the profile denies file-write* too.
    const { priv, dir } = workspace();
    const r = runSandboxed(`mv ${priv} ${join(dir, "moved")} && cat ${join(dir, "moved", "note.txt")}`, priv);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Operation not permitted/);
    expect(r.out).not.toContain("SECRET");
  });

  it("cannot be escaped by the model prefixing its own permissive sandbox-exec", () => {
    // Our wrap is always the OUTER one, and sandbox_apply inside an existing
    // sandbox fails, so a nested profile cannot re-grant what the outer denies.
    const { priv, dir } = workspace();
    const permissive = join(dir, "permissive.sb");
    writeFileSync(permissive, "(version 1)\n(allow default)\n");
    const r = runSandboxed(
      `${SANDBOX_EXEC_PATH} -f ${permissive} cat ${join(priv, "note.txt")}`,
      priv,
    );
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("SECRET");
  });

  it("sets AGENT_BROWSER_ARGS inside the sandbox so Chrome can launch", () => {
    // Chrome's own sandbox conflicts with sandbox-exec; agent-browser reads
    // AGENT_BROWSER_ARGS for extra launch flags. The wrapper injects
    // --no-sandbox --disable-gpu so Chrome's internal sandbox is skipped.
    const { priv } = workspace();
    const r = runSandboxed("printf '%s' \"$AGENT_BROWSER_ARGS\"", priv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--no-sandbox");
    expect(r.out).toContain("--disable-gpu");
  });

  it("appends to an existing AGENT_BROWSER_ARGS rather than overwriting", () => {
    // A caller may already have flags in the env var; the injection must
    // preserve them and append, not clobber.
    const { priv } = workspace();
    const r = runSandboxed(
      'export AGENT_BROWSER_ARGS="--existing-flag"; '
      + `${AGENT_BROWSER_ENV_INJECT}; `
      + 'printf "%s" "$AGENT_BROWSER_ARGS"',
      priv,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("--existing-flag");
    expect(r.out).toContain("--no-sandbox");
    expect(r.out).toContain("--disable-gpu");
  });

  it("leaves the everyday toolchain working — this is one deny, not a jail", () => {
    const { priv } = workspace();
    const r = runSandboxed(`git --version && echo ok > /dev/null && echo fine`, priv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fine");
  });

  it("runs a command whose first word starts with a dash", () => {
    // Without `--` the inner shell never runs this at all: `zsh: bad option
    // string`. With it, the dash-leading word is the script's first command, so
    // the `||` branch is reached and the turn is not silently broken.
    const { priv } = workspace();
    const r = runSandboxed("-n true || echo fell-through", priv);
    expect(r.out).toContain("fell-through");
    expect(r.out).not.toContain("bad option string");
  });

  // THE PROFILE-FILE BYPASS, AS AN END-TO-END CHECK.
  //
  // The earlier version wrote the profile to `<tomoHome>/data/bash-sandbox.sb`
  // and memoized the path for the life of the process. That file was outside the
  // deny set, owned by the same uid, writable under `(allow default)` — so
  // command 1 could overwrite it with `(allow default)` and command 2, reusing
  // the memo, ran with the policy the MODEL had written. `rm -f` on it was a
  // denial of service by the same route. Each call now carries its own policy in
  // argv, so a command that writes a permissive profile anywhere has written a
  // file nothing reads.
  /** Exactly where the deleted file-based implementation would have looked:
   *  `<config.tomoHome>/data/bash-sandbox.sb` (the mocked tomoHome at the top of
   *  this file), and the `$TMPDIR/tomo/` fallback it used when tomoHome was
   *  absent. Both, because a revert could land on either branch — planting at a
   *  path the old code never read would leave these tests green against it, which
   *  would make the revert-to-red claim false. */
  const OLD_PROFILE_PATHS = [
    join(OLD_TOMO_HOME, "data", "bash-sandbox.sb"),
    join(process.env.TMPDIR || "/tmp", "tomo", "bash-sandbox.sb"),
  ];

  it("cannot be escaped by writing a permissive profile to disk first", () => {
    const { priv, dir } = workspace();
    const mine = join(dir, "mine.sb");
    const targets = [...OLD_PROFILE_PATHS, mine];

    // Command 1: plant a permissive profile at every path the old implementation
    // read, plus one of the command's own choosing.
    const plant = targets
      .map((t) => `mkdir -p ${JSON.stringify(dirname(t))} && printf '(version 1)\\n(allow default)\\n' > ${JSON.stringify(t)}`)
      .join("; ");
    const planted = runSandboxed(`${plant}; echo planted`, priv);
    expect(planted.out).toContain("planted");
    // The writes really landed — otherwise command 2 would prove nothing.
    for (const t of targets) expect(existsSync(t), t).toBe(true);

    // Command 2, same process, same private dir: still denied.
    const after = runSandboxed(`cat ${join(priv, "note.txt")}`, priv);
    expect(after.code).not.toBe(0);
    expect(after.out).toMatch(/Operation not permitted/);
    expect(after.out).not.toContain("SECRET");
  });

  it("cannot be denied service by deleting the profile the old version cached", () => {
    // `rm -f <profile>` used to make every later call exit 65 — sandbox-exec
    // could not open the file the memo still pointed at.
    const { priv } = workspace();
    const rm = OLD_PROFILE_PATHS.map((t) => `rm -f ${JSON.stringify(t)}`).join("; ");
    runSandboxed(`${rm}; echo removed`, priv);
    const after = runSandboxed("echo still-working", priv);
    expect(after.code).toBe(0);
    expect(after.out).toContain("still-working");
  });
});
