import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
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
  /**
   * Identity of the volume holding a path, so legs on different volumes are
   * each checked against their own free space; null falls back to grouping
   * by parent directory.
   */
  volumeOf?: (path: string) => string | null;
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

/**
 * `existsSync` follows symlinks; a broken link would read as absent. It also
 * turns EVERY error into "absent", and that is the wrong answer for a decision
 * that destroys data: an EIO on the live `config.json` must not read as "there
 * is nothing live here, nothing to park" — the swap would then rename the
 * staged copy over the original with no pre-restore copy, and a later rollback
 * would have nothing to put back while reporting itself clean. Only the two
 * errors that MEAN absent do; anything else propagates to the caller.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * For cleanup after a failure, where a throw would replace the error that
 * matters. "Unknown" reads as "occupied": the cleanup then leaves the path
 * alone, which is the conservative side.
 */
function probablyExists(path: string): boolean {
  try {
    return pathExists(path);
  } catch {
    return true;
  }
}

function occupancy(dest: string): RecoveryHint["occupiedBy"] {
  try {
    return pathExists(dest) ? "the backup's copy" : "nothing";
  } catch {
    return "something that could not be read";
  }
}

/**
 * Entry count, logical size, and an estimate of the ALLOCATED size of a tree,
 * symlinks counted as entries in their own right (never followed).
 *
 * `bytes` is what the files contain. `allocated` is what they cost the
 * filesystem — blocks rather than bytes, and a block for every directory — and
 * is what the free-space pre-flight compares against: a backup of ten thousand
 * one-byte files, or a thousand empty directories, is not "10 KB" to the volume
 * that has to hold it. It is still an estimate (block size differs between the
 * volume measured and the one written to, and a copy un-sparses a sparse
 * file), so it is built as a floor: the logical size is taken wherever it
 * exceeds the block count, never the other way round.
 */
export function measureTree(path: string): { entries: number; bytes: number; allocated: number } {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { entries: 1, bytes: st.size, allocated: allocatedSize(st) };

  let entries = 0;
  let bytes = 0;
  let allocated = DIRECTORY_ALLOWANCE;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    entries += 1;
    if (entry.isDirectory()) {
      const sub = measureTree(child);
      entries += sub.entries;
      bytes += sub.bytes;
      allocated += sub.allocated;
    } else {
      const cst = lstatSync(child);
      bytes += cst.size;
      allocated += allocatedSize(cst);
    }
  }
  return { entries, bytes, allocated };
}

/** One block per directory entry: what a directory costs before it holds anything. */
const DIRECTORY_ALLOWANCE = 4096;

function allocatedSize(st: Stats): number {
  return Math.max(st.size, (st.blocks ?? 0) * 512);
}

/**
 * A structural manifest of a tree: every entry, its kind, and its size or link
 * target, in a fixed order. This is the verification of a staged copy.
 *
 * It is only meaningful because the copy passes `dereference: false`: source
 * and staging then have identical structure, so equal manifests are a real
 * check rather than an approximate one. (`cpSync`'s default, `dereference:
 * true`, would turn one symlink into a whole subtree and make any comparison
 * meaningless.)
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
 * of reading every byte a second time. Shape plus per-entry size catches what
 * actually goes wrong here — a copy that stopped early (ENOSPC, EIO, a killed
 * process), skipped an entry, or inflated a link — and names the entry where
 * it happened. An aggregate count-and-total, which this replaces, could not
 * tell one missing empty directory from one extra one.
 */
export function manifestTree(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string, rel: string): void => {
    const st = lstatSync(path);
    if (st.isDirectory()) {
      out.push(`${rel}\tdir`);
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name), rel === "" ? name : `${rel}/${name}`);
      }
    } else if (st.isSymbolicLink()) {
      out.push(`${rel}\tlink\t${readlinkSync(path)}`);
    } else if (st.isFile()) {
      out.push(`${rel}\tfile\t${st.size}`);
    } else {
      out.push(`${rel}\tother`);
    }
  };
  walk(root, "");
  return out;
}

/** The first entry on which two manifests disagree, worded for a message. */
export function firstDifference(want: string[], got: string[]): string | null {
  const describe = (line: string | undefined): string => {
    if (line === undefined) return "nothing";
    const [rel, kind, extra] = line.split("\t");
    return `${rel === "" ? "." : rel} (${kind}${extra !== undefined ? ` ${extra}` : ""})`;
  };
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (want[i] === got[i]) continue;
    return `expected ${describe(want[i])}, staged ${describe(got[i])}`;
  }
  return null;
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
  occupiedBy: "the backup's copy" | "nothing" | "something that could not be read";
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

/** `dest` need not exist yet; the nearest ancestor that does stands in for it. */
function nearestExisting(path: string): string {
  let probe = path;
  for (let i = 0; i < 40; i++) {
    try {
      lstatSync(probe);
      return probe;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return probe;
      probe = parent;
    }
  }
  return probe;
}

/** Bytes free on the filesystem holding `path`, or null if it cannot be read. */
function defaultFreeSpace(path: string): number | null {
  try {
    const fs = statfsSync(nearestExisting(path));
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

/** The device holding `path` — two paths with the same one share free space. */
function defaultVolumeOf(path: string): string | null {
  try {
    return String(statSync(nearestExisting(path)).dev);
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
  //
  // PER VOLUME. `config.sdkSessionsDir` is configurable and can sit on a
  // different disk from `~/.tomo`; the sum of every leg checked against one
  // volume would pass on a roomy first disk while the second one fills, or
  // refuse because the first cannot hold bytes that were never going there.
  const freeSpace = io.freeSpace ?? defaultFreeSpace;
  const volumeOf = io.volumeOf ?? defaultVolumeOf;
  const volumes = new Map<string, { at: string; needed: number }>();
  for (const leg of legs) {
    const at = dirname(leg.dest);
    const key = volumeOf(at) ?? `path:${at}`;
    const volume = volumes.get(key) ?? { at, needed: 0 };
    try {
      volume.needed += measureTree(leg.src).allocated;
    } catch { /* unreadable leg — the copy will report it properly */ }
    volumes.set(key, volume);
  }
  for (const volume of volumes.values()) {
    const available = freeSpace(volume.at);
    if (available !== null && available < volume.needed) {
      throw new StagedRestoreError(
        `not enough free space to stage the restore: at least ${formatBytes(volume.needed)} needed, `
        + `${formatBytes(available)} available on the volume holding ${volume.at}. `
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

      const difference = firstDifference(manifestTree(leg.src), manifestTree(staging));
      if (difference !== null) {
        throw new Error(`${leg.label}: staged copy does not match the backup (${difference})`);
      }

      staged.push({ leg, staging, preRestore: null });
    }
  } catch (err) {
    for (const s of staged) safely(() => remove(s.staging), warn, `remove staging copy ${s.staging}`);
    // The staging directory of the leg that failed, which never made the list.
    for (const leg of legs) {
      const staging = `${leg.dest}.restoring-${stamp}`;
      if (probablyExists(staging)) safely(() => remove(staging), warn, `remove staging copy ${staging}`);
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
      if (parked && probablyExists(parked)) {
        // Strict on purpose: putting the original back is a rename ONTO the
        // live path, and for a file leg that overwrites whatever is there.
        // "Could not read it" is not "nothing is there".
        let destState: "absent" | "occupied" | "unknown";
        try {
          destState = pathExists(s.leg.dest) ? "occupied" : "absent";
        } catch {
          destState = "unknown";
        }
        if (destState === "absent") {
          try {
            rename(parked, s.leg.dest);
            s.preRestore = null;
          } catch (restoreErr) {
            warn(`Could not restore ${s.leg.label} from ${parked}: ${(restoreErr as Error).message}`);
            recovery.push({ label: s.leg.label, dest: s.leg.dest, occupiedBy: occupancy(s.leg.dest), preRestore: parked });
          }
        } else if (destState === "unknown") {
          warn(`Could not tell what is at ${s.leg.dest}; leaving ${parked} where it is`);
          recovery.push({
            label: s.leg.label,
            dest: s.leg.dest,
            occupiedBy: "something that could not be read",
            preRestore: parked,
          });
        }
      }
      if (probablyExists(s.staging)) safely(() => remove(s.staging), warn, `remove staging copy ${s.staging}`);
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
      if (movedAside && !probablyExists(s.leg.dest)) {
        // Put SOMETHING valid back at the live path — the backup's copy is
        // wrong-but-complete, and an absent directory is neither.
        try {
          rename(s.staging, s.leg.dest);
        } catch (putBackErr) {
          warn(`Could not put ${s.leg.label} back at ${s.leg.dest}: ${(putBackErr as Error).message}`);
        }
      }
      if (s.preRestore) {
        recovery.push({ label: s.leg.label, dest: s.leg.dest, occupiedBy: occupancy(s.leg.dest), preRestore: s.preRestore });
      }
      continue;
    }
    safely(() => {
      if (probablyExists(s.staging)) remove(s.staging);
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
 * and EXACTLY ONE parked copy available. When `dest` exists, the parked copy
 * might be older or newer than what is there and only the operator can say;
 * when two are parked, two restores were interrupted, and stamps from the same
 * second cannot even be ordered. Both are reported and left alone rather than
 * guessed at.
 *
 * NAMES ARE PARSED, NOT PREFIX-MATCHED. Anything this moves onto a live path
 * becomes the live data, so only a name this module could have written — the
 * exact `<dest>.pre-restore-YYYYMMDD-HHMMSS-<pid>` shape — qualifies. A user's
 * own `data.pre-restore-old` is not a candidate, and is not even reported.
 *
 * NOT SAFE TO RUN BESIDE ANOTHER RESTORE, and the caller must not: between
 * the two renames of a swap the live path IS missing, and this would move the
 * other run's parked original back. That is what {@link acquireRestoreLock}
 * is for.
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

    const staging = leftoverNames(names, `${prefix}.restoring-`);
    const parked = leftoverNames(names, `${prefix}.pre-restore-`);

    for (const item of staging) {
      found.push({ label: leg.label, path: join(dir, item.name), kind: "staging", recovered: false });
    }

    let destMissing = false;
    if (parked.length === 1) {
      try {
        destMissing = !pathExists(leg.dest);
      } catch {
        destMissing = false; // unreadable is not absent; report, do not move.
      }
    }
    for (const item of parked) {
      const path = join(dir, item.name);
      let recovered = false;
      if (destMissing) {
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

/** The suffix `defaultStamp` writes: `YYYYMMDD-HHMMSS-<pid>`. */
const STAMP = /^(\d{8}-\d{6})-(\d+)$/;

/** Names under `prefix` that carry a well-formed stamp, oldest first. */
function leftoverNames(names: string[], prefix: string): { name: string; stamp: string; pid: number }[] {
  const out: { name: string; stamp: string; pid: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = STAMP.exec(name.slice(prefix.length));
    if (!m) continue;
    out.push({ name, stamp: m[1], pid: Number(m[2]) });
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.pid - b.pid);
}

// --------------------------------------------------------------------------
// One restore at a time
// --------------------------------------------------------------------------

/** The lock is held by a restore that is still running. */
export class RestoreLockHeldError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | null;

  constructor(lockPath: string, holderPid: number | null) {
    super(
      `another restore is in progress${holderPid === null ? "" : ` (pid ${holderPid})`}; `
      + `if it is not, remove ${lockPath}`,
    );
    this.name = "RestoreLockHeldError";
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

/**
 * A lock that has existed for less than this and carries no readable pid is
 * one whose creator is between `open` and `write` — held, not abandoned.
 */
const LOCK_WRITE_GRACE_MS = 5_000;

/**
 * Serialize restores on one `~/.tomo`. Returns the release function.
 *
 * WHY. {@link sweepRestoreLeftovers} repairs a PREVIOUS run's interrupted
 * swap by moving a parked copy back when the live path is missing. Between
 * "live tree renamed aside" and "staged tree renamed in" — two syscalls in the
 * middle of every swap — the live path IS missing, and a second
 * `tomo backup restore` starting at that instant would move the first one's
 * parked original back; the first's swap then renames over it, and its
 * rollback has nothing left to roll back to. The daemon-running check does not
 * serialize two CLIs. This does.
 *
 * STALENESS BY PID, DELIBERATELY. A restore of many gigabytes legitimately
 * runs for a long time, so no age is a safe threshold. A liveness check errs in
 * one direction only: a recycled pid reads as "alive" and the restore is
 * REFUSED, with the lock path in the message — the conservative outcome. It
 * cannot read a running restore as dead.
 *
 * TAKEOVER BY RENAME. Two takers judging the same lock stale must not both
 * "unlink and create": the second unlink would remove the first's fresh lock.
 * Renaming the stale file aside gives exactly one winner; the loser's create
 * then meets the winner's lock and refuses.
 */
export function acquireRestoreLock(
  dir: string,
  io: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): () => void {
  const lockPath = join(dir, "restore.lock");
  const pid = io.pid ?? process.pid;
  const isAlive = io.isAlive ?? defaultIsAlive;
  mkdirSync(dir, { recursive: true });

  const tryCreate = (): boolean => {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  if (!tryCreate()) {
    const holder = readLockPid(lockPath);
    if (holder !== null && isAlive(holder)) throw new RestoreLockHeldError(lockPath, holder);
    if (holder === null && lockAgeMs(lockPath) < LOCK_WRITE_GRACE_MS) throw new RestoreLockHeldError(lockPath, null);

    const claimed = `${lockPath}.stale-${pid}`;
    try {
      renameSync(lockPath, claimed);
      rmSync(claimed, { force: true });
    } catch { /* someone else claimed it first, or it vanished; the create below decides */ }
    if (!tryCreate()) throw new RestoreLockHeldError(lockPath, readLockPid(lockPath));
  }

  return () => {
    try {
      if (readLockPid(lockPath) === pid) unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
}

function readLockPid(lockPath: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to someone else. Anything else: gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
