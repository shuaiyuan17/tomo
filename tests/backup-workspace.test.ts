import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreWorkspaceFromBackup } from "../src/cli/backup-workspace.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tomo-backup-workspace-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("restoreWorkspaceFromBackup", () => {
  it("restores workspace files while keeping live Claude state and skills", () => {
    const root = tempRoot();
    const workspaceSrc = join(root, "backup", "workspace");
    const workspaceDest = join(root, "custom-volume", "workspace");
    const tempBase = join(root, "preserve-temp");
    mkdirSync(join(workspaceSrc, ".claude", "skills", "backup-only"), { recursive: true });
    mkdirSync(join(workspaceSrc, ".claude", "skills", "shared"), { recursive: true });
    mkdirSync(join(workspaceDest, ".claude", "skills", "live-only"), { recursive: true });
    mkdirSync(join(workspaceDest, ".claude", "skills", "shared"), { recursive: true });
    mkdirSync(tempBase, { recursive: true });

    writeFileSync(join(workspaceSrc, "SOUL.md"), "restored soul");
    writeFileSync(join(workspaceSrc, ".claude", "skills", "backup-only", "SKILL.md"), "backup");
    writeFileSync(join(workspaceSrc, ".claude", "skills", "shared", "SKILL.md"), "old backup");
    writeFileSync(join(workspaceDest, ".claude", "settings.json"), '{"live":true}');
    writeFileSync(join(workspaceDest, ".claude", "skills", "live-only", "SKILL.md"), "live");
    writeFileSync(join(workspaceDest, ".claude", "skills", "shared", "SKILL.md"), "current live");

    restoreWorkspaceFromBackup(workspaceSrc, workspaceDest, tempBase);

    expect(readFileSync(join(workspaceDest, "SOUL.md"), "utf-8")).toBe("restored soul");
    expect(readFileSync(join(workspaceDest, ".claude", "settings.json"), "utf-8")).toBe('{"live":true}');
    expect(readFileSync(join(workspaceDest, ".claude", "skills", "live-only", "SKILL.md"), "utf-8")).toBe("live");
    expect(readFileSync(join(workspaceDest, ".claude", "skills", "shared", "SKILL.md"), "utf-8")).toBe("current live");
    expect(readFileSync(join(workspaceDest, ".claude", "skills", "backup-only", "SKILL.md"), "utf-8")).toBe("backup");
    expect(readdirSync(tempBase)).toEqual([]);
  });

  it("restores a workspace that has no live Claude directory", () => {
    const root = tempRoot();
    const workspaceSrc = join(root, "backup", "workspace");
    const workspaceDest = join(root, "custom-workspace");
    mkdirSync(workspaceSrc, { recursive: true });
    mkdirSync(workspaceDest, { recursive: true });
    writeFileSync(join(workspaceSrc, "AGENT.md"), "restored");
    writeFileSync(join(workspaceDest, "old.txt"), "remove me");

    restoreWorkspaceFromBackup(workspaceSrc, workspaceDest);

    expect(readFileSync(join(workspaceDest, "AGENT.md"), "utf-8")).toBe("restored");
    expect(existsSync(join(workspaceDest, "old.txt"))).toBe(false);
  });
});
