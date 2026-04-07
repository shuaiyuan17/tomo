export type CronSchedule =
  | { kind: "at"; at: string }         // ISO-8601 or relative ("20m", "2h")
  | { kind: "every"; everyMs: number } // Fixed interval in ms
  | { kind: "cron"; expr: string; tz?: string }; // Cron expression

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  message: string;
  /** Channel + chatId to deliver response to */
  channel?: string;
  chatId?: string;
  /** Auto-delete after successful run (for one-shots) */
  deleteAfterRun: boolean;
  createdAt: number;
  /** Runtime state */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "error" | null;
}

export type CronJobCreate = Pick<CronJob, "name" | "message"> & {
  schedule: string; // Parsed by the CLI: "in 20m", "every 1h", "0 9 * * *"
  channel?: string;
  chatId?: string;
  deleteAfterRun?: boolean;
};
