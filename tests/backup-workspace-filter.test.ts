import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceBackupFilter } from "../src/cli/backup.js";

describe("workspaceBackupFilter", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function file(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
  }

  it("copies the workspace without its top-level tmp/ or .claude/, keeping nested tmp folders", () => {
    root = mkdtempSync(join(tmpdir(), "backup-filter-"));
    const ws = join(root, "workspace");
    file(join(ws, "memory", "MEMORY.md"));
    file(join(ws, "tmp", "derived", "huge.bin"));
    file(join(ws, "tmp", "worktree", "src", "a.ts"));
    file(join(ws, ".claude", "settings.json"));
    file(join(ws, "projects", "tmp", "keep.md"));
    file(join(ws, "tmpnotes.md"));

    const dest = join(root, "out");
    cpSync(ws, dest, { recursive: true, filter: workspaceBackupFilter(ws) });

    expect(existsSync(join(dest, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(dest, "projects", "tmp", "keep.md"))).toBe(true);
    expect(existsSync(join(dest, "tmpnotes.md"))).toBe(true);
    expect(existsSync(join(dest, "tmp"))).toBe(false);
    expect(existsSync(join(dest, ".claude"))).toBe(false);
  });
});
