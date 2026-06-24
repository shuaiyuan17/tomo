import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Restore a backed-up workspace while preserving the live `.claude` directory.
 *
 * The preserve copy lives in the OS temp directory and uses copy/remove rather
 * than rename, so custom workspaces on another filesystem do not fail with
 * EXDEV and a workspace containing ~/.tomo cannot delete its own preserve copy.
 */
export function restoreWorkspaceFromBackup(
  workspaceSrc: string,
  workspaceDest: string,
  tempBaseDir = tmpdir(),
): void {
  const claudeDir = join(workspaceDest, ".claude");
  const hadLiveClaude = existsSync(claudeDir);
  const preserveRoot = hadLiveClaude
    ? mkdtempSync(join(tempBaseDir, "tomo-workspace-restore-"))
    : null;
  const claudePreserve = preserveRoot ? join(preserveRoot, ".claude") : null;
  let preserveReady = false;
  let workspaceRemoved = false;
  let liveClaudeRestored = !hadLiveClaude;
  let completed = false;

  try {
    if (hadLiveClaude && claudePreserve) {
      cpSync(claudeDir, claudePreserve, { recursive: true, dereference: false });
      preserveReady = true;
    }

    rmSync(workspaceDest, { recursive: true, force: true });
    workspaceRemoved = true;
    cpSync(workspaceSrc, workspaceDest, { recursive: true });

    if (hadLiveClaude && claudePreserve) {
      mergeMissingBackupSkills(claudeDir, claudePreserve);
      rmSync(claudeDir, { recursive: true, force: true });
      mkdirSync(dirname(claudeDir), { recursive: true });
      cpSync(claudePreserve, claudeDir, { recursive: true, dereference: false });
      liveClaudeRestored = true;
    }

    completed = true;
  } catch (err) {
    if (hadLiveClaude && preserveReady && workspaceRemoved && claudePreserve) {
      try {
        rmSync(claudeDir, { recursive: true, force: true });
        mkdirSync(dirname(claudeDir), { recursive: true });
        cpSync(claudePreserve, claudeDir, { recursive: true, dereference: false });
        liveClaudeRestored = true;
      } catch {
        throw new Error(
          `Workspace restore failed; the live .claude backup remains at ${claudePreserve}`,
          { cause: err },
        );
      }
    }
    throw err;
  } finally {
    const originalClaudeStillExists = hadLiveClaude && !workspaceRemoved && existsSync(claudeDir);
    if (preserveRoot && (completed || liveClaudeRestored || originalClaudeStillExists)) {
      rmSync(preserveRoot, { recursive: true, force: true });
    }
  }
}

function mergeMissingBackupSkills(backupClaudeDir: string, liveClaudeDir: string): void {
  const backupSkills = join(backupClaudeDir, "skills");
  if (!existsSync(backupSkills)) return;

  const liveSkills = join(liveClaudeDir, "skills");
  mkdirSync(liveSkills, { recursive: true });
  for (const entry of readdirSync(backupSkills, { withFileTypes: true })) {
    const dest = join(liveSkills, entry.name);
    if (existsSync(dest)) continue;
    cpSync(join(backupSkills, entry.name), dest, {
      recursive: true,
      dereference: false,
    });
  }
}
