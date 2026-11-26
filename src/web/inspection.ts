import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CronStore } from "../cron/store.js";
import { formatSchedule } from "../cron/format.js";
import type { CronJob } from "../cron/types.js";
import { computeContextStatsFromEvents, type SdkEvent } from "../lcm/stats.js";
import { summaryBlocksFromEvents, type SummaryBlock } from "../lcm/summary-reader.js";
import type { SessionEntry } from "../sessions/types.js";
import { WebError, type WebContext, type WebCronJob } from "./protocol.js";
import { isEnoent } from "../fs-utils.js";

/**
 * Optimistic concurrency over what the owner reviewed — the job's intent —
 * not scheduler bookkeeping, so a run starting or finishing between review
 * and confirmation does not invalidate the confirmation, while any edit to
 * the job itself does.
 */
export function cronRevision(job: CronJob): string {
  const { id, name, schedule, message, sessionKey, enabled, deleteAfterRun } = job;
  return createHash("sha256").update(JSON.stringify({ id, name, schedule, message, sessionKey, enabled, deleteAfterRun })).digest("hex");
}

/** What the Study shows of a job: its intent and run state, never internal bookkeeping. */
export function webCronJob(job: CronJob): WebCronJob {
  return { revision: cronRevision(job), id: job.id, name: job.name, enabled: job.enabled, schedule: job.schedule, scheduleLabel: formatSchedule(job.schedule),
    message: job.message, sessionKey: job.sessionKey, deleteAfterRun: job.deleteAfterRun, createdAt: job.createdAt,
    nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt, lastStatus: job.lastStatus, interruptedAt: job.interruptedAt ?? null };
}

/**
 * Cron jobs, read fresh from the database the daemon's scheduler uses (its
 * path is handed over by the daemon, never derived here), through the same
 * CronStore as `tomo cron` and the schedule tools. A confirmed change goes
 * through the store's guarded write transaction like theirs.
 */
export class WebCron {
  constructor(private readonly path: string | undefined) {}
  async list(): Promise<{ jobs: WebCronJob[] }> {
    return { jobs: this.read().map(webCronJob) };
  }
  protected read(): CronJob[] {
    if (!this.path) throw new WebError(503, "cron_unavailable");
    try { return new CronStore(this.path).list(); }
    catch { throw new WebError(503, "cron_unavailable"); }
  }
  /** Enable / disable (`enabled` given) or delete a job, if it still has the reviewed `revision`. */
  async change(id: string, revision: string, enabled?: boolean): Promise<{ ok: true }> {
    if (!this.read().some((job) => job.id === id)) throw new WebError(404, "job_not_found");
    const guard = (job: CronJob) => cronRevision(job) === revision;
    let result: ReturnType<CronStore["setEnabled"]> | ReturnType<CronStore["remove"]>;
    try {
      const store = new CronStore(this.path);
      result = enabled === undefined ? store.remove(id, guard) : store.setEnabled(id, enabled, guard);
    } catch { throw new WebError(503, "cron_unavailable"); }
    if (result === "refused") throw new WebError(409, "cron_changed");
    if (result === "unschedulable") throw new WebError(422, "unschedulable");
    if (!result) throw new WebError(404, "job_not_found");
    return { ok: true };
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
    if (isEnoent(error)) return { ...none, analysisStatus: "unavailable" };
    throw error;
  }
}
