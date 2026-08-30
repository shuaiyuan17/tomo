import { Command } from "commander";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { config } from "../config.js";
import { restoreWorkspaceFromBackup } from "./backup-workspace.js";
import {
  acquireRestoreLock,
  RestoreLockHeldError,
  restoreLegsStaged,
  StagedRestoreError,
  sweepRestoreLeftovers,
  type RestoreLeg,
} from "./backup-restore.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { isRecordedProcessLive, readPidFileRecord } from "./pidfile.js";

const TOMO_HOME = config.tomoHome;
const PID_FILE = defaultRuntimePaths.pidFile;
const BACKUPS_DIR = join(homedir(), "Backups", "tomo");
// Local backups are one leg of three (local / iCloud / R2), and each one is a
// full copy — they do not dedupe. A daily archive grew from 1.7 GB to 2.8 GB
// over two weeks, so 14 days was holding 32 GB on a disk that was down to 21 GB
// free. Seven days of local history plus the other two legs is the trade we
// picked (2026-08-16). Override with TOMO_BACKUP_RETENTION_DAYS.
export const DEFAULT_RETENTION_DAYS = 7;
/** Ten years. Past this a value is a typo or a units mix-up, not a policy. */
export const MAX_RETENTION_DAYS = 3650;

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
 * Anything not a finite value in [1, MAX_RETENTION_DAYS] falls back to the
 * default and says so — including an empty string, which is how a shell
 * profile most often 'unsets' a variable.
 */
export function resolveRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  // An UPPER bound as well as a lower one. A retention of a million days is
  // not a policy, it is a typo or a units mix-up (milliseconds, seconds), and
  // it disables pruning exactly as thoroughly as NaN did — silently, and with
  // the same unbounded-growth consequence the comment above describes. Ten
  // years is far past any plausible intent.
  if (raw.trim() === "" || !Number.isFinite(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    console.warn(
      `Ignoring TOMO_BACKUP_RETENTION_DAYS=${JSON.stringify(raw)} `
      + `(expected a number of days between 1 and ${MAX_RETENTION_DAYS}); using ${DEFAULT_RETENTION_DAYS}.`,
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
 * A backup directory that passed validation, identified by BOTH its canonical
 * path and its filesystem identity.
 *
 * The path alone is not an identity. `realpathSync` answers "what does this
 * name point at right now", so a directory renamed away and replaced by
 * another ordinary directory at the same pathname resolves to the identical
 * string. `dev`+`ino` is what distinguishes the two.
 */
export interface ResolvedBackup {
  /** Canonical path, symlinks resolved. */
  path: string;
  /** Device id — an inode number is only unique within its filesystem. */
  dev: number;
  /** Inode number, captured at validation time. */
  ino: number;
}

/**
 * Resolve `date` to the directory `restore` may read, or null to refuse.
 *
 * Restore is the most destructive command here: for each of four components it
 * `rmSync`s the live tree and copies the backup's over it. So the argument has
 * to survive four separate questions, not one.
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
 * 4. IDENTITY. `dev`+`ino` from the same `lstat` that answered (2), so the
 *    caller can prove later that it is still looking at the same directory
 *    and not a replacement wearing its name.
 */
export function resolveBackupPath(date: string): ResolvedBackup | null {
  if (!isBackupName(date)) return null;
  const candidate = join(BACKUPS_DIR, date);
  try {
    // Refuses a symlink, a file, a socket — anything that is not a directory
    // in its own right. The same stat supplies the identity below, so the
    // kind and the identity describe ONE entry, not two observations that a
    // swap could straddle. What this does not do is pin the entry: the
    // `realpathSync` that follows is a separate syscall, and a directory
    // renamed in between yields A's identity with B at the path. Node's `fs`
    // has no `openat`, so no sequence of pathname syscalls can close that;
    // it is the same residual as content changing under the copy itself.
    const entry = lstatSync(candidate);
    if (!entry.isDirectory()) return null;
    const realRoot = realpathSync(BACKUPS_DIR);
    const realCandidate = realpathSync(candidate);
    // Directly inside, not merely underneath: a backup is always one level
    // down, so there is nothing to gain from accepting deeper paths.
    if (realCandidate !== join(realRoot, date)) return null;
    return { path: realCandidate, dev: entry.dev, ino: entry.ino };
  } catch {
    // Missing, unreadable, or a broken link — all equally not restorable.
    return null;
  }
}

/**
 * The top-level entries `restore` copies. Checked as a set before any of them
 * is acted on, so an aborted restore has not already half-overwritten.
 */
const RESTORE_LEGS = ["config.json", "workspace", "data", "sdk-sessions"] as const;

/** Same directory, not merely the same name. */
function sameBackup(a: ResolvedBackup, b: ResolvedBackup | null): boolean {
  return b !== null && a.path === b.path && a.dev === b.dev && a.ino === b.ino;
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
      // readPidFileRecord + isRecordedProcessLive, not a bare kill(pid, 0):
      // the pid file carries an identity line (so a whole-file Number() is
      // NaN), and a pid inherited by an unrelated process must not block a
      // restore. isPidAlive also treats EPERM as alive, so a daemon owned by
      // another uid is correctly refused instead of silently restored over.
      const record = readPidFileRecord(PID_FILE);
      if (record && isRecordedProcessLive(record)) {
        console.error("Tomo daemon is running. Run `tomo stop` first.");
        process.exit(1);
      }
    }

    const backup = resolveBackupPath(date);
    if (!backup) {
      console.error(`Not a restorable backup: ${date}`);
      console.error("Expected YYYY-MM-DD_HHMM naming a real directory directly inside " + BACKUPS_DIR + ".");
      console.error("Run 'tomo backup list' to see available backups.");
      process.exit(1);
      return;
    }

    // ONE RESTORE AT A TIME, and the lock is taken BEFORE the leftover sweep
    // and held across the prompt. The sweep moves a parked copy back when the
    // live path is missing — and for the two renames in the middle of another
    // restore's swap, it is missing. See acquireRestoreLock.
    let releaseRestoreLock: () => void;
    try {
      releaseRestoreLock = acquireRestoreLock(TOMO_HOME);
    } catch (err) {
      if (err instanceof RestoreLockHeldError) {
        console.error(`Cannot restore: ${err.message}.`);
        process.exit(1);
        return;
      }
      throw err;
    }

    try {
      console.log(`Restore from: ${backup.path}`);
      console.log("This will overwrite current tomo data.\n");

      const legs: RestoreLeg[] = [];
      const configSrc = join(backup.path, "config.json");
      if (existsSync(configSrc)) {
        legs.push({ label: "config.json", src: configSrc, dest: join(TOMO_HOME, "config.json") });
      }
      const dataSrc = join(backup.path, "data");
      if (existsSync(dataSrc)) {
        legs.push({ label: "data/", src: dataSrc, dest: join(TOMO_HOME, "data") });
      }
      const sdkSrc = join(backup.path, "sdk-sessions");
      if (existsSync(sdkSrc)) {
        legs.push({ label: "sdk-sessions/", src: sdkSrc, dest: config.sdkSessionsDir });
      }

      // BEFORE THE PROMPT, because it is a repair of a PREVIOUS run rather than
      // part of this one: a restore killed mid-swap can leave `~/.tomo/data`
      // absent with a complete copy parked beside it, and declining here should
      // still leave the machine mended rather than broken.
      const leftovers = sweepRestoreLeftovers(
        // Sweep every leg the staged path can own, not just the ones this backup
        // happens to contain — the interrupted run may have had more.
        [
          { label: "config.json", dest: join(TOMO_HOME, "config.json") },
          { label: "data/", dest: join(TOMO_HOME, "data") },
          { label: "sdk-sessions/", dest: config.sdkSessionsDir },
        ],
      );
      if (leftovers.length > 0) {
        console.log("Found leftovers from an interrupted restore:");
        for (const item of leftovers) {
          console.log(`  ${item.recovered ? "[recovered]" : "[left in place]"} ${item.path}`);
        }
        for (const item of leftovers.filter((l) => l.recovered)) {
          console.log(`  ${item.label} was missing and has been restored from the copy above.`);
        }
        console.log("Anything still listed is safe to delete once you have checked it.\n");
      }

      const ok = await confirm("Proceed?");
      if (!ok) {
        console.log("Aborted.");
        return;
      }

      // RE-CHECK AFTER THE PROMPT. What survived the checks above describes the
      // directory as it was, and `confirm()` is an unbounded wait — the prompt
      // sits there until a human answers. That window belongs to whoever can
      // write to `~/Backups/tomo`: swap the validated directory out and every
      // `existsSync`/`cpSync` below follows the replacement, while the `rmSync`s
      // still delete the live destinations.
      //
      // COMPARED BY IDENTITY, NOT BY NAME. Re-resolving and comparing only the
      // canonical path catches a symlink swap but not a directory one: rename
      // the original away, `mkdir` an ordinary directory at the same pathname,
      // and both resolutions return the identical string. `dev`+`ino` is what
      // separates "the same directory" from "something else wearing its name".
      //
      // WHAT THIS DOES AND DOES NOT GUARANTEE. It establishes the identity of
      // the backup DIRECTORY ONLY. Its contents are not validated and are not
      // frozen: a child of the backup can be a symlink pointing anywhere
      // (`<backup>/data -> /tmp/outside/data`), and a file inside it can be
      // rewritten at any moment. Neither needs a race to exploit — a backup
      // directory that was already hostile when it was written stays hostile.
      // The `lstat` sweep below closes the top-level symlink case, which is the
      // cheap half; deep content is out of scope, and `~/Backups/tomo` is
      // trusted to the extent that anything under the invoking user's home is.
      if (!sameBackup(backup, resolveBackupPath(date))) {
        console.error(`Backup ${date} changed while waiting for confirmation; aborting without restoring.`);
        process.exit(1);
        return;
      }

      // Each restore leg is read with `existsSync`, which FOLLOWS a symlink and
      // answers about the target. So a `data` symlink inside an otherwise
      // genuine backup redirects that whole leg out of the tree while the
      // matching `rmSync` still deletes the live one. And a leg of the wrong
      // KIND is just as destructive without any redirection: a regular file
      // named `workspace` passes `existsSync`, the live workspace is deleted,
      // and the file is copied into its place. Both refused here rather than
      // per leg, so the command aborts before it has overwritten anything.
      for (const leg of RESTORE_LEGS) {
        const legPath = join(backup.path, leg);
        let entry;
        try {
          entry = lstatSync(legPath);
        } catch {
          continue; // absent legs are legitimate; each copy is already gated.
        }
        if (entry.isSymbolicLink()) {
          console.error(`Backup ${date} has a symlink at ${leg}; aborting without restoring.`);
          process.exit(1);
          return;
        }
        const wantDir = leg !== "config.json";
        if (wantDir ? !entry.isDirectory() : !entry.isFile()) {
          console.error(
            `Backup ${date} has ${wantDir ? "a non-directory" : "a non-file"} at ${leg}; aborting without restoring.`,
          );
          process.exit(1);
          return;
        }
      }

      console.log();

      // STAGED LEGS FIRST. config.json, data/ and sdk-sessions/ used to be
      // three independent `rmSync` + `cpSync` pairs: the live tree was deleted
      // before anything knew the copy would succeed, and a failure on the third
      // left the first two replaced and the third destroyed. They now go
      // through restoreLegsStaged, which copies everything into siblings and
      // verifies it before a single live byte moves — so the ENOSPC case that
      // motivated this aborts with all three still intact, INCLUDING the
      // workspace below, which is why the staged legs run first.
      try {
        restoreLegsStaged(legs, {
          onLegRestored: (leg) => console.log(`  [ok] ${leg.label}`),
          onWarning: (message) => console.error(`  [warn] ${message}`),
        });
      } catch (err) {
        console.error(`\nRestore failed: ${(err as Error).message}`);
        // "Nothing was replaced" is a claim, and it has to be earned. A rollback
        // that could not put a leg back means something WAS replaced, and the
        // operator needs the path of their original data far more than they need
        // reassurance.
        if (err instanceof StagedRestoreError && !err.rollbackClean) {
          console.error("\nSome components could NOT be rolled back:");
          for (const hint of err.recovery) {
            console.error(`  ${hint.label}: ${hint.dest} now holds ${hint.occupiedBy}.`);
            console.error(`    Your data before this restore is at: ${hint.preRestore}`);
          }
          console.error("\nRecover by moving each path above back over its destination, e.g.");
          const first = err.recovery[0];
          if (first) console.error(`  rm -rf "${first.dest}" && mv "${first.preRestore}" "${first.dest}"`);
        } else {
          console.error("Nothing was replaced — your existing data is as it was.");
        }
        process.exit(1);
        return;
      }

      // workspace/ (preserve .claude/ which is populated by init/start).
      //
      // OUTSIDE THE TRANSACTION ABOVE, deliberately: restoreWorkspaceFromBackup
      // snapshots and rolls back the live `.claude`, which the other legs have
      // no equivalent of, and folding it in would mean rebuilding that. The
      // consequence is stated rather than hidden — if this leg fails, the three
      // staged legs are already restored and are NOT rolled back with it.
      const workspaceSrc = join(backup.path, "workspace");
      if (existsSync(workspaceSrc)) {
        try {
          restoreWorkspaceFromBackup(workspaceSrc, config.workspaceDir);
          console.log("  [ok] workspace/");
        } catch (err) {
          console.error(`  [fail] workspace/: ${(err as Error).message}`);
          const done = legs.map((leg) => leg.label);
          console.error(
            done.length > 0
              ? `\nRestore INCOMPLETE. ${done.join(", ")} ${done.length === 1 ? "was" : "were"} restored;`
              : "\nRestore INCOMPLETE. This backup carried no config.json, data/ or sdk-sessions/;",
          );
          console.error("the workspace was not. It is restored outside that transaction (its live");
          console.error(".claude/ is put back on failure; the rest of the live workspace may be partly");
          console.error(`replaced), so it has not been rolled back. The backup's copy is at ${workspaceSrc}.`);
          process.exit(1);
          return;
        }
      }

      console.log("\nRestore complete.");
    } finally {
      releaseRestoreLock();
    }
  });
