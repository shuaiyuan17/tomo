import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

/**
 * Entries older than this are dropped on the next write. A period's cooldown
 * (6h, see runner.ts) is long expired by then, and a past period that has been
 * rolled up never comes due again — so the only thing an old entry does is grow
 * the file.
 */
export const NUDGE_COOLDOWN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface NudgeCooldownFile {
  version: number;
  /** `${sessionKey}:${level}:${period}` → epoch ms of the last nudge. */
  nudged: Record<string, number>;
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
 * Pass a null filePath for a purely in-memory store (tests).
 */
export class NudgeCooldownStore {
  private nudged = new Map<string, number>();

  constructor(private readonly filePath: string | null) {
    this.load();
  }

  /** Epoch ms of the last nudge for this key, or undefined if never nudged. */
  get(key: string): number | undefined {
    return this.nudged.get(key);
  }

  /** Record a nudge and persist (pruning stale entries in the same write). */
  set(key: string, now: number): void {
    this.nudged.set(key, now);
    this.prune(now);
    this.persist();
  }

  /** Entry count — for tests and diagnostics. */
  size(): number {
    return this.nudged.size;
  }

  private prune(now: number): void {
    for (const [key, ts] of this.nudged) {
      if (!(now - ts < NUDGE_COOLDOWN_RETENTION_MS)) this.nudged.delete(key);
    }
  }

  /**
   * Missing file = first run. Corrupt/unreadable file = start empty and say so
   * once (load runs exactly once, at construction); the next nudge rewrites it.
   */
  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as NudgeCooldownFile;
      for (const [key, ts] of Object.entries(raw?.nudged ?? {})) {
        if (typeof ts === "number" && Number.isFinite(ts)) this.nudged.set(key, ts);
      }
    } catch (err) {
      this.nudged.clear();
      log.warn({ err, file: this.filePath }, "Could not load rollup nudge cooldowns; starting empty");
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: NudgeCooldownFile = { version: 1, nudged: Object.fromEntries(this.nudged) };
      writeJsonAtomicSync(this.filePath, data);
    } catch (err) {
      // Losing the file only costs us the restart guarantee — never a nudge.
      log.warn({ err, file: this.filePath }, "Could not persist rollup nudge cooldowns");
    }
  }
}
