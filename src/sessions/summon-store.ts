import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

export interface SummonEntry {
  /** Lowercased identity name whose dm: session owns the group. */
  identity: string;
  summonedAt: number;
  /** Last time a message from the summoned group was routed. Drives expiry. */
  lastActivityAt: number;
}

interface SummonFile {
  version: number;
  summons: Record<string, SummonEntry>;
}

export const DEFAULT_SUMMON_EXPIRY_MS = 60 * 60 * 1000;

/** Activity touches are persisted at most this often per key — a summoned
 *  group's every message updates lastActivityAt in memory, but we don't need
 *  a disk write per message for hour-granularity expiry. */
const TOUCH_PERSIST_INTERVAL_MS = 60_000;

/**
 * Persistence for /summon state (group → dm:<identity> routing overrides).
 * Survives daemon restarts; entries lapse after `expiryMs` of group
 * inactivity (lazily, on next access — there is no timer). Pass a null
 * filePath for a purely in-memory store (tests).
 */
export class SummonStore {
  private summons = new Map<string, SummonEntry>();
  private lastPersistedTouch = new Map<string, number>();

  constructor(
    private readonly filePath: string | null,
    /** Expire after this much group inactivity. <= 0 disables expiry. */
    private readonly expiryMs: number = DEFAULT_SUMMON_EXPIRY_MS,
  ) {
    this.load();
  }

  /** Active entry under `entry`, or a just-lapsed one under `expired` (removed as a side effect). */
  get(rawKey: string, now = Date.now()): { entry?: SummonEntry; expired?: SummonEntry } {
    const entry = this.summons.get(rawKey);
    if (!entry) return {};
    if (this.expiryMs > 0 && now - entry.lastActivityAt > this.expiryMs) {
      this.summons.delete(rawKey);
      this.persist();
      return { expired: entry };
    }
    return { entry };
  }

  set(rawKey: string, identity: string, now = Date.now()): void {
    this.summons.set(rawKey, { identity, summonedAt: now, lastActivityAt: now });
    this.persist();
  }

  delete(rawKey: string): boolean {
    const deleted = this.summons.delete(rawKey);
    if (deleted) this.persist();
    return deleted;
  }

  /** Record group activity (resets the expiry clock). Throttles disk writes. */
  touch(rawKey: string, now = Date.now()): void {
    const entry = this.summons.get(rawKey);
    if (!entry) return;
    entry.lastActivityAt = now;
    const lastPersisted = this.lastPersistedTouch.get(rawKey) ?? 0;
    if (now - lastPersisted >= TOUCH_PERSIST_INTERVAL_MS) {
      this.lastPersistedTouch.set(rawKey, now);
      this.persist();
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as SummonFile;
      for (const [key, entry] of Object.entries(raw.summons ?? {})) {
        if (entry?.identity) this.summons.set(key, entry);
      }
    } catch (err) {
      log.warn({ err, file: this.filePath }, "Could not load summons file; starting empty");
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: SummonFile = { version: 1, summons: Object.fromEntries(this.summons) };
      writeJsonAtomicSync(this.filePath, data);
    } catch (err) {
      log.warn({ err, file: this.filePath }, "Could not persist summons file");
    }
  }
}
