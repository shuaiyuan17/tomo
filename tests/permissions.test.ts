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
  // DANGLING symlinks — the target does not exist, so realpathSync throws
  // ENOENT for the link itself, exactly as it does for an absent name.
  try { symlinkSync(`${WS}/.claude/settings.local.json`, `${SKILLS}/dangling-out`); } catch { /* already there */ }
  try { symlinkSync(`${SKILLS}/not-created-yet.md`, `${SKILLS}/dangling-in`); } catch { /* already there */ }
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

  describe("dangling symlinks", () => {
    it("denies a write onto a dangling symlink whose target is outside the tree", async () => {
      // realpathSync throws ENOENT for a link with a missing target, which is
      // indistinguishable from an absent name — so the parent-walk fallback
      // reported the LINK's own path, inside the tree, and the write followed
      // the link to settings.local.json.
      const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/dangling-out` });
      expect(r.behavior).toBe("deny");
    });

    it("allows a dangling symlink whose target is inside the tree", async () => {
      const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/dangling-in` });
      expect(r.behavior).toBe("allow");
    });

    it("denies the same escape through every Bash program that writes", async () => {
      const allowed = async (command: string): Promise<boolean> =>
        (await skillsCanUseTool("Bash", { command })).behavior === "allow";
      expect(await allowed(`cp ${SKILLS}/real-skill/SKILL.md ${SKILLS}/dangling-out`)).toBe(false);
      expect(await allowed(`mv ${SKILLS}/real-skill/SKILL.md ${SKILLS}/dangling-out`)).toBe(false);
      expect(await allowed(`touch ${SKILLS}/dangling-out`)).toBe(false);
    });
  });

  describe("the file arm is gated on the tool", () => {
    it("does not let a Bash call take the file arm via a decoy path key", async () => {
      // Tool input is model-authored. An ungated file arm reads
      // `file_path ?? notebook_path ?? path` off ANY tool, so a decoy key
      // alongside the real command returned allow and the command ran without
      // ever meeting the Bash allowlist.
      const r = await skillsCanUseTool("Bash", {
        command: `cat ${WS}/.claude/settings.json`,
        path: `${SKILLS}/a.md`,
      });
      expect(r.behavior).toBe("deny");
    });

    it("does not let an unknown tool take the file arm", async () => {
      const r = await skillsCanUseTool("WebFetch", { path: `${SKILLS}/a.md` });
      expect(r.behavior).toBe("deny");
    });

    it("honours the SDK's blockedPath when it disagrees with the input", async () => {
      // blockedPath is the SDK's own answer to "which path triggered this",
      // so a contained input path must not vouch for an escaping one.
      const r = await skillsCanUseTool(
        "Write",
        { file_path: `${SKILLS}/a.md` },
        { blockedPath: `${WS}/.claude/settings.json` },
      );
      expect(r.behavior).toBe("deny");
    });

    it("allows when blockedPath and the input both land inside", async () => {
      const r = await skillsCanUseTool(
        "Write",
        { file_path: `${SKILLS}/a.md` },
        { blockedPath: `${SKILLS}/a.md` },
      );
      expect(r.behavior).toBe("allow");
    });
  });

  it("denies a case-permuted skills root rather than normalising it", async (ctx) => {
    // Detected inside the test, not at collection time: beforeAll has not run
    // when the describe body is evaluated.
    let caseInsensitive = false;
    try { statSync(`${SKILLS}/REAL-SKILL`); caseInsensitive = true; } catch { /* case-sensitive volume */ }
    if (!caseInsensitive) return ctx.skip();

    // Node's realpathSync PRESERVES the caller's spelling — realpath of
    // `<ws>/.CLAUDE/SKILLS` is `<ws>/.CLAUDE/SKILLS`, not the on-disk
    // `.claude/skills`. So containment fails and the path is DENIED even
    // though it opens the same file on this volume. Conservative, not an
    // escape: it falls back to the SDK's ordinary permission handling.
    const r = await skillsCanUseTool("Write", { file_path: `${WS}/.CLAUDE/SKILLS/x.md` });
    expect(r.behavior).toBe("deny");
  });

  it("allows a case-permuted CHILD under a correctly-spelled root", async (ctx) => {
    let caseInsensitive = false;
    try { statSync(`${SKILLS}/REAL-SKILL`); caseInsensitive = true; } catch { /* case-sensitive volume */ }
    if (!caseInsensitive) return ctx.skip();

    // Containment only compares the root prefix, and here that prefix is spelled
    // correctly — so the permuted leaf is immaterial.
    const r = await skillsCanUseTool("Write", { file_path: `${SKILLS}/REAL-SKILL/SKILL.md` });
    expect(r.behavior).toBe("allow");
  });

});

describe("the Bash arm of the re-allow", () => {
  // Driven through skillsCanUseTool, the real entry point, so every case below
  // exercises the code path the SDK calls.
  const allows = async (command: string): Promise<boolean> =>
    (await skillsCanUseTool("Bash", { command })).behavior === "allow";

  describe("auto-allowed: one simple command, every path inside the tree", () => {
    it("allows ordinary skill management", async () => {
      expect(await allows(`mkdir -p ${SKILLS}/my-skill`)).toBe(true);
      expect(await allows(`touch ${SKILLS}/my-skill/SKILL.md`)).toBe(true);
      expect(await allows(`rm -rf ${SKILLS}/old-skill`)).toBe(true);
      expect(await allows(`mv ${SKILLS}/a ${SKILLS}/b`)).toBe(true);
      expect(await allows(`cat ${SKILLS}/real-skill/SKILL.md`)).toBe(true);
    });

    it("allows a quoted path with spaces INSIDE the tree", async () => {
      expect(await allows(`touch "${SKILLS}/my skill/SKILL.md"`)).toBe(true);
      expect(await allows(`touch '${SKILLS}/my skill/SKILL.md'`)).toBe(true);
    });

    it("allows the skills directory itself", async () => {
      expect(await allows(`ls ${SKILLS}`)).toBe(true);
    });
  });

  describe("the escapes this replaces", () => {
    it("denies the traversal the substring check used to wave through", async () => {
      expect(await allows(`touch ${SKILLS}/../../.claude/settings.json`)).toBe(false);
    });

    it("denies a quoted SIBLING that whitespace-splitting used to hide", async () => {
      // "skills dir" is a sibling of "skills". Splitting on whitespace turned
      // this into two words, neither of which looked like the sibling it names.
      expect(await allows(`touch "${WS}/.claude/skills dir/x"`)).toBe(false);
    });

    it("denies quotes embedded mid-path", async () => {
      // A raw split leaves `/workspace/".claude"/settings.json` glued together
      // and unrecognisable; the tokenizer resolves it to the protected file.
      expect(await allows(`touch ${SKILLS}/ok ${WS}/".claude"/settings.json`)).toBe(false);
      expect(await allows(`touch ${SKILLS}/ok ${WS}/'.claude'/settings.json`)).toBe(false);
    });

    it("denies a relative path reached through cd", async () => {
      // The shell's cwd is not knowable from here, so `escape/loot/x` cannot be
      // resolved. Refused twice over: `&&`, and the non-absolute argument.
      expect(await allows(`cd ${SKILLS} && touch escape/loot/x`)).toBe(false);
      expect(await allows(`touch escape/loot/x`)).toBe(false);
    });

    it("denies an outside destination that is not under .claude or .git", async () => {
      // Previously only the protected siblings were checked, so any other
      // outside path rode along.
      expect(await allows(`cp ${SKILLS}/a /etc/x`)).toBe(false);
      expect(await allows(`mv ${SKILLS}/a /tmp/anywhere`)).toBe(false);
    });

    it("denies a flag whose value escapes the tree", async () => {
      expect(await allows(`grep --file=${SKILLS}/../x ${SKILLS}/y`)).toBe(false);
      expect(await allows(`grep --file=${WS}/.claude/settings.json ${SKILLS}/y`)).toBe(false);
    });

    it("denies redirection, even into the tree", async () => {
      // Refused rather than parsed: a redirection target is a path the command
      // writes without naming it as an argument.
      expect(await allows(`echo foo > ${SKILLS}/../x`)).toBe(false);
      expect(await allows(`cat ${SKILLS}/a > ${SKILLS}/b`)).toBe(false);
    });

    it("denies a leading environment assignment", async () => {
      expect(await allows(`FOO=bar touch ${SKILLS}/x`)).toBe(false);
      expect(await allows(`LD_PRELOAD=/tmp/evil.so cat ${SKILLS}/x`)).toBe(false);
    });

    it("denies a write through a symlink planted inside the skills tree", async () => {
      expect(await allows(`touch ${SKILLS}/escape/loot/x.md`)).toBe(false);
    });

    it("denies a protected sibling", async () => {
      expect(await allows(`cat ${WS}/.claude/settings.json`)).toBe(false);
      expect(await allows(`cp ${WS}/.claude/settings.json ${SKILLS}/x`)).toBe(false);
    });
  });

  describe("refused because they cannot be read unambiguously", () => {
    it("denies anything that hides its paths from a static read", async () => {
      expect(await allows(`touch ${SKILLS}/$(whoami).md`)).toBe(false);
      expect(await allows("touch `echo " + SKILLS + "`/x.md")).toBe(false);
      expect(await allows(`touch $HOME/.claude/settings.json`)).toBe(false);
      expect(await allows(`touch ${SKILLS}/\${DIR}/x`)).toBe(false);
    });

    it("denies command chaining and pipes", async () => {
      expect(await allows(`touch ${SKILLS}/a; cat ${WS}/.claude/settings.json`)).toBe(false);
      expect(await allows(`touch ${SKILLS}/a || cat ${WS}/.claude/settings.json`)).toBe(false);
      expect(await allows(`cat ${SKILLS}/a | tee ${WS}/.claude/settings.json`)).toBe(false);
      expect(await allows(`touch ${SKILLS}/a &`)).toBe(false);
      expect(await allows(`touch ${SKILLS}/a\ntouch ${WS}/.claude/settings.json`)).toBe(false);
    });

    it("denies a backslash escape and an unterminated quote", async () => {
      expect(await allows(`touch ${SKILLS}/my\\ skill/x`)).toBe(false);
      expect(await allows(`touch "${SKILLS}/x`)).toBe(false);
    });

    it("denies a program outside the allowlist", async () => {
      expect(await allows(`sudo touch ${SKILLS}/x.md`)).toBe(false);
      expect(await allows(`sh -c "touch ${SKILLS}/x"`)).toBe(false);
      expect(await allows(`xargs touch ${SKILLS}/x`)).toBe(false);
      expect(await allows(`/bin/touch ${SKILLS}/x`)).toBe(false);
    });

    it("denies a home-relative word it cannot resolve", async () => {
      expect(await allows(`cp ${SKILLS}/x.md ~/.claude/settings.json`)).toBe(false);
      expect(await allows(`touch ~/x`)).toBe(false);
    });

    it("denies a command that names no path in the tree", async () => {
      expect(await allows("rm -rf /")).toBe(false);
      expect(await allows("ls")).toBe(false);
      expect(await allows("")).toBe(false);
    });
  });

  describe("shell expansion that would escape after validation", () => {
    it("denies glob metacharacters that expand to the parent directory", async () => {
      // `.?` expands to `..`, so the word validated here is not the word that
      // runs. Quoting the prefix does not help: whether a quote suppresses
      // expansion depends on the shell and where it falls.
      expect(await allows(`rm -rf "${SKILLS}/".?/*`)).toBe(false);
      expect(await allows(`rm -rf ${SKILLS}/.?/*`)).toBe(false);
    });

    it("denies brace expansion that synthesises a parent reference", async () => {
      expect(await allows(`cat "${SKILLS}/"{.,}./settings.json`)).toBe(false);
      expect(await allows(`cat ${SKILLS}/{.,}./settings.json`)).toBe(false);
    });

    it("denies ordinary globs too, contained or not", async () => {
      // No carve-out for a glob that looks safe: it is still not a literal path.
      expect(await allows(`ls ${SKILLS}/*.md`)).toBe(false);
      expect(await allows(`rm -rf ${SKILLS}/[a-z]*`)).toBe(false);
      expect(await allows(`cat ${SKILLS}/?.md`)).toBe(false);
    });
  });

  describe("flags that carry a path", () => {
    it("denies a long flag with an attached value", async () => {
      expect(await allows(`cp --target-directory=.. ${SKILLS}/x`)).toBe(false);
      expect(await allows(`cp --target-directory=${WS}/.claude ${SKILLS}/x`)).toBe(false);
    });

    it("denies an attached value built from otherwise-allowed letters", async () => {
      // Every letter of `-flah` is in the old shared set, but BSD grep reads
      // this as `-f lah` and takes its pattern list from the file `lah`. A
      // per-character check over one shared set cannot see the difference.
      expect(await allows(`grep -flah ${SKILLS}/a.md`)).toBe(false);
      expect(await allows(`grep -fair ${SKILLS}/a.md`)).toBe(false);
    });

    it("denies a value-taking flag the program actually has", async () => {
      // `-f` is --force to cp/mv/rm but --file=FILE to grep, so "valueless" is
      // a property of the program, not of the letter.
      expect(await allows(`grep -f ${SKILLS}/a.md`)).toBe(false);
      expect(await allows(`head -n ${SKILLS}/a.md`)).toBe(false);
    });

    it("denies a short flag with an attached value", async () => {
      // `-f.env` is ONE word: grep reads its pattern list from `.env`, and a
      // "does this flag contain a slash" test never saw a path at all.
      expect(await allows(`grep -f.env ${SKILLS}/x`)).toBe(false);
      expect(await allows(`grep -f/etc/passwd ${SKILLS}/x`)).toBe(false);
    });

    it("denies an unknown long flag even without a value", async () => {
      expect(await allows(`cp --archive ${SKILLS}/a ${SKILLS}/b`)).toBe(false);
      expect(await allows(`ls -- ${SKILLS}`)).toBe(false);
      expect(await allows(`cat - ${SKILLS}/x`)).toBe(false);
    });

    it("still allows the value-less flags skill management actually uses", async () => {
      expect(await allows(`rm -rf ${SKILLS}/old`)).toBe(true);
      expect(await allows(`mkdir -p ${SKILLS}/a/b`)).toBe(true);
      expect(await allows(`ls -la ${SKILLS}`)).toBe(true);
      expect(await allows(`cp --recursive ${SKILLS}/a ${SKILLS}/b`)).toBe(true);
    });
  });

  describe("the skills root as an operand", () => {
    it("denies destroying or relocating the root itself", async () => {
      // `<skills>` is a contained path by every check above, and wiping it
      // takes the whole skill library with it.
      expect(await allows(`rm -rf ${SKILLS}`)).toBe(false);
      expect(await allows(`rmdir ${SKILLS}`)).toBe(false);
      expect(await allows(`mv ${SKILLS} ${SKILLS}/nested`)).toBe(false);
      expect(await allows(`mv ${SKILLS}/a ${SKILLS}`)).toBe(false);
    });

    it("still allows destroying something inside it", async () => {
      expect(await allows(`rm -rf ${SKILLS}/old-skill`)).toBe(true);
      expect(await allows(`mv ${SKILLS}/a ${SKILLS}/b`)).toBe(true);
    });

    it("still allows reading the root", async () => {
      expect(await allows(`ls ${SKILLS}`)).toBe(true);
      expect(await allows(`stat ${SKILLS}`)).toBe(true);
      expect(await allows(`find ${SKILLS}`)).toBe(true);
    });
  });

  describe("the accepted residual", () => {
    // These are legitimate skill management that now goes through the SDK's
    // ordinary permission handling instead of being auto-allowed. Asserted so
    // the trade is recorded rather than discovered.
    it("does not auto-allow a grep pattern, which is not a path", async () => {
      expect(await allows(`grep -r pattern ${SKILLS}`)).toBe(false);
    });

    it("does not auto-allow chmod's symbolic mode", async () => {
      expect(await allows(`chmod +x ${SKILLS}/x.sh`)).toBe(false);
    });
  });
});
