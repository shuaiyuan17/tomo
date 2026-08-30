export type CronSchedule =
  | { kind: "at"; at: string }         // ISO-8601 or relative ("20m", "2h")
  | { kind: "every"; everyMs: number } // Fixed interval in ms
  | { kind: "cron"; expr: string; tz?: string }; // Cron expression

/**
 * Outcome of a run. `interrupted` means the daemon went away between dispatch
 * and completion (a restart, a crash) — the turn may have done all, some, or
 * none of its work, so it is never silently equated with success or failure.
 */
export type CronRunStatus = "ok" | "error" | "interrupted";

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  message: string;
  /** Session key to deliver the triggered message to */
  sessionKey: string;
  /** Auto-delete after successful run (for one-shots) */
  deleteAfterRun: boolean;
  createdAt: number;
  /** Runtime state */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: CronRunStatus | null;
  /**
   * When the most recent run was *dispatched*. Written (and flushed to disk)
   * before the agent turn starts, so a daemon that dies mid-run leaves
   * `lastStartedAt > lastRunAt` behind — the only durable evidence that a run
   * was interrupted rather than never attempted. See CronStore.markStarted.
   */
  lastStartedAt?: number | null;
  /** Id of the run recorded by `lastStartedAt` — correlates logs/events. */
  lastRunId?: string | null;
  /**
   * Set by recovery when a dispatched run never reported completion (daemon
   * restart mid-run). Persisted rather than kept in memory so the marker
   * survives further restarts; cleared on the next dispatch.
   */
  interruptedAt?: number | null;
  /** Failed runs of a one-shot ("at") job so far — bounds the retry loop. */
  retryCount?: number;
}

export type CronJobCreate = Pick<CronJob, "name" | "message" | "sessionKey"> & {
  schedule: string; // Parsed by the CLI: "in 20m", "every 1h", "0 9 * * *"
  deleteAfterRun?: boolean;
};
