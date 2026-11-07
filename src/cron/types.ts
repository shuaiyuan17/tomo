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
   * The run id that was last *acknowledged* (completed, or settled by
   * recovery). `lastRunId !== lastCompletedRunId` is the definition of an
   * interrupted run — a token comparison rather than a timestamp one, so a
   * clock that steps backwards mid-run cannot make a finished run look
   * unfinished (and get it re-fired).
   */
  lastCompletedRunId?: string | null;
  /**
   * Set by recovery when a dispatched run never reported completion (daemon
   * restart mid-run). Persisted rather than kept in memory so the marker
   * survives further restarts; cleared on the next dispatch.
   */
  interruptedAt?: number | null;
  /** Failed runs of a one-shot ("at") job so far — bounds the retry loop. */
  retryCount?: number;
  /**
   * How many times this recurring job has been resumed after an interruption.
   * Cumulative, NOT a count of back-to-back restarts: it is reset only by a
   * run that reaches a successful outcome, or by an operator re-enabling a
   * settled interrupted job — so interruptions separated by weeks of failed
   * (but completed) runs still add up. Bounds a crash loop: a turn that
   * reliably kills the daemon would otherwise earn a fresh resume on every
   * restart, forever.
   */
  resumeAttempts?: number;
  /**
   * How late a missed run may still fire, in ms past its slot. A recurring
   * run missed by more (the daemon was down, the store unreadable) is skipped
   * to the next slot instead of firing late; an interrupted one-shot older
   * than this is not retried. Absent = the default, which scales with the
   * job's period (see staleWindowMs in store.ts); 0 = never stale (always
   * catch up, always retry once).
   */
  staleAfterMs?: number;
  /** When a run of this job was last skipped as stale (informational). */
  lastSkippedAt?: number | null;
  /**
   * Stale skips the owner has not been told about yet: how many, details of
   * the latest, and a sequence number so an acknowledgement clears only what
   * was actually reported (a skip landing while the DM is in flight stays).
   */
  skipNotice?: SkipNotice | null;
  /**
   * When the owner was told this interrupted one-shot will not run again on
   * its own. Set once, so the notice is not repeated on every restart.
   */
  interruptNotifiedAt?: number | null;
}

export interface SkipNotice {
  seq: number;
  count: number;
  lateByMs: number;
  windowMs: number;
}

export type CronJobCreate = Pick<CronJob, "name" | "message" | "sessionKey"> & {
  schedule: string; // Parsed by the CLI: "in 20m", "every 1h", "0 9 * * *"
  deleteAfterRun?: boolean;
  staleAfterMs?: number;
};

/** A job recovery declined to fire again, and why. */
export interface InterruptedSkip {
  job: CronJob;
  /**
   * `once-stale`: a one-shot whose interrupted run is older than its
   *   staleness window — too late to be worth a retry.
   * `once-retried`: a one-shot already retried once after an interruption.
   * `once-disabled`: a one-shot disabled (by someone) while its run was in flight.
   * `resume-cap`: a recurring job was interrupted too many times running.
   */
  reason: "once-stale" | "once-retried" | "once-disabled" | "resume-cap";
}
