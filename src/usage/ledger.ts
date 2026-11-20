import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";
import { scrubSecretValues } from "../redact.js";
import { appendLineSerial } from "./append.js";
import type { ModelTurnUsage } from "../agent/sdk-result.js";
import type { UsageBaseline } from "../sessions/types.js";
import { parseTomoEvent } from "../tomo-event.js";
import { errorMessage } from "../error-text.js";

/**
 * Usage ledger: one NDJSON line per SDK result, appended to
 * `<dir>/YYYY-MM.ndjson` (local month of the result). Append-only and never
 * rotated — the Study Cost page reads it as its history, so unlike the
 * optional, size-rotated activity log it is always on and kept forever.
 *
 * Bookkeeping only: a failed write is a warn, never a failed turn.
 *
 * Writes go through `appendLineSerial`: every append to the same month file
 * runs after the previous one, in call order, so rows from concurrent
 * sessions land whole and in order. Values are written as the SDK reported
 * them (deltas unrounded); rounding is for display.
 */
export const USAGE_LEDGER_VERSION = 1;

/**
 * Who started the turn.
 *  - `owner` / `group`: a message in the owner's DM (web, watch chat
 *    included) / in a group chat;
 *  - `cron`: a scheduled job (`jobId`, `jobName` set);
 *  - `system`: harness-made cron-path turns with no job — LCM rollups,
 *    context nudges, undelivered-reply restates;
 *  - `delegate`: `send_message(mode: "delegate")` from another session;
 *  - `heartbeat` / `restart`: continuity turns;
 *  - `background`: a turn the CLI started itself (a background task's report).
 */
export type UsageSource = "owner" | "group" | "cron" | "system" | "delegate" | "heartbeat" | "restart" | "background";

/** The Cost page's three buckets ("You" / "Background" / "Scheduled"). */
export type UsageCategory = "you" | "background" | "scheduled";

export function usageCategory(source: UsageSource): UsageCategory {
  switch (source) {
    case "owner":
    case "group":
      return "you";
    case "cron":
    case "system":
    case "delegate":
      return "scheduled";
    default:
      return "background";
  }
}

/** What the turn's caller knows about it; rides on ReplyContext into LiveSession. */
export interface UsageAttribution {
  source: UsageSource;
  jobId?: string;
  jobName?: string;
  /** Start of the message that triggered the turn (see triggerSnippet). */
  trigger?: string;
}

export interface UsageLedgerRow {
  v: typeof USAGE_LEDGER_VERSION;
  /** ms epoch when the result arrived. */
  ts: number;
  sessionKey: string;
  source: UsageSource;
  jobId?: string;
  jobName?: string;
  /** Web request id, when the turn answers one. */
  requestId?: string;
  trigger?: string;
  /** Result subtype when it was not `success`. */
  subtype?: string;
  /** This turn's estimated cost (delta of the SDK's cumulative total). */
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreated: number };
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /**
   * First result after a resume with no usable baseline: `costUsd` is 0 and
   * `tokens` are the main loop's only — an undercount, not a measurement.
   */
  noBaseline?: true;
  /**
   * This turn per model. Absent when it cannot be split: no `modelUsage` on
   * the result, `noBaseline`, or a resume from a baseline written before
   * per-model usage existed.
   */
  models?: Record<string, ModelTurnUsage>;
  /**
   * Tool calls the main loop made this turn (root `tool_use` blocks;
   * subagents' own calls are not counted). Absent on rows written before it
   * existed.
   */
  tools?: number;
  /**
   * Rebuilt by `tomo usage backfill` from the activity log, not written when
   * the result arrived: cost, timings and attribution only — `tokens` are
   * zeros (the activity log never had them) and there is no `models` or
   * `snapshot`.
   */
  backfilled?: true;
  /** A backfilled row's id (backfillRowId): what a later backfill merges by. */
  backfillId?: string;
  /**
   * Before the fix of #389 (2026-09-23): a resumed session's first turn was
   * charged the session's whole history, so `costUsd` is too high. Kept, shown
   * marked, and left out of every comparison.
   */
  overcounted?: true;
  /** The SDK session the result belongs to. */
  sdkSessionId?: string;
  /**
   * The SDK's cumulative counters at the end of this turn (totals and per
   * model): THE baseline a resume of `sdkSessionId` starts from (see
   * UsageLedger.lastSnapshot). Absent when they cannot be trusted as one (the
   * totals just reset, or the result carried none), which sends that resume
   * down the no-baseline path.
   */
  snapshot?: UsageBaseline;
}

export const TRIGGER_MAX_CHARS = 80;

/**
 * The first TRIGGER_MAX_CHARS characters of a turn's prompt, for "the most
 * expensive turns". A harness envelope (`<tomo-event>`) is unwrapped to its
 * body so a cron turn reads as its task, not as markup. Credentials are
 * scrubbed (`scrubSecretValues`): the ledger holds every session's snippets,
 * DMs included, in one file.
 */
export function triggerSnippet(prompt: string): string | undefined {
  // Scrubbed BEFORE clipping: a credential cut in half at the 80th character
  // no longer has the shape the scrubber recognises.
  const text = scrubSecretValues((parseTomoEvent(prompt)?.body ?? prompt).replace(/\s+/g, " ").trim());
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > TRIGGER_MAX_CHARS ? chars.slice(0, TRIGGER_MAX_CHARS).join("") : text;
}

/** `YYYY-MM.ndjson` for the local month of `ts`. */
export function ledgerFileName(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.ndjson`;
}

/** Owner-only: the ledger mixes every session's trigger snippets. */
export const LEDGER_FILE_MODE = 0o600;
export const LEDGER_DIR_MODE = 0o700;

/**
 * Called once per SDK result. `build` makes the row when its turn in the
 * session's write queue comes (so it can measure against the last row that
 * landed); `onWritten` runs once that row is on disk, before the session's
 * next `build`. A row that fails never calls it.
 */
export type UsageRecorder = (build: () => UsageLedgerRow | undefined, onWritten: () => void) => void;

/** How many month files a baseline lookup reads back before giving up. */
const SNAPSHOT_LOOKBACK_FILES = 3;

export class UsageLedger {
  /** After a failure, warn once until a write succeeds again. */
  private failing = false;
  /** The directory's mode has been tightened (it may predate the ledger). */
  private dirSecured = false;
  /** Appends not yet settled (see idle). */
  private readonly pending = new Set<Promise<void>>();

  /** `dir`: the usage data directory (`usageDataDir`). */
  constructor(private readonly dir: string) {}

  /** Each session's rows, written one after another. */
  private readonly sessionChains = new Map<string, Promise<void>>();
  /** sessionKey + sdkSessionId → the snapshot of the last row that landed this process. */
  private readonly landed = new Map<string, UsageBaseline | null>();

  /**
   * Record, once ever, when the ledger first started (LEDGER_STARTED_FILE).
   * `tomo usage backfill` rebuilds history only from before it: from then on
   * every turn is the ledger's, a row that failed to land included (its cost
   * rides on the next row), so nothing after it may come from elsewhere.
   * Called at daemon start, before any turn. Never throws.
   */
  markStarted(now = Date.now()): void {
    try {
      writeLedgerStarted(this.dir, now);
    } catch (err) {
      log.warn({ err: errorMessage(err), dir: this.dir }, "Could not record when the usage ledger started");
    }
  }

  /** Queue a ready row. See appendFor. */
  append(row: UsageLedgerRow, onWritten?: () => void): Promise<void> {
    return this.appendFor(row.sessionKey, () => row, onWritten);
  }

  /**
   * Queue one row for `sessionKey`. Rows of one session are written strictly
   * one after another, whatever month file they go to: `build` runs only once
   * the previous row has landed or failed, and `onWritten` right after this
   * one lands. Never throws and never rejects: callers fire and forget.
   */
  appendFor(sessionKey: string, build: () => UsageLedgerRow | undefined, onWritten?: () => void): Promise<void> {
    const previous = this.sessionChains.get(sessionKey) ?? Promise.resolve();
    const write = previous.then(() => this.writeOne(build, onWritten));
    this.sessionChains.set(sessionKey, write);
    this.pending.add(write);
    void write.finally(() => {
      this.pending.delete(write);
      if (this.sessionChains.get(sessionKey) === write) this.sessionChains.delete(sessionKey);
    });
    return write;
  }

  private async writeOne(build: () => UsageLedgerRow | undefined, onWritten?: () => void): Promise<void> {
    let row: UsageLedgerRow | undefined;
    let line: string;
    try {
      row = build();
      if (!row) return;
      line = JSON.stringify(row);
    } catch (err) {
      this.warn(err, row?.sessionKey);
      return;
    }
    const landedRow = row;
    const path = join(this.dir, ledgerFileName(row.ts));
    try {
      await appendLineSerial(path, () => line, () => {
        this.failing = false;
        if (landedRow.sdkSessionId) this.landed.set(snapshotKey(landedRow.sessionKey, landedRow.sdkSessionId), landedRow.snapshot ?? null);
        onWritten?.();
      }, { fileMode: LEDGER_FILE_MODE, dirMode: LEDGER_DIR_MODE });
      await this.secureDir();
    } catch (err) {
      this.warn(err, row.sessionKey);
    }
  }

  /**
   * The baseline a resume of `sdkSessionId` on `sessionKey` starts from,
   * read from the ledger: the snapshot of that session's last row that
   * parses. `null`: that row says the counters cannot be trusted (resume on
   * the no-baseline path). `undefined`: the ledger has no row for it within
   * the look-back (the caller may fall back to the registry's copy).
   *
   * A torn or corrupt line — a crash mid-append — is skipped, so the lookup
   * falls back to the row before it. Rows that never landed are not here, so
   * a failed append leaves the baseline where it was and the next row
   * carries that turn. Call after `idle()` so rows still queued count.
   */
  lastSnapshot(sessionKey: string, sdkSessionId: string): UsageBaseline | null | undefined {
    const key = snapshotKey(sessionKey, sdkSessionId);
    if (this.landed.has(key)) return this.landed.get(key) ?? null;
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => LEDGER_FILE_RE.test(f)).sort().reverse().slice(0, SNAPSHOT_LOOKBACK_FILES);
    } catch {
      return undefined;
    }
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(this.dir, file), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes(sdkSessionId)) continue;
        let row: Partial<UsageLedgerRow>;
        try {
          row = JSON.parse(line) as Partial<UsageLedgerRow>;
        } catch {
          continue;
        }
        if (row.sessionKey !== sessionKey || row.sdkSessionId !== sdkSessionId) continue;
        const snap = row.snapshot;
        return snap && snap.sdkSessionId === sdkSessionId && typeof snap.totalCostUsd === "number" && snap.tokens ? snap : null;
      }
    }
    return undefined;
  }

  /**
   * Creation modes do not touch what already exists: the usage directory is
   * shared with limits-log and may have been made 0755 before the ledger.
   * Tightened once. (A month file wider than 0600 is tightened by
   * appendLineSerial, before the row is written.)
   */
  private async secureDir(): Promise<void> {
    if (!this.dirSecured) {
      await chmod(this.dir, LEDGER_DIR_MODE);
      this.dirSecured = true;
    }
  }

  /** Resolves once every row appended so far has landed (or failed). Shutdown waits on it. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private warn(err: unknown, sessionKey: string | undefined): void {
    if (this.failing) return;
    this.failing = true;
    log.warn(
      { err: errorMessage(err), dir: this.dir, sessionKey },
      "Could not write the usage ledger; this turn's usage is not recorded",
    );
  }
}

/** `<usage dir>/backfill.ndjson`: history rebuilt by `tomo usage backfill`, replaced whole on each run. */
export const BACKFILL_FILE = "backfill.ndjson";

/** `<usage dir>/ledger-started.json`: `{ v: 1, startedAt: <ms epoch> }`, written once ever. */
export const LEDGER_STARTED_FILE = "ledger-started.json";

/**
 * Write the start marker unless it exists (O_EXCL: the first writer wins,
 * an existing marker is never moved). A ledger that already has rows — it
 * ran before the marker existed — is dated by its earliest row instead.
 * Returns the marker's time.
 */
export function writeLedgerStarted(dir: string, now: number): number {
  const existing = readLedgerStarted(dir);
  if (existing !== undefined) return existing;
  let startedAt = now;
  try {
    for (const file of readdirSync(dir).filter((f) => LEDGER_FILE_RE.test(f)).sort().slice(0, 1)) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        try {
          const ts = (JSON.parse(line) as { ts?: unknown }).ts;
          if (typeof ts === "number" && Number.isFinite(ts) && ts < startedAt) startedAt = ts;
        } catch { /* torn line */ }
      }
    }
  } catch { /* no directory yet */ }
  mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
  // Whole or absent: written and synced under a temporary name, then linked
  // into place — link(2) fails if the marker exists, so the first writer wins.
  const marker = join(dir, LEDGER_STARTED_FILE);
  const tmp = `${marker}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", LEDGER_FILE_MODE);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, startedAt })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readLedgerStarted(dir) ?? startedAt;
  } finally {
    rmSync(tmp, { force: true });
  }
  return startedAt;
}

/** When the ledger first started (ms epoch); undefined: never, or the marker is unreadable. */
export function readLedgerStarted(dir: string): number | undefined {
  try {
    const value = (JSON.parse(readFileSync(join(dir, LEDGER_STARTED_FILE), "utf8")) as { startedAt?: unknown }).startedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A month file of the ledger (`YYYY-MM.ndjson`). */
export const LEDGER_FILE_RE = /^\d{4}-\d{2}\.ndjson$/;

function snapshotKey(sessionKey: string, sdkSessionId: string): string {
  return `${sessionKey}\u0000${sdkSessionId}`;
}
