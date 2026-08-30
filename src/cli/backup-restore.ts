import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Staged, all-or-nothing restore of the directory legs of a backup.
 *
 * WHAT THIS REPLACES. `tomo backup restore` used to be, per leg:
 *
 * ```ts
 * rmSync(dataDest, { recursive: true, force: true });
 * cpSync(dataSrc, dataDest, { recursive: true });
 * ```
 *
 * The live tree is deleted before anything knows the copy will succeed, and
 * the legs are independent, so a failure part-way through leaves the machine
 * in a state that exists in no backup: `~/.tomo/data` gone (registry,
 * transcripts, archives, cron jobs, pause/summon state) and the replacement
 * half-written. Restoring a 2.8 GB backup onto a disk with 1 GB free does
 * exactly this — and restore is the command people reach for when something
 * has *already* gone wrong.
 *
 * THE SHAPE OF THE FIX. Copy every leg into a sibling staging directory
 * first, verify each copy, and only then swap: the live tree is renamed aside
 * to `<dest>.pre-restore-<ts>` and the staged tree renamed into place. The
 * aside copies are deleted only once EVERY leg has swapped, so a failure at
 * any point has something to roll back to. Nothing destructive happens until
 * every byte has already been written successfully.
 *
 * WHY SIBLINGS. `rename` is the only operation here that is atomic and cannot
 * half-succeed, and it only works within a filesystem. A staging directory
 * beside its destination is guaranteed to be on the same one; a temp directory
 * under `/tmp` is not, and would silently degrade the swap back into a copy.
 *
 * THE COST, STATED PLAINLY. At the peak, three copies of the data exist at
 * once: the backup, the live tree, and the staged copy. The old code only ever
 * held two, because it deleted the live tree before copying. So a restore that
 * used to *just* fit can now be refused. That is the trade being made
 * deliberately — the old code bought that headroom by destroying the only copy
 * of the live data before it knew the new one would land — and the refusal is
 * now a PRE-FLIGHT (see the free-space check in restoreLegsStaged) that states
 * both numbers before writing anything, rather than an ENOSPC part-way
 * through a copy.
 */

/** One component of a backup: a source inside the backup and where it goes. */
export interface RestoreLeg {
  /** Human label for progress and error messages, e.g. `data/`. */
  label: string;
  /** Path inside the backup directory. */
  src: string;
  /** Live destination path. */
  dest: string;
}

/**
 * Seams for tests. Production uses the `node:fs` defaults; the tests inject a
 * `copy` that throws part-way through to prove the live tree survives, which
 * is not something you can provoke reliably any other way.
 */
export interface StagedRestoreIo {
  copy?: (src: string, dest: string) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  /** Bytes free on the volume holding a path; null disables the check. */
  freeSpace?: (path: string) => number | null;
  /** Timestamp suffix for the staging/pre-restore names. */
  stamp?: string;
  /** Called after each leg is swapped in, for progress output. */
  onLegRestored?: (leg: RestoreLeg) => void;
  /** Non-fatal diagnostics (failed cleanup, rollback trouble). */
  onWarning?: (message: string) => void;
}

/** Copy preserving symlinks — see `measureTree` for why that matters here. */
function defaultCopy(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, dereference: false });
}

/** `existsSync` follows symlinks; a broken link would read as absent. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Entry count and total byte size of a tree, symlinks counted as entries in
 * their own right (never followed).
 *
 * This is the verification, and it is only meaningful because the copy above
 * passes `dereference: false`: source and staging then have identical
 * structure, so identical counts are a real check rather than an approximate
 * one. (`cpSync`'s default, `dereference: true`, would turn one symlink into a
 * whole subtree and make any comparison meaningless.)
 *
 * WHAT THAT DOES AND DOES NOT CHANGE for a real restore: `backup create`
 * copies these legs with `cpSync`'s default (`copyIfExists`, backup.ts:80 —
 * only the skills copy at :287 passes `dereference: false`), so a backup made
 * by tomo contains no symlinks in `data/`, `sdk-sessions/` or `config.json` in
 * the first place. Preserving them here therefore changes nothing for those
 * backups; it matters only for a hand-assembled backup directory, where it is
 * also the safer reading of intent. The asymmetry on the create side is #312's
 * finding 41 and is not addressed by this PR.
 *
 * Deliberately not a checksum: backups carry no manifest to check against, so
 * a hash would only prove the copy matches a source we just read — at the cost
 * of reading every byte a second time. Count plus size catches what actually
 * goes wrong here: a copy that stopped early (ENOSPC, EIO, a killed process).
 */
export function measureTree(path: string): { entries: number; bytes: number } {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { entries: 1, bytes: st.size };

  let entries = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    entries += 1;
    if (entry.isDirectory()) {
      const sub = measureTree(child);
      entries += sub.entries;
      bytes += sub.bytes;
    } else {
      bytes += lstatSync(child).size;
    }
  }
  return { entries, bytes };
}

function defaultStamp(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${process.pid}`;
}

/**
 * A leg whose original data could not be put back where it belongs.
 *
 * Only produced when a rollback fails, which needs an error that persists
 * across two renames in opposite directions (a read-only remount, EIO on the
 * device). Rare — and exactly when the operator must not be told "nothing was
 * replaced", because something was.
 */
export interface RecoveryHint {
  label: string;
  /** The live path, and what is sitting there now. */
  dest: string;
  occupiedBy: "the backup's copy" | "nothing";
  /** Where the original data is. */
  preRestore: string;
}

/**
 * Thrown by {@link restoreLegsStaged}. `rollbackClean` is the question the CLI
 * has to answer before it prints anything reassuring.
 */
export class StagedRestoreError extends Error {
  readonly rollbackClean: boolean;
  readonly recovery: RecoveryHint[];

  constructor(message: string, opts: { cause?: unknown; rollbackClean: boolean; recovery?: RecoveryHint[] }) {
    super(message, { cause: opts.cause });
    this.name = "StagedRestoreError";
    this.rollbackClean = opts.rollbackClean;
    this.recovery = opts.recovery ?? [];
  }
}

/** Bytes free on the filesystem holding `path`, or null if it cannot be read. */
function defaultFreeSpace(path: string): number | null {
  let probe = path;
  // `dest` need not exist yet; walk up to something that does.
  for (let i = 0; i < 40 && !pathExists(probe); i++) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const fs = statfsSync(probe);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface StagedLeg {
  leg: RestoreLeg;
  staging: string;
  /** Where the live tree was moved aside to, or null if there was none. */
  preRestore: string | null;
}

/**
 * Restore every leg, or none of them.
 *
 * Throws on failure. Whatever it throws, the live destinations are either all
 * restored or all exactly as they were — never a mixture, and never missing.
 */
export function restoreLegsStaged(legs: RestoreLeg[], io: StagedRestoreIo = {}): void {
  const copy = io.copy ?? defaultCopy;
  const rename = io.rename ?? renameSync;
  const remove = io.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const stamp = io.stamp ?? defaultStamp();
  const warn = io.onWarning ?? (() => undefined);

  const staged: StagedLeg[] = [];

  // PHASE 0 — is there room? Staging means the copy exists ALONGSIDE the live
  // tree, so the peak requirement is the backup plus the live data plus the
  // staged copy, where the old code freed the live tree's space first. Asking
  // the filesystem up front turns "ENOSPC half-way through a 2.8 GB copy"
  // into a refusal that names both numbers, before anything has been written.
  const freeSpace = io.freeSpace ?? defaultFreeSpace;
  if (legs.length > 0) {
    let needed = 0;
    for (const leg of legs) {
      try {
        needed += measureTree(leg.src).bytes;
      } catch { /* unreadable leg — the copy will report it properly */ }
    }
    const available = freeSpace(dirname(legs[0].dest));
    if (available !== null && available < needed) {
      throw new StagedRestoreError(
        `not enough free space to stage the restore: ${formatBytes(needed)} needed, `
        + `${formatBytes(available)} available on the volume holding ${dirname(legs[0].dest)}. `
        + "Staging keeps your current data in place until the copy has succeeded, so a restore "
        + "needs room for both copies at once.",
        { rollbackClean: true },
      );
    }
  }

  // PHASE 1 — copy and verify. Nothing live is touched here, so any failure
  // is a clean abort: remove the staging trees and leave.
  try {
    for (const leg of legs) {
      const staging = `${leg.dest}.restoring-${stamp}`;
      if (pathExists(staging)) remove(staging);
      mkdirSync(dirname(staging), { recursive: true });
      copy(leg.src, staging);

      const want = measureTree(leg.src);
      const got = measureTree(staging);
      if (want.entries !== got.entries || want.bytes !== got.bytes) {
        throw new Error(
          `${leg.label}: staged copy does not match the backup `
          + `(${got.entries} entries / ${got.bytes} bytes staged, expected ${want.entries} / ${want.bytes})`,
        );
      }

      staged.push({ leg, staging, preRestore: null });
    }
  } catch (err) {
    for (const s of staged) safely(() => remove(s.staging), warn, `remove staging copy ${s.staging}`);
    // The staging directory of the leg that failed, which never made the list.
    for (const leg of legs) {
      const staging = `${leg.dest}.restoring-${stamp}`;
      if (pathExists(staging)) safely(() => remove(staging), warn, `remove staging copy ${staging}`);
    }
    if (err instanceof StagedRestoreError) throw err;
    // Nothing live was touched, so the rollback is vacuously clean.
    throw new StagedRestoreError((err as Error).message, { cause: err, rollbackClean: true });
  }

  // PHASE 2 — swap. Two renames per leg, and rename is the one thing here
  // that cannot half-happen. A failure rolls the already-swapped legs back.
  const swapped: StagedLeg[] = [];
  try {
    for (const s of staged) {
      if (pathExists(s.leg.dest)) {
        s.preRestore = `${s.leg.dest}.pre-restore-${stamp}`;
        if (pathExists(s.preRestore)) remove(s.preRestore);
        rename(s.leg.dest, s.preRestore);
      }
      mkdirSync(dirname(s.leg.dest), { recursive: true });
      rename(s.staging, s.leg.dest);
      swapped.push(s);
      io.onLegRestored?.(s.leg);
    }
  } catch (err) {
    const recovery = rollback(swapped, rename, remove, warn);

    // The leg that failed mid-swap, plus any that never started: put their
    // originals back and clear their staging copies.
    for (const s of staged) {
      if (swapped.includes(s)) continue;
      const parked = s.preRestore;
      if (parked && pathExists(parked) && !pathExists(s.leg.dest)) {
        try {
          rename(parked, s.leg.dest);
          s.preRestore = null;
        } catch (restoreErr) {
          warn(`Could not restore ${s.leg.label} from ${parked}: ${(restoreErr as Error).message}`);
          recovery.push({
            label: s.leg.label,
            dest: s.leg.dest,
            occupiedBy: pathExists(s.leg.dest) ? "the backup's copy" : "nothing",
            preRestore: parked,
          });
        }
      }
      if (pathExists(s.staging)) safely(() => remove(s.staging), warn, `remove staging copy ${s.staging}`);
    }

    throw new StagedRestoreError((err as Error).message, {
      cause: err,
      rollbackClean: recovery.length === 0,
      recovery,
    });
  }

  // PHASE 3 — every leg is in place; only now is the old data expendable.
  for (const s of swapped) {
    if (!s.preRestore) continue;
    safely(() => remove(s.preRestore!), warn, `remove pre-restore copy ${s.preRestore}`);
  }
}

/**
 * Undo the swaps that did happen, newest first, and report anything that could
 * not be undone.
 *
 * THE DESTINATION IS NEVER LEFT EMPTY. The rollback is two renames — restored
 * tree out, original tree back in — and the second can fail on its own (a
 * volume remounted read-only, EIO) after the first succeeded. The earlier
 * version stopped there, leaving the live path ABSENT while the caller printed
 * "nothing was replaced": the worst outcome in the file, and produced by the
 * code that exists to prevent it. Now the restored tree is moved back so
 * something valid occupies the path, and the leg is reported as needing manual
 * recovery with the location of the original.
 *
 * Failures are reported, never thrown: the caller is already throwing the
 * original error, and replacing it with a rollback error would lose the only
 * description of what actually went wrong.
 */
function rollback(
  swapped: StagedLeg[],
  rename: (from: string, to: string) => void,
  remove: (path: string) => void,
  warn: (message: string) => void,
): RecoveryHint[] {
  const recovery: RecoveryHint[] = [];

  for (const s of [...swapped].reverse()) {
    let movedAside = false;
    try {
      if (pathExists(s.leg.dest)) {
        if (pathExists(s.staging)) remove(s.staging);
        rename(s.leg.dest, s.staging);
        movedAside = true;
      }
      if (s.preRestore) rename(s.preRestore, s.leg.dest);
    } catch (err) {
      warn(`Could not roll ${s.leg.label} back: ${(err as Error).message}`);
      if (movedAside && !pathExists(s.leg.dest)) {
        // Put SOMETHING valid back at the live path — the backup's copy is
        // wrong-but-complete, and an absent directory is neither.
        try {
          rename(s.staging, s.leg.dest);
        } catch (putBackErr) {
          warn(`Could not put ${s.leg.label} back at ${s.leg.dest}: ${(putBackErr as Error).message}`);
        }
      }
      if (s.preRestore) {
        recovery.push({
          label: s.leg.label,
          dest: s.leg.dest,
          occupiedBy: pathExists(s.leg.dest) ? "the backup's copy" : "nothing",
          preRestore: s.preRestore,
        });
      }
      continue;
    }
    safely(() => {
      if (pathExists(s.staging)) remove(s.staging);
    }, warn, `remove staging copy ${s.staging}`);
  }

  return recovery;
}

function safely(fn: () => void, warn: (message: string) => void, what: string): void {
  try {
    fn();
  } catch (err) {
    warn(`Could not ${what}: ${(err as Error).message}`);
  }
}

/** What a sweep found — and, for a recovered leg, what it did about it. */
export interface Leftover {
  label: string;
  path: string;
  kind: "staging" | "pre-restore";
  /** True when this was moved back to the live path. */
  recovered: boolean;
}

/**
 * Look for the wreckage of an interrupted restore, and put back anything the
 * live path is missing.
 *
 * A restore that is killed inside phase 2 — `tomo restart`, a laptop lid, an
 * OOM — leaves the live tree parked at `<dest>.pre-restore-<ts>` with either
 * the staged copy or NOTHING at `dest`. Nothing sweeps for that on its own:
 * the stamp carries a pid, so the next run's own guard never matches an
 * earlier run's names, and `~/.tomo/data` would sit absent while a complete
 * copy of it sat beside it under a name nobody reads.
 *
 * Recovery is deliberately limited to the unambiguous case — `dest` missing
 * and exactly one parked copy available. When `dest` exists, the parked copy
 * might be older or newer than what is there and only the operator can say, so
 * it is reported and left alone rather than guessed at.
 */
export function sweepRestoreLeftovers(
  legs: readonly { label: string; dest: string }[],
  io: { rename?: (from: string, to: string) => void } = {},
): Leftover[] {
  const rename = io.rename ?? renameSync;
  const found: Leftover[] = [];

  for (const leg of legs) {
    const dir = dirname(leg.dest);
    const prefix = basename(leg.dest);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    const staging = names.filter((n) => n.startsWith(`${prefix}.restoring-`)).sort();
    // Newest last: the stamp starts YYYYMMDD-HHMMSS, so a lexical sort is
    // chronological.
    const parked = names.filter((n) => n.startsWith(`${prefix}.pre-restore-`)).sort();

    for (const name of staging) {
      found.push({ label: leg.label, path: join(dir, name), kind: "staging", recovered: false });
    }

    for (const [i, name] of parked.entries()) {
      const path = join(dir, name);
      const isNewest = i === parked.length - 1;
      let recovered = false;
      if (isNewest && !pathExists(leg.dest)) {
        try {
          rename(path, leg.dest);
          recovered = true;
        } catch { /* reported below as an un-recovered leftover */ }
      }
      found.push({ label: leg.label, path, kind: "pre-restore", recovered });
    }
  }

  return found;
}
