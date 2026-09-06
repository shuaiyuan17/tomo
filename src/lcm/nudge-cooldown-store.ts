import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

/**
 * Entries older than this are dropped on the next write. A period's cooldown
 * (6h, see runner.ts) is long expired by then, and a past period that has been
 * rolled up never comes due again — so the only thing an old entry does is grow
 * the file.
 */
export const NUDGE_COOLDOWN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tolerance for a timestamp that sits in the future. A little skew is normal
 * (NTP nudges, a file written by a machine seconds ahead); anything beyond this
 * means the clock moved backwards — e.g. a large NTP correction — and the entry
 * is garbage. Without this, a timestamp years ahead would suppress its period
 * until the clock caught up, since the check is `now - last < COOLDOWN`.
 */
export const NUDGE_COOLDOWN_FUTURE_SLACK_MS = 5 * 60 * 1000;

interface NudgeCooldownFile {
  version: number;
  /** `${sessionKey}:${level}:${period}` → epoch ms of the last nudge. */
  nudged: Record<string, number>;
}

const FILE_VERSION = 1;

function isCooldownFile(raw: unknown): raw is NudgeCooldownFile {
  if (typeof raw !== "object" || raw === null) return false;
  const { version, nudged } = raw as Partial<NudgeCooldownFile>;
  return version === FILE_VERSION
    && typeof nudged === "object" && nudged !== null && !Array.isArray(nudged);
}

/** Is this timestamp usable as a cooldown start at `now`? */
function isUsable(ts: unknown, now: number): ts is number {
  return typeof ts === "number" && Number.isFinite(ts)
    && ts <= now + NUDGE_COOLDOWN_FUTURE_SLACK_MS
    && now - ts < NUDGE_COOLDOWN_RETENTION_MS;
}

/**
 * Persistence for the rollup runner's per-period nudge cooldown.
 *
 * The cooldown used to live in a plain in-memory Map, so a daemon restart
 * re-armed every period. Observed 2026-08-29: the daemon restarted at 08:14 and
 * the runner re-nudged `daily 2026-08-28` at 08:16 — one hour after the 07:15
 * nudge, well inside the 6h window — because the Map came back empty.
 *
 * The Map is still the hot path: reads never touch the disk, and a write is one
 * small atomic file rewrite per nudge (at most a handful per hour).
 *
 * Two instances over the same path would otherwise be independent snapshots,
 * each rewriting the whole file from its own view — last writer wins and the
 * other's entries vanish. Two defences:
 *
 *  - `nudgeCooldownStore(path)` returns a process-wide singleton per path, so
 *    everything in one process shares one map (and one corrupt-file warning).
 *  - every write re-reads the file and merges, newest timestamp per key, so a
 *    concurrent or stale writer cannot erase entries it never knew about — and
 *    a store that loaded corruption cannot clobber a file someone just
 *    repaired.
 *
 * Cross-*process* sharing is out of scope: the daemon is the only writer, and
 * the merge means a stray second process degrades to a lost entry at worst,
 * never a corrupt file (writes are atomic rename).
 *
 * Pass a null filePath for a purely in-memory store (tests).
 */
export class NudgeCooldownStore {
  private nudged = new Map<string, number>();

  constructor(private readonly filePath: string | null) {
    this.load();
  }

  /**
   * Epoch ms of the last nudge for this key, or undefined if there is no
   * usable one — never nudged, aged out, or stamped in the future by a clock
   * that has since been corrected backwards.
   */
  get(key: string, now = Date.now()): number | undefined {
    const ts = this.nudged.get(key);
    if (ts === undefined) return undefined;
    if (!isUsable(ts, now)) {
      this.nudged.delete(key);
      return undefined;
    }
    return ts;
  }

  /** Record a nudge and persist (pruning stale entries in the same write). */
  set(key: string, now: number): void {
    this.nudged.set(key, now);
    this.persist(now);
  }

  /**
   * Drop an entry.
   *
   * The runner arms a cooldown BEFORE the nudge turn it debounces (a turn can
   * outlive the hourly tick, and an un-armed period would be re-nudged behind
   * it), so it needs a way to take that back when the turn reports it never
   * ran. A plain map delete is not enough: `persist` merges over the file, so
   * the entry would come straight back from disk on the next write.
   */
  clear(key: string): void {
    this.nudged.delete(key);
    this.persist(Date.now(), key);
  }

  /** Entry count — for tests and diagnostics. */
  size(): number {
    return this.nudged.size;
  }

  /** Read the file into a map. `corrupt` distinguishes unreadable from absent. */
  private read(now: number): { entries: Map<string, number>; corrupt: boolean } {
    const entries = new Map<string, number>();
    if (!this.filePath || !existsSync(this.filePath)) return { entries, corrupt: false };
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      // Valid JSON of the wrong shape (another version, `nudged` that is not a
      // record) is corruption too — silently reading it as empty would hide
      // the problem and then overwrite it as version 1 without a word.
      if (!isCooldownFile(raw)) throw new Error("unexpected shape");
      for (const [key, ts] of Object.entries(raw.nudged)) {
        if (isUsable(ts, now)) entries.set(key, ts);
      }
      return { entries, corrupt: false };
    } catch {
      return { entries: new Map(), corrupt: true };
    }
  }

  /**
   * Missing file = first run. Corrupt/unreadable file = start empty and say so
   * once (load runs exactly once per store, and stores are shared per path);
   * the next nudge rewrites it.
   */
  private load(): void {
    const { entries, corrupt } = this.read(Date.now());
    this.nudged = entries;
    if (corrupt) {
      log.warn({ file: this.filePath }, "Could not load rollup nudge cooldowns; starting empty");
    }
  }

  private persist(now: number, drop?: string): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Read-modify-write: merge our view over whatever is on disk now, keeping
      // the newest timestamp per key. `read` already drops aged-out and
      // future-dated entries, so this is also the prune.
      const merged = this.read(now).entries;
      for (const [key, ts] of this.nudged) {
        if (!isUsable(ts, now)) continue;
        const disk = merged.get(key);
        if (disk === undefined || ts > disk) merged.set(key, ts);
      }
      // Applied after the merge, or the disk copy of a cleared entry would
      // resurrect it — the merge exists to protect entries this store never
      // saw, and a clear is precisely a statement about one it did.
      if (drop !== undefined) merged.delete(drop);
      this.nudged = merged;
      const data: NudgeCooldownFile = { version: FILE_VERSION, nudged: Object.fromEntries(merged) };
      writeJsonAtomicSync(this.filePath, data);
    } catch (err) {
      // Losing the file only costs us the restart guarantee — never a nudge.
      log.warn({ err, file: this.filePath }, "Could not persist rollup nudge cooldowns");
    }
  }
}

const stores = new Map<string, NudgeCooldownStore>();

/**
 * The store for `path`, shared process-wide. Two RollupRunners in one process
 * (or a runner plus a future caller) must not hold independent snapshots of the
 * same file.
 */
export function nudgeCooldownStore(path: string): NudgeCooldownStore {
  const key = resolve(path);
  let store = stores.get(key);
  if (!store) {
    store = new NudgeCooldownStore(key);
    stores.set(key, store);
  }
  return store;
}

/** Drop the shared instances. Only tests need this (a real restart is a process). */
export function resetNudgeCooldownStores(): void {
  stores.clear();
}
