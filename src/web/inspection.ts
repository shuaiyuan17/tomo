import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCronStore } from "../cron/store.js";
import { formatSchedule } from "../cron/format.js";
import type { CronJob } from "../cron/types.js";
import { computeContextStatsFromEvents, type SdkEvent } from "../lcm/stats.js";
import { summaryBlocksFromEvents, type SummaryBlock } from "../lcm/summary-reader.js";
import type { SessionEntry } from "../sessions/types.js";
import { WebError, type WebContext, type WebCronJob } from "./protocol.js";

/** What the Study shows of a job: its intent and run state, never internal bookkeeping. */
export function webCronJob(job: CronJob): WebCronJob {
  return { id: job.id, name: job.name, enabled: job.enabled, schedule: job.schedule, scheduleLabel: formatSchedule(job.schedule),
    message: job.message, sessionKey: job.sessionKey, deleteAfterRun: job.deleteAfterRun, createdAt: job.createdAt,
    nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt, lastStatus: job.lastStatus, interruptedAt: job.interruptedAt ?? null };
}

/** Largest cron store the web process will read. */
export const MAX_CRON_STORE_BYTES = 4 * 1024 * 1024;

/**
 * Cron jobs, read fresh from the store file the daemon's scheduler uses (its
 * path is handed over by the daemon, never derived here). Read-only: the file
 * is read asynchronously and bounded, without following a symlink or blocking
 * on a FIFO, and parsed by the store's own side-effect-free parser, so the
 * web process never constructs a CronStore (whose load can repair and save).
 */
export class WebCron {
  constructor(private readonly path: string | undefined) {}
  async list(): Promise<{ jobs: WebCronJob[] }> {
    return { jobs: (await this.read()).map(webCronJob) };
  }
  protected async read() {
    if (!this.path) throw new WebError(503, "cron_unavailable");
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new WebError(503, "cron_unavailable");
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new WebError(503, "cron_unavailable");
      if (stat.size > MAX_CRON_STORE_BYTES) throw new WebError(413, "cron_store_too_large");
      // Bounded even if the file grows after stat().
      const bytes = Buffer.alloc(MAX_CRON_STORE_BYTES + 1);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      if (read > MAX_CRON_STORE_BYTES) throw new WebError(413, "cron_store_too_large");
      try { return parseCronStore(this.path, bytes.toString("utf8", 0, read)).jobs; }
      catch { throw new WebError(503, "cron_unavailable"); }
    } finally { await file.close(); }
  }
}

const MAX_CONTEXT_FILE = 16 * 1024 * 1024;
const MAX_CONTEXT_LINE = 256 * 1024;
const MAX_CONTEXT_LINES = 20_000;
const MAX_SUMMARIES = 100;
const MAX_SUMMARY_CHARS = 8000;

/**
 * Context usage for one session: the persisted usage (what `tomo status`
 * shows), the shared CLI estimator's breakdown, and retained rollup blocks.
 * Unknown stays unknown: no window is `null`, never zero usage.
 */
export async function readSessionContext(entry: SessionEntry | undefined, sdkSessionsDir: string): Promise<WebContext> {
  const usage = entry?.stats;
  const base = { used: usage?.contextMax ? usage.contextUsed : null, max: usage?.contextMax || null, estimated: usage?.contextEstimated ?? false,
    recordedAt: entry?.lastActiveAt ?? null, breakdown: usage?.contextBreakdown ?? [] };
  const none = { ...base, analysis: null, summaries: [], summariesTruncated: false };
  if (!entry?.sdkSessionId) return { ...none, analysisStatus: "unavailable" };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.sdkSessionId)) throw new WebError(503, "context_unavailable");
  try {
    const path = resolve(await realpath(sdkSessionsDir), `${entry.sdkSessionId}.jsonl`);
    if (await realpath(path) !== path) throw new WebError(503, "context_unavailable");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new WebError(503, "context_unavailable");
      if (stat.size > MAX_CONTEXT_FILE) return { ...none, analysisStatus: "too_large" };
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_CONTEXT_FILE + 1));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_CONTEXT_FILE) return { ...none, analysisStatus: "too_large" };
      const summaries: Array<SummaryBlock & { truncated: boolean }> = []; let summaryCount = 0;
      // Feed the shared estimator one JSON value at a time: never retain a
      // full UTF-8 copy, split-line array, or parsed SDK event graph. Line
      // limits also cover tiny-line / huge-object amplification within 16 MiB.
      function* events(): Iterable<SdkEvent> {
        let count = 0;
        for (let start = 0; start < bytesRead;) {
          const newline = bytes.indexOf(10, start);
          const end = newline < 0 || newline > bytesRead ? bytesRead : newline;
          if (end - start > MAX_CONTEXT_LINE || ++count > MAX_CONTEXT_LINES) throw new WebError(413, "context_limit");
          let event: SdkEvent;
          try { event = JSON.parse(bytes.toString("utf8", start, end)) as SdkEvent; }
          catch { start = end + 1; continue; }
          start = end + 1;
          for (const block of summaryBlocksFromEvents([event])) {
            summaryCount++;
            summaries.push({ ...block, content: block.content.slice(0, MAX_SUMMARY_CHARS), truncated: block.content.length > MAX_SUMMARY_CHARS });
            summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            if (summaries.length > MAX_SUMMARIES) summaries.pop();
          }
          yield event;
        }
      }
      const analysis = computeContextStatsFromEvents(events());
      return { ...base, analysis: { ...analysis, sections: analysis.sections.slice(-100), truncated: analysis.sections.length > 100 },
        summaries, summariesTruncated: summaryCount > MAX_SUMMARIES, analysisStatus: "available" };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof WebError && error.code === "context_limit") return { ...none, analysisStatus: "too_large" };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...none, analysisStatus: "unavailable" };
    throw error;
  }
}
