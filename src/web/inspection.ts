import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CronStore } from "../cron/store.js";
import { formatSchedule } from "../cron/format.js";
import type { CronJob } from "../cron/types.js";
import { computeContextStatsFromEvents, type SdkEvent } from "../lcm/stats.js";
import { summaryBlocksFromEvents } from "../lcm/summary-reader.js";
import type { SessionEntry } from "../sessions/types.js";
import { WebError } from "./protocol.js";
export function cronRevision(job: CronJob): string { return createHash("sha256").update(JSON.stringify(job)).digest("hex"); }
export class WebCron {
  constructor(private readonly tomoHome: string) {}
  private store() { return new CronStore(join(this.tomoHome, "data", "cron", "jobs.json")); }
  list() { return { jobs: this.store().list().map((job) => ({ ...job, revision: cronRevision(job), scheduleLabel: formatSchedule(job.schedule) })) }; }
  change(id: string, revision: string, enabled?: boolean) {
    const guard = (job: CronJob) => cronRevision(job) === revision;
    const store = this.store();
    const result = enabled === undefined ? store.remove(id, guard) : store.setEnabled(id, enabled, guard);
    if (result === "refused") throw new WebError(409, "cron_changed");
    if (result === "unschedulable") throw new WebError(422, "unschedulable");
    if (!result) throw new WebError(404, "job_not_found");
    return { ok: true };
  }
}
export async function readSessionContext(entry: SessionEntry | undefined, sdkSessionsDir: string) {
  const usage = entry?.stats;
  const base = { used: usage?.contextMax ? usage.contextUsed : null, max: usage?.contextMax || null, estimated: usage?.contextEstimated ?? false,
    recordedAt: entry?.lastActiveAt ?? null, breakdown: usage?.contextBreakdown ?? [] };
  if (!entry?.sdkSessionId) return { ...base, analysis: null, summaries: [], analysisStatus: "unavailable" as const };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.sdkSessionId)) throw new WebError(503, "context_unavailable");
  try {
    const path = resolve(await realpath(sdkSessionsDir), `${entry.sdkSessionId}.jsonl`);
    if (await realpath(path) !== path) throw new WebError(503, "context_unavailable");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(); const limit = 16 * 1024 * 1024;
      if (!stat.isFile()) throw new WebError(503, "context_unavailable");
      if (stat.size > limit) return { ...base, analysis: null, summaries: [], analysisStatus: "too_large" as const };
      const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > limit) throw new WebError(413, "context_limit");
      const events = bytes.subarray(0, bytesRead).toString("utf8").split("\n").flatMap((line): SdkEvent[] => {
        try { return [JSON.parse(line) as SdkEvent]; } catch { return []; }
      });
      const analysis = computeContextStatsFromEvents(events);
      const summaries = summaryBlocksFromEvents(events).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return { ...base, analysis: { ...analysis, sections: analysis.sections.slice(-100), truncated: analysis.sections.length > 100 },
        summaries: summaries.slice(0, 100).map((block) => ({ ...block, content: block.content.slice(0, 8000), truncated: block.content.length > 8000 })),
        summariesTruncated: summaries.length > 100, analysisStatus: "available" as const };
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, analysis: null, summaries: [], analysisStatus: "unavailable" as const };
    throw error;
  }
}
