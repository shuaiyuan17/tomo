import { Command } from "commander";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { config } from "../config.js";
import { restoreWorkspaceFromBackup } from "./backup-workspace.js";
import { defaultRuntimePaths } from "../runtime-paths.js";

const TOMO_HOME = config.tomoHome;
const PID_FILE = defaultRuntimePaths.pidFile;
const BACKUPS_DIR = join(homedir(), "Backups", "tomo");
// Local backups are one leg of three (local / iCloud / R2), and each one is a
// full copy — they do not dedupe. A daily archive grew from 1.7 GB to 2.8 GB
// over two weeks, so 14 days was holding 32 GB on a disk that was down to 21 GB
// free. Seven days of local history plus the other two legs is the trade we
// picked (2026-08-16). Override with TOMO_BACKUP_RETENTION_DAYS.
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Resolve the retention window from `TOMO_BACKUP_RETENTION_DAYS`.
 *
 * This used to be a bare `Number(env ?? 7)`, which failed in both directions
 * and silently. `"7d"` — a plausible typo in a shell profile or a launchd
 * `EnvironmentVariables` block — is `NaN`, so `Date.now() - NaN` is `NaN`,
 * every `date < NaN` is false, and pruning stops entirely with no "Pruned N"
 * line to notice: exactly the unbounded growth this file's comment above was
 * written about. `0` (or a negative) puts the cutoff at or after now, so the
 * backup that was just created is itself deleted, along with every other one,
 * and the command then prints `Backup complete: 0 B` because the size is read
 * after the prune.
 *
 * Anything not a finite value >= 1 falls back to the default and says so.
 */
export function resolveRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `Ignoring TOMO_BACKUP_RETENTION_DAYS=${JSON.stringify(raw)} (expected a number of days >= 1); using ${DEFAULT_RETENTION_DAYS}.`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

const RETENTION_DAYS = resolveRetentionDays(process.env.TOMO_BACKUP_RETENTION_DAYS);

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

/**
 * The only shape a backup directory name may have: `YYYY-MM-DD_HHMM`, as
 * produced by `timestamp()`.
 *
 * `listBackups` has always filtered on this, but `tomo backup restore <date>`
 * joined its argument onto BACKUPS_DIR unchecked — so `restore ../../..` named
 * an arbitrary directory, which the restore then treats as a backup: it
 * `rmSync`s the live `~/.tomo/data` and `sdk-sessions` and copies whatever it
 * finds (or nothing) over them. Same predicate, both places.
 */
export function isBackupName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(name);
}

function listBackups(): { name: string; path: string; date: Date; size: number }[] {
  if (!existsSync(BACKUPS_DIR)) return [];
  const entries = readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isBackupName(e.name))
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

/**
 * Resolve `date` to the directory `restore` may read, or null to refuse.
 *
 * Restore is the most destructive command here: for each of four components it
 * `rmSync`s the live tree and copies the backup's over it. So the argument has
 * to survive three separate questions, not one.
 *
 * 1. SHAPE. `YYYY-MM-DD_HHMM`, the same predicate `listBackups` applies. Alone
 *    this stops `restore ../../..`.
 * 2. KIND. `lstatSync`, NOT `statSync` or `existsSync`, both of which follow
 *    the link and answer about the target. A symlink at
 *    `~/Backups/tomo/2026-08-30_0142` pointing anywhere passes a shape check
 *    and an existence check while being a redirect, so the entry must be a
 *    real directory.
 * 3. CONTAINMENT, ON REAL PATHS. `realpathSync` both sides and require the
 *    candidate to sit directly inside the backups root. Lexical containment is
 *    not enough once any ancestor can be a link, and the root itself is under
 *    `homedir()`, which is a symlink on plenty of setups.
 *
 * Returns the REAL path, so what is validated is what is then read.
 */
export function resolveBackupPath(date: string): string | null {
  if (!isBackupName(date)) return null;
  const candidate = join(BACKUPS_DIR, date);
  try {
    // Refuses a symlink, a file, a socket — anything that is not a directory
    // in its own right.
    if (!lstatSync(candidate).isDirectory()) return null;
    const realRoot = realpathSync(BACKUPS_DIR);
    const realCandidate = realpathSync(candidate);
    // Directly inside, not merely underneath: a backup is always one level
    // down, so there is nothing to gain from accepting deeper paths.
    if (realCandidate !== join(realRoot, date)) return null;
    return realCandidate;
  } catch {
    // Missing, unreadable, or a broken link — all equally not restorable.
    return null;
  }
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
    const workspaceSrc = config.workspaceDir;
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
    const sdkDir = config.sdkSessionsDir;
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
    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
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

    const backupPath = resolveBackupPath(date);
    if (!backupPath) {
      console.error(`Not a restorable backup: ${date}`);
      console.error("Expected YYYY-MM-DD_HHMM naming a real directory directly inside " + BACKUPS_DIR + ".");
      console.error("Run 'tomo backup list' to see available backups.");
      process.exit(1);
      return;
    }

    console.log(`Restore from: ${backupPath}`);
    console.log("This will overwrite current tomo data.\n");

    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }

    // RE-CHECK AFTER THE PROMPT. What survived the checks above is a STRING,
    // and `confirm()` is an unbounded wait — the prompt sits there until a
    // human answers. That window belongs to whoever can write to
    // `~/Backups/tomo`: rename the validated directory away and drop a symlink
    // in its place, and every `existsSync`/`cpSync` below follows the
    // replacement, while the `rmSync`s still delete the live destinations.
    //
    // Re-resolving and requiring the SAME real path collapses the window to
    // the gap between this line and the first copy, which contains no `await`
    // — nothing below yields, so nothing else gets to run in between.
    //
    // RESIDUAL: this is not descriptor pinning. A swap landing inside that
    // gap is still not detected, and closing it properly means holding an
    // `open()` handle on the directory and copying through `openat`-relative
    // operations, which Node's `fs` does not expose. Out of scope here; the
    // re-check turns an indefinite window into an instantaneous one.
    if (resolveBackupPath(date) !== backupPath) {
      console.error(`Backup ${date} changed while waiting for confirmation; aborting without restoring.`);
      process.exit(1);
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
      restoreWorkspaceFromBackup(workspaceSrc, config.workspaceDir);

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
      const sdkDest = config.sdkSessionsDir;
      rmSync(sdkDest, { recursive: true, force: true });
      mkdirSync(sdkDest, { recursive: true });
      cpSync(sdkSrc, sdkDest, { recursive: true });
      console.log("  [ok] sdk-sessions/");
    }

    console.log("\nRestore complete.");
  });
