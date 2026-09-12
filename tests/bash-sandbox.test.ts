import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Real directory for the profile file, so the 0600 mode and the written text
 *  can be asserted rather than assumed. `realpathSync` because macOS makes
 *  `/tmp` a symlink to `/private/tmp`, and this suite is partly ABOUT that. */
const TOMO_HOME = realpathSync(mkdtempSync(join(tmpdir(), "tomo-sbx-home-")));

vi.mock("../src/config.js", () => ({ config: { workspaceDir: "/ws", tomoHome: TOMO_HOME } }));
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
  SANDBOX_EXEC_PATH,
  SANDBOX_SHELL_PATH,
  ensureSandboxProfile,
  resetBashSandboxForTests,
  resolvedDenyDir,
  sandboxProfileText,
  sandboxedBashCommand,
  shellSingleQuote,
  wrapWithSandbox,
} = await import("../src/agent/bash-sandbox.js");

const scratch: string[] = [TOMO_HOME];
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
  const PROFILE = "/tomo/data/bash-sandbox.sb";

  it("wraps a simple command", () => {
    expect(wrapWithSandbox("ls -la /tmp", PROFILE)).toBe(
      `/usr/bin/sandbox-exec -f '/tomo/data/bash-sandbox.sb' /bin/zsh -lc 'ls -la /tmp'`,
    );
  });

  it("escapes single quotes by closing, quoting and reopening", () => {
    // `'` → `'\''`: the only character a single-quoted shell word cannot hold.
    expect(wrapWithSandbox(`echo 'hi there'`, PROFILE)).toBe(
      `/usr/bin/sandbox-exec -f '/tomo/data/bash-sandbox.sb' /bin/zsh -lc 'echo '\\''hi there'\\'''`,
    );
  });

  it("carries a multi-line heredoc through unchanged", () => {
    const heredoc = ["cat <<'EOF'", "line one with 'quotes'", "  line two", "EOF"].join("\n");
    expect(wrapWithSandbox(heredoc, PROFILE)).toBe(
      `/usr/bin/sandbox-exec -f '/tomo/data/bash-sandbox.sb' /bin/zsh -lc `
      + `'cat <<'\\''EOF'\\''\nline one with '\\''quotes'\\''\n  line two\nEOF'`,
    );
  });

  it("quotes a profile path containing a space", () => {
    expect(wrapWithSandbox("true", "/Users/a b/data/p.sb")).toContain(`-f '/Users/a b/data/p.sb'`);
  });

  it("leaves $, backticks and backslashes for the inner shell, not the outer one", () => {
    // Inside single quotes the outer shell expands nothing, so the inner shell
    // sees the command byte for byte. A scheme that escaped `$` would change
    // the meaning of the command it is supposed to be transporting.
    expect(shellSingleQuote('echo $HOME `id -u` "a\\b"')).toBe(`'echo $HOME \`id -u\` "a\\b"'`);
  });
});

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

  it.each(shapes)("%s survives the wrap", (_name, command) => {
    const direct = execFileSync("/bin/zsh", ["-lc", command], { encoding: "utf8" });
    const viaQuote = execFileSync("/bin/zsh", ["-lc", `/bin/zsh -lc ${shellSingleQuote(command)}`], {
      encoding: "utf8",
    });
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
});

// ---------------------------------------------------------------------------
// Profile file management
// ---------------------------------------------------------------------------

describe("ensureSandboxProfile", () => {
  it("writes the profile under the tomo data dir, mode 0600", () => {
    const dir = scratchDir("tomo-sbx-priv-");
    const path = ensureSandboxProfile(dir);
    expect(path).toBe(join(TOMO_HOME, "data", "bash-sandbox.sb"));
    expect(readFileSync(path!, "utf8")).toBe(sandboxProfileText(dir));
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });

  it("writes once per process for an unchanged deny dir", () => {
    const dir = scratchDir("tomo-sbx-once-");
    expect(ensureSandboxProfile(dir)).not.toBeNull();
    expect(ensureSandboxProfile(dir)).not.toBeNull();
    expect(ensureSandboxProfile(dir)).not.toBeNull();
    expect(vi.mocked(log.info).mock.calls).toHaveLength(1);
  });

  it("regenerates when the private dir changes", () => {
    const first = scratchDir("tomo-sbx-a-");
    const second = scratchDir("tomo-sbx-b-");
    const path = ensureSandboxProfile(first)!;
    expect(readFileSync(path, "utf8")).toContain(first);
    ensureSandboxProfile(second);
    expect(readFileSync(path, "utf8")).toContain(second);
    expect(readFileSync(path, "utf8")).not.toContain(first);
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

  it("returns null when the profile cannot be written", () => {
    const blocked = join(TOMO_HOME, "data");
    rmSync(blocked, { recursive: true, force: true });
    // A FILE where the data directory should be: mkdirSync fails with EEXIST.
    writeFileSync(blocked, "not a directory");
    try {
      expect(sandboxedBashCommand("ls", scratchDir("tomo-sbx-nowrite-"))).toBeNull();
    } finally {
      rmSync(blocked, { force: true });
    }
  });

  it("logs the fallback exactly once, however many commands are refused", () => {
    MISSING.add(SANDBOX_EXEC_PATH);
    const dir = scratchDir("tomo-sbx-warnonce-");
    for (let i = 0; i < 4; i++) expect(sandboxedBashCommand("ls", dir)).toBeNull();
    expect(vi.mocked(log.warn).mock.calls).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls[0][1]).toContain("withholding the shell instead");
  });

  it("wraps when the sandbox is available", () => {
    if (!existsSync(SANDBOX_EXEC_PATH) || !existsSync(SANDBOX_SHELL_PATH)) return;
    const dir = scratchDir("tomo-sbx-ok-");
    const wrapped = sandboxedBashCommand("echo hi", dir);
    expect(wrapped).toBe(wrapWithSandbox("echo hi", ensureSandboxProfile(dir)!));
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

  it("leaves the everyday toolchain working — this is one deny, not a jail", () => {
    const { priv } = workspace();
    const r = runSandboxed(`git --version && echo ok > /dev/null && echo fine`, priv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fine");
  });
});
