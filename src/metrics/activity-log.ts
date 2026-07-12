import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { log } from "../logger.js";
import { watchBus, type WatchBus } from "../watch/bus.js";
import type { WatchEvent } from "../watch/protocol.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 2;

export interface ActivityLogOptions {
  /** NDJSON file path, e.g. ~/.tomo/logs/activity.ndjson. */
  path: string;
  bus?: WatchBus;
  /** When false, transcript message text is replaced by its length. Turn this
   *  off if the log is shipped anywhere off this machine. Default true. */
  includeMessageText?: boolean;
  /** Rotate once the live file passes this size. */
  maxBytes?: number;
  /** Rotated files kept as <path>.1 … <path>.N. */
  maxRotatedFiles?: number;
}

/**
 * Activity feed for log shippers (Loki via Alloy/promtail): every WatchBus
 * event as one NDJSON line, size-rotated. This is the same stream the
 * `tomo watch` TUI renders, in a form Grafana can tail, label, and query.
 *
 * Writes are synchronous appends — bus event rates are a few lines per turn,
 * and a subscriber that buffered asynchronously could drop the tail on
 * daemon shutdown.
 */
export class ActivityLog {
  private readonly bus: WatchBus;
  private readonly includeMessageText: boolean;
  private readonly maxBytes: number;
  private readonly maxRotatedFiles: number;
  private unsubscribe: (() => void) | null = null;
  private bytesWritten = 0;
  /** After a write failure, stay quiet until something succeeds again —
   *  logging per event would flood the daemon log (and the bus). */
  private writeBroken = false;
  /** Same for rotation failures — and load-bearing, not just politeness:
   *  log.warn publishes an issue event back onto the watch bus, which
   *  re-enters write() while still over the size threshold. Without the
   *  guard a persistent rotation failure recurses until the stack blows. */
  private rotationBroken = false;

  constructor(private readonly options: ActivityLogOptions) {
    this.bus = options.bus ?? watchBus;
    this.includeMessageText = options.includeMessageText ?? true;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;
  }

  start(): void {
    try {
      this.bytesWritten = existsSync(this.options.path) ? statSync(this.options.path).size : 0;
    } catch {
      this.bytesWritten = 0;
    }
    this.unsubscribe = this.bus.subscribe((event) => this.write(event));
    log.info({ path: this.options.path }, "Activity log started");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private write(event: WatchEvent): void {
    const line = JSON.stringify(this.redact(event)) + "\n";
    try {
      if (this.bytesWritten + line.length > this.maxBytes) this.rotate();
      appendFileSync(this.options.path, line, "utf-8");
      this.bytesWritten += Buffer.byteLength(line);
      this.writeBroken = false;
    } catch (err) {
      if (!this.writeBroken) {
        this.writeBroken = true;
        log.warn({ err, path: this.options.path }, "Activity log write failed; suppressing further warnings");
      }
    }
  }

  private redact(event: WatchEvent): WatchEvent | Record<string, unknown> {
    if (event.type === "transcript" && !this.includeMessageText) {
      const { text, ...rest } = event;
      return { ...rest, textChars: text.length };
    }
    return event;
  }

  private rotate(): void {
    const { path } = this.options;
    const rotated = (n: number) => `${path}.${n}`;
    try {
      if (existsSync(rotated(this.maxRotatedFiles))) unlinkSync(rotated(this.maxRotatedFiles));
      for (let n = this.maxRotatedFiles - 1; n >= 1; n--) {
        if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1));
      }
      if (existsSync(path)) renameSync(path, rotated(1));
    } catch (err) {
      // Rotation failing must not stop the feed; keep appending to the live
      // file and try rotating again on the next over-size write. Set the
      // guard BEFORE logging: the warning itself re-enters write() via the
      // logger's watch-bus issue tap.
      if (!this.rotationBroken) {
        this.rotationBroken = true;
        log.warn({ err, path }, "Activity log rotation failed; suppressing further warnings");
      }
      return;
    }
    this.rotationBroken = false;
    this.bytesWritten = 0;
  }
}
