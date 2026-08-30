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
 * @param caller  The session these tools act on behalf of — a key, or a
 *   getter resolved at call time.
 *
 *   Every tool here is scoped by `canManageJob` (src/cron/scope.ts). The cron
 *   store is one flat file shared by every session, so unscoped a group chat —
 *   where any participant can steer the model — could list the full text of
 *   every reminder the owner scheduled from their private DM, remove any of
 *   them, re-enable a dormant one, or create a job that fires a crafted
 *   message into the owner's DM. Scoping puts these tools on the same footing
 *   as the two factories below them in `internal-server.ts`, which already
 *   bound `buildPeopleTools` and `buildRecallTools` to the caller.
 *
 *   A GETTER, not just a key, because the live session a turn runs on is not
 *   always the audience it came from: a summoned group's messages run on the
 *   owner's `dm:` session, so a fixed key would hand every participant of that
 *   group the owner's own DM scope. The getter returns the audience of the
 *   turn in flight — see `Agent.scopedCallerKey`.
 *
 *   Left undefined the tools are unscoped, which is what the tests and any
 *   non-session caller want. `tomo cron` remains the unrestricted human audit
 *   surface — it is not built from these tools.
 */
export function buildCronTools(
  storePath?: string,
  caller?: string | (() => string | undefined),
) {
  /** Resolved per call: a summoned-group turn changes the answer mid-session. */
  const callerKey = (): string | undefined => (typeof caller === "function" ? caller() : caller);
  const manageable = (job: Pick<CronJob, "sessionKey">): boolean => canManageJob(job, callerKey());
  /**
   * May this caller aim a job at `session`? A group may only ever target
   * itself. An identity DM may still schedule into another session —
   * "remind the family group every Sunday" is a normal request, and a DM is
   * the owner's own private surface. The asymmetry is the point: a group is
   * steerable by anyone in it.
   */
  const canTarget = (session: string): boolean => canManageJob({ sessionKey: session }, callerKey());
  /** Every refusal names the way round it, so the model can tell the user. */
  const ELSEWHERE = "this session can only manage scheduled tasks that fire into this conversation — use `tomo cron` on the Mac to see or change the rest.";
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
        "The `session` field is the routing target (the **Session key** in the agent system prompt). Omit it to schedule into the current conversation; pass it only when the user explicitly addresses someone else. A group chat can only schedule into itself.",
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
        session: z.string().min(1).optional().describe(
          'Session key to deliver to. Defaults to the current session, which is almost always what you want. Identity DM ("dm:alice"), iMessage chat key ("imessage:any;+;<guid>"), Telegram chat key ("telegram:-100…"), etc.',
        ),
        once: z.boolean().optional().describe(
          "Override lifecycle. Defaults to true for one-time `at` schedules and false for recurring (`every`/cron). Pass `true` to make a cron expression fire once and auto-delete; pass `false` to keep an `at` job around as a disabled record after firing.",
        ),
      },
      async ({ name, schedule, message, session, once }) => {
        const target = session ?? callerKey();
        if (target === undefined) {
          return {
            content: [{ type: "text" as const, text: "schedule_create failed: no session to deliver to." }],
            isError: true,
          };
        }
        // A session key is a channel name and a chat id; a control character
        // cannot occur in either. This is also what makes the mixed-audience
        // sentinel unrepresentable as a target, so a turn that may manage
        // nothing cannot create a job "owned" by the sentinel and aimed at no
        // real conversation.
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001F]/.test(target)) {
          return {
            content: [{ type: "text" as const, text: `schedule_create failed: ${ELSEWHERE}` }],
            isError: true,
          };
        }
        if (!canTarget(target)) {
          // Deliberately does not confirm whether the target session exists.
          return {
            content: [{ type: "text" as const, text: `schedule_create failed: ${ELSEWHERE}` }],
            isError: true,
          };
        }
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
            sessionKey: target,
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
        "",
        "Scoped to this session: only tasks this conversation may manage are listed. If others exist, a trailing line says how many — nothing else about them. A task with an empty `sessionKey` is an orphan that fires into no conversation; it shows up here for the owner's DM so it can be cleaned up rather than staying invisible and still running.",
      ].join("\n"),
      {},
      async () => {
        const store = new CronStore(storePath);
        const all = store.list();
        const visible = all.filter(manageable);
        const hidden = all.length - visible.length;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(visible.map(summarizeJob), null, 2) },
            // A bare count, not a summary: the message text of a reminder the
            // owner scheduled from their DM is the thing being protected, and
            // so is which sessions exist. Reported at all because "no tasks"
            // and "no tasks you can see" are different facts, and the model
            // will otherwise tell the user there are none.
            ...(hidden > 0
              ? [{
                type: "text" as const,
                text: `${hidden} further scheduled task${hidden === 1 ? " belongs" : "s belong"} to other sessions and cannot be listed here — use \`tomo cron\` on the Mac to audit every session's tasks.`,
              }]
              : []),
          ],
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
        if (!manageable(existing)) {
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
        "",
        "Scoped to this session: only tasks this conversation may manage can be removed here.",
      ].join("\n"),
      {
        id: z.string().min(1).describe("The job id from `schedule_list` (e.g. `f43d8a93`)."),
      },
      async ({ id }) => {
        const store = new CronStore(storePath);
        // The guard runs inside remove()'s own load-modify-save, against the
        // job as it exists on disk at that moment. Checking `store.get(id)`
        // here instead would consult the constructor's snapshot, which
        // remove() then replaces — a job written by another process in between
        // would skip the check entirely and be deleted.
        const removed = store.remove(id, manageable);
        if (removed === "refused") {
          // Deliberately does not name the owning session.
          return {
            content: [{ type: "text" as const, text: `Job ${id} belongs to a different session; ${ELSEWHERE}` }],
            isError: true,
          };
        }
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
