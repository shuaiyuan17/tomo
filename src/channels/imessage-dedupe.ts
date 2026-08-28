import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

export const IMESSAGE_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50_000;

interface DedupeEntry {
  guid: string;
  seenAt: number;
}

interface DedupeFile {
  version: 1;
  entries: DedupeEntry[];
}

interface DedupeOptions {
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * Persistent inbound GUID cache for replayed chat.db message rows. Built for
 * the BlueBubbles backend (removed 2026-08-27), whose message poller scanned a
 * seven-day lookback window; the imsg channel keeps it as a second layer behind
 * its rowid cursor. Persistence is the point: process-local state is
 * insufficient because the source can re-emit an old row after either side
 * restarts.
 */
export class MessageGuidDedupeStore {
  private entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private warnedPersistenceFailure = false;

  constructor(
    private readonly filePath: string | null,
    options: DedupeOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? IMESSAGE_DEDUPE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.load();
  }

  /** Returns true when this GUID is already inside the replay window. */
  checkAndRecord(guid: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.entries.has(guid)) return true;

    this.entries.set(guid, now);
    this.prune(now);
    this.persist();
    return false;
  }

  /**
   * Read-only membership check (no side effects beyond TTL pruning). Split out
   * from `checkAndRecord` so an at-least-once consumer can CHECK before
   * dispatch and only `record()` AFTER a successful hand-off — recording up
   * front then crashing mid-dispatch would drop the message on replay.
   */
  has(guid: string, now = Date.now()): boolean {
    this.prune(now);
    return this.entries.has(guid);
  }

  /** Record a GUID as seen. Idempotent. */
  record(guid: string, now = Date.now()): void {
    if (this.entries.has(guid)) return;
    this.entries.set(guid, now);
    this.prune(now);
    this.persist();
  }

  private prune(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [guid, seenAt] of this.entries) {
      if (seenAt < cutoff) this.entries.delete(guid);
    }

    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.entries.size - this.maxEntries);
    for (const [guid] of oldest) this.entries.delete(guid);
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<DedupeFile>;
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("unsupported dedupe file");
      for (const entry of data.entries) {
        if (!entry || typeof entry.guid !== "string" || !entry.guid || !Number.isFinite(entry.seenAt)) continue;
        this.entries.set(entry.guid, entry.seenAt);
      }
    } catch (err) {
      log.warn({ err, file: this.filePath }, "Could not load iMessage dedupe file; starting empty");
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: DedupeFile = {
        version: 1,
        entries: [...this.entries].map(([guid, seenAt]) => ({ guid, seenAt })),
      };
      writeJsonAtomicSync(this.filePath, data);
      this.warnedPersistenceFailure = false;
    } catch (err) {
      if (!this.warnedPersistenceFailure) {
        log.warn({ err, file: this.filePath }, "Could not persist iMessage dedupe file; using memory only");
        this.warnedPersistenceFailure = true;
      }
    }
  }
}
