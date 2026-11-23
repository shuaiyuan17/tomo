/**
 * Schedule math for cron jobs: when a schedule next fires, how long a missed
 * run stays worth catching up, and parsing / validating the schedule strings
 * the creation surfaces accept. Pure functions over a schedule — no store I/O.
 */
import { Cron } from "croner";
import type { CronJob, CronSchedule, InterruptedRun } from "./types.js";
import { errorMessage } from "../error-text.js";

/**
 * Default staleness window for a ONE-SHOT (see staleWindowMs). A one-shot has
 * no period to scale against; it is usually a reminder or a hand-off someone
 * is waiting on, and two hours still covers a restart, an update or a short
 * outage without delivering yesterday's reminder today. (An INTERRUPTED
 * one-shot is never retried automatically, however fresh — see
 * settleInterruptedRun.)
 */
export const ONE_SHOT_STALE_AFTER_MS = 2 * 3_600_000;

/**
 * DEFAULT STALENESS WINDOW FOR RECURRING JOBS — scales with the job's period.
 *
 * A missed run is worth firing late while it is still closer to its own slot
 * than to the next one, so the window is half the period, clamped:
 *
 * - at most STALE_WINDOW_MAX_MS (12h): a daily job (backup, health check,
 *   brief) still catches up after an outage of up to half a day — skipping a
 *   backup is worse than running it late — while a longer outage does not end
 *   with the morning's brief arriving in the evening, right before the next.
 * - at least STALE_WINDOW_MIN_MS (5 min): a short-interval job is not skipped
 *   over a scan that ran a little late (a busy event loop, a lock wait).
 *
 * A job whose period is longer than CATCH_UP_PERIOD_MS (a little over a day,
 * so a 25-hour DST day still counts as daily) ALWAYS catches up by default:
 * skipping it would silently drop a whole week, month, quarter or year.
 * Likewise when the period cannot be determined.
 *
 * Per job: `staleAfterMs` overrides all of this (0 = always catch up).
 */
export const STALE_WINDOW_MAX_MS = 12 * 3_600_000;
export const STALE_WINDOW_MIN_MS = 5 * 60_000;
export const CATCH_UP_PERIOD_MS = 25 * 3_600_000;

/**
 * The gap from a run's slot to the one after it: the interval for `every`;
 * for a cron expression, from `slotMs` (an occurrence — typically the missed
 * one) to the next occurrence. So a weekday cron missed on a Thursday has a
 * 24h period and one missed on a Friday a 72h one, and a DST day is 23 or
 * 25h. Without `slotMs`, the next occurrence after now is the slot. Null for
 * one-shots and for anything that cannot be evaluated.
 */
export function schedulePeriodMs(schedule: CronSchedule, slotMs?: number): number | null {
  if (schedule.kind === "every") return everyIntervalReason(schedule.everyMs) === null ? schedule.everyMs : null;
  if (schedule.kind !== "cron") return null;
  try {
    const cron = new Cron(schedule.expr, { timezone: schedule.tz });
    const slot = slotMs ?? cron.nextRun()?.getTime();
    if (slot === undefined) return null;
    const next = cron.nextRun(new Date(slot));
    return next ? next.getTime() - slot : null;
  } catch {
    return null;
  }
}

/**
 * The job's staleness window in ms; 0 means "never stale" (always catch up).
 * `slotMs` is the run being judged (defaults to the job's nextRunAt).
 */
export function staleWindowMs(
  job: Pick<CronJob, "staleAfterMs" | "schedule" | "deleteAfterRun"> & { nextRunAt?: number | null },
  slotMs: number | undefined = job.nextRunAt ?? undefined,
): number {
  const own = job.staleAfterMs;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) return own;
  if (isSingleFire(job)) return ONE_SHOT_STALE_AFTER_MS;
  const period = schedulePeriodMs(job.schedule, slotMs);
  if (period === null || period > CATCH_UP_PERIOD_MS) return 0;
  return Math.min(STALE_WINDOW_MAX_MS, Math.max(STALE_WINDOW_MIN_MS, Math.floor(period / 2)));
}

/**
 * Milliseconds in one schedule unit, keyed by its first letter: s/sec, m/min,
 * h/hr, d/day (any case; the grammar's regexes decide which spellings reach
 * here).
 */
function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  return u.startsWith("s") ? 1000
    : u.startsWith("m") ? 60_000
    : u.startsWith("h") ? 3_600_000
    : 86_400_000;
}

/**
 * Parse a `--stale-after` value: "0", or a whole number with a unit
 * (s, m, h, d). Null when unusable.
 */
export function parseStaleAfter(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "0") return 0;
  const match = /^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i.exec(trimmed);
  if (!match) return null;
  const val = Number(match[1]);
  const ms = val * unitMs(match[2]);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Single-fire: every `at` schedule, and anything that deletes itself after a run. */
export function isSingleFire(job: Pick<CronJob, "deleteAfterRun" | "schedule">): boolean {
  return job.deleteAfterRun || job.schedule.kind === "at";
}

/** A recurring run skipped because its slot was too far in the past. */
export interface StaleSkip {
  job: CronJob;
  /** How late the run would have been, in ms. */
  lateByMs: number;
  windowMs: number;
}

/**
 * Floor for a recurring ("every") interval, in milliseconds. Kept equal to the
 * scheduler's `POLL_INTERVAL_MS` (30s, `src/cron/scheduler.ts` — a test pins
 * the two together): a job cannot fire more often than the scan that dispatches
 * it, so a shorter interval is a cadence the scheduler cannot keep. Zero is
 * worse than unkeepable — `computeNextRun` returns `fromMs + 0`, so the job is
 * due again the instant `markRun` records the run it just finished, and fires
 * on every poll forever.
 */
export const MIN_EVERY_MS = 30_000;

/**
 * Ceiling for a recurring interval (~1 year). Guards the other end of the
 * range: `every 99999999999999d` multiplies past `Number.MAX_SAFE_INTEGER`, and
 * the job would be stored `enabled: true` with a `nextRunAt` no clock ever
 * reaches — scheduled as far as every surface can tell, and silently inert.
 */
export const MAX_EVERY_MS = 366 * 86_400_000;

/**
 * Why this recurring interval cannot be scheduled, or null when it is usable.
 * The phrasing slots into the refusal templates both creation surfaces use
 * (`Cannot schedule "...": <reason>, so the job could never fire.`).
 */
export function everyIntervalReason(everyMs: unknown): string | null {
  if (typeof everyMs !== "number" || !Number.isSafeInteger(everyMs)) {
    return "its interval is not a whole number of milliseconds";
  }
  if (everyMs < MIN_EVERY_MS) {
    return `an interval of ${everyMs}ms is below the ${MIN_EVERY_MS / 1000}s minimum`;
  }
  if (everyMs > MAX_EVERY_MS) {
    return `an interval of ${everyMs}ms is above the ${MAX_EVERY_MS / 86_400_000}-day maximum`;
  }
  return null;
}

/** Upper bound on slots walked when counting a cron-expression job's gap. */
const MAX_MISSED_SLOT_WALK = 100_000;

/**
 * The recurring slots strictly AFTER the interrupted run's own `slot` and up
 * to `now` — the runs a downtime swallowed, which the policy does not catch
 * up. Count plus the first and last, for the owner report; undefined when
 * there are none (the usual graceful restart).
 */
export function missedSlots(schedule: CronSchedule, slot: number, now: number): InterruptedRun["missed"] {
  if (schedule.kind === "every") {
    if (everyIntervalReason(schedule.everyMs) !== null) return undefined;
    const count = Math.floor(Math.max(0, now - slot) / schedule.everyMs);
    if (count === 0) return undefined;
    return { count, from: slot + schedule.everyMs, to: slot + count * schedule.everyMs };
  }
  if (schedule.kind !== "cron") return undefined;
  // croner directly: computeNextRun's cron branch always answers "after now".
  const cron = new Cron(schedule.expr, { timezone: schedule.tz });
  let count = 0;
  let from = 0;
  let to = 0;
  let t = cron.nextRun(new Date(slot))?.getTime() ?? null;
  while (t !== null && t <= now && count < MAX_MISSED_SLOT_WALK) {
    if (count === 0) from = t;
    to = t;
    count++;
    t = cron.nextRun(new Date(t))?.getTime() ?? null;
  }
  return count > 0 ? { count, from, to } : undefined;
}

/**
 * Why this schedule can never fire, or null when it can — the check every
 * job-CREATION surface owes its caller.
 *
 * `computeNextRun` returning null is not an error condition on an existing
 * job (a fired one-shot has no next run, and that is the point), but at
 * creation time it means the job would land `enabled: true` with
 * `nextRunAt: null`: a task the store reports as scheduled, the scan never
 * picks up, and the user finds out about when the reminder does not arrive.
 * `croner` only throws for a syntactically bad expression, so a try/catch
 * around `computeNextRun` does not catch this — hence a separate check.
 *
 * Deliberately NOT enforced inside `add()`: the store primitive has to be able
 * to represent a one-shot whose time has passed (that is every fired `at` job
 * still on disk, and what `setEnabled` re-arms). The refusal belongs where a
 * human or the model is asking for a NEW job. The one exception is an `every`
 * interval outside `MIN_EVERY_MS`..`MAX_EVERY_MS`, which is not a spent
 * schedule but an unrepresentable one — `add()` rejects that outright.
 *
 * May throw for a malformed cron expression — callers already handle that.
 */
export function unschedulableReason(schedule: CronSchedule, fromMs: number): string | null {
  // Checked ahead of computeNextRun so the caller gets the actual defect
  // ("below the 30s minimum") rather than the generic no-occurrence line, and
  // so `every 0s` — which computeNextRun would otherwise have answered with a
  // perfectly good timestamp — is refused at all.
  if (schedule.kind === "every") {
    const bad = everyIntervalReason(schedule.everyMs);
    if (bad !== null) return bad;
  }
  if (computeNextRun(schedule, fromMs) !== null) return null;
  if (schedule.kind === "at") {
    return Number.isNaN(parseAtSchedule(schedule.at))
      ? `"${schedule.at}" is not a date/time that can be parsed`
      : `${schedule.at} is in the past`;
  }
  return "it has no future occurrence";
}

/**
 * The outcome of validating a `--schedule` / `schedule` string on a surface
 * that is CREATING a job: either the parsed schedule, or which of the two ways
 * it is unusable. Both are refusals, and neither should reach the user as a
 * croner stack trace.
 */
export type CreatableSchedule =
  | { kind: "ok"; schedule: CronSchedule }
  /** croner rejected the expression outright — `detail` is its message. */
  | { kind: "unparseable"; detail: string }
  /** Well-formed, but with no future occurrence — see `unschedulableReason`. */
  | { kind: "unschedulable"; reason: string };

/**
 * Parse and validate a schedule string for a job-creation surface.
 *
 * `parseScheduleString` accepts any unrecognized string as `kind: "cron"`
 * (catch-all) and croner only throws when the expression is actually
 * evaluated, so the validation is this trial run — not `store.add`, whose
 * failures are about the STORE and must not be reported as a bad schedule.
 *
 * Shared by `schedule_create` and `tomo cron add` so the two cannot drift on
 * what they accept, and so neither prints a stack trace at whoever typed it.
 */
export function parseCreatableSchedule(text: string, fromMs = Date.now()): CreatableSchedule {
  let schedule: CronSchedule;
  let reason: string | null;
  try {
    schedule = parseScheduleString(text);
    reason = unschedulableReason(schedule, fromMs);
  } catch (err) {
    return { kind: "unparseable", detail: errorMessage(err) };
  }
  return reason === null ? { kind: "ok", schedule } : { kind: "unschedulable", reason };
}

export function computeNextRun(schedule: CronSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case "at": {
      const ts = parseAtSchedule(schedule.at);
      return ts > fromMs ? ts : null;
    }
    case "every":
      // An interval outside the bounds has no honourable next run: 0 means
      // "due again immediately, forever", and a value past MAX_SAFE_INTEGER
      // means "never". Both read as null here, which is what every caller
      // already treats as "this cannot fire".
      return everyIntervalReason(schedule.everyMs) === null ? fromMs + schedule.everyMs : null;
    case "cron": {
      const cron = new Cron(schedule.expr, { timezone: schedule.tz });
      const next = cron.nextRun();
      return next ? next.getTime() : null;
    }
  }
}

export function parseScheduleString(input: string): CronSchedule {
  // "in 20m", "in 2h", "in 1d"
  const relMatch = input.match(/^in\s+(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (relMatch) {
    const val = Number(relMatch[1]);
    const ms = val * unitMs(relMatch[2]);
    return { kind: "at", at: new Date(Date.now() + ms).toISOString() };
  }

  // "every 30m", "every 2h"
  const everyMatch = input.match(/^every\s+(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (everyMatch) {
    const val = Number(everyMatch[1]);
    const ms = val * unitMs(everyMatch[2]);
    return { kind: "every", everyMs: ms };
  }

  // ISO-8601 date
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
    return { kind: "at", at: input };
  }

  // Assume cron expression
  return { kind: "cron", expr: input, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function parseAtSchedule(at: string): number {
  return new Date(at).getTime();
}
