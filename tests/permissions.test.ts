import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// `permissions.ts` imports `config` at module load, which throws if no
// channels are configured. CI has no config file and no env vars, so the real
// module would blow up before any test runs. The isPrivateMemoryAccess
// predicate takes its `ctx` as a parameter and never touches `config`, so a
// minimal stub is enough.
vi.mock("../src/config.js", () => ({
  config: { workspaceDir: "/ws" },
}));
// The guard hook reads these at build time. Pinned to the same `/ws` root the
// config mock names, so the hook's own ctx matches the `ctx` the predicate
// tests below pass in by hand — otherwise the hook would be judging `/ws`
// paths against the real ~/.tomo memory dir.
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: "/ws/memory",
  PRIVATE_MEMORY_DIR: "/ws/memory/private",
  PRIVATE_MEMORY_SUBDIR: "private",
}));
// Stubbed so the agent-profile tests can assert on the fail-open warning and
// the Bash audit line without going through pino.
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import("../src/logger.js");
const {
  agentProfileDenial,
  agentProfileGuardHooks,
  isPrivateMemoryAccess,
  privateMemoryBashDenial,
  privateMemoryGuardHooks,
  skillsCanUseTool,
  SEND_MESSAGE_TOOL,
  PRIVATE_MEMORY_GROUP_DENIAL,
  PRIVATE_MEMORY_SUMMONED_DENIAL,
} = await import("../src/agent/permissions.js");

const ctx = {
  cwd: "/ws",
  memoryDir: "/ws/memory",
  privateDir: "/ws/memory/private",
};

describe("isPrivateMemoryAccess — group-session guard", () => {
  describe("Read / Edit / Write / NotebookEdit", () => {
    it("denies direct read of a private file (relative)", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "memory/private/secret.md" }, ctx)).toBe(true);
    });

    it("denies direct read of a private file (absolute)", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "/ws/memory/private/secret.md" }, ctx)).toBe(true);
    });

    it("denies read through ./ prefix", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "./memory/private/secret.md" }, ctx)).toBe(true);
    });

    it("denies read through .. traversal that still lands inside private/", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "memory/../memory/private/x.md" }, ctx)).toBe(true);
    });

    it("denies write to private/", () => {
      expect(isPrivateMemoryAccess("Write", { file_path: "memory/private/new.md", content: "x" }, ctx)).toBe(true);
    });

    it("denies edit on private/", () => {
      expect(isPrivateMemoryAccess("Edit", { file_path: "memory/private/x.md", old_string: "a", new_string: "b" }, ctx)).toBe(true);
    });

    it("denies NotebookEdit on private/", () => {
      expect(isPrivateMemoryAccess("NotebookEdit", { notebook_path: "memory/private/n.ipynb" }, ctx)).toBe(true);
    });

    it("allows read of a public memory file", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "memory/public.md" }, ctx)).toBe(false);
    });

    it("allows read of MEMORY.md itself", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "memory/MEMORY.md" }, ctx)).toBe(false);
    });

    it("allows read outside the memory tree", () => {
      expect(isPrivateMemoryAccess("Read", { file_path: "tmp/scratch.txt" }, ctx)).toBe(false);
    });
  });

  describe("Glob", () => {
    it("denies glob rooted at memory/ with recursive pattern (reviewer's case)", () => {
      expect(isPrivateMemoryAccess("Glob", { path: "memory", pattern: "**/*.md" }, ctx)).toBe(true);
    });

    it("denies glob rooted at memory/ even with a non-recursive pattern", () => {
      expect(isPrivateMemoryAccess("Glob", { path: "memory", pattern: "*.md" }, ctx)).toBe(true);
    });

    it("denies glob rooted inside private/", () => {
      expect(isPrivateMemoryAccess("Glob", { path: "memory/private", pattern: "*.md" }, ctx)).toBe(true);
    });

    it("denies unanchored recursive glob from cwd (would descend into private/)", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "**/*.md" }, ctx)).toBe(true);
    });

    it("denies unanchored recursive glob with no path arg (defaults to cwd)", () => {
      expect(isPrivateMemoryAccess("Glob", { pattern: "**/*.md" }, ctx)).toBe(true);
    });

    it("denies glob with pattern naming the private segment", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "memory/private/*" }, ctx)).toBe(true);
    });

    it("denies wildcard segment that expands to private (reviewer's bypass)", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "memory/pri*/*.md" }, ctx)).toBe(true);
    });

    it("denies pattern with intermediate wildcard reaching private", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "*/private/*" }, ctx)).toBe(true);
    });

    it("denies pattern using brace expansion containing private", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "memory/{public,private}/*.md" }, ctx)).toBe(true);
    });

    it("denies pattern using character class matching private", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "memory/p[a-z]*/*.md" }, ctx)).toBe(true);
    });

    it("allows glob anchored to a non-memory subtree", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "skills/**/*.md" }, ctx)).toBe(false);
    });

    it("allows non-recursive glob at cwd", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "*.json" }, ctx)).toBe(false);
    });

    it("allows glob anchored to memory siblings that don't match private", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "skills/*.json" }, ctx)).toBe(false);
    });

    it("denies case-permuted pattern (case-insensitive match)", () => {
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "Memory/PRIVATE/*.md" }, ctx)).toBe(true);
      expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "memory/PRI*/*.md" }, ctx)).toBe(true);
    });
  });

  describe("Grep", () => {
    it("denies grep rooted at memory/ (reviewer's case)", () => {
      expect(isPrivateMemoryAccess("Grep", { path: "memory", pattern: "secret" }, ctx)).toBe(true);
    });

    it("denies grep rooted inside private/", () => {
      expect(isPrivateMemoryAccess("Grep", { path: "memory/private", pattern: "x" }, ctx)).toBe(true);
    });

    it("denies grep at absolute memory dir", () => {
      expect(isPrivateMemoryAccess("Grep", { path: "/ws/memory", pattern: "x" }, ctx)).toBe(true);
    });

    it("allows grep in a non-memory subtree", () => {
      expect(isPrivateMemoryAccess("Grep", { path: "tmp", pattern: "x" }, ctx)).toBe(false);
    });

    it("denies recursive grep from cwd (would descend into private/)", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x" }, ctx)).toBe(true);
    });

    it("denies recursive grep with no path (defaults to cwd)", () => {
      expect(isPrivateMemoryAccess("Grep", { pattern: "x" }, ctx)).toBe(true);
    });

    it("allows grep from cwd when glob filter anchors to a non-memory subtree", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x", glob: "skills/**/*.md" }, ctx)).toBe(false);
    });

    it("denies grep from cwd even with a recursive glob filter (could still reach private/)", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x", glob: "**/*.md" }, ctx)).toBe(true);
    });

    it("denies grep with wildcard glob filter that expands to private (reviewer's bypass)", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "secret", glob: "memory/pri*/*.md" }, ctx)).toBe(true);
    });

    it("denies grep with basename glob filter (ripgrep semantics, reviewer's bypass)", () => {
      // `-g '*.md'` is a basename filter that matches at any depth, including
      // `memory/private/*.md`.
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "secret", glob: "*.md" }, ctx)).toBe(true);
    });

    it("denies grep with basename glob from memory subtree above private", () => {
      // Root is the workspace cwd, glob has no `/` → basename filter could
      // hit nested files in private/.
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x", glob: "secret.md" }, ctx)).toBe(true);
    });

    it("denies grep with brace-only basename glob", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x", glob: "{*.md,*.txt}" }, ctx)).toBe(true);
    });

    it("allows grep with basename glob when root is outside the memory tree", () => {
      // tmp/ is a sibling of memory/, so even a basename filter can't reach
      // private/ from there.
      expect(isPrivateMemoryAccess("Grep", { path: "tmp", pattern: "x", glob: "*.md" }, ctx)).toBe(false);
    });

    it("allows grep with anchored path-style glob to a non-memory subtree", () => {
      expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "x", glob: "skills/**/*.md" }, ctx)).toBe(false);
    });
  });

  describe("Bash", () => {
    it("denies cd-then-relative-cat (reviewer's case)", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cd memory && cat private/secret.md" }, ctx)).toBe(true);
    });

    it("denies ls without trailing slash (reviewer's case)", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "ls memory/private" }, ctx)).toBe(true);
    });

    it("denies cat with absolute path", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cat /ws/memory/private/x.md" }, ctx)).toBe(true);
    });

    it("denies pipe chains touching private", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "find memory/private -type f | head" }, ctx)).toBe(true);
    });

    it("denies relative paths that resolve into private/", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cat ./memory/private/x.md" }, ctx)).toBe(true);
    });

    it("allows shell ops that don't touch memory/ or 'private' as a segment", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "ls tmp" }, ctx)).toBe(false);
      expect(isPrivateMemoryAccess("Bash", { command: "echo hello" }, ctx)).toBe(false);
      expect(isPrivateMemoryAccess("Bash", { command: "git status" }, ctx)).toBe(false);
    });

    it("denies wildcard expansion targeting private (reviewer's bypass)", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cat memory/pri*/*.md" }, ctx)).toBe(true);
    });

    it("denies any reference to the memory tree, even for public files", () => {
      // New strict rule: groups don't get Bash access to memory/ at all.
      // The agent should use Read on a named public file (MEMORY.md is in its
      // prompt) instead of shelling out.
      expect(isPrivateMemoryAccess("Bash", { command: "cat memory/MEMORY.md" }, ctx)).toBe(true);
      expect(isPrivateMemoryAccess("Bash", { command: "ls memory" }, ctx)).toBe(true);
    });

    it("denies absolute paths into the memory tree", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cd /ws/memory" }, ctx)).toBe(true);
    });

    // The token dequoter stripped `"`, `'` and backticks and left the fourth
    // quoting operator in place. Both commands below were ALLOWED on a barred
    // turn and both really print the file in bash: `\` quotes the one
    // character after it, so the shell opens `memory/private/x.md` while the
    // segment rule was looking at `mem\ory`.
    it("denies backslash-quoted spellings of the memory segment", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cat mem\\ory/priv\\ate/x.md" }, ctx)).toBe(true);
    });

    it("denies a backslash-quoted cd into memory followed by a read", () => {
      expect(isPrivateMemoryAccess("Bash", { command: "cd mem\\ory && cat priv\\ate/x.md" }, ctx)).toBe(true);
    });
  });

  describe("unknown tools", () => {
    it("allows tools that don't read filesystem inputs", () => {
      expect(isPrivateMemoryAccess("WebSearch", { query: "private memory" }, ctx)).toBe(false);
      expect(isPrivateMemoryAccess("TaskCreate", { task: "test" }, ctx)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The hook itself: WHICH turns the predicate above is applied to.
//
// The predicate has always been right; the hook was only ever INSTALLED for
// group sessions (sdk-options.ts `guardPrivateMemory: isGroup`). A summoned
// group runs on the owner's `dm:` session, so `isGroupSessionKey` is false and
// the whole guard was absent for turns a group participant was steering.
// ---------------------------------------------------------------------------

type PreToolUseResult = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
type PreToolUseHook = (input: { tool_name: string; tool_input: unknown }) => Promise<PreToolUseResult>;

function hookFor(bar: () => "group-session" | "summoned-turn" | null): PreToolUseHook {
  const hooks = privateMemoryGuardHooks("dm:shuai", bar) as {
    PreToolUse: Array<{ hooks: PreToolUseHook[] }>;
  };
  return hooks.PreToolUse[0].hooks[0];
}

const PRIVATE_READ = { tool_name: "Read", tool_input: { file_path: "memory/private/secret.md" } };
const PRIVATE_CAT = { tool_name: "Bash", tool_input: { command: "cat memory/private/x" } };
const PRIVATE_GLOB = { tool_name: "Glob", tool_input: { path: "memory/private", pattern: "*.md" } };
const PUBLIC_READ = { tool_name: "Read", tool_input: { file_path: "memory/MEMORY.md" } };
const INNOCUOUS_BASH = { tool_name: "Bash", tool_input: { command: "ls -la /tmp" } };
// THE BYPASS THIS ARM EXISTS FOR. Spells neither `memory` nor `private` in the
// raw text nor in any dequoted token, carries no `$`, no backtick, no glob and
// no brace — every rule in `bashTouchesMemory` passes it, and the shell hands
// node a program that reads the file anyway. `python -c`, `perl -e`,
// `osascript -e` and a script written on an earlier turn are the same shape;
// the list does not end, which is why the TOOL goes rather than the spelling.
const NODE_E_BYPASS = {
  tool_name: "Bash",
  tool_input: {
    command: `node -e 'process.stdout.write(require("node:fs").readFileSync("mem"+"ory/pri"+"vate/note.txt","utf8"))'`,
  },
};

function decision(result: PreToolUseResult): string | undefined {
  return result.hookSpecificOutput?.permissionDecision;
}

describe("privateMemoryGuardHooks", () => {
  it("denies private-memory access on a summoned turn, naming the summon", async () => {
    const hook = hookFor(() => "summoned-turn");

    // Bash is no longer in this list: on a barred turn it is denied outright,
    // with its own reason. See the describe below.
    for (const call of [PRIVATE_READ, PRIVATE_GLOB]) {
      const result = await hook(call);
      expect(decision(result), call.tool_name).toBe("deny");
      expect(result.hookSpecificOutput?.permissionDecisionReason).toBe(PRIVATE_MEMORY_SUMMONED_DENIAL);
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("unavailable during a summoned turn");
    }
  });

  it("allows the owner's own turn through the same hook", async () => {
    const hook = hookFor(() => null);

    for (const call of [PRIVATE_READ, PRIVATE_CAT, PRIVATE_GLOB, PUBLIC_READ, INNOCUOUS_BASH, NODE_E_BYPASS]) {
      expect(await hook(call), call.tool_name).toEqual({});
    }
  });

  it("still denies group sessions, with the group wording (unchanged)", async () => {
    const hook = hookFor(() => "group-session");

    const result = await hook(PRIVATE_READ);
    expect(decision(result)).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBe(PRIVATE_MEMORY_GROUP_DENIAL);
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("not accessible from group sessions");
  });

  it("leaves public memory and non-path tools alone even while barred", async () => {
    const hook = hookFor(() => "summoned-turn");

    expect(await hook(PUBLIC_READ)).toEqual({});
    expect(await hook({ tool_name: "WebSearch", tool_input: { query: "memory/private" } })).toEqual({});
  });

  it("re-reads the bar on every call, so one hook covers a whole session", async () => {
    // The hook is installed once per live session, but a dm: session flips
    // between summoned and own turns for its whole life.
    let bar: "summoned-turn" | null = null;
    const hook = hookFor(() => bar);

    expect(await hook(PRIVATE_READ)).toEqual({});
    bar = "summoned-turn";
    expect(decision(await hook(PRIVATE_READ))).toBe("deny");
    bar = null;
    expect(await hook(PRIVATE_READ)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The shell is withheld WHOLE on a barred turn. `bashTouchesMemory` is a token
// scan over text the model chose, and an interpreter's argument is a program:
// no spelling rule decides what it will read. So the decision moved off the
// command and onto the turn.
// ---------------------------------------------------------------------------

describe("privateMemoryGuardHooks - Bash on a barred turn", () => {
  for (const bar of ["group-session", "summoned-turn"] as const) {
    describe(bar, () => {
      it("denies an innocuous command that names no path at all", async () => {
        const result = await hookFor(() => bar)(INNOCUOUS_BASH);
        expect(decision(result)).toBe("deny");
        expect(result.hookSpecificOutput?.permissionDecisionReason)
          .toBe(privateMemoryBashDenial(bar));
      });

      it("denies the node -e concatenation bypass", async () => {
        const result = await hookFor(() => bar)(NODE_E_BYPASS);
        expect(decision(result)).toBe("deny");
      });

      it("denies every other interpreter shape the token scan cannot see", async () => {
        const hook = hookFor(() => bar);
        for (const command of [
          `python3 -c "print(open(chr(109)+'emory/pri'+'vate/x').read())"`,
          "perl -e 'print <>' ./notes.txt",
          "bash ./helper.sh",
          "./written-on-an-earlier-turn.sh",
          "cat notes.txt",
        ]) {
          expect(decision(await hook({ tool_name: "Bash", tool_input: { command } })), command)
            .toBe("deny");
        }
      });

      it("says why the shell is gone AND why this turn is barred", async () => {
        const reason = (await hookFor(() => bar)(INNOCUOUS_BASH))
          .hookSpecificOutput?.permissionDecisionReason ?? "";
        expect(reason).toContain("The Bash tool is not available on this turn");
        expect(reason).toContain(
          bar === "group-session" ? "not accessible from group sessions" : "summoned turn",
        );
      });
    });
  }

  it("leaves Bash alone on an unbarred turn", async () => {
    const hook = hookFor(() => null);
    for (const call of [INNOCUOUS_BASH, NODE_E_BYPASS, PRIVATE_CAT]) {
      expect(await hook(call), String(call.tool_input.command)).toEqual({});
    }
  });

  it("does not widen the bar to other tools - public Read still passes", async () => {
    expect(await hookFor(() => "group-session")(PUBLIC_READ)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// send_message: a MEDIA: tag is a read the file-path arms never see. The
// channel opens the path and puts its contents in the target chat, so a barred
// turn that cannot Read `memory/private/x` must not be able to attach it.
// ---------------------------------------------------------------------------

describe("isPrivateMemoryAccess - send_message MEDIA paths", () => {
  const call = (message: unknown) =>
    isPrivateMemoryAccess(SEND_MESSAGE_TOOL, { target: "group", message }, ctx);

  it("denies a relative MEDIA path inside private/", () => {
    expect(call('here you go MEDIA:"memory/private/diary.png"')).toBe(true);
  });

  it("denies an absolute MEDIA path inside private/", () => {
    expect(call('MEDIA:"/ws/memory/private/diary.png"')).toBe(true);
  });

  it("denies an unquoted MEDIA path inside private/", () => {
    expect(call("MEDIA:memory/private/diary.png")).toBe(true);
  });

  it("denies when only one of several MEDIA paths is private", () => {
    expect(call('MEDIA:"memory/cat.png"\nMEDIA:"memory/private/diary.png"')).toBe(true);
  });

  it("denies a path that traverses back into the memory tree", () => {
    expect(call('MEDIA:"memory/../memory/private/diary.png"')).toBe(true);
  });

  it("allows a public attachment", () => {
    expect(call('look MEDIA:"memory/cat.png"')).toBe(false);
    expect(call('MEDIA:"/tmp/screenshot.png"')).toBe(false);
  });

  it("allows a message with no MEDIA tag, however it talks about private/", () => {
    expect(call("I can't reach memory/private/ from here")).toBe(false);
  });

  it("ignores a non-string message", () => {
    expect(call(undefined)).toBe(false);
    expect(call(42)).toBe(false);
  });

  it("leaves STICKER ids alone - they name no file", () => {
    expect(call("STICKER:memory/private/x")).toBe(false);
  });

  it("is enforced by the hook, so a barred turn's direct send is refused", async () => {
    const hook = hookFor(() => "group-session");
    const send = (message: string) => ({
      tool_name: SEND_MESSAGE_TOOL,
      tool_input: { target: "telegram:-100", mode: "direct", message },
    });
    expect(decision(await hook(send('MEDIA:"memory/private/diary.png"')))).toBe("deny");
    expect(await hook(send('MEDIA:"memory/cat.png"'))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Path containment: symlinks and `..`, which a lexical prefix check misses.
// ---------------------------------------------------------------------------

describe("isPrivateMemoryAccess — real-path containment", () => {
  const root = mkdtempSync(join(tmpdir(), "tomo-perm-real-"));
  const realCtx = {
    cwd: root,
    memoryDir: join(root, "memory"),
    privateDir: join(root, "memory", "private"),
  };

  beforeAll(() => {
    mkdirSync(realCtx.privateDir, { recursive: true });
    writeFileSync(join(realCtx.privateDir, "secret.md"), "owner-only", "utf-8");
    // A link the agent is allowed to create: nothing in its path spells
    // "private", but it lands there.
    symlinkSync(realCtx.privateDir, join(realCtx.memoryDir, "notes"));
    // ...and one whose TARGET does not exist yet, which realpath cannot see.
    symlinkSync(join(realCtx.privateDir, "planted.md"), join(realCtx.memoryDir, "planted"));
    // A link to the memory tree ITSELF, planted OUTSIDE it. Nothing about it
    // is at-or-inside private/, so the file-op rules have nothing to say —
    // but a recursive search rooted here walks straight into private/.
    symlinkSync(realCtx.memoryDir, join(root, "shortcut"));
    // The control: a link of the same shape that lands nowhere near memory/.
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(root, "detour"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("denies a read through a symlink into private/", () => {
    expect(isPrivateMemoryAccess("Read", { file_path: "memory/notes/secret.md" }, realCtx)).toBe(true);
  });

  it("denies a write through a DANGLING symlink into private/", () => {
    // realpathSync throws ENOENT here — the same error as "no such name" — so
    // a plain parent-walk would report `memory/planted` and allow the write.
    expect(isPrivateMemoryAccess("Write", { file_path: "memory/planted", content: "x" }, realCtx)).toBe(true);
  });

  it("denies a `..` segment anywhere in the memory tree", () => {
    // `..` collapses lexically, before the kernel follows any link, so the two
    // disagree about where `memory/notes/../x` lands. Refused rather than
    // reconciled.
    expect(isPrivateMemoryAccess("Read", { file_path: "memory/notes/../x.md" }, realCtx)).toBe(true);
  });

  it("still allows a plainly-public memory file", () => {
    expect(isPrivateMemoryAccess("Read", { file_path: "memory/MEMORY.md" }, realCtx)).toBe(false);
  });

  it("still allows paths outside the memory tree that use ..", () => {
    expect(isPrivateMemoryAccess("Read", { file_path: "tmp/../scratch.txt" }, realCtx)).toBe(false);
  });

  it("denies a Glob rooted on a symlink into private/", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "memory/notes", pattern: "*.md" }, realCtx)).toBe(true);
  });

  it("denies a Grep rooted on a symlink to the memory tree itself", () => {
    // The root is not at-or-inside private/, so landsInPrivate says nothing;
    // the containment test then ran on the LEXICAL root, for which private/
    // is `../memory/private` — "not reachable" — and ripgrep recursed through
    // the link into the whole private tree.
    expect(isPrivateMemoryAccess("Grep", { path: "shortcut", pattern: "owner-only" }, realCtx)).toBe(true);
    expect(isPrivateMemoryAccess("Grep", { path: "shortcut", pattern: "x", glob: "private/*.md" }, realCtx)).toBe(true);
  });

  it("denies a Glob rooted on a symlink to the memory tree itself", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "shortcut", pattern: "private/*.md" }, realCtx)).toBe(true);
    expect(isPrivateMemoryAccess("Glob", { path: "shortcut", pattern: "pri*/*.md" }, realCtx)).toBe(true);
  });

  it("still allows a search rooted on a symlink that lands outside memory/", () => {
    expect(isPrivateMemoryAccess("Grep", { path: "detour", pattern: "x" }, realCtx)).toBe(false);
    expect(isPrivateMemoryAccess("Glob", { path: "detour", pattern: "private/*.md" }, realCtx)).toBe(false);
  });

  it("denies a send_message attachment reached through a symlink into private/", () => {
    // The whole point of binding the outbound check to `landsInPrivate`: the
    // path the model wrote spells neither `private` nor anything else the
    // guard could pattern-match, and the channel would open `secret.md`.
    expect(isPrivateMemoryAccess(
      SEND_MESSAGE_TOOL,
      { target: "g", message: 'MEDIA:"memory/notes/secret.md"' },
      realCtx,
    )).toBe(true);
  });

  it("still allows a send_message attachment through a link outside memory/", () => {
    expect(isPrivateMemoryAccess(
      SEND_MESSAGE_TOOL,
      { target: "g", message: 'MEDIA:"detour/holiday.png"' },
      realCtx,
    )).toBe(false);
  });

  it("denies a case-permuted read that the filesystem itself resolves", () => {
    // On case-insensitive APFS this path OPENS `secret.md` — and
    // `realpathSync` hands back the caller's spelling rather than the on-disk
    // one, so an exact compare found no containment and allowed the read.
    expect(isPrivateMemoryAccess("Read", { file_path: "memory/PRIVATE/secret.md" }, realCtx)).toBe(true);
    expect(isPrivateMemoryAccess("Read", { file_path: "MEMORY/private/secret.md" }, realCtx)).toBe(true);
  });

  it("denies a case-permuted symlink hop into private/", ({ skip }) => {
    // Only a case-folding filesystem (APFS on macOS) resolves `NOTES` to the
    // `notes` link at all — on a case-sensitive volume (CI's ext4) the name
    // does not exist, the read would ENOENT, and there is nothing to deny.
    // The lexical fold in isInside() is exercised by the PRIVATE/ case above
    // on both; this one needs the kernel's cooperation, so probe for it.
    if (!existsSync(join(realCtx.memoryDir, "PRIVATE"))) skip();
    expect(isPrivateMemoryAccess("Read", { file_path: "memory/NOTES/secret.md" }, realCtx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F6 — case-permuted paths. This is a DENY predicate, so a spelling that fails
// the containment check is ALLOWED. macOS ships APFS case-insensitive and
// `realpathSync` preserves the caller's casing, so an exact compare let
// `memory/PRIVATE/secret.md` through and the read succeeded.
// ---------------------------------------------------------------------------

describe("isPrivateMemoryAccess — case-permuted paths", () => {
  const casings = [
    "memory/PRIVATE/secret.md",
    "MEMORY/private/secret.md",
    "MEMORY/PRIVATE/secret.md",
    "Memory/Private/secret.md",
    "memory/PrIvAtE/secret.md",
    "/ws/memory/PRIVATE/secret.md",
  ];

  for (const p of casings) {
    it(`denies Read of ${p}`, () => {
      expect(isPrivateMemoryAccess("Read", { file_path: p }, ctx)).toBe(true);
    });
  }

  it("denies Write and Edit on case-permuted private paths", () => {
    expect(isPrivateMemoryAccess("Write", { file_path: "memory/PRIVATE/new.md", content: "x" }, ctx)).toBe(true);
    expect(isPrivateMemoryAccess("Edit", { file_path: "MEMORY/Private/x.md", old_string: "a", new_string: "b" }, ctx)).toBe(true);
    expect(isPrivateMemoryAccess("MultiEdit", { file_path: "memory/PRIVATE/x.md" }, ctx)).toBe(true);
    expect(isPrivateMemoryAccess("NotebookEdit", { notebook_path: "MEMORY/PRIVATE/n.ipynb" }, ctx)).toBe(true);
  });

  it("denies a case-permuted Glob root", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "MEMORY/PRIVATE", pattern: "*.md" }, ctx)).toBe(true);
    expect(isPrivateMemoryAccess("Grep", { path: "Memory", pattern: "x" }, ctx)).toBe(true);
  });

  it("still allows a case-permuted path outside the memory tree", () => {
    // Folding must not swallow unrelated paths.
    expect(isPrivateMemoryAccess("Read", { file_path: "TMP/scratch.txt" }, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F7 — the Bash arm. Every probe below was ALLOWED before: none of them spells
// `memory` or `private` as a literal path segment.
// ---------------------------------------------------------------------------

describe("isPrivateMemoryAccess — Bash exfiltration shapes", () => {
  const denied = [
    ["wildcard segments", "cat mem*/priv*/*.md"],
    ["single-char wildcards", "cat memor?/privat?/x.md"],
    // Spelled so that neither name appears literally — otherwise the
    // pre-existing path-segment rule catches it and this probe proves nothing.
    ["character class", "cat m[e]mory/priv[a]te/x.md"],
    ["bare glob", "cat *"],
    ["glob at any depth", "cat */*/*.md"],
    ["find -exec", "find . -name '*.md' -exec cat {} +"],
    ["find -execdir", "find . -type f -execdir head {} ;"],
    ["recursive grep over $HOME", "grep -r pistachio-mousse $HOME"],
    ["recursive grep, long flag", "grep --recursive secret ."],
    ["ripgrep recursive", "rg -r x ."],
    // The flag is usually bundled: `\b` after a lone `r` missed all of these.
    ["recursive grep, -rn", "grep -rn pistachio-mousse ."],
    ["recursive grep, -ri", "grep -ri pistachio-mousse ."],
    ["recursive grep, -rl", "grep -rl pistachio-mousse ."],
    ["recursive grep, -Rn", "grep -Rn pistachio-mousse ."],
    ["recursive grep, r inside a cluster", "grep -inr pistachio-mousse ."],
    ["recursive grep, flags before the pattern flag", "grep --color=never -rn -e pistachio ."],
    ["grep -d recurse", "grep -d recurse pistachio-mousse ."],
    ["grep --directories=recurse", "grep --directories=recurse pistachio-mousse ."],
    // These three recurse from `.` with no flag at all.
    ["bare ripgrep", "rg pistachio-mousse"],
    ["ripgrep with unrelated flags", "rg -n -i pistachio-mousse"],
    ["ripgrep after a pipe", "echo x | rg pistachio-mousse"],
    ["ag", "ag pistachio-mousse"],
    ["ack", "ack pistachio-mousse"],
    // find naming the paths for a reader on the far side of a pipe or a
    // substitution — no -exec, no glob, no literal segment.
    ["find piped to xargs", "find . -type f | xargs cat"],
    ["find -print0 to xargs -0", "find . -type f -print0 | xargs -0 head -50"],
    ["find piped to a read loop", "find . -type f | while read f; do cat \"$f\"; done"],
    ["find in a command substitution", "cat $(find . -type f)"],
    ["find in backticks", "cat `find . -type f`"],
    ["tar piped to base64", "tar czf - . | base64"],
    ["zip of the workspace", "zip -r /tmp/out.zip ."],
    ["base64 alone", "base64 somefile"],
    ["xxd", "xxd somefile"],
    // Brace expansion is not globbing: it fires with no matching file, and
    // neither name is spelled anywhere in the command. Executed by the
    // reviewer against the live guard before the fix.
    ["brace expansion over both names", "cat {m,}emory/{p,}rivate/x.md"],
    ["brace expansion over one name", "cat memory{,}/private/x.md"],
    ["brace alternation naming private", "cat notes/{public,private}/x.md"],
    // The shell writes the word; the hook only ever sees the recipe.
    ["command substitution", "cat $(echo bWVtb3J5 | tr a-z a-z)/x.md"],
    ["backtick substitution", "cat `printf notes`/x.md"],
    ["parameter expansion assembled from pieces", "d=notes e=stuff; cat $d/$e/x.md"],
    ["braced parameter expansion", "cat ${d}/x.md"],
    // Adjacent quoted runs: one word to the shell, two quoted fragments to a
    // regex reading the raw command, so neither name sat at a word border.
    ["adjacent-quote concatenation", 'cat "mem""ory"/x.md'],
    ["quote split inside a name", "cat me''mory/x.md"],
  ] as const;

  for (const [label, cmd] of denied) {
    it(`denies ${label}: ${cmd}`, () => {
      expect(isPrivateMemoryAccess("Bash", { command: cmd }, ctx)).toBe(true);
    });
  }

  it("still allows ordinary shell work with no glob and no bulk-read verb", () => {
    for (const cmd of ["ls tmp", "echo hello", "git status", "node --version", "cat skills/readme.md"]) {
      expect(isPrivateMemoryAccess("Bash", { command: cmd }, ctx), cmd).toBe(false);
    }
  });

  it("allows a glob whose literal prefix cannot reach memory/ or private/", () => {
    // "sk" is a prefix of neither name, so this is not over-matched.
    expect(isPrivateMemoryAccess("Bash", { command: "ls sk*/x" }, ctx)).toBe(false);
    expect(isPrivateMemoryAccess("Bash", { command: "cat skills/tool?.md" }, ctx)).toBe(false);
  });

  it("allows non-recursive grep", () => {
    for (const cmd of [
      "grep needle notes.txt",
      "grep -n needle notes.txt",
      "grep -c r notes.txt",
      "grep -E 'r+' notes.txt",
      "grep --color=never -i needle notes.txt",
    ]) {
      expect(isPrivateMemoryAccess("Bash", { command: cmd }, ctx), cmd).toBe(false);
    }
  });

  it("allows a find that only prints, and words that merely contain rg/ag", () => {
    for (const cmd of ["find . -type f -name README", "echo storage", "git log --author=Meg"]) {
      expect(isPrivateMemoryAccess("Bash", { command: cmd }, ctx), cmd).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// F8 — Glob/Grep patterns were only ever probed root-RELATIVE, so a pattern
// that anchors itself (absolute) or steers upward (`..`) was never compared
// against private/ at all.
// ---------------------------------------------------------------------------

describe("isPrivateMemoryAccess — self-anchoring Glob/Grep patterns", () => {
  it("denies an absolute pattern from a root that cannot reach private/", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "/tmp", pattern: "/ws/memory/private/*.md" }, ctx)).toBe(true);
  });

  it("denies an absolute pattern naming the private dir itself", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "/tmp", pattern: "/ws/memory/private/**" }, ctx)).toBe(true);
  });

  it("denies an upward-steering pattern under a memory-reachable root", () => {
    expect(isPrivateMemoryAccess("Glob", { path: ".", pattern: "../ws/memory/private/*.md" }, ctx)).toBe(true);
  });

  it("denies an absolute Grep glob filter", () => {
    expect(isPrivateMemoryAccess("Grep", { path: "/tmp", pattern: "secret", glob: "/ws/memory/private/*.md" }, ctx)).toBe(true);
  });

  it("denies an upward-steering Grep glob filter", () => {
    expect(isPrivateMemoryAccess("Grep", { path: ".", pattern: "secret", glob: "../ws/memory/private/*.md" }, ctx)).toBe(true);
  });

  it("still allows an absolute pattern that lands outside the memory tree", () => {
    expect(isPrivateMemoryAccess("Glob", { path: "/tmp", pattern: "/etc/hosts" }, ctx)).toBe(false);
    expect(isPrivateMemoryAccess("Glob", { path: "/tmp", pattern: "/ws/skills/*.md" }, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The `.claude/skills/` re-allow. This one is an ALLOW predicate, so the
// failure mode is the mirror image of the guard above: a string test that
// over-matches hands back the very paths the SDK protected.
// ---------------------------------------------------------------------------

describe("skillsCanUseTool", () => {
  const allow = async (toolName: string, input: Record<string, unknown>) =>
    (await skillsCanUseTool(toolName, input)).behavior;

  it("allows a write inside the skills dir", async () => {
    expect(await allow("Write", { file_path: "/ws/.claude/skills/tomo-x/SKILL.md", content: "x" })).toBe("allow");
    expect(await allow("Read", { file_path: "/ws/.claude/skills/tomo-x/refs/a.md" })).toBe("allow");
  });

  it("denies a path that only STARTS with the skills prefix", async () => {
    // `startsWith` said yes; the path lands in `.claude/`, which is exactly
    // what the SDK routed here to protect.
    expect(await allow("Write", { file_path: "/ws/.claude/skills/../settings.local.json", content: "x" }))
      .toBe("deny");
    expect(await allow("Edit", { file_path: "/ws/.claude/skills/a/../../settings.json", old_string: "a", new_string: "b" }))
      .toBe("deny");
  });

  it("denies protected paths outside the carve-out", async () => {
    expect(await allow("Write", { file_path: "/ws/.claude/settings.local.json", content: "x" })).toBe("deny");
    expect(await allow("Write", { file_path: "/ws/.git/config", content: "x" })).toBe("deny");
  });

  it("allows Bash housekeeping whose only named path is inside skills", async () => {
    expect(await allow("Bash", { command: "mkdir -p /ws/.claude/skills/tomo-x" })).toBe("allow");
    expect(await allow("Bash", { command: "rm -rf /ws/.claude/skills/tomo-x" })).toBe("allow");
  });

  it("denies a Bash command that merely MENTIONS the skills dir", async () => {
    // `includes(SKILLS_DIR)` approved the whole command on the strength of the
    // trailing comment.
    expect(await allow("Bash", { command: "rm -rf /ws/.claude/settings.local.json # /ws/.claude/skills/" }))
      .toBe("deny");
    expect(await allow("Bash", { command: "echo /ws/.claude/skills/ && cat /ws/.git/config" })).toBe("deny");
    expect(await allow("Bash", { command: "cp /ws/.claude/skills/a.md /ws/.claude/agents/a.md" })).toBe("deny");
  });

  it("denies a Bash command that names no skills path at all", async () => {
    expect(await allow("Bash", { command: "ls /tmp" })).toBe("deny");
  });

  it("denies a Bash command that moves the working directory", async () => {
    // Every relative token here is resolved against the WORKSPACE, so the
    // `cd` was invisible: `../settings.local.json` read as `/settings.local.json`,
    // which is in no protected tree, and the command was ALLOWED. Run for real
    // it deletes `/ws/.claude/settings.local.json`.
    expect(await allow("Bash", { command: "cd /ws/.claude/skills && rm -rf ../settings.local.json" }))
      .toBe("deny");
    expect(await allow("Bash", { command: "cd /ws/.claude/skills && rm -rf tomo-x" })).toBe("deny");
  });

  it("denies a Bash token with a .. segment", async () => {
    expect(await allow("Bash", { command: "rm -rf /ws/.claude/skills/../agents" })).toBe("deny");
    expect(await allow("Bash", { command: "cp /ws/.claude/skills/a.md ../a.md" })).toBe("deny");
    // `..` as a SEGMENT, not as a substring — an ordinary name that merely
    // contains dots is still housekeeping.
    expect(await allow("Bash", { command: "touch /ws/.claude/skills/a..b.md" })).toBe("allow");
  });

  it("denies a --flag=path whose value leaves the skills dir", async () => {
    // The whole word starts with `-`, so it was skipped as a flag and the
    // command was ALLOWED on the strength of its source path alone.
    expect(await allow("Bash", { command: "tar -xf /ws/.claude/skills/x.tar --directory=/ws/.claude" }))
      .toBe("deny");
    expect(await allow("Bash", { command: "cp /ws/.claude/skills/a.md --target-directory=/ws/.claude/agents" }))
      .toBe("deny");
    expect(await allow("Bash", { command: "tar -xf /ws/.claude/skills/x.tar --directory=../.claude" }))
      .toBe("deny");
    // A flag with no `=` still names no path.
    expect(await allow("Bash", { command: "cp -r /ws/.claude/skills/a /ws/.claude/skills/b" })).toBe("allow");
  });

  it("denies the two-token flag form that escapes the skills dir", async () => {
    expect(await allow("Bash", { command: "tar -xf /ws/.claude/skills/x.tar -C ../.claude" })).toBe("deny");
    expect(await allow("Bash", { command: "tar -xf /ws/.claude/skills/x.tar -C /ws/.claude" })).toBe("deny");
    expect(await allow("Bash", { command: "tar -xf /ws/.claude/skills/x.tar -C /ws/.claude/skills/out" }))
      .toBe("allow");
  });

  it("denies a Bash command whose target the shell would construct", async () => {
    expect(await allow("Bash", { command: "cp /ws/.claude/skills/a.md $DEST" })).toBe("deny");
    expect(await allow("Bash", { command: "cp /ws/.claude/skills/a.md ~/.claude/settings.json" })).toBe("deny");
  });

  it("names the auto-approved prefix in the denial", async () => {
    const result = await skillsCanUseTool("Write", { file_path: "/ws/.claude/settings.json", content: "x" });
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") expect(result.message).toContain("/ws/.claude/skills/");
  });
});


// ---------------------------------------------------------------------------
// Per-agent permission scoping (config `agentProfiles`).
//
// The hole: every session runs `permissionMode: "bypassPermissions"` and the
// SDK propagates that into subagents, so `ios-reviewer` — declared read-only,
// with `tools: Read, Grep, Glob, Bash` — has a full shell on the owner's
// machine. `AgentDefinition` scopes tools and has no notion of a path.
//
// The two deny lists are NOT the same rule and the tests below are organised
// around the difference: `denyPaths` fences WRITES (a reviewer must read the
// repos it may not touch), `denyReadPaths` fences MENTIONS (secrets).
// ---------------------------------------------------------------------------

type AgentPreToolUseInput = {
  tool_name: string;
  tool_input: unknown;
  agent_id?: string;
  agent_type?: string;
};
type AgentPreToolUseHook = (input: AgentPreToolUseInput) => Promise<PreToolUseResult>;
type Profile = Parameters<typeof agentProfileDenial>[0];

function agentHookFor(profiles: Record<string, Profile>): AgentPreToolUseHook {
  const hooks = agentProfileGuardHooks("dm:shuai", (type) => profiles[type]) as {
    PreToolUse: Array<{ hooks: AgentPreToolUseHook[] }>;
  };
  return hooks.PreToolUse[0].hooks[0];
}

/** A real tree, because containment here has to survive `/var` -> `/private/var`
 *  (every `mkdtemp` path on macOS is behind that symlink) and a link planted
 *  inside a writeRoot that points at a deny list. */
const agentRoot = mkdtempSync(join(tmpdir(), "tomo-agent-prof-"));
const worktree = join(agentRoot, "wt");
const vault = join(agentRoot, "vault");
const sharedCheckout = join(agentRoot, "bloom");
/**
 * The profile's second writeRoot, and it lives INSIDE the fixture on purpose.
 *
 * It used to be the literal `/tmp`, and that quietly coupled every writeRoot
 * assertion to where the host puts `os.tmpdir()`. On macOS that is
 * `/var/folders/…/T`, comfortably outside `/tmp`; on Linux it IS `/tmp`, so
 * the whole fixture — `wt`, `vault`, `bloom`, and the case-variant path the
 * one failing test builds — sat inside a writeRoot and was allowed on a rule
 * nobody wrote. Nothing about the guard was wrong; the fixture was describing
 * a different machine than the one it ran on. A scratch dir under the fixture
 * root is inside exactly one writeRoot on every platform: this one.
 *
 * `/tmp` is still exercised, once, by the rootSpellings test below — which is
 * where that spelling actually matters.
 */
const scratch = join(agentRoot, "scratch");

beforeAll(() => {
  mkdirSync(worktree, { recursive: true });
  mkdirSync(vault, { recursive: true });
  mkdirSync(sharedCheckout, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  // The escape a lexical prefix check misses: nothing in `wt/out` spells
  // `vault`, and writing through it lands in a fenced tree.
  if (!existsSync(join(worktree, "out"))) symlinkSync(vault, join(worktree, "out"));
});

afterAll(() => {
  rmSync(agentRoot, { recursive: true, force: true });
});

const REVIEWER: Profile = {
  writeRoots: [worktree, scratch],
  denyPaths: [
    "/Applications", sharedCheckout, "/ws/memory", "/ws/.claude",
    join(homedir(), "Library", "LaunchAgents"),
  ],
  denyReadPaths: [vault, join(homedir(), ".ssh")],
  bash: "readonly",
};
const IMPLEMENTER: Profile = { ...REVIEWER, bash: "worktree" };
const FULL: Profile = { ...REVIEWER, bash: "full" };

describe("agentProfileGuardHooks — who the guard applies to", () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
  });

  it("leaves the MAIN THREAD alone — no agent_id, no opinion", async () => {
    const hook = agentHookFor({ "ios-reviewer": REVIEWER });
    // The same call is denied for the subagent two tests down.
    expect(await hook({ tool_name: "Write", tool_input: { file_path: "/Applications/x", content: "x" } }))
      .toEqual({});
    expect(await hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } })).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("leaves an UNREGISTERED agent type alone (fail-open) and warns once per type", async () => {
    const hook = agentHookFor({ "ios-reviewer": REVIEWER });
    const call = (tool_name: string, tool_input: unknown): AgentPreToolUseInput =>
      ({ tool_name, tool_input, agent_id: "sub-1", agent_type: "general-purpose" });

    expect(await hook(call("Write", { file_path: "/Applications/x", content: "x" }))).toEqual({});
    expect(await hook(call("Bash", { command: "rm -rf /Applications/x" }))).toEqual({});

    // Once per (session, agent_type) — the Set lives in the per-session closure.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0][0]).toMatchObject({
      key: "dm:shuai",
      agentType: "general-purpose",
      tool: "Write",
    });

    // ...but a DIFFERENT unprofiled type gets its own warning: the point of
    // fail-open is measuring the surface, not muting it.
    await hook({ tool_name: "Read", tool_input: { file_path: "/x" }, agent_id: "sub-2", agent_type: "Explore" });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("logs EVERY subagent Bash call at info, profiled or not, clipped to 120 chars", async () => {
    const hook = agentHookFor({ "ios-reviewer": REVIEWER });
    const long = `echo ${"a".repeat(400)}`;

    await hook({ tool_name: "Bash", tool_input: { command: long }, agent_id: "s", agent_type: "general-purpose" });
    await hook({ tool_name: "Bash", tool_input: { command: "git status" }, agent_id: "s", agent_type: "ios-reviewer" });

    expect(log.info).toHaveBeenCalledTimes(2);
    const first = vi.mocked(log.info).mock.calls[0][0] as { agentType: string; command: string };
    expect(first.agentType).toBe("general-purpose");
    expect(first.command).toHaveLength(120);
    expect((vi.mocked(log.info).mock.calls[1][0] as { command: string }).command).toBe("git status");
  });

  it("denies a profiled agent through the hook, naming the agent type", async () => {
    const hook = agentHookFor({ "ios-reviewer": REVIEWER });
    const result = await hook({
      tool_name: "Write",
      tool_input: { file_path: "/Applications/x", content: "x" },
      agent_id: "sub-1",
      agent_type: "ios-reviewer",
    });
    expect(decision(result)).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("ios-reviewer");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("denyPaths");
  });
});

describe("agentProfileDenial — denyPaths fence WRITES, not reads", () => {
  const bash = (cmd: string, profile = REVIEWER) =>
    agentProfileDenial(profile, "Bash", { command: cmd }, "/ws");

  it("lets a reviewer READ the checkout it may never write", () => {
    // This is the whole point of splitting the two lists: reviewing bloom is
    // the reviewer's job, and bloom is on its denyPaths.
    expect(bash(`cat ${join(sharedCheckout, "App.swift")}`)).toBeNull();
    expect(bash(`git -C ${sharedCheckout} log --oneline -20`)).toBeNull();
    expect(bash(`git -C ${sharedCheckout} diff main...HEAD`)).toBeNull();
    expect(bash(`git -C ${sharedCheckout} worktree list`)).toBeNull();
    expect(bash(`cd ${sharedCheckout} && git log`)).toBeNull();
    expect(agentProfileDenial(REVIEWER, "Read", { file_path: join(sharedCheckout, "App.swift") }, "/ws"))
      .toBeNull();
    expect(agentProfileDenial(REVIEWER, "Grep", { pattern: "x", path: sharedCheckout }, "/ws")).toBeNull();
  });

  it("still refuses to WRITE there, by tool or by verb", () => {
    expect(agentProfileDenial(FULL, "Write", { file_path: join(sharedCheckout, "App.swift") }, "/ws"))
      .toContain("denyPaths");
    expect(bash(`rm -rf ${sharedCheckout}`, FULL)).toContain("denyPaths");
    expect(bash(`git -C ${sharedCheckout} commit -m wip`, FULL)).toContain("denyPaths");
    expect(bash(`echo x > ${join(sharedCheckout, "App.swift")}`, FULL)).toContain("denyPaths");
  });

  it("denies a destructive verb aimed at an ANCESTOR of a denyPath", () => {
    // `rm -rf <parent>` is not "inside" the denyPath and takes it anyway.
    expect(bash(`rm -rf ${agentRoot}`, FULL)).toContain("denyPaths");
    // A read of the same ancestor is untouched.
    expect(bash(`ls ${agentRoot}`, FULL)).toBeNull();
  });
});

describe("agentProfileDenial — denyReadPaths fence every mention", () => {
  const bash = (cmd: string, profile = REVIEWER) =>
    agentProfileDenial(profile, "Bash", { command: cmd }, "/ws");

  it("refuses a read, in every mode including full", () => {
    for (const profile of [REVIEWER, IMPLEMENTER, FULL]) {
      expect(bash("cat ~/.ssh/id_rsa", profile)).toContain("denyReadPaths");
      expect(bash(`cat ${join(homedir(), ".ssh", "id_rsa")}`, profile)).toContain("denyReadPaths");
    }
  });

  it("refuses Read, Grep and Glob too — not just Bash", () => {
    expect(agentProfileDenial(REVIEWER, "Read", { file_path: join(vault, "secret") }, "/ws"))
      .toContain("denyReadPaths");
    expect(agentProfileDenial(REVIEWER, "Grep", { pattern: "key", path: vault }, "/ws"))
      .toContain("denyReadPaths");
    expect(agentProfileDenial(REVIEWER, "Glob", { pattern: "*", path: vault }, "/ws"))
      .toContain("denyReadPaths");
  });

  it("follows a symlink out of a writeRoot into the secrets tree", () => {
    // `wt/out` is inside a writeRoot and spells nothing about the vault.
    expect(agentProfileDenial(REVIEWER, "Read", { file_path: join(worktree, "out", "secret") }, "/ws"))
      .toContain("denyReadPaths");
  });

  it("is silent when the profile lists none", () => {
    const open: Profile = { ...FULL, denyReadPaths: [] };
    expect(bash("cat ~/.ssh/id_rsa", open)).toBeNull();
  });
});

describe("agentProfileDenial — write tools", () => {
  const denied = (p: string, profile = REVIEWER, tool = "Write") =>
    agentProfileDenial(profile, tool, tool === "NotebookEdit" ? { notebook_path: p } : { file_path: p }, "/ws");

  it("denies a write to /Applications", () => {
    expect(denied("/Applications/Foo.app/x")).toContain("denyPaths");
  });

  it("allows a write inside the agent's own worktree root", () => {
    expect(denied(join(worktree, "Sources", "New.swift"))).toBeNull();
  });

  it("denies a write outside every writeRoot, naming the roots", () => {
    const reason = denied("/etc/hosts");
    expect(reason).toContain("outside this agent's writeRoots");
    expect(reason).toContain(worktree);
  });

  it("lets a denyPath BEAT a writeRoot it sits inside", () => {
    const nested: Profile = { writeRoots: [agentRoot], denyPaths: [vault], denyReadPaths: [], bash: "none" };
    expect(agentProfileDenial(nested, "Write", { file_path: join(agentRoot, "ok.txt") }, "/ws")).toBeNull();
    expect(agentProfileDenial(nested, "Write", { file_path: join(vault, "secret.txt") }, "/ws"))
      .toContain("denyPaths");
  });

  it("applies to Edit, MultiEdit and NotebookEdit too", () => {
    expect(denied("/Applications/x", REVIEWER, "Edit")).toContain("denyPaths");
    expect(denied("/Applications/x", REVIEWER, "MultiEdit")).toContain("denyPaths");
    expect(denied("/Applications/x.ipynb", REVIEWER, "NotebookEdit")).toContain("denyPaths");
  });

  it("denies everywhere when the profile has no writeRoots at all", () => {
    const nowhere: Profile = { writeRoots: [], denyPaths: [], denyReadPaths: [], bash: "none" };
    expect(agentProfileDenial(nowhere, "Write", { file_path: join(worktree, "x") }, "/ws"))
      .toContain("no writeRoots");
  });

  it("bash: full switches writeRoots off for the FILE TOOLS too", () => {
    // A profile that says "run anything anywhere except these paths" and then
    // refuses its Write calls is incoherent.
    expect(agentProfileDenial(FULL, "Write", { file_path: "/etc/hosts" }, "/ws")).toBeNull();
    expect(agentProfileDenial(FULL, "Edit", { file_path: "/etc/hosts" }, "/ws")).toBeNull();
    // ...but the deny lists still bind.
    expect(agentProfileDenial(FULL, "Write", { file_path: "/Applications/x" }, "/ws")).toContain("denyPaths");
  });

  it("holds a CASE-VARIANT writeRoot to the writeRoots rule, on EITHER filesystem", () => {
    // landsInWriteRoot is an ALLOW predicate and must use the case-SENSITIVE
    // isInsideExact. The assertion is the same on both kinds of volume, and it
    // is worth spelling out WHY, because the two reasons are different:
    //
    //  - case-SENSITIVE (Linux CI, a case-sensitive APFS image): `<root>/WT` is
    //    a genuinely different directory that the profile never granted, so
    //    allowing it would be a straightforward hole.
    //  - case-INSENSITIVE (stock macOS): the write really would land in `wt`,
    //    and it is refused anyway — the conservative fold an allow predicate
    //    owes, and the reason isInsideExact exists next to isInside.
    //
    // The control below is what keeps this honest: the exact spelling must be
    // ALLOWED, so a `null` here can never be "the fixture drifted outside the
    // rule" — which is exactly the way this test failed on CI.
    expect(denied(join(worktree, "New.swift"))).toBeNull();
    expect(denied(join(agentRoot, "WT", "New.swift"))).toContain("outside this agent's writeRoots");
  });

  it("keeps the fixture out of any writeRoot it did not mean to be in", () => {
    // The r3 CI failure in one assertion. `os.tmpdir()` is `/var/folders/…/T`
    // on macOS and `/tmp` on Linux; with `/tmp` in the profile's writeRoots,
    // the whole fixture sat inside one on Linux and several tests passed —
    // and one failed — for a reason that had nothing to do with what they
    // assert. Anything under the fixture root must be governed by `worktree`
    // and `scratch` alone.
    expect(denied(join(agentRoot, "stray.txt"))).toContain("outside this agent's writeRoots");
    expect(denied(join(worktree, "ok.txt"))).toBeNull();
    expect(denied(join(scratch, "ok.txt"))).toBeNull();
  });

  it("matches a writeRoot through a SYMLINKED prefix (/tmp -> /private/tmp)", () => {
    // The coverage the fixture change would otherwise have dropped, kept where
    // it belongs: `/tmp` is a symlink to `/private/tmp` on macOS, so a root
    // spelled one way and a path resolved the other must still match. On Linux
    // the two spellings coincide and this degrades to a plain containment
    // check, which is the right no-op.
    const tmpProfile: Profile = { ...REVIEWER, writeRoots: ["/tmp"], bash: "readonly" };
    const realTmp = realpathSync("/tmp");
    expect(agentProfileDenial(tmpProfile, "Write", { file_path: "/tmp/x" }, "/ws")).toBeNull();
    expect(agentProfileDenial(tmpProfile, "Write", { file_path: join(realTmp, "x") }, "/ws")).toBeNull();
    expect(agentProfileDenial(tmpProfile, "Write", { file_path: "/etc/x" }, "/ws"))
      .toContain("outside this agent's writeRoots");
  });

  it("has nothing to say about Read or Grep outside the secrets list", () => {
    expect(agentProfileDenial(REVIEWER, "Read", { file_path: "/Applications/x" }, "/ws")).toBeNull();
    expect(agentProfileDenial(REVIEWER, "Grep", { pattern: "x", path: "/Applications" }, "/ws")).toBeNull();
  });
});

describe("agentProfileDenial — Bash by mode", () => {
  const bash = (cmd: string, profile: Profile) =>
    agentProfileDenial(profile, "Bash", { command: cmd }, "/ws");

  it("bash: none denies every command", () => {
    const none: Profile = { ...REVIEWER, bash: "none" };
    expect(bash("ls", none)).toContain("not available");
    expect(bash("echo hi", none)).toContain("not available");
  });

  describe("readonly", () => {
    it("ALLOWS command substitution — a reviewer lives on it", () => {
      // The v1 call: refuse by VERB, not by substitution. Denying `$(…)` would
      // deny `git log $(git merge-base main HEAD)`, i.e. deny the reviewer.
      expect(bash("git log $(git merge-base main HEAD)", REVIEWER)).toBeNull();
      expect(bash("xcodebuild test | grep -c error", REVIEWER)).toBeNull();
      expect(bash("git diff --stat `git merge-base main HEAD`", REVIEWER)).toBeNull();
    });

    it("denies write VERBS", () => {
      expect(bash("rm -rf x", REVIEWER)).toContain("`rm` writes");
      expect(bash("mv a b", REVIEWER)).toContain("writes");
      expect(bash("echo x | tee /etc/hosts", REVIEWER)).toContain("writes");
      expect(bash("brew install foo", REVIEWER)).toContain("writes");
      expect(bash("wget https://example.com/x.tar", REVIEWER)).toContain("writes");
      expect(bash("shred -u secrets.txt", REVIEWER)).toContain("writes");
    });

    it("denies the verbs the first pass missed", () => {
      expect(bash("find . -name '*.o' -delete", REVIEWER)).toContain("find -delete");
      expect(bash("sed -i '' 's/a/b/' File.swift", REVIEWER)).toContain("sed -i");
      expect(bash("sed -i.bak 's/a/b/' File.swift", REVIEWER)).toContain("sed -i");
      expect(bash("perl -i -pe 's/a/b/' File.swift", REVIEWER)).toContain("perl -i");
      expect(bash(`git worktree remove ${join(sharedCheckout, "wt")}`, REVIEWER))
        .toContain("denyPaths");
      expect(bash("git worktree prune", REVIEWER)).toContain("git worktree prune");
      expect(bash("rsync -a src/ dst/ --delete", REVIEWER)).toContain("rsync --delete");
      expect(bash("curl -sSL -o out.tar https://example.com/x", REVIEWER)).toContain("curl -o");
      expect(bash("curl -O https://example.com/x", REVIEWER)).toContain("curl -o");
      expect(bash("gh pr merge 12", REVIEWER)).toContain("gh pr merge");
      expect(bash("gh pr close 12", REVIEWER)).toContain("gh pr close");
      expect(bash("git apply /etc/p.patch", REVIEWER)).toContain("git apply");
      expect(bash("git config --global user.name x", REVIEWER)).toContain("git config --global");
      expect(bash("unlink /etc/x", REVIEWER)).toContain("writes");
      expect(bash("ditto a b", REVIEWER)).toContain("writes");
      expect(bash("xattr -d com.apple.quarantine App", REVIEWER)).toContain("xattr -d");
      expect(bash("chflags nouchg File", REVIEWER)).toContain("writes");
      expect(bash("swift package reset", REVIEWER)).toContain("swift package reset");
      expect(bash("xcodebuild clean test", REVIEWER)).toContain("xcodebuild clean");
    });

    it("ALLOWS killing a hung simulator — a signal is not a write", () => {
      // kill/killall/pkill were on the first version of this list and had no
      // business there: clearing a wedged simulator is routine reviewer work.
      expect(bash("killall Simulator", REVIEWER)).toBeNull();
      expect(bash("pkill -f xcodebuild", REVIEWER)).toBeNull();
      expect(bash("kill -9 4242", REVIEWER)).toBeNull();
    });

    it("denies write SUBCOMMANDS without needing them adjacent to the head", () => {
      expect(bash("git push origin HEAD", REVIEWER)).toContain("git push");
      expect(bash("git -C /repo commit -m wip", REVIEWER)).toContain("git commit");
      expect(bash("npm publish", REVIEWER)).toContain("writes");
      expect(bash("xcrun simctl erase all", REVIEWER)).toContain("simctl erase");
      expect(bash("defaults write com.apple.finder X 1", REVIEWER)).toContain("defaults write");
    });

    it("allows read-only git, gh, config and xcodebuild", () => {
      expect(bash("git log --oneline -20", REVIEWER)).toBeNull();
      expect(bash("git diff main...HEAD", REVIEWER)).toBeNull();
      expect(bash("git worktree list", REVIEWER)).toBeNull();
      expect(bash("git config user.name", REVIEWER)).toBeNull();
      expect(bash("gh pr view 12", REVIEWER)).toBeNull();
      expect(bash("gh pr diff 12", REVIEWER)).toBeNull();
      expect(bash("xcodebuild -derivedDataPath /tmp/foo-dd test", REVIEWER)).toBeNull();
      expect(bash("curl -sSL https://example.com/x", REVIEWER)).toBeNull();
    });

    it("lets a write verb write where the writeRoots say it may", () => {
      // The r2 contradiction: `Write /tmp/ok` and `echo hi > /tmp/ok` were
      // allowed while these four were refused — the same write, to the same
      // granted directory, decided differently per surface. And the refusal
      // was not even a bar: `cat a > b` walked round it.
      expect(bash(`touch ${join(scratch, "marker")}`, REVIEWER)).toBeNull();
      expect(bash(`mkdir -p ${join(scratch, "rev-dd")}`, REVIEWER)).toBeNull();
      expect(bash(`cp ${join(scratch, "a")} ${join(scratch, "b")}`, REVIEWER)).toBeNull();
      expect(bash(`rm -rf ${join(scratch, "rev-1")}`, REVIEWER)).toBeNull();
      expect(agentProfileDenial(REVIEWER, "Write", { file_path: join(scratch, "ok") }, "/ws")).toBeNull();
      expect(bash(`echo hi > ${join(scratch, "ok")}`, REVIEWER)).toBeNull();
    });

    it("still refuses a write that names no destination it can locate", () => {
      // This is the ONE clause that separates readonly from worktree: a
      // readonly agent may write only where it can name the place out loud.
      expect(bash("rm -rf x", REVIEWER)).toContain("has to name an absolute path");
      expect(bash("rm -rf *", REVIEWER)).toBeTruthy();
      expect(bash("mkdir build", REVIEWER)).toContain("has to name an absolute path");
      // ...and the same command IS allowed for the worktree-mode agent.
      expect(bash("rm -rf build/Old", IMPLEMENTER)).toBeNull();
    });

    it("still refuses a write outside the writeRoots or onto a denyPath", () => {
      expect(bash(`cp ${join(scratch, "a")} ${join(sharedCheckout, "b")}`, REVIEWER)).toContain("denyPaths");
      expect(bash(`rm -rf ${join(homedir(), "Library", "LaunchAgents", "x.plist")}`, REVIEWER))
        .toContain("denyPaths");
      expect(bash(`cp ${join(scratch, "a")} /etc/hosts`, REVIEWER)).toContain("outside this agent's writeRoots");
      expect(bash("touch /etc/marker", REVIEWER)).toContain("outside this agent's writeRoots");
    });

    it("allows a redirection INTO a writeRoot and denies one outside it", () => {
      expect(bash(`echo hi > ${join(scratch, "x")}`, REVIEWER)).toBeNull();
      const noScratch: Profile = { ...REVIEWER, writeRoots: [worktree] };
      expect(bash(`echo hi > ${join(scratch, "x")}`, noScratch)).toContain("redirection target");
      expect(bash("echo hi >> /etc/hosts", REVIEWER)).toContain("redirection target");
      expect(bash(`xcodebuild test > ${join(worktree, "log.txt")}`, REVIEWER)).toBeNull();
    });

    it("does not read a `>` inside quotes as a redirection", () => {
      // `awk '$1 > 5' f` and `echo 'a > b'` are the whole reason for the
      // quote mask; without it the first "redirects to 5" and the second
      // "redirects to b".
      expect(bash("awk '$1 > 5' f", REVIEWER)).toBeNull();
      expect(bash("echo 'a > b'", REVIEWER)).toBeNull();
      expect(bash('grep "a > b" f', REVIEWER)).toBeNull();
      // The one that only the MASK can save: an absolute path inside the
      // quotes is path-shaped and outside the writeRoots, so without the mask
      // this is a redirection onto /etc and gets refused.
      expect(bash('grep "write > /etc/passwd" Notes.md', REVIEWER)).toBeNull();
      // A numeric target is not a filename even unquoted.
      expect(bash("cmd 2>3", REVIEWER)).toBeNull();
    });

    it("still judges a QUOTED redirection target — the mask blanks operators, not paths", () => {
      // Deleting the whole quoted run would have lost this target entirely,
      // which is why only the operator characters inside quotes are blanked.
      expect(bash(`echo hi > "${join(scratch, "out.log")}"`, REVIEWER)).toBeNull();
      const noScratch: Profile = { ...REVIEWER, writeRoots: [worktree] };
      expect(bash(`echo hi > "${join(scratch, "out.log")}"`, noScratch)).toContain("redirection target");
    });

    it("leaves /dev/null and fd duplication alone", () => {
      expect(bash("xcodebuild test 2>&1 > /dev/null", REVIEWER)).toBeNull();
      expect(bash("swift build 2> /dev/null", REVIEWER)).toBeNull();
    });

    it("does not judge a RELATIVE redirection target — the cwd is unknowable", () => {
      expect(bash("xcodebuild test > build.log", REVIEWER)).toBeNull();
    });
  });

  describe("worktree", () => {
    it("gives an agent a normal shell inside its own worktree", () => {
      // Every one of these is a relative token, and the daemon is not told
      // where the subagent's worktree is. Judging them would make the mode
      // unusable; see limit 1 in the module header.
      expect(bash("mkdir -p Sources/New", IMPLEMENTER)).toBeNull();
      expect(bash("rm -rf build/Old", IMPLEMENTER)).toBeNull();
      expect(bash("git commit -m msg", IMPLEMENTER)).toBeNull();
      expect(bash("git commit -m 'refactor the memory layer'", IMPLEMENTER)).toBeNull();
      expect(bash("npm install", IMPLEMENTER)).toBeNull();
      expect(bash(`mkdir -p ${join(worktree, "Sources")}`, IMPLEMENTER)).toBeNull();
    });

    it("catches the accident that hits the WORKSPACE it inherited its cwd from", () => {
      // A relative write target is resolved against the workspace for the deny
      // check only. `/ws/memory` and `/ws/.claude` are on the denyPaths.
      expect(bash("rm -rf memory", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("rm -rf memory/private", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("rm -rf .claude", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("echo x > memory/MEMORY.md", IMPLEMENTER)).toContain("denyPaths");
    });

    it("catches the shapes that name no path at all", () => {
      // `*`, `.` and `git clean -fdx` destroy the cwd while naming nothing.
      expect(bash("rm -rf *", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("rm -rf .", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("rm -rf ./", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("git clean -fdx", IMPLEMENTER)).toContain("denyPaths");
    });

    it("refuses `git reset --hard`, the twin of `git clean -fdx`", () => {
      // Both discard the tree under the cwd while naming neither a path nor a
      // `*`; for a subagent that never moved, that cwd is the workspace.
      expect(bash("git reset --hard", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("git reset --hard HEAD~1", IMPLEMENTER)).toContain("denyPaths");
      expect(bash("git reset --merge", IMPLEMENTER)).toContain("denyPaths");
      // readonly refuses it a step earlier, on the verb naming no destination.
      expect(bash("git reset --hard", REVIEWER)).toBeTruthy();
      // A soft reset moves a ref and touches no file.
      expect(bash("git reset --soft HEAD~1", IMPLEMENTER)).toBeNull();
    });

    it("still denies a write verb aimed OUTSIDE the writeRoots, absolutely", () => {
      expect(bash("rm -rf /Users/shared/checkout", IMPLEMENTER)).toContain("outside this agent's writeRoots");
      expect(bash("cp x /etc/hosts", IMPLEMENTER)).toContain("outside this agent's writeRoots");
    });

    it("allows a non-write command naming a path outside the writeRoots", () => {
      expect(bash("xcodebuild -derivedDataPath /tmp/foo-dd test", IMPLEMENTER)).toBeNull();
      expect(bash("cat /etc/hosts", IMPLEMENTER)).toBeNull();
    });
  });

  describe("full", () => {
    it("allows the write verbs anywhere the deny lists permit", () => {
      expect(bash("rm -rf /Users/shared/scratch", FULL)).toBeNull();
      expect(bash("git push origin HEAD", FULL)).toBeNull();
      expect(bash("echo hi > /etc/hosts", FULL)).toBeNull();
    });

    it("still enforces both deny lists", () => {
      expect(bash("cat ~/.ssh/id_rsa", FULL)).toContain("denyReadPaths");
      expect(bash("rm -rf /Applications/Xcode.app", FULL)).toContain("denyPaths");
      // ...and still lets the reader through on a write-only fence.
      expect(bash("cat /Applications/Xcode.app/Contents/Info.plist", FULL)).toBeNull();
    });
  });
});
