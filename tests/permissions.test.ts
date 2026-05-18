import { describe, it, expect, vi } from "vitest";

// `permissions.ts` imports `config` at module load, which throws if no
// channels are configured. CI has no config file and no env vars, so the real
// module would blow up before any test runs. The isPrivateMemoryAccess
// predicate takes its `ctx` as a parameter and never touches `config`, so a
// minimal stub is enough.
vi.mock("../src/config.js", () => ({
  config: { workspaceDir: "/tmp/tomo-mock-permissions" },
}));

const { isPrivateMemoryAccess } = await import("../src/agent/permissions.js");

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
