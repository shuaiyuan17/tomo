import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The group path policy (src/agent/group-fs-policy.ts), end to end: the Bash
// profile under a REAL sandbox-exec, and the file-tool arm of the guard, both
// against one fixture tree shaped like a real install:
//
//   <root>/tomo-home/config.json, logs/, data/   — Tomo's home
//   <root>/tomo-home/workspace/                  — the workspace inside it
//       memory/MEMORY.md, memory/private/note.txt, secrets/token.txt, home/
//   <root>/user-home/Library/Keychains/, .ssh/   — a stand-in home directory
//   <root>/external/project/file.txt             — a checkout outside the workspace
//
// The fixture root is outside the temp dirs every group turn is granted, so
// "outside the workspace" really is outside the allowlist.
// ---------------------------------------------------------------------------

const fx = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  // NOT under the temp dir: the temp dirs are granted to every group turn, so a
  // fixture there would be reachable by construction. node_modules/.cache is
  // inside the checkout and ignored by git.
  const base = path.join(process.cwd(), "node_modules", ".cache");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "tomo-group-sbx-")));
  const tomoHome = path.join(root, "tomo-home");
  const ws = path.join(tomoHome, "workspace");
  return {
    root,
    tomoHome,
    ws,
    userHome: path.join(root, "user-home"),
    external: path.join(root, "external", "project"),
  };
});

vi.mock("../src/config.js", () => ({
  config: { workspaceDir: fx.ws, tomoHome: fx.tomoHome, sessionsDir: join(fx.tomoHome, "data", "sessions") },
}));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: join(fx.ws, "memory"),
  PRIVATE_MEMORY_DIR: join(fx.ws, "memory", "private"),
  HOME_SCENE_DIR: join(fx.ws, "home"),
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { groupPathPolicy, groupPathDenial, effectiveGroupSandbox, isValidExtraPath, tomoHomeDenies } = await import("../src/agent/group-fs-policy.js");
const { sandboxedBashCommand, sandboxProfileText, SANDBOX_EXEC_PATH, SANDBOX_SHELL_PATH, SANDBOX_MACH_DENY, resolvedDenyDir, shellSingleQuote } = await import("../src/agent/bash-sandbox.js");
const { privateMemoryGuardHooks } = await import("../src/agent/private-memory-guard.js");

const CONFIG = join(fx.tomoHome, "config.json");
const LOG = join(fx.tomoHome, "logs", "tomo.log");
const DATA = join(fx.tomoHome, "data", "usage.ndjson");
const PUBLIC = join(fx.ws, "memory", "MEMORY.md");
const PRIVATE = join(fx.ws, "memory", "private", "note.txt");
const SECRET = join(fx.ws, "secrets", "token.txt");
const EXTERNAL = join(fx.external, "file.txt");
const SSH_KEY = join(fx.userHome, ".ssh", "id_test");
const KEYCHAINS = join(fx.userHome, "Library", "Keychains");

function write(p: string, body: string) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}
write(CONFIG, "CONFIG-SECRET\n");
write(LOG, "LOG-SECRET\n");
write(DATA, "DATA-SECRET\n");
write(PUBLIC, "PUBLIC\n");
write(PRIVATE, "PRIVATE-SECRET\n");
write(SECRET, "TOKEN-SECRET\n");
write(EXTERNAL, "EXTERNAL\n");
write(SSH_KEY, "SSH-SECRET\n");
mkdirSync(KEYCHAINS, { recursive: true });
mkdirSync(join(fx.ws, "home"), { recursive: true });
mkdirSync(join(fx.ws, "notes"), { recursive: true });

afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

/** The policy a group turn gets in this fixture, optionally with extras. */
function policy(entry?: { extraRead?: string[]; extraWrite?: string[] }) {
  return groupPathPolicy({
    workspaceDir: fx.ws,
    privateDir: join(fx.ws, "memory", "private"),
    homeSceneDir: join(fx.ws, "home"),
    tomoHome: fx.tomoHome,
    dataDirs: [join(fx.tomoHome, "data")],
    entry: { extraRead: entry?.extraRead ?? [], extraWrite: entry?.extraWrite ?? [] },
    userHome: fx.userHome,
  });
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

describe("effectiveGroupSandbox — the legacy allowlist, read in place", () => {
  it("maps every groupShellAllowlist key to an unsandboxed entry", () => {
    expect(effectiveGroupSandbox(undefined, ["group:test-1"])).toEqual({
      groups: { "group:test-1": { extraRead: [], extraWrite: [], unsandboxed: true } },
    });
  });

  it("lets an explicit groupSandbox entry win over the legacy list", () => {
    const explicit = { extraRead: ["/x"], extraWrite: [], unsandboxed: false };
    expect(effectiveGroupSandbox({ groups: { "group:test-1": explicit } }, ["group:test-1"]).groups["group:test-1"]).toBe(explicit);
  });

  it("is empty with neither", () => {
    expect(effectiveGroupSandbox(undefined, undefined)).toEqual({ groups: {} });
  });
});

describe("isValidExtraPath", () => {
  it.each([
    ["/abs/dir", true],
    ["~/dir", true],
    ["relative/dir", false],
    ["/abs/../escape", false],
    ["/", false],
    ["~", false],
    ["~/", false],
  ])("%s → %s", (p, ok) => {
    expect(isValidExtraPath(p, "/h")).toBe(ok);
  });

  it("drops an invalid extra rather than granting it", () => {
    expect(policy({ extraRead: ["/", "relative"] }).readDirs).not.toContain("/");
  });
});

describe("tomoHomeDenies", () => {
  it("denies everything in Tomo's home except the workspace, read from disk", () => {
    const denies = tomoHomeDenies(fx.tomoHome, fx.ws);
    expect(denies).toEqual(expect.arrayContaining([CONFIG, join(fx.tomoHome, "logs"), join(fx.tomoHome, "data")]));
    expect(denies).not.toContain(fx.ws);
  });

  it("denies all of it when the workspace lives elsewhere", () => {
    expect(tomoHomeDenies(fx.tomoHome, fx.external)).toEqual([fx.tomoHome]);
  });
});

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

const sandboxRuns = process.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH) && existsSync(SANDBOX_SHELL_PATH);

function runWrapped(wrapped: string): { code: number; out: string } {
  // HOME is the fixture's, so git and zsh look for their start-up files where
  // the policy (built with the fixture's userHome) grants them.
  const r = spawnSync("/bin/zsh", ["-lc", wrapped], { encoding: "utf8", cwd: fx.ws, env: { ...process.env, HOME: fx.userHome } });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function run(command: string, p = policy()): { code: number; out: string } {
  const wrapped = sandboxedBashCommand(command, p);
  expect(wrapped).not.toBeNull();
  return runWrapped(wrapped!);
}

const q = shellSingleQuote;

describe.runIf(sandboxRuns)("group Bash under a real sandbox-exec", () => {
  it.each([
    ["the config file", CONFIG, "CONFIG-SECRET"],
    ["the logs", LOG, "LOG-SECRET"],
    ["Tomo's data", DATA, "DATA-SECRET"],
    ["secrets/", SECRET, "TOKEN-SECRET"],
    ["private memory", PRIVATE, "PRIVATE-SECRET"],
    ["~/.ssh", SSH_KEY, "SSH-SECRET"],
  ])("cannot read %s", (_what, file, marker) => {
    const r = run(`cat ${q(file)}`);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(marker);
  });

  it("cannot list secrets/ or write the config file", () => {
    expect(run(`ls ${q(join(fx.ws, "secrets"))}`).code).not.toBe(0);
    expect(run(`echo '{"x":1}' > ${q(CONFIG)}`).code).not.toBe(0);
    expect(readFileSync(CONFIG, "utf8")).toBe("CONFIG-SECRET\n");
  });

  it("reads and writes ordinary workspace files", () => {
    const r = run(`cat ${q(PUBLIC)} && echo made > ${q(join(fx.ws, "made.txt"))} && cat ${q(join(fx.ws, "made.txt"))}`);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("PUBLIC");
    expect(r.out).toContain("made");
  });

  it("cannot read outside the workspace until the group's entry grants it", () => {
    expect(run(`cat ${q(EXTERNAL)}`).code).not.toBe(0);
    const granted = run(`cat ${q(EXTERNAL)}`, policy({ extraRead: [fx.external] }));
    expect(granted).toMatchObject({ code: 0 });
    expect(granted.out).toContain("EXTERNAL");
    // Read, not write.
    expect(run(`echo x >> ${q(EXTERNAL)}`, policy({ extraRead: [fx.external] })).code).not.toBe(0);
    expect(run(`echo x >> ${q(EXTERNAL)} && echo ok`, policy({ extraWrite: [fx.external] })).out).toContain("ok");
  });

  // REVERT-CATCHER. The permanent denies are emitted after every allow because
  // SBPL applies the last matching rule. Move them first (or go back to
  // `(allow default)`) and an extra covering Tomo's home reads the config file.
  it("keeps the permanent denies even when an extra covers them", () => {
    const r = run(`cat ${q(CONFIG)}; cat ${q(SECRET)}`, policy({ extraRead: [fx.tomoHome], extraWrite: [fx.ws] }));
    expect(r.out).not.toContain("CONFIG-SECRET");
    expect(r.out).not.toContain("TOKEN-SECRET");
  });

  it("cannot write the scene or the workspace's .claude/", () => {
    expect(run(`echo x > ${q(join(fx.ws, "home", "scene.json"))}`).code).not.toBe(0);
    expect(run(`mkdir -p ${q(join(fx.ws, ".claude"))} && echo x > ${q(join(fx.ws, ".claude", "settings.json"))}`).code).not.toBe(0);
  });

  it("keeps the everyday toolchain working", () => {
    const r = run([
      "python3 -c 'print(40+2)'",
      "git --version >/dev/null && echo git-ok",
      "sqlite3 :memory: 'select 7*6'",
    ].join(" && "));
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("42");
    expect(r.out).toContain("git-ok");
  });

  it("cannot connect to localhost", () => {
    const r = run(`curl -sS -m 3 -o /dev/null http://127.0.0.1:9/ ; echo "rc=$?"`);
    expect(r.out).toMatch(/rc=(7|1|28)/);
    expect(r.out).not.toContain("rc=0");
  });

  // THE KEYCHAIN, with controls. A throwaway keychain file in the fixture's
  // Library/Keychains, never added to the user's search list (every call names
  // the file), deleted afterwards.
  describe("the keychain", () => {
    const kc = join(KEYCHAINS, "tomo-sandbox-test.keychain-db");
    const SERVICE = "tomo-sandbox-test";
    const find = `/usr/bin/security find-generic-password -s ${SERVICE} -a probe ${q(kc)} >/dev/null 2>&1; echo "rc=$?"`;
    let made = false;
    try {
      execFileSync("/usr/bin/security", ["create-keychain", "-p", "test", kc], { stdio: "ignore" });
      execFileSync("/usr/bin/security", ["add-generic-password", "-s", SERVICE, "-a", "probe", "-w", "value", kc], { stdio: "ignore" });
      made = true;
    } catch {
      // No keychain tooling here: the cases below are skipped.
    }
    afterAll(() => {
      if (made) spawnSync("/usr/bin/security", ["delete-keychain", kc], { stdio: "ignore" });
    });

    /** The real profile with the keychain dir moved from deny to read. */
    function profileWithKeychainReadable(keepMachDeny: boolean): string {
      const p = policy();
      const resolve = (dirs: readonly string[]) => dirs.map((d) => resolvedDenyDir(d)!).filter(Boolean);
      const text = sandboxProfileText({
        readDirs: [...resolve(p.readDirs), resolvedDenyDir(KEYCHAINS)!],
        readFiles: resolve(p.readFiles),
        writeDirs: resolve(p.writeDirs),
        denyDirs: resolve(p.denyDirs.filter((d) => d !== KEYCHAINS)),
        writeDenyDirs: resolve(p.writeDenyDirs),
      });
      return keepMachDeny ? text : text.split("\n").filter((l) => !l.startsWith("(deny mach-lookup")).join("\n");
    }

    it.runIf(made)("is readable outside the sandbox (control)", () => {
      expect(execFileSync("/bin/zsh", ["-c", find], { encoding: "utf8" })).toContain("rc=0");
    });

    it.runIf(made)("is not readable from a group shell", () => {
      expect(run(find).out).not.toContain("rc=0");
    });

    it.runIf(made)("is readable when both locks are removed (control: the probe really works under sandbox-exec)", () => {
      const wrapped = `${SANDBOX_EXEC_PATH} -p ${q(profileWithKeychainReadable(false))} ${SANDBOX_SHELL_PATH} -lc -- ${q(find)}`;
      expect(runWrapped(wrapped).out).toContain("rc=0");
    });

    it.runIf(made)("is still not readable with the files open, because of the mach deny alone", () => {
      expect(SANDBOX_MACH_DENY).toContain("com.apple.SecurityServer");
      const wrapped = `${SANDBOX_EXEC_PATH} -p ${q(profileWithKeychainReadable(true))} ${SANDBOX_SHELL_PATH} -lc -- ${q(find)}`;
      expect(runWrapped(wrapped).out).not.toContain("rc=0");
    });
  });

  // The mach deny list must not cost the shell https. Skipped without network.
  const online = spawnSync("/usr/bin/curl", ["-sS", "-m", "5", "-o", "/dev/null", "https://example.com"]).status === 0;
  it.runIf(online)("keeps https working under the mach deny list (curl, git)", () => {
    const r = run(`curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com && echo && (cd /tmp && git ls-remote https://github.com/git/git HEAD >/dev/null) && echo git-net-ok`);
    expect(r.out).toContain("200");
    expect(r.out).toContain("git-net-ok");
  });
});

// ---------------------------------------------------------------------------
// The guard: Bash and the file tools on a group turn
// ---------------------------------------------------------------------------

type Result = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<Result>;

const GROUP = "group:test-1";
function hook(entry?: { extraRead?: string[]; extraWrite?: string[]; unsandboxed?: boolean }): Hook {
  const groups = entry ? { [GROUP]: { extraRead: entry.extraRead ?? [], extraWrite: entry.extraWrite ?? [], unsandboxed: entry.unsandboxed ?? false } } : {};
  const hooks = privateMemoryGuardHooks(GROUP, () => "group-session", () => [], () => ({ groups })) as unknown as { PreToolUse: Array<{ hooks: Hook[] }> };
  return hooks.PreToolUse[0].hooks[0];
}
const denied = (r: Result) => r.hookSpecificOutput?.permissionDecision === "deny";

describe("file tools on a sandboxed group turn", () => {
  it.each([
    ["the config file", CONFIG],
    ["the logs", LOG],
    ["secrets/", SECRET],
    ["private memory", PRIVATE],
    ["a keychain", join(homedir(), "Library", "Keychains", "login.keychain-db")],
    ["~/.ssh", join(homedir(), ".ssh", "id_ed25519")],
    ["a file outside the workspace", EXTERNAL],
  ])("Read of %s is denied", async (_what, file) => {
    expect(denied(await hook()({ tool_name: "Read", tool_input: { file_path: file } }))).toBe(true);
  });

  it("Write and Edit of the config file are denied", async () => {
    expect(denied(await hook()({ tool_name: "Write", tool_input: { file_path: CONFIG, content: "{}" } }))).toBe(true);
    expect(denied(await hook()({ tool_name: "Edit", tool_input: { file_path: CONFIG, old_string: "a", new_string: "b" } }))).toBe(true);
  });

  it("Read and Write of an ordinary workspace file are allowed", async () => {
    expect(await hook()({ tool_name: "Read", tool_input: { file_path: PUBLIC } })).toEqual({});
    expect(await hook()({ tool_name: "Read", tool_input: { file_path: "memory/MEMORY.md" } })).toEqual({});
    expect(await hook()({ tool_name: "Write", tool_input: { file_path: join(fx.ws, "notes.md"), content: "x" } })).toEqual({});
  });

  it("a symlink in the workspace pointing at the config file is judged by its target", async () => {
    const link = join(fx.ws, "innocent.json");
    symlinkSync(CONFIG, link);
    expect(denied(await hook()({ tool_name: "Read", tool_input: { file_path: link } }))).toBe(true);
  });

  it("searches rooted outside the workspace, or above a permanent deny, are denied", async () => {
    expect(denied(await hook()({ tool_name: "Grep", tool_input: { pattern: "x", path: fx.external } }))).toBe(true);
    expect(denied(await hook()({ tool_name: "Glob", tool_input: { pattern: "*", path: fx.tomoHome } }))).toBe(true);
    expect(denied(await hook()({ tool_name: "Glob", tool_input: { pattern: `${fx.tomoHome}/logs/*` } }))).toBe(true);
    expect(await hook()({ tool_name: "Grep", tool_input: { pattern: "x", path: join(fx.ws, "notes"), glob: "*.md" } })).toEqual({});
  });

  it("an attachment outside what the group may read is refused", async () => {
    const send = (path: string) => hook()({ tool_name: "mcp__tomo-internal__send_message", tool_input: { target: "owner", message: `here MEDIA:${path}` } });
    expect(denied(await send(SECRET))).toBe(true);
    expect(denied(await send(EXTERNAL))).toBe(true);
    expect(await send(PUBLIC)).toEqual({});
  });

  it("the group's extras open the file tools exactly as they open the shell", async () => {
    const h = hook({ extraRead: [fx.external] });
    expect(await h({ tool_name: "Read", tool_input: { file_path: EXTERNAL } })).toEqual({});
    expect(denied(await h({ tool_name: "Write", tool_input: { file_path: EXTERNAL, content: "x" } }))).toBe(true);
    expect(await hook({ extraWrite: [fx.external] })({ tool_name: "Write", tool_input: { file_path: EXTERNAL, content: "x" } })).toEqual({});
    // An extra never reaches a permanent deny.
    expect(denied(await hook({ extraRead: [fx.tomoHome] })({ tool_name: "Read", tool_input: { file_path: CONFIG } }))).toBe(true);
  });

  it("groupPathDenial says nothing about tools without a path", () => {
    expect(groupPathDenial("WebSearch", { query: "x" }, fx.ws, policy())).toBeNull();
  });
});

describe("an unsandboxed group behaves as before", () => {
  const h = hook({ unsandboxed: true });

  it("Bash is not rewritten", async () => {
    expect(await h({ tool_name: "Bash", tool_input: { command: `cat ${CONFIG}` } })).toEqual({});
  });

  it("file tools keep only the private-memory, data and home guards", async () => {
    expect(await h({ tool_name: "Read", tool_input: { file_path: EXTERNAL } })).toEqual({});
    expect(denied(await h({ tool_name: "Read", tool_input: { file_path: PRIVATE } }))).toBe(true);
    expect(denied(await h({ tool_name: "Read", tool_input: { file_path: DATA } }))).toBe(true);
  });
});

describe.runIf(sandboxRuns)("group Bash through the guard, executed", () => {
  async function exec(command: string, entry?: { extraRead?: string[] }) {
    const r = await hook(entry)({ tool_name: "Bash", tool_input: { command } });
    const rewritten = r.hookSpecificOutput?.updatedInput?.command;
    expect(typeof rewritten).toBe("string");
    return runWrapped(rewritten as string);
  }

  it("cannot read the config, secrets or logs; can read the workspace", async () => {
    for (const [file, marker] of [[CONFIG, "CONFIG-SECRET"], [SECRET, "TOKEN-SECRET"], [LOG, "LOG-SECRET"], [PRIVATE, "PRIVATE-SECRET"]] as const) {
      const r = await exec(`cat ${q(file)}`);
      expect(r.code, file).not.toBe(0);
      expect(r.out).not.toContain(marker);
    }
    const ok = await exec(`cat ${q(PUBLIC)}`);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.out).toContain("PUBLIC");
  });
});

// Keep the fixture honest: it must not sit inside a dir every group may reach.
it("the fixture lies outside the temp dirs a group turn is granted", () => {
  expect(fx.root.startsWith(realpathSync.native(tmpdir()))).toBe(false);
  expect(fx.root.startsWith("/private/tmp")).toBe(false);
});
