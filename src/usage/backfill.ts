import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isGroupSessionKey } from "../sessions/keys.js";
import { BACKFILL_FILE, LEDGER_DIR_MODE, LEDGER_FILE_MODE, readLedgerStarted, triggerSnippet, USAGE_LEDGER_VERSION, type UsageLedgerRow, type UsageSource } from "./ledger.js";
import { localParts } from "./local-time.js";
import { isEnoent } from "../fs-utils.js";

/**
 * One-off: rebuild the usage ledger's history from the activity log
 * (`~/.tomo/logs/activity.ndjson*`, the watch-bus feed) for the time before
 * the ledger started. Run by hand (`tomo usage backfill`), never by the daemon.
 *
 * What the activity log has per turn: who started it (`turn.start.source`),
 * its cost (`turn.stats.costUsd`, already per turn), its duration
 * (`turn.end`), its main-loop tool calls (`tool.start` without an `agent`),
 * the owner's message before it (`transcript`), and for a cron turn the job
 * that fired within 5 s before it (`cron.fired`). No tokens, no model split.
 *
 * The rows go to a file of their own, `<usage dir>/backfill.ndjson`, never
 * into the live month files (the daemon's appends are never touched). Each
 * run merges what the log yields into it by row id, adding and never
 * removing, so history survives the log's rotation, and replaces the file
 * atomically. Only turns before the ledger's start
 * marker (`ledger-started.json`) are kept: from then on the ledger owns every
 * turn — one whose row failed to land included, its cost carried by the next
 * row — so the activity log must not add any of them. No marker (the ledger
 * never ran): refused. Two runs at once: the second is refused (lock file).
 */

/** The fix of #389: before this local date a resume's first turn was charged the whole session. */
export const OVERCOUNTED_BEFORE = "2026-09-23";
/** A cron turn's job is the `cron.fired` at most this long before its start (or 1 s after). */
const CRON_PAIR_MS = 5_000;
const CRON_PAIR_AFTER_MS = 1_000;

interface ActivityEvent {
  ts?: number;
  type?: string;
  sessionKey?: string;
  source?: string;
  costUsd?: number;
  durationMs?: number;
  role?: string;
  text?: string;
  agent?: string;
  jobId?: string;
  name?: string;
}

interface OpenTurn {
  start: number;
  source: string;
  tools: number;
  trigger?: string;
  jobId?: string;
  jobName?: string;
  costUsd?: number;
  statsTs?: number;
  durationMs?: number;
  endTs?: number;
}

/** A result is the ended turn's at most this long after its turn.end (it usually follows within ms). */
const STATS_AFTER_END_MS = 5_000;

/** Activity files oldest first: `activity.ndjson.N` … `.1`, then `activity.ndjson`. */
export function activityFiles(logsDir: string): string[] {
  let names: string[];
  try { names = readdirSync(logsDir); } catch { return []; }
  const rotation = (name: string) => { const m = /^activity\.ndjson(?:\.(\d+))?$/.exec(name); return m ? Number(m[1] ?? 0) : -1; };
  return names.filter((n) => rotation(n) >= 0).sort((a, b) => rotation(b) - rotation(a)).map((n) => join(logsDir, n));
}

function sourceFor(activitySource: string, sessionKey: string, jobId: string | undefined): UsageSource {
  if (activitySource === "user") return isGroupSessionKey(sessionKey) ? "group" : "owner";
  if (activitySource === "cron") return jobId ? "cron" : "system";
  return "background";
}

/**
 * Ledger rows for the turns the activity events describe, in event order.
 * One row per `turn.stats` (one SDK result). `timeZone` decides which days
 * are before OVERCOUNTED_BEFORE.
 */
export function rowsFromActivity(lines: Iterable<string>, timeZone: string): UsageLedgerRow[] {
  const rows: UsageLedgerRow[] = [];
  const open = new Map<string, OpenTurn>();
  const userText = new Map<string, string>();
  const fired: { ts: number; jobId: string; name: string; used: boolean }[] = [];

  const emit = (sessionKey: string, turn: OpenTurn) => {
    if (turn.costUsd === undefined || turn.statsTs === undefined) return;
    const source = sourceFor(turn.source, sessionKey, turn.jobId);
    const row: UsageLedgerRow = {
      v: USAGE_LEDGER_VERSION,
      ts: turn.statsTs,
      sessionKey,
      source,
      ...(source === "cron" && turn.jobId ? { jobId: turn.jobId, ...(turn.jobName ? { jobName: turn.jobName } : {}) } : {}),
      ...(turn.trigger ? { trigger: turn.trigger } : {}),
      costUsd: turn.costUsd,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 },
      ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      tools: turn.tools,
      backfilled: true,
      ...(localParts(turn.statsTs, timeZone).date < OVERCOUNTED_BEFORE ? { overcounted: true as const } : {}),
    };
    rows.push(row);
  };

  for (const line of lines) {
    if (!line) continue;
    let e: ActivityEvent;
    try { e = JSON.parse(line) as ActivityEvent; } catch { continue; }
    if (!e || typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    const key = typeof e.sessionKey === "string" ? e.sessionKey : undefined;
    switch (e.type) {
      case "cron.fired":
        if (typeof e.jobId === "string") fired.push({ ts: e.ts, jobId: e.jobId, name: typeof e.name === "string" ? e.name : e.jobId, used: false });
        while (fired.length > 0 && fired[0].ts < e.ts - 10 * CRON_PAIR_MS) fired.shift();
        break;
      case "transcript":
        if (key && e.role === "user" && typeof e.text === "string") userText.set(key, e.text);
        break;
      case "turn.start": {
        if (!key) break;
        const previous = open.get(key);
        if (previous) emit(key, previous);
        const source = typeof e.source === "string" ? e.source : "continuity";
        const turn: OpenTurn = { start: e.ts, source, tools: 0 };
        if (source === "user") {
          const text = userText.get(key);
          userText.delete(key);
          const snippet = text ? triggerSnippet(text) : undefined;
          if (snippet) turn.trigger = snippet;
        } else if (source === "cron") {
          let best: (typeof fired)[number] | undefined;
          for (const f of fired) {
            if (f.used || f.ts < e.ts - CRON_PAIR_MS || f.ts > e.ts + CRON_PAIR_AFTER_MS) continue;
            if (!best || Math.abs(f.ts - e.ts) < Math.abs(best.ts - e.ts)) best = f;
          }
          if (best) { best.used = true; turn.jobId = best.jobId; turn.jobName = best.name; turn.trigger = triggerSnippet(best.name); }
        }
        open.set(key, turn);
        break;
      }
      case "tool.start": {
        const turn = key ? open.get(key) : undefined;
        if (turn && e.agent === undefined) turn.tools++;
        break;
      }
      case "turn.stats": {
        if (!key || typeof e.costUsd !== "number" || !Number.isFinite(e.costUsd)) break;
        let turn = open.get(key);
        if (turn && turn.costUsd === undefined && turn.endTs !== undefined && e.ts - turn.endTs > STATS_AFTER_END_MS) {
          // That turn ended without a result; this one is another's.
          open.delete(key);
          turn = undefined;
        }
        if (turn && turn.costUsd === undefined) {
          turn.costUsd = e.costUsd;
          turn.statsTs = e.ts;
          if (turn.durationMs !== undefined) { emit(key, turn); open.delete(key); }
        } else {
          // A result no turn.start announced: one the CLI started itself.
          emit(key, { start: e.ts, source: "continuity", tools: 0, costUsd: e.costUsd, statsTs: e.ts });
        }
        break;
      }
      case "turn.end": {
        const turn = key ? open.get(key) : undefined;
        if (!turn || turn.durationMs !== undefined) break;
        turn.durationMs = typeof e.durationMs === "number" ? e.durationMs : e.ts - turn.start;
        turn.endTs = e.ts;
        if (turn.costUsd !== undefined) { emit(key!, turn); open.delete(key!); }
        break;
      }
    }
  }
  for (const [key, turn] of open) emit(key, turn);
  return rows.sort((a, b) => a.ts - b.ts);
}

export interface BackfillOptions {
  logsDir: string;
  /** The usage data directory (`usageDataDir`). */
  usageDir: string;
  timeZone: string;
  dryRun: boolean;
  /** Write even when the activity log yields nothing, or under half the rows already backfilled. */
  force?: boolean;
}

export interface BackfillReport {
  activityFiles: string[];
  /** Rows the activity log yields. */
  found: number;
  /** Of those, at or after the ledger's start (left to it). */
  afterStart: number;
  /** Of those, before the start: this run's input. */
  fromLog: number;
  /** Rows backfill.ndjson already held. */
  existing: number;
  /** Rows this run adds (dry run: would add). */
  added: number;
  /** Rows in backfill.ndjson after the run. */
  total: number;
  /** Local dates the file's rows cover. */
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  overcountedDays: number;
  costUsd: number;
  /** The ledger's start marker, ms epoch. */
  ledgerStartedAt: number;
  dryRun: boolean;
}

export class BackfillError extends Error {}

export const BACKFILL_LOCK_FILE = "backfill.lock";

/**
 * A backfilled row's id, from what the activity log gives the same on every
 * read (session key + the result's timestamp), hashed.
 */
export function backfillRowId(sessionKey: string, ts: number): string {
  return createHash("sha256").update(`${sessionKey}\u0000${ts}`).digest("hex").slice(0, 24);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Take the backfill lock: `backfill.lock` created with O_EXCL, holding our
 * pid. A lock whose pid is not running (a run that crashed) is stale: it is
 * removed and taken once more. Returns the release function.
 */
export function acquireBackfillLock(usageDir: string): () => void {
  const path = join(usageDir, BACKFILL_LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, "wx", LEDGER_FILE_MODE);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return () => {
        try { if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true }); } catch { /* gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: number | undefined;
    try { holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch { /* removed meanwhile: retry */ }
    // An unreadable or empty lock is treated as held: its writer may be mid-write.
    if (holder !== undefined && Number.isInteger(holder) && holder > 0 && !alive(holder) && attempt === 0) {
      rmSync(path, { force: true });
      continue;
    }
    if (holder === undefined && attempt === 0) continue;
    throw new BackfillError(`Another backfill is running${holder && Number.isInteger(holder) ? ` (pid ${holder})` : ""}; ${path} is its lock`);
  }
}

/** chmod `path` to `mode` when its permissions are wider. */
function tighten(path: string, mode: number): void {
  if ((statSync(path).mode & 0o777 & ~mode) !== 0) chmodSync(path, mode);
}

/** Replace `path` with `text` whole: temp file, fsync, rename, fsync the directory. */
function replaceFile(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", LEDGER_FILE_MODE);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const dirFd = openSync(join(path, ".."), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/**
 * Merge this run's rows from the activity log into backfill.ndjson and write
 * it back whole (atomically). Only adds: a row already there (same id) is
 * kept as written, and rows the log no longer has (it rotates) stay. A run
 * whose input is empty, or under half of what the file holds, is refused
 * unless `force`: a missing or cut-short log is far likelier than history
 * that shrank.
 */
export function backfillUsage(options: BackfillOptions): BackfillReport {
  const ledgerStartedAt = readLedgerStarted(options.usageDir);
  if (ledgerStartedAt === undefined) {
    throw new BackfillError(`The usage ledger has never started (no ${join(options.usageDir, "ledger-started.json")}): nothing to backfill up to. Start tomo once first.`);
  }
  let release: (() => void) | undefined;
  if (!options.dryRun) {
    mkdirSync(options.usageDir, { recursive: true, mode: LEDGER_DIR_MODE });
    release = acquireBackfillLock(options.usageDir);
  }
  try {
    const files = activityFiles(options.logsDir);
    const lines = (function* () {
      for (const file of files) {
        let text: string;
        try { text = readFileSync(file, "utf8"); } catch { continue; }
        yield* text.split("\n");
      }
    })();
    const rows = rowsFromActivity(lines, options.timeZone);
    const fresh = rows.filter((row) => row.ts < ledgerStartedAt);

    // What the file holds, kept line for line.
    const target = join(options.usageDir, BACKFILL_FILE);
    let text = "";
    try { text = readFileSync(target, "utf8"); }
    catch (err) { if (!isEnoent(err)) throw err; }
    const merged: { id: string; ts: number; line: string; row?: Partial<UsageLedgerRow> }[] = [];
    const ids = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let row: Partial<UsageLedgerRow> | undefined;
      try { row = JSON.parse(line) as Partial<UsageLedgerRow>; } catch { /* kept verbatim */ }
      const ts = typeof row?.ts === "number" ? row.ts : -Infinity;
      const id = row?.backfillId ?? (row && typeof row.sessionKey === "string" ? backfillRowId(row.sessionKey, ts) : `line:${merged.length}`);
      ids.add(id);
      merged.push({ id, ts, line, row });
    }
    const existing = merged.length;

    if (!options.force && (fresh.length === 0 || fresh.length < existing / 2)) {
      throw new BackfillError(fresh.length === 0
        ? `The activity log yields no turns before the ledger started (${files.length} file(s) in ${options.logsDir}); nothing written. --force to write anyway.`
        : `The activity log yields ${fresh.length} turns, under half the ${existing} already backfilled (rotated or cut short?); nothing written. --force to merge anyway (nothing already backfilled is removed).`);
    }

    let added = 0;
    for (const row of fresh) {
      const id = backfillRowId(row.sessionKey, row.ts);
      if (ids.has(id)) continue;
      ids.add(id);
      const withId: UsageLedgerRow = { ...row, backfillId: id };
      merged.push({ id, ts: row.ts, line: JSON.stringify(withId), row: withId });
      added++;
    }
    merged.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const days = new Set<string>();
    const overcounted = new Set<string>();
    let costUsd = 0;
    for (const { row } of merged) {
      if (typeof row?.ts !== "number") continue;
      const date = localParts(row.ts, options.timeZone).date;
      days.add(date);
      if (row.overcounted) overcounted.add(date);
      costUsd += typeof row.costUsd === "number" ? row.costUsd : 0;
    }
    if (!options.dryRun) {
      if (added > 0 || !existsSync(target)) replaceFile(target, merged.map((m) => `${m.line}\n`).join(""));
      // Every run, new rows or not: a file or directory left wider (an older
      // build, a restore, by hand) is tightened.
      tighten(options.usageDir, LEDGER_DIR_MODE);
      tighten(target, LEDGER_FILE_MODE);
    }

    const sorted = [...days].sort();
    return {
      activityFiles: files,
      found: rows.length,
      afterStart: rows.length - fresh.length,
      fromLog: fresh.length,
      existing,
      added,
      total: merged.length,
      days: days.size,
      firstDay: sorted[0] ?? null,
      lastDay: sorted.at(-1) ?? null,
      overcountedDays: overcounted.size,
      costUsd,
      ledgerStartedAt,
      dryRun: options.dryRun,
    };
  } finally {
    release?.();
  }
}
