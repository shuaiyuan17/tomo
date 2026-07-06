import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

export interface PauseEntry {
  pausedAt: number;
  /** Display name of the group member who sent /pause. */
  pausedBy?: string;
}

interface PauseFile {
  version: number;
  pauses: Record<string, PauseEntry>;
}

/**
 * Persistence for /pause state — raw group keys whose inbound messages are
 * dropped entirely at receipt (never reach a session, the batcher, or the
 * transcript). Survives daemon restarts; there is no expiry — only /resume
 * lifts a pause. Pass a null filePath for a purely in-memory store (tests).
 */
export class PauseStore {
  private pauses = new Map<string, PauseEntry>();

  constructor(private readonly filePath: string | null) {
    this.load();
  }

  isPaused(rawKey: string): boolean {
    return this.pauses.has(rawKey);
  }

  get(rawKey: string): PauseEntry | undefined {
    return this.pauses.get(rawKey);
  }

  pause(rawKey: string, pausedBy?: string, now = Date.now()): void {
    this.pauses.set(rawKey, { pausedAt: now, pausedBy });
    this.persist();
  }

  /** Lift a pause. Returns false if the key wasn't paused. */
  resume(rawKey: string): boolean {
    const deleted = this.pauses.delete(rawKey);
    if (deleted) this.persist();
    return deleted;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as PauseFile;
      for (const [key, entry] of Object.entries(raw.pauses ?? {})) {
        if (entry && typeof entry.pausedAt === "number") this.pauses.set(key, entry);
      }
    } catch (err) {
      log.warn({ err, file: this.filePath }, "Could not load pauses file; starting empty");
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: PauseFile = { version: 1, pauses: Object.fromEntries(this.pauses) };
      writeJsonAtomicSync(this.filePath, data);
    } catch (err) {
      log.warn({ err, file: this.filePath }, "Could not persist pauses file");
    }
  }
}
