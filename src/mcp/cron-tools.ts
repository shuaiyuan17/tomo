import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CronStore, CronStoreReadError, computeNextRun, parseScheduleString } from "../cron/store.js";
import { canManageJob, isStorableSessionKey } from "../cron/scope.js";
import type { CronJob, CronRunStatus } from "../cron/types.js";

/**
 * MCP tool factories for the cron store. Registered onto the
 * `tomo-internal` server alongside `send_message` / `list_sessions`.
 *
 * These are deferred (no `alwaysLoad`) so they only consume context when
 * the agent searches for scheduling capability — most turns don't touch
 * the cron store, and when they do, the schemas are small.
 *
 * Core logic stays in `CronStore`. The CLI (`tomo cron …`) is a parallel
 * surface against the same store, kept for human audit.
 *
 * Each handler instantiates a fresh `CronStore` so it picks up writes
 * from the CLI, the scheduler, or external edits (the constructor calls
 * `load()` from disk). The on-disk JSON is the single source of truth.
 */
/**
 * @param storePath  Override the jobs file (tests).
 * @param callerSessionKey  The session this MCP server instance belongs to.
 *   When set, `schedule_enable` is scoped by `canManageJob` (src/cron/scope.ts):
 *   re-enabling is the one cron operation here that makes a *dormant* job run
 *   again, so a group chat must not be able to restart a job that fires into
 *   the owner's DM. Scoping of `schedule_list` / `schedule_create` /
 *   `schedule_remove` is #319, which should adopt the same predicate.
 */
export function buildCronTools(storePath?: string, callerSessionKey?: string) {
  return [
    tool(
      "schedule_create",
      [
        "Create a scheduled task that fires a message back into a session at a future time, on an interval, or on a cron pattern.",
        "",
        "Use when the user asks for a reminder, recurring nudge, future check-in, or any time-triggered prompt to themselves or a group.",
        "",
        "Schedule formats (free-form string):",
        "- `in 20m`, `in 2h`, `in 3d` — one-shot relative; auto-deletes after firing.",
        "- `2026-05-01T19:00` — one-shot at an ISO date/time; auto-deletes after firing.",
        "- `every 30m`, `every 6h` — recurring interval.",
        "- 5-field cron like `0 9 * * *` (daily 9am), `0 9 * * 1-5` (weekdays 9am) — recurring.",
        "",
        "One-shot trap: a cron expression with a specific day-of-month + month (e.g. `0 19 1 5 *`) re-fires every year. For a single fire on a calendar date, prefer the ISO date form, or pass `once: true` with the cron expression.",
        "",
        "The `session` field is the routing target (the **Session key** in the agent system prompt). Use the current session key unless the user explicitly addresses someone else.",
        "",
        "Returns the created job (id, schedule, lifecycle, nextRunAt).",
      ].join("\n"),
      {
        name: z.string().min(1).max(80).describe(
          "Short slug-style name for the job (e.g. `airplant-weekly-soak`). Used in logs and `cron list` output.",
        ),
        schedule: z.string().min(1).describe(
          'Schedule string. Examples: "in 20m", "in 3d", "2026-05-01T19:00", "every 1h", "0 9 * * *".',
        ),
        message: z.string().min(1).max(4000).describe(
          "The text the user (or scheduler) will receive when the job fires. Written as a system message into the target session.",
        ),
        session: z.string().min(1).describe(
          'Session key to deliver to. Identity DM ("dm:alice"), iMessage chat key ("imessage:any;+;<guid>"), Telegram chat key ("telegram:-100…"), etc.',
        ),
        once: z.boolean().optional().describe(
          "Override lifecycle. Defaults to true for one-time `at` schedules and false for recurring (`every`/cron). Pass `true` to make a cron expression fire once and auto-delete; pass `false` to keep an `at` job around as a disabled record after firing.",
        ),
      },
      async ({ name, schedule, message, session, once }) => {
        // Validate the schedule on its own. parseScheduleString accepts any
        // unrecognized string as `kind: "cron"` (catch-all) and croner only
        // throws when the expression is actually evaluated, so the validation
        // is the trial computeNextRun — not `store.add`, whose failures are
        // about the STORE and must not be reported as a bad schedule.
        if (!isStorableSessionKey(session)) {
          // Persisting a malformed target buys a job that can never deliver,
          // found out days later when the reminder does not arrive.
          return {
            content: [{
              type: "text" as const,
              text: `schedule_create failed: "${session}" is not a session key. Use the session key from the system prompt — "dm:<identity>", or "<channel>:<chatId>" such as "telegram:-1001234567".`,
            }],
            isError: true,
          };
        }
        let parsed;
        try {
          parsed = parseScheduleString(schedule);
          computeNextRun(parsed, Date.now());
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `schedule_create failed: invalid schedule "${schedule}": ${detail}` }],
            isError: true,
          };
        }
        try {
          const store = new CronStore(storePath);
          const job = store.add({
            name,
            schedule: parsed,
            message,
            sessionKey: session,
            deleteAfterRun: once,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(summarizeJob(job), null, 2) }],
          };
        } catch (err) {
          // The schedule was fine; the store was not. Say so, or the agent
          // rewrites a perfectly good schedule string forever.
          const detail = err instanceof CronStoreReadError
            ? `the schedule store could not be read (${err.path}) — the schedule itself is valid`
            : err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `schedule_create failed: ${detail}` }],
            isError: true,
          };
        }
      },
      {
        searchHint: "schedule task reminder cron recurring one-shot future fire trigger ping",
      },
    ),
    tool(
      "schedule_list",
      [
        "List every scheduled task in the store. Use to audit what reminders/recurring jobs exist before adding more, or to find a job's id for removal.",
        "",
        "Returns an array; each entry includes id, name, lifecycle (`once`|`recurring`), enabled, schedule, message, sessionKey, nextRunAt, lastStartedAt, lastRunAt, lastStatus. Times are ISO-8601 in UTC.",
        "",
        "`lastStatus: \"interrupted\"` means a run was dispatched but the daemon restarted before it finished — the work may be partly done. Such a job is left disabled rather than re-fired; use `schedule_enable` to run it again, and only after checking whether the task actually completed.",
      ].join("\n"),
      {},
      async () => {
        const store = new CronStore(storePath);
        const jobs = store.list().map(summarizeJob);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }],
        };
      },
      {
        searchHint: "list scheduled tasks reminders crons jobs audit",
      },
    ),
    tool(
      "schedule_enable",
      [
        "Enable or disable a scheduled task without deleting it.",
        "",
        "The main use is a job left disabled after an interrupted run (`lastStatus: \"interrupted\"` in `schedule_list`) — the daemon restarted mid-run, so the task may already have done its work. Check that first; enabling it runs it again. Enabling clears the interrupted state and recomputes the next run (a one-shot whose time has passed fires on the next poll).",
        "",
        "Pass `enabled: false` to park a job you want to keep but not run.",
        "",
        "Scoped: this conversation's own jobs always; from a DM, also jobs that deliver into a group chat or that carry no session. A group chat can only enable or disable its own jobs.",
        "",
        "Returns the updated job, or `not_found`.",
      ].join("\n"),
      {
        id: z.string().min(1).describe("The job id from `schedule_list` (e.g. `f43d8a93`)."),
        enabled: z.boolean().optional().describe("Target state. Defaults to true (enable)."),
      },
      async ({ id, enabled }) => {
        const store = new CronStore(storePath);
        const existing = store.get(id);
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Job ${id} not found.` }] };
        }
        if (!canManageJob(existing, callerSessionKey)) {
          // Deliberately does not name the owning session.
          return {
            content: [{
              type: "text" as const,
              text: `Job ${id} belongs to a different session; this session can only enable or disable its own scheduled tasks.`,
            }],
            isError: true,
          };
        }
        const job = store.setEnabled(id, enabled ?? true);
        if (!job) {
          return { content: [{ type: "text" as const, text: `Job ${id} not found.` }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summarizeJob(job), null, 2) }],
        };
      },
      {
        searchHint: "enable disable resume pause reactivate scheduled task reminder cron job interrupted",
      },
    ),
    tool(
      "schedule_remove",
      [
        "Remove a scheduled task by id. Use when a reminder is no longer needed, or to clean up a one-shot left disabled by an older code path.",
        "",
        "Returns `removed` or `not_found`.",
      ].join("\n"),
      {
        id: z.string().min(1).describe("The job id from `schedule_list` (e.g. `f43d8a93`)."),
      },
      async ({ id }) => {
        const store = new CronStore(storePath);
        const removed = store.remove(id);
        // Not-found is an expected outcome of a list → pick → remove flow,
        // not an error worth flagging. The text conveys the result; isError
        // would push the agent toward retry/escalate semantics.
        return {
          content: [{
            type: "text" as const,
            text: removed ? `Removed job ${id}.` : `Job ${id} not found.`,
          }],
        };
      },
      {
        searchHint: "remove delete cancel scheduled task reminder cron job",
      },
    ),
  ];
}

interface JobSummary {
  id: string;
  name: string;
  enabled: boolean;
  lifecycle: "once" | "recurring";
  schedule: { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string };
  message: string;
  sessionKey: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStartedAt: string | null;
  lastStatus: CronRunStatus | null;
}

function summarizeJob(job: CronJob): JobSummary {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    lifecycle: job.deleteAfterRun ? "once" : "recurring",
    schedule: job.schedule,
    message: job.message,
    sessionKey: job.sessionKey,
    nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
    lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
    lastStartedAt: job.lastStartedAt ? new Date(job.lastStartedAt).toISOString() : null,
    lastStatus: job.lastStatus,
  };
}
