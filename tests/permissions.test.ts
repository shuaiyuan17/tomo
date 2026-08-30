import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const {
  isPrivateMemoryAccess,
  privateMemoryGuardHooks,
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

function decision(result: PreToolUseResult): string | undefined {
  return result.hookSpecificOutput?.permissionDecision;
}

describe("privateMemoryGuardHooks", () => {
  it("denies private-memory access on a summoned turn, naming the summon", async () => {
    const hook = hookFor(() => "summoned-turn");

    for (const call of [PRIVATE_READ, PRIVATE_CAT, PRIVATE_GLOB]) {
      const result = await hook(call);
      expect(decision(result), call.tool_name).toBe("deny");
      expect(result.hookSpecificOutput?.permissionDecisionReason).toBe(PRIVATE_MEMORY_SUMMONED_DENIAL);
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("unavailable during a summoned turn");
    }
  });

  it("allows the owner's own turn through the same hook", async () => {
    const hook = hookFor(() => null);

    for (const call of [PRIVATE_READ, PRIVATE_CAT, PRIVATE_GLOB, PUBLIC_READ]) {
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
