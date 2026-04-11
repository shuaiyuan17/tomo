import { Command } from "commander";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { getSdkSessionDir } from "../sessions/store.js";

const TOMO_HOME = join(homedir(), ".tomo");
const BACKUPS_DIR = join(homedir(), "Backups", "tomo");
const RETENTION_DAYS = 14;

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function copyIfExists(src: string, dest: string, opts?: { filter?: (src: string, dest: string) => boolean }): boolean {
  if (!existsSync(src)) return false;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: opts?.filter });
  return true;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try {
        total += statSync(full).size;
      } catch {
        // skip unreadable
      }
    }
  }
  return total;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function listBackups(): { name: string; path: string; date: Date; size: number }[] {
  if (!existsSync(BACKUPS_DIR)) return [];
  const entries = readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(e.name))
    .map((e) => {
      const full = join(BACKUPS_DIR, e.name);
      // Parse date from folder name: YYYY-MM-DD_HHMM
      const [datePart, timePart] = e.name.split("_");
      const [y, m, d] = datePart.split("-").map(Number);
      const hh = Number(timePart.slice(0, 2));
      const mm = Number(timePart.slice(2, 4));
      return {
        name: e.name,
        path: full,
        date: new Date(y, m - 1, d, hh, mm),
        size: dirSize(full),
      };
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  return entries;
}

function pruneOldBackups(): number {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const backups = listBackups();
  let removed = 0;
  for (const b of backups) {
    if (b.date.getTime() < cutoff) {
      rmSync(b.path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export const backupCommand = new Command("backup")
  .description("Backup and restore tomo data");

// Default action: create a backup
backupCommand
  .command("create", { isDefault: true })
  .description("Create a backup of all tomo data")
  .action(() => {
    const ts = timestamp();
    const dest = join(BACKUPS_DIR, ts);
    const tmpDest = dest + ".tmp";

    // Clean up any leftover partial backup
    if (existsSync(tmpDest)) {
      rmSync(tmpDest, { recursive: true, force: true });
    }

    mkdirSync(tmpDest, { recursive: true });

    console.log(`Creating backup: ${dest}\n`);

    // 1. config.json
    const configSrc = join(TOMO_HOME, "config.json");
    if (existsSync(configSrc)) {
      cpSync(configSrc, join(tmpDest, "config.json"));
      console.log("  [ok] config.json");
    } else {
      console.log("  [--] config.json (not found)");
    }

    // 2. workspace/ (excluding .claude/)
    const workspaceSrc = join(TOMO_HOME, "workspace");
    const workspaceDest = join(tmpDest, "workspace");
    if (copyIfExists(workspaceSrc, workspaceDest, {
      filter: (src) => !src.includes(`${sep}.claude${sep}`) && !src.endsWith(`${sep}.claude`),
    })) {
      console.log("  [ok] workspace/");
    } else {
      console.log("  [--] workspace/ (not found)");
    }

    // 2b. .claude/skills/ (custom skills — preserve symlinks to avoid bloating backup)
    const skillsSrc = join(workspaceSrc, ".claude", "skills");
    const skillsDest = join(workspaceDest, ".claude", "skills");
    if (existsSync(skillsSrc)) {
      mkdirSync(join(workspaceDest, ".claude"), { recursive: true });
      cpSync(skillsSrc, skillsDest, { recursive: true, dereference: false });
      console.log("  [ok] workspace/.claude/skills/");
    }

    // 3. data/
    const dataSrc = join(TOMO_HOME, "data");
    const dataDest = join(tmpDest, "data");
    if (copyIfExists(dataSrc, dataDest)) {
      console.log("  [ok] data/");
    } else {
      console.log("  [--] data/ (not found)");
    }

    // 4. SDK session files
    const sdkDir = getSdkSessionDir();
    const sdkDest = join(tmpDest, "sdk-sessions");
    if (copyIfExists(sdkDir, sdkDest)) {
      console.log("  [ok] sdk-sessions/");
    } else {
      console.log("  [--] sdk-sessions/ (not found)");
    }

    // Atomically move tmp dir to final destination
    renameSync(tmpDest, dest);

    // Prune old backups
    const pruned = pruneOldBackups();

    const size = dirSize(dest);
    console.log(`\nBackup complete: ${formatSize(size)}`);
    if (pruned > 0) {
      console.log(`Pruned ${pruned} backup(s) older than ${RETENTION_DAYS} days.`);
    }
  });

backupCommand
  .command("list")
  .description("List existing backups")
  .action(() => {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log("No backups found.");
      return;
    }

    console.log(`Found ${backups.length} backup(s) in ${BACKUPS_DIR}:\n`);
    for (const b of backups) {
      const dateStr = b.date.toLocaleDateString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      console.log(`  ${b.name}  ${dateStr}  ${formatSize(b.size)}`);
    }
  });

backupCommand
  .command("restore <date>")
  .description("Restore from a backup (e.g. 2026-04-10_1430)")
  .action(async (date: string) => {
    // Refuse to restore while daemon is running
    const pidFile = join(TOMO_HOME, "tomo.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf-8").trim());
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.error("Tomo daemon is running. Run `tomo stop` first.");
          process.exit(1);
        } catch {
          // process not alive — stale PID file, continue
        }
      }
    }

    const backupPath = join(BACKUPS_DIR, date);
    if (!existsSync(backupPath)) {
      console.error(`Backup not found: ${backupPath}`);
      console.error("Run 'tomo backup list' to see available backups.");
      process.exit(1);
    }

    console.log(`Restore from: ${backupPath}`);
    console.log("This will overwrite current tomo data.\n");

    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }

    console.log();

    // 1. config.json
    const configSrc = join(backupPath, "config.json");
    if (existsSync(configSrc)) {
      cpSync(configSrc, join(TOMO_HOME, "config.json"));
      console.log("  [ok] config.json");
    }

    // 2. workspace/ (preserve .claude/ which is populated by init/start)
    const workspaceSrc = join(backupPath, "workspace");
    if (existsSync(workspaceSrc)) {
      const workspaceDest = join(TOMO_HOME, "workspace");
      const claudeDir = join(workspaceDest, ".claude");
      const claudePreserve = join(workspaceDest, ".claude.preserve");
      if (existsSync(claudeDir)) renameSync(claudeDir, claudePreserve);
      rmSync(workspaceDest, { recursive: true, force: true });
      cpSync(workspaceSrc, workspaceDest, { recursive: true });
      if (existsSync(claudePreserve)) renameSync(claudePreserve, claudeDir);

      // Merge backed-up custom skills into restored workspace
      const skillsBackup = join(workspaceSrc, ".claude", "skills");
      const skillsTarget = join(workspaceDest, ".claude", "skills");
      if (existsSync(skillsBackup)) {
        mkdirSync(skillsTarget, { recursive: true });
        cpSync(skillsBackup, skillsTarget, { recursive: true });
      }

      console.log("  [ok] workspace/");
    }

    // 3. data/
    const dataSrc = join(backupPath, "data");
    if (existsSync(dataSrc)) {
      const dataDest = join(TOMO_HOME, "data");
      rmSync(dataDest, { recursive: true, force: true });
      cpSync(dataSrc, dataDest, { recursive: true });
      console.log("  [ok] data/");
    }

    // 4. SDK session files
    const sdkSrc = join(backupPath, "sdk-sessions");
    if (existsSync(sdkSrc)) {
      const sdkDest = getSdkSessionDir();
      rmSync(sdkDest, { recursive: true, force: true });
      mkdirSync(sdkDest, { recursive: true });
      cpSync(sdkSrc, sdkDest, { recursive: true });
      console.log("  [ok] sdk-sessions/");
    }

    console.log("\nRestore complete.");
  });
