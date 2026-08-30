import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `permissions.ts` imports `config` at module load, which throws if no
// channels are configured. CI has no config file and no env vars, so the real
// module would blow up before any test runs. The isPrivateMemoryAccess
// predicate takes its `ctx` as a parameter and never touches `config`, so a
// minimal stub is enough.
vi.mock("../src/config.js", () => ({
  config: { workspaceDir: "/tmp/tomo-mock-permissions" },
}));

const { isPrivateMemoryAccess, skillsCanUseTool } = await import("../src/agent/permissions.js");

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

// The mocked workspaceDir above; skillsCanUseTool derives its allowed root from it.
const WS = "/tmp/tomo-mock-permissions";
const SKILLS = `${WS}/.claude/skills`;

/** A directory outside the workspace that a planted symlink can point at. */
let outsideDir: string;

beforeAll(() => {
  // Real directories, because containment is now decided by realpath and a
  // symlink escape cannot be expressed without a filesystem.
  mkdirSync(`${SKILLS}/real-skill`, { recursive: true });
  outsideDir = mkdtempSync(join(tmpdir(), "tomo-perm-outside-"));
  mkdirSync(`${outsideDir}/loot`, { recursive: true });
  try { symlinkSync(outsideDir, `${SKILLS}/escape`, "dir"); } catch { /* already there */ }
});

afterAll(() => {
  rmSync(WS, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("skillsCanUseTool — narrow .claude/skills/ re-allow", () => {
  it("allows a write inside the skills dir", async () => {
    const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/my-skill/SKILL.md` });
    expect(r.behavior).toBe("allow");
  });

  it("allows notebook_path and path inputs inside the skills dir", async () => {
    expect((await skillsCanUseTool("NotebookEdit", { notebook_path: `${SKILLS}/a/b.ipynb` })).behavior)
      .toBe("allow");
    expect((await skillsCanUseTool("Read", { path: `${SKILLS}/a/b.md` })).behavior)
      .toBe("allow");
  });

  it("denies a path outside the skills dir", async () => {
    const r = await skillsCanUseTool("Write", { file_path: `${WS}/.claude/settings.json` });
    expect(r.behavior).toBe("deny");
  });

  it("denies traversal that escapes the skills dir into .claude/", async () => {
    const r = await skillsCanUseTool("Write", {
      file_path: `${SKILLS}/../../.claude/settings.json`,
    });
    expect(r.behavior).toBe("deny");
  });

  it("denies traversal that escapes the workspace entirely", async () => {
    const r = await skillsCanUseTool("Write", {
      file_path: `${SKILLS}/../../../../../../etc/passwd`,
    });
    expect(r.behavior).toBe("deny");
  });

  it("denies a sibling directory that merely shares the skills prefix", async () => {
    const r = await skillsCanUseTool("Write", { file_path: `${WS}/.claude/skills-evil/x.md` });
    expect(r.behavior).toBe("deny");
  });

  it("denies when no path is present at all", async () => {
    const r = await skillsCanUseTool("WebFetch", { url: "https://example.com" });
    expect(r.behavior).toBe("deny");
  });

  describe("symlink escapes", () => {
    it("denies a write through a symlink planted inside the skills tree", async () => {
      // The agent is allowed to create files under skills/, so it can create
      // the symlink too. Lexical containment says `<skills>/escape/x.md` is
      // inside; realpath says it is in the temp dir.
      const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/escape/loot/x.md` });
      expect(r.behavior).toBe("deny");
    });

    it("denies even when the final component does not exist yet", async () => {
      const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/escape/brand/new/file.md` });
      expect(r.behavior).toBe("deny");
    });

    it("still allows a genuine directory next to the symlink", async () => {
      const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/real-skill/SKILL.md` });
      expect(r.behavior).toBe("allow");
    });
  });

  it("normalises casing through realpath rather than string compare", async (ctx) => {
    // Detected inside the test, not at collection time: beforeAll has not run
    // when the describe body is evaluated, so the probe directory would not
    // exist yet and this would skip on every volume.
    let caseInsensitive = false;
    try { statSync(`${SKILLS}/REAL-SKILL`); caseInsensitive = true; } catch { /* case-sensitive volume */ }
    if (!caseInsensitive) return ctx.skip();
    // On an APFS/HFS+ case-insensitive volume `<SKILLS>/REAL-SKILL` IS the same
    // directory, so a case-sensitive string containment check would deny a path
    // the filesystem resolves squarely inside the skills tree. realpath returns
    // the on-disk casing, normalising both sides.
    const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/REAL-SKILL/SKILL.md` });
    expect(r.behavior).toBe("allow");
  });
});

describe("the Bash arm of the re-allow", () => {
  // Driven through skillsCanUseTool, the real entry point, so every case below
  // exercises the same code path the SDK calls — and so each one demonstrates
  // the defect against the previous implementation rather than merely noting
  // that a new helper did not exist yet.
  const allows = async (command: string): Promise<boolean> =>
    (await skillsCanUseTool("Bash", { command })).behavior === "allow";

  it("allows ordinary skill management", async () => {
    expect(await allows(`mkdir -p ${SKILLS}/my-skill`)).toBe(true);
    expect(await allows(`touch ${SKILLS}/my-skill/SKILL.md`)).toBe(true);
    expect(await allows(`rm -rf ${SKILLS}/old-skill`)).toBe(true);
    expect(await allows(`mv ${SKILLS}/a ${SKILLS}/b`)).toBe(true);
  });

  it("denies the traversal the substring check used to wave through", async () => {
    // The headline: the SAME escape the file_path arm rejects, reachable
    // through the arm that checked no paths at all.
    expect(await allows(`touch ${SKILLS}/../../.claude/settings.json`)).toBe(false);
  });

  it("denies a command that reads a protected sibling and merely mentions skills", async () => {
    expect(await allows(`cp ${WS}/.claude/settings.json /tmp/x; echo ${SKILLS}/`)).toBe(false);
    expect(await allows(`cat ${WS}/.git/config && ls ${SKILLS}/`)).toBe(false);
  });

  it("denies redirection that lands outside the skills tree", async () => {
    expect(await allows(`echo pwned > ${WS}/.claude/settings.json && ls ${SKILLS}/`)).toBe(false);
    expect(await allows(`ls ${SKILLS}/ >> ${WS}/.claude/settings.json`)).toBe(false);
  });

  it("allows redirection into the skills tree", async () => {
    expect(await allows(`echo hi > ${SKILLS}/my-skill/SKILL.md`)).toBe(true);
  });

  it("denies a write through a symlink planted inside the skills tree", async () => {
    expect(await allows(`touch ${SKILLS}/escape/loot/x.md`)).toBe(false);
  });

  it("denies anything that hides its paths from a static read", async () => {
    expect(await allows(`touch ${SKILLS}/$(whoami).md`)).toBe(false);
    expect(await allows("touch `echo " + SKILLS + "`/x.md")).toBe(false);
    expect(await allows(`touch $HOME/.claude/settings.json; ls ${SKILLS}/`)).toBe(false);
    expect(await allows(`sudo touch ${SKILLS}/x.md`)).toBe(false);
  });

  it("denies a home-relative word it cannot resolve", async () => {
    expect(await allows(`cp ${SKILLS}/x.md ~/.claude/settings.json`)).toBe(false);
  });

  it("denies a command that never lands in the skills tree", async () => {
    expect(await allows("rm -rf /")).toBe(false);
    expect(await allows(`cat ${WS}/.claude/settings.json`)).toBe(false);
    expect(await allows("echo hello")).toBe(false);
  });
});
