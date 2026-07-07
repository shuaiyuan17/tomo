import type { CronJob } from "../cron/types.js";
import { filterCostEntriesByRange, parseCostEntries, type CostEntry } from "../costs.js";
import { watchBus } from "./bus.js";
import {
  WATCH_PROTOCOL_VERSION,
  type WatchSessionInfo,
  type WatchSnapshot,
} from "./protocol.js";

/** How much feed backfill a freshly attached client receives. */
const SNAPSHOT_RECENT_LIMIT = 200;

export interface SnapshotSources {
  startedAt: number;
  version: string;
  model: string;
  overview(): { channels: string[]; sessions: WatchSessionInfo[] };
  cronJobs(): CronJob[];
  nextHeartbeatAt(): number | null;
  /** Override for tests; defaults to the daemon log (see costs.ts). */
  costLogPath?: string;
}

function totalCost(entries: CostEntry[]): number {
  return entries.reduce((sum, e) => sum + e.cost, 0);
}

/**
 * Build the connect-time snapshot for a watch client. Runs per connect, not
 * per event — the cost-log parse reads the whole daemon log, which is fine
 * at that cadence.
 */
export function buildWatchSnapshot(src: SnapshotSources): WatchSnapshot {
  const costEntries = parseCostEntries(src.costLogPath);
  const day = filterCostEntriesByRange(costEntries, "day");
  const week = filterCostEntriesByRange(costEntries, "week");
  const { channels, sessions } = src.overview();

  return {
    protocolVersion: WATCH_PROTOCOL_VERSION,
    pid: process.pid,
    startedAt: src.startedAt,
    version: src.version,
    model: src.model,
    channels,
    sessions,
    cron: src.cronJobs().map((job) => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
    })),
    nextHeartbeatAt: src.nextHeartbeatAt(),
    costTodayUsd: totalCost(day),
    costWeekUsd: totalCost(week),
    turnsToday: day.length,
    recent: watchBus.recent(SNAPSHOT_RECENT_LIMIT),
    lastIssue: watchBus.lastIssue(),
  };
}
