import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
 * THE COST, STATED PLAINLY. Staging means the copy exists alongside the live
 * tree, so a restore now needs room for both — where the old code freed the
 * live tree's space first. A restore that used to *just* fit may now fail with
 * ENOSPC. That is the trade being made deliberately: the old code bought that
 * headroom by destroying the only copy of the live data before it knew the new
 * one would land. Failing while everything is still intact is the better half
 * of that bargain, and the error names the leg it died on.
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
 * whole subtree and make any comparison meaningless — as well as silently
 * inflating a restore, which is a separate note in #312's finding 41.)
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
    throw err;
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
    rollback(swapped, rename, remove, warn);
    // Legs that never swapped still have a staging copy to clear away.
    for (const s of staged) {
      if (swapped.includes(s)) continue;
      if (pathExists(s.staging)) safely(() => remove(s.staging), warn, `remove staging copy ${s.staging}`);
      if (s.preRestore && pathExists(s.preRestore)) {
        safely(() => rename(s.preRestore!, s.leg.dest), warn, `restore ${s.leg.label} from ${s.preRestore}`);
      }
    }
    throw err;
  }

  // PHASE 3 — every leg is in place; only now is the old data expendable.
  for (const s of swapped) {
    if (!s.preRestore) continue;
    safely(() => remove(s.preRestore!), warn, `remove pre-restore copy ${s.preRestore}`);
  }
}

/**
 * Undo the swaps that did happen, newest first: move the restored tree back to
 * its staging name and the live tree back to where it was.
 *
 * A failure in here is reported, never thrown — the caller is already throwing
 * the original error, and hiding it behind a rollback error would lose the
 * only description of what actually went wrong. The warning names the
 * pre-restore path so the data is recoverable by hand in the worst case.
 */
function rollback(
  swapped: StagedLeg[],
  rename: (from: string, to: string) => void,
  remove: (path: string) => void,
  warn: (message: string) => void,
): void {
  for (const s of [...swapped].reverse()) {
    safely(() => {
      if (pathExists(s.leg.dest)) {
        if (pathExists(s.staging)) remove(s.staging);
        rename(s.leg.dest, s.staging);
      }
      if (s.preRestore) rename(s.preRestore, s.leg.dest);
    }, warn, `roll ${s.leg.label} back${s.preRestore ? ` from ${s.preRestore}` : ""}`);
    safely(() => {
      if (pathExists(s.staging)) remove(s.staging);
    }, warn, `remove staging copy ${s.staging}`);
  }
}

function safely(fn: () => void, warn: (message: string) => void, what: string): void {
  try {
    fn();
  } catch (err) {
    warn(`Could not ${what}: ${(err as Error).message}`);
  }
}
