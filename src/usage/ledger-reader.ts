import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isWellFormedTaskId, taskIdFromSessionKey } from "../sessions/keys.js";
import { BACKFILL_FILE, LEDGER_FILE_RE, readLedgerStarted, usageCategory, type UsageCategory, type UsageLedgerRow, type UsageSource } from "./ledger.js";

/**
 * What the Cost page needs of a ledger row: the row minus its snapshot (the
 * cumulative counters, a resume's business) and minus per-model counters it
 * does not show.
 */
export interface CostRow {
  ts: number;
  sessionKey: string;
  source: UsageSource;
  category: UsageCategory;
  jobId?: string;
  jobName?: string;
  /** `task` / `task-relay` rows: the sub-session the turn was for. */
  taskId?: string;
  trigger?: string;
  costUsd: number;
  durationMs?: number;
  numTurns?: number;
  tools?: number;
  models?: Record<string, { costUsd: number; input: number; output: number; cacheRead: number; cacheCreated: number }>;
  overcounted?: true;
  backfilled?: true;
}

const SOURCES = new Set<UsageSource>(["owner", "group", "cron", "system", "delegate", "heartbeat", "restart", "background", "task", "task-relay"]);

/**
 * How the owning session's turns for its tasks began, before they had a
 * source of their own (`task-relay`): the first words of each wake's prompt,
 * as the trigger snippet keeps them (src/agent.ts mirrorWake / messageWake,
 * subsessions/service.ts wakeForReport and the unanswered-messages wake).
 */
const LEGACY_RELAY_TRIGGERS = [
  "A sub-session finished; its report is in a note above.",
  "A sub-session conversation is shown above.",
  "A sub-session handed you something for the owner;",
  "A finished sub-session could not answer what it was sent;",
];

/**
 * The source a row is read as. Rows are never rewritten: rows from before
 * sub-sessions had sources of their own are read into them here. A row on
 * a `task:` key is the task's own turn whatever it was written as (they were
 * all `background`); a `background` row whose trigger is one of the relay
 * wakes is a relay turn.
 */
function readSource(raw: Partial<UsageLedgerRow>, sessionKey: string): UsageSource {
  const written = SOURCES.has(raw.source as UsageSource) ? raw.source as UsageSource : "background";
  if (taskIdFromSessionKey(sessionKey)) return "task";
  // Only a task's own key can hold its own turns (every `task` row is in Tasks with an id).
  if (written === "task") return "background";
  if (written === "background" && typeof raw.trigger === "string" && LEGACY_RELAY_TRIGGERS.some((t) => raw.trigger!.startsWith(t))) return "task-relay";
  return written;
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const wellFormedTaskId = (v: unknown): string | undefined => (typeof v === "string" && isWellFormedTaskId(v) ? v : undefined);

/** One parsed line, or undefined for a torn, corrupt or foreign one. */
export function toCostRow(line: string): CostRow | undefined {
  let raw: Partial<UsageLedgerRow>;
  try { raw = JSON.parse(line) as Partial<UsageLedgerRow>; } catch { return undefined; }
  if (!raw || typeof raw !== "object" || typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || typeof raw.sessionKey !== "string") return undefined;
  const source = readSource(raw, raw.sessionKey);
  const row: CostRow = { ts: raw.ts, sessionKey: raw.sessionKey, source, category: usageCategory(source), costUsd: num(raw.costUsd) };
  const taskId = source === "task" ? taskIdFromSessionKey(raw.sessionKey) : source === "task-relay" ? wellFormedTaskId(raw.taskId) : undefined;
  if (taskId) row.taskId = taskId;
  const jobId = optStr(raw.jobId); if (jobId) row.jobId = jobId;
  const jobName = optStr(raw.jobName); if (jobName) row.jobName = jobName;
  const trigger = optStr(raw.trigger); if (trigger) row.trigger = trigger;
  const durationMs = optNum(raw.durationMs); if (durationMs !== undefined) row.durationMs = durationMs;
  const numTurns = optNum(raw.numTurns); if (numTurns !== undefined) row.numTurns = numTurns;
  const tools = optNum(raw.tools); if (tools !== undefined) row.tools = tools;
  if (raw.overcounted === true) row.overcounted = true;
  if (raw.backfilled === true) row.backfilled = true;
  if (raw.models && typeof raw.models === "object") {
    const models: NonNullable<CostRow["models"]> = {};
    for (const [model, m] of Object.entries(raw.models)) {
      if (!m || typeof m !== "object") continue;
      models[model] = { costUsd: num(m.costUsd), input: num(m.input), output: num(m.output), cacheRead: num(m.cacheRead), cacheCreated: num(m.cacheCreated) };
    }
    if (Object.keys(models).length > 0) row.models = models;
  }
  return row;
}

interface CachedFile {
  /** Bytes consumed: up to and including the last newline read. */
  consumed: number;
  mtimeMs: number;
  /** Device + inode: a replaced file (restore, rename) is read again from the start. */
  identity: string;
  rows: CostRow[];
}

/**
 * Reads the ledger's month files with a per-file cache. The ledger is
 * append-only, so a file that grew is read from where the last read stopped
 * (a partial last line waits for its newline); one that shrank, or was
 * replaced, is read again whole. A request stats each file and reads only
 * what is new.
 */
export class LedgerReader {
  /** Insertion order is recency: a file read is moved to the end. */
  private readonly cache = new Map<string, CachedFile>();

  /** `maxFiles`: month files kept parsed (least recently read dropped first); about two years by default. */
  constructor(private readonly dir: string, private readonly maxFiles = 26) {}

  /** Month files present, oldest first (`YYYY-MM.ndjson`). */
  files(): string[] {
    try { return readdirSync(this.dir).filter((f) => LEDGER_FILE_RE.test(f)).sort(); }
    catch { return []; }
  }

  /** Rows of the month files named (see `files`); unreadable files read as empty. */
  rows(files: readonly string[]): CostRow[][] {
    const present = new Set(this.files());
    for (const key of this.cache.keys()) if (!present.has(key) && key !== BACKFILL_FILE) this.cache.delete(key);
    const out = files.map((file) => (present.has(file) ? this.read(file) : []));
    for (const key of this.cache.keys()) {
      if (this.cache.size <= Math.max(this.maxFiles, files.length)) break;
      this.cache.delete(key);
    }
    return out;
  }

  /**
   * The rows of `backfill.ndjson` that are history: before the ledger's
   * start marker. Anything at or after it is the live ledger's (a turn whose
   * row failed to land has its cost on the next live row), so it is dropped
   * here even if a backfill wrote it; without a marker there is no history to
   * add. The file is replaced whole on each backfill, so the cache reads it
   * again then.
   */
  backfillRows(): CostRow[] {
    const startedAt = readLedgerStarted(this.dir);
    if (startedAt === undefined) return [];
    const rows = this.read(BACKFILL_FILE);
    return rows.every((row) => row.ts < startedAt) ? rows : rows.filter((row) => row.ts < startedAt);
  }

  private read(file: string): CostRow[] {
    const path = join(this.dir, file);
    let st;
    try { st = statSync(path); } catch { this.cache.delete(file); return []; }
    const identity = `${st.dev}:${st.ino}`;
    let cached = this.cache.get(file);
    if (cached && cached.identity === identity && cached.mtimeMs === st.mtimeMs && st.size === cached.consumed) {
      this.cache.delete(file);
      this.cache.set(file, cached);
      return cached.rows;
    }
    if (!cached || cached.identity !== identity || st.size < cached.consumed) {
      cached = { consumed: 0, mtimeMs: 0, identity, rows: [] };
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const length = size - cached.consumed;
      if (length > 0) {
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
          const n = readSync(fd, buffer, read, length - read, cached.consumed + read);
          if (n === 0) break;
          read += n;
        }
        const last = buffer.lastIndexOf(0x0a, read - 1);
        if (last >= 0) {
          const text = buffer.toString("utf8", 0, last + 1);
          // A fresh array: callers may still hold the previous one.
          const rows = cached.rows.slice();
          for (const line of text.split("\n")) {
            if (!line) continue;
            const row = toCostRow(line);
            if (row) rows.push(row);
          }
          cached = { ...cached, consumed: cached.consumed + last + 1, rows };
        }
      }
      cached.mtimeMs = st.mtimeMs;
      this.cache.delete(file);
      this.cache.set(file, cached);
      return cached.rows;
    } catch {
      return cached.rows;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
