import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { CronJob, CronSchedule, InterruptedSkip } from "./types.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

const DEFAULT_STORE_PATH = join(homedir(), ".tomo", "data", "cron", "jobs.json");

/** Failed one-shot ("at") jobs retry this many times before being disabled. */
export const ONE_SHOT_MAX_RETRIES = 2;
/** Delay before a failed one-shot job's retry. */
export const ONE_SHOT_RETRY_DELAY_MS = 5 * 60_000;

/**
 * A recurring job gets this many marked resume fires before the scheduler
 * gives up on it. Without a cap, a job whose turn reliably kills the daemon
 * (or a daemon in a crash loop) re-fires forever, once per restart.
 */
export const MAX_RESUME_ATTEMPTS = 3;

export class CronStore {
  private jobs: CronJob[] = [];
  /**
   * Per-job copy of `jobs` as of the last load — the merge base. The copies
   * are SHALLOW (`{ ...job }`), which is sound only because no mutator edits
   * a nested value in place: `schedule` is replaced wholesale, everything
   * else is a primitive. A future mutator that reaches into a nested object
   * would be invisible to the merge (base and ours would share the object and
   * compare equal) and must deep-copy here instead.
   *
   * Every save is a
   * three-way merge (baseline / our in-memory jobs / whatever is on disk right
   * now), so a concurrent writer that loaded before us and saves between our
   * load and our save cannot silently revert fields we never touched, and we
   * cannot revert theirs. See `mergeWithDisk`.
   *
   * This is not a lock: two writers can still interleave their read-modify-
   * write cycles, and the loser's *conflicting* field edit is lost (last write
   * wins per field). It closes the common case — the daemon writing
   * `lastStartedAt` while a `tomo cron add` / `schedule_create` in another
   * process holds a snapshot that predates it — which would otherwise erase
   * the only durable record that a run was dispatched.
   */
  private baseline = new Map<string, CronJob>();
  /**
   * Set when the last load failed. The instance still exists (constructing a
   * store must not take the daemon down over a transient read error) but it
   * holds no trustworthy state, so reads and writes refuse rather than report
   * an empty store. Cleared by the next successful load.
   */
  private loadError: unknown = null;
  private path: string;

  constructor(path = DEFAULT_STORE_PATH) {
    this.path = path;
    try {
      this.load();
    } catch {
      // Recorded by load(); every read and write refuses until a reload succeeds.
    }
  }

  list(): CronJob[] {
    this.assertLoaded();
    return [...this.jobs];
  }

  get(id: string): CronJob | undefined {
    this.assertLoaded();
    return this.jobs.find((j) => j.id === id);
  }

  /** Refuse to serve or overwrite state we could not read. */
  private assertLoaded(): void {
    if (this.loadError !== null) throw this.loadError;
  }

  add(opts: {
    name: string;
    schedule: CronSchedule;
    message: string;
    sessionKey: string;
    deleteAfterRun?: boolean;
  }): CronJob {
    // Reload before mutating (like markRun/remove): jobs added/removed by
    // separate CLI processes while this instance holds a stale snapshot
    // would otherwise be reverted by the save below.
    this.load();
    const now = Date.now();
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      name: opts.name,
      enabled: true,
      schedule: opts.schedule,
      message: opts.message,
      sessionKey: opts.sessionKey,
      deleteAfterRun: opts.deleteAfterRun ?? (opts.schedule.kind === "at"),
      createdAt: now,
      nextRunAt: computeNextRun(opts.schedule, now),
      lastRunAt: null,
      lastStatus: null,
      lastStartedAt: null,
      lastRunId: null,
      lastCompletedRunId: null,
    };
    this.jobs.push(job);
    this.save();
    return job;
  }

  /** Rewrite sessionKey on all jobs matching oldKey. Returns count changed. */
  rewriteSessionKey(oldKey: string, newKey: string): number {
    this.load();
    let count = 0;
    for (const job of this.jobs) {
      if (job.sessionKey === oldKey) {
        job.sessionKey = newKey;
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * Enable or disable a job. Enabling recomputes the next run; a one-shot
   * ("at") job whose time already passed fires on the next poll, with its
   * retry budget reset — re-enabling a failed reminder is a manual retry.
   */
  setEnabled(id: string, enabled: boolean): CronJob | undefined {
    this.load();
    const job = this.get(id);
    if (!job) return undefined;
    if (job.enabled === enabled) return job;
    job.enabled = enabled;
    if (enabled) {
      const now = Date.now();
      const next = computeNextRun(job.schedule, now);
      job.nextRunAt = job.schedule.kind === "at" && next === null ? now : next;
      if (job.schedule.kind === "at") delete job.retryCount;
      // Re-enabling adjudicates an interrupted run that recovery has ALREADY
      // settled: whoever re-enabled it has decided the job should run again,
      // so clear the state that would otherwise make the next daemon start
      // settle (and for a one-shot, immediately re-disable) it a second time.
      //
      // "Settled" is BOTH halves: the status says interrupted AND the run
      // token is acknowledged. The status alone is not enough — recovery
      // stamps it on a *resumed recurring* job too, and that job then gets
      // dispatched again with the status still set, so a disable→enable
      // during the resumed run would acknowledge the LIVE token and the next
      // restart would re-fire it with no [resumed] marker. Checking
      // isInterrupted means a live run is never mistaken for a settled one.
      // (For a genuinely settled job the ack is a no-op — recovery already
      // acknowledged the token — and stays only to repair a hand-edited file.)
      if (job.lastStatus === "interrupted" && !isInterrupted(job)) {
        job.lastStatus = null;
        job.lastCompletedRunId = job.lastRunId ?? null;
        if (job.interruptedAt != null) job.interruptedAt = null;
        delete job.resumeAttempts;
      }
    } else {
      // Clear rather than leave a stale timestamp that list/detail views
      // would show as a "next run" that will never fire.
      job.nextRunAt = null;
    }
    this.save();
    return job;
  }

  /**
   * Remove a job.
   *
   * `guard` is checked against the job as it exists AFTER the reload, inside
   * the same load-modify-save. Checking ownership against a snapshot taken
   * when the store was constructed is not enough: `load()` here replaces it,
   * so a job written to disk by another process in between was absent from
   * the caller's snapshot, skipped their ownership check, and was then deleted
   * by the filter below. The guard has to run against the state the delete
   * actually applies to.
   *
   * Returns `"refused"` when the guard rejects, distinct from `false`
   * (not found) so the caller can say which happened.
   */
  remove(id: string, guard?: (job: CronJob) => boolean): boolean | "refused" {
    this.load();
    const existing = this.jobs.find((j) => j.id === id);
    if (!existing) return false;
    if (guard && !guard(existing)) return "refused";
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    return true;
  }

  /**
   * Record — durably, BEFORE the agent turn is dispatched — that a run has
   * started. `nextRunAt` only advances once a run completes (markRun), and the
   * scheduler's in-flight guard lives in memory, so without this a daemon that
   * restarts mid-run comes back up, sees a due job on disk, and fires it a
   * second time.
   *
   * The durable flag is a run *token*, not a timestamp comparison:
   * `lastRunId !== lastCompletedRunId` means "dispatched, never acknowledged".
   * Wall-clock ordering would misread a clock that jumped (NTP step, DST-era
   * system time fix, a VM resumed from a snapshot) between dispatch and
   * completion; ids are immune.
   *
   * Returns the new run id, or undefined when the job vanished (removed by a
   * concurrent CLI call between the due-scan and dispatch).
   */
  markStarted(id: string): string | undefined {
    // Reload before mutating, like markRun/add: another process may have
    // changed the file since this instance's last read.
    this.load();
    const job = this.get(id);
    if (!job) return undefined;
    const runId = randomUUID().slice(0, 8);
    job.lastStartedAt = Date.now();
    job.lastRunId = runId;
    // This dispatch supersedes any earlier interrupted run: whatever marker
    // recovery left is being delivered right now. Only written when there is
    // actually a marker to clear — an unconditional `= null` would add the
    // key to every job on every dispatch and, since clearing a field is a
    // merge edit that beats a concurrent value, would let a routine dispatch
    // stomp a marker another process had just set.
    //
    // The status goes with it: from here on the interruption is being acted
    // on, not waiting to be. Leaving `lastStatus: "interrupted"` behind on a
    // live run makes the job look settled to anything that reads the status
    // (setEnabled did exactly that), and it is stale besides — this run's
    // outcome is what markRun is about to write.
    if (job.interruptedAt != null) {
      job.interruptedAt = null;
      if (job.lastStatus === "interrupted") job.lastStatus = null;
    }
    this.save();
    return runId;
  }

  /**
   * Last-resort bookkeeping for a run whose turn finished but whose outcome
   * could not be written (markRun kept throwing — disk full, permissions).
   * The run is acknowledged, so recovery will not treat it as interrupted,
   * and the job is parked: disabled, with no next run. A one-shot that
   * already did its work must never come back through the failure-retry path
   * as if it had never fired, and a recurring job whose store is unwritable
   * cannot keep its cadence honestly anyway.
   */
  markUnacked(id: string, status: "ok" | "error"): void {
    this.load();
    const job = this.get(id);
    if (!job) return;
    job.lastRunAt = Date.now();
    job.lastStatus = status;
    job.lastCompletedRunId = job.lastRunId ?? null;
    job.enabled = false;
    job.nextRunAt = null;
    this.save();
  }

  /**
   * Settle runs that were dispatched but never acknowledged — the daemon was
   * restarted or killed mid-turn. Called before the scheduler's first
   * due-scan, so the normal path never sees a job in a half state.
   *
   * Each interrupted run is closed out (the run token is acknowledged, so the
   * job is not re-flagged on every subsequent restart) and the job is sorted:
   *
   * - `resumed`: recurring jobs, up to MAX_RESUME_ATTEMPTS times. Still due on
   *   disk, so they fire on the next scan — with `interruptedAt` set so the
   *   scheduler marks that fire as a resume in the event body, telling the
   *   model to check state before repeating anything with side effects.
   * - `skipped` with reason `"once"`: one-shot (`deleteAfterRun`) jobs. Their
   *   whole point is a single fire, and that fire already happened; whether it
   *   finished is unknowable. Disabled with `lastStatus: "interrupted"` so a
   *   human/agent can inspect and re-enable — never fired twice.
   * - `skipped` with reason `"resume-cap"`: a recurring job that has been
   *   resumed MAX_RESUME_ATTEMPTS times since its last successful run. A turn
   *   that reliably takes the daemon down (or a crash loop) would otherwise
   *   re-fire once per restart forever.
   */
  recoverInterrupted(): { resumed: CronJob[]; skipped: InterruptedSkip[] } {
    this.load();
    const now = Date.now();
    const resumed: CronJob[] = [];
    const skipped: InterruptedSkip[] = [];
    for (const job of this.jobs) {
      if (!isInterrupted(job)) continue;
      // Acknowledge the run token: this interruption is now accounted for.
      job.lastCompletedRunId = job.lastRunId ?? null;
      job.interruptedAt = job.lastStartedAt ?? now;
      job.lastRunAt = job.lastStartedAt ?? now;
      job.lastStatus = "interrupted";
      const park = (reason: InterruptedSkip["reason"]) => {
        job.enabled = false;
        job.nextRunAt = null;
        // No further fire, so no marker to carry — the state stays visible
        // through lastStatus.
        job.interruptedAt = null;
        skipped.push({ job: { ...job }, reason });
      };
      if (job.deleteAfterRun) {
        park("once");
        continue;
      }
      const attempts = (job.resumeAttempts ?? 0) + 1;
      job.resumeAttempts = attempts;
      if (attempts > MAX_RESUME_ATTEMPTS) {
        park("resume-cap");
        continue;
      }
      resumed.push({ ...job });
    }
    if (resumed.length > 0 || skipped.length > 0) this.save();
    return { resumed, skipped };
  }

  markRun(id: string, status: "ok" | "error"): void {
    // Reload before mutating: jobs are added/removed by separate CLI
    // processes (tomo cron add) while the daemon's run is in flight; saving
    // the stale poll-time snapshot would silently delete them.
    this.load();
    const job = this.get(id);
    if (!job) return;

    const now = Date.now();
    job.lastRunAt = now;
    job.lastStatus = status;
    // Acknowledge the dispatch token — this is what makes the run "completed"
    // for isInterrupted, independent of any clock.
    job.lastCompletedRunId = job.lastRunId ?? null;
    // A run that got all the way to an outcome clears the crash-loop budget:
    // the cap exists for jobs that keep taking the daemon down mid-turn.
    if (status === "ok") delete job.resumeAttempts;

    if (status === "ok" && job.deleteAfterRun) {
      this.remove(id);
      return;
    }

    // Compute next run for recurring jobs
    if (job.schedule.kind === "every") {
      // Advance from the scheduled due time, not from run completion —
      // otherwise every run's duration (an agent turn can take minutes)
      // accumulates as drift. If the daemon was down long enough that the
      // next slot is already in the past, restart the cadence from now
      // instead of burst-firing missed runs.
      const scheduled = job.nextRunAt ?? now;
      const next = scheduled + job.schedule.everyMs;
      job.nextRunAt = next > now ? next : computeNextRun(job.schedule, now);
    } else if (job.schedule.kind !== "at") {
      job.nextRunAt = computeNextRun(job.schedule, now);
    } else if (status === "error" && (job.retryCount ?? 0) < ONE_SHOT_MAX_RETRIES) {
      // A one-shot job IS the deliverable (a reminder, usually) — a failed
      // run gets a bounded number of delayed retries instead of being
      // silently disabled. Recurring jobs need none of this: their next
      // scheduled run is the retry.
      job.retryCount = (job.retryCount ?? 0) + 1;
      job.nextRunAt = now + ONE_SHOT_RETRY_DELAY_MS;
    } else {
      job.enabled = false;
      job.nextRunAt = null;
    }

    this.save();
  }

  getDueJobs(): CronJob[] {
    // Re-read from disk to pick up jobs added by external CLI calls
    this.load();
    const now = Date.now();
    return this.jobs.filter(
      (j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now,
    );
  }

  private load(): void {
    let disk: { jobs: CronJob[]; revision: number };
    try {
      disk = readStore(this.path);
    } catch (err) {
      // A reload that fails AFTER a successful one must not leave the old
      // snapshot serviceable: `list()` would keep reporting the jobs that
      // were there before the file went bad, and the surfaces that degrade on
      // `CronStoreReadError` (watch snapshot, metrics scrape, `tomo status`)
      // would see a healthy store. Record the failure so they degrade too.
      this.loadError = err;
      throw err;
    }
    this.jobs = disk.jobs;
    this.baseline = snapshot(this.jobs);
    this.loadError = null;
  }

  /**
   * Publish our merged view. Optimistic concurrency, not a lock: the file
   * carries a monotonic `revision`, we merge against the revision we just
   * read, and we re-check that revision at the last possible moment — after
   * the temp file is written, immediately before the rename. If another
   * process published in between we re-read, re-merge and try again, so a
   * write can only be lost inside the rename syscall itself instead of across
   * the whole read-modify-write.
   */
  private save(): void {
    // Never publish from a state we could not read: that is how a transient
    // read error turns into an empty jobs file.
    this.assertLoaded();
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    for (let attempt = 1; ; attempt++) {
      const disk = readStore(this.path);
      const merged = mergeWithDisk(this.baseline, this.jobs, disk.jobs);
      try {
        writeJsonAtomicSync(
          this.path,
          { version: STORE_SCHEMA_VERSION, revision: disk.revision + 1, jobs: merged },
          {
            beforeRename: () => {
              if (readStore(this.path).revision !== disk.revision) {
                throw new StaleWriteError(this.path);
              }
            },
          },
        );
      } catch (err) {
        if (err instanceof StaleWriteError && attempt < SAVE_MAX_ATTEMPTS) continue;
        throw err;
      }
      this.jobs = merged;
      this.baseline = snapshot(merged);
      return;
    }
  }
}

/** Schema version of the on-disk file. Unrelated to `revision`. */
const STORE_SCHEMA_VERSION = 1;
/** Optimistic save retries before giving up and reporting a write failure. */
const SAVE_MAX_ATTEMPTS = 5;

/** The file changed under an optimistic save; re-read, re-merge, retry. */
class StaleWriteError extends Error {
  constructor(path: string) {
    super(`cron store changed during write: ${path}`);
    this.name = "StaleWriteError";
  }
}

/**
 * The store could not be read. Distinct from "no store yet": an unreadable or
 * corrupt file must never be mistaken for an empty one — that reading would
 * let interrupted-run recovery "succeed" with nothing to recover and then let
 * the next save overwrite the real jobs with an empty list.
 */
export class CronStoreReadError extends Error {
  /** The store file that could not be read — surfaced by CLI error output. */
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`cron store could not be read: ${path}`, { cause });
    this.name = "CronStoreReadError";
    this.path = path;
  }
}

function readStore(path: string): { jobs: CronJob[]; revision: number } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // Absent is a normal state — a fresh install has no jobs file. Anything
    // else (EACCES, EIO, a directory in the way) is a failure, not emptiness.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], revision: 0 };
    throw new CronStoreReadError(path, err);
  }
  let data: { jobs?: unknown; revision?: unknown };
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CronStoreReadError(path, err);
  }
  if (data === null || typeof data !== "object" || !Array.isArray(data.jobs)) {
    throw new CronStoreReadError(path, new Error("missing or malformed `jobs` array"));
  }
  // Each entry has to be a job record, not merely present: a `null` or a
  // truncated object would otherwise surface later as a TypeError from the
  // first `job.id` / `job.schedule.kind` access — in the scheduler's due-scan,
  // not here — and would never be recognised as the read failure it is.
  const bad = data.jobs.findIndex((entry) => !isJobRecord(entry));
  if (bad !== -1) {
    throw new CronStoreReadError(path, new Error(`jobs[${bad}] is not a job record`));
  }
  return {
    jobs: data.jobs as CronJob[],
    // Files written before revisions existed start at 0 and get 1 on the next
    // save; the counter only ever has to be monotonic within one file.
    revision: typeof data.revision === "number" ? data.revision : 0,
  };
}

const SCHEDULE_KINDS: ReadonlySet<string> = new Set(["at", "every", "cron"]);

/**
 * Shape check for one persisted job: every field `CronJob` declares as
 * required, with the type the store and scheduler dereference without
 * checking. Optional fields (the run-token and resume bookkeeping) are left
 * alone — records written before they existed have none, and every reader
 * already tolerates their absence.
 */
function isJobRecord(entry: unknown): entry is CronJob {
  if (entry === null || typeof entry !== "object") return false;
  const j = entry as Record<string, unknown>;
  const schedule = j.schedule as Record<string, unknown> | null | undefined;
  return (
    typeof j.id === "string" &&
    typeof j.name === "string" &&
    typeof j.enabled === "boolean" &&
    schedule !== null && typeof schedule === "object" &&
    typeof schedule.kind === "string" && SCHEDULE_KINDS.has(schedule.kind) &&
    typeof j.message === "string" &&
    // Absent is a real state (`canManageJob` assigns such orphans to the
    // owner); a non-string is not.
    (j.sessionKey === undefined || typeof j.sessionKey === "string") &&
    typeof j.deleteAfterRun === "boolean" &&
    typeof j.createdAt === "number" &&
    (j.nextRunAt === null || typeof j.nextRunAt === "number") &&
    (j.lastRunAt === null || typeof j.lastRunAt === "number") &&
    (j.lastStatus === null || typeof j.lastStatus === "string")
  );
}

function snapshot(jobs: CronJob[]): Map<string, CronJob> {
  return new Map(jobs.map((j) => [j.id, { ...j }]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Absence and an explicit null are different edits: clearing a field
  // (`interruptedAt = null`, `nextRunAt = null`) is a change that must beat a
  // concurrent non-null value, not be read as "we never touched it".
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Three-way merge of one job. `base` is what we read, `ours` is what we made
 * of it, `theirs` is what is on disk now. Fields we changed win; every other
 * field keeps the on-disk value, so a writer holding a stale snapshot cannot
 * roll back a field it never looked at.
 */
function mergeJob(base: CronJob, ours: CronJob, theirs: CronJob): CronJob {
  const merged = { ...theirs } as Record<string, unknown>;
  const o = ours as unknown as Record<string, unknown>;
  const b = base as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(o), ...Object.keys(b)])) {
    if (sameValue(o[key], b[key])) continue; // untouched by us — theirs stands
    if (o[key] === undefined) delete merged[key];
    else merged[key] = o[key];
  }
  return merged as unknown as CronJob;
}

/**
 * Reconcile our view of the job list with the file. Presence is resolved
 * against the baseline so neither side resurrects a job the other deleted:
 * a job missing from our memory but present in the baseline was deleted by
 * us; one missing from disk but present in the baseline was deleted by them.
 */
export function mergeWithDisk(
  baseline: Map<string, CronJob>,
  ours: CronJob[],
  theirs: CronJob[],
): CronJob[] {
  const ourById = new Map(ours.map((j) => [j.id, j]));
  const theirById = new Map(theirs.map((j) => [j.id, j]));
  const out: CronJob[] = [];

  // Disk order first: keeps unrelated concurrent additions where they were.
  for (const t of theirs) {
    const mine = ourById.get(t.id);
    const base = baseline.get(t.id);
    if (!mine) {
      if (base) continue;   // we removed it
      out.push(t);          // they added it
      continue;
    }
    out.push(base ? mergeJob(base, mine, t) : { ...t, ...mine });
  }
  // Jobs we hold that are not on disk: ours if we created them, dropped if
  // the other writer removed them.
  for (const mine of ours) {
    if (theirById.has(mine.id)) continue;
    if (baseline.has(mine.id)) continue; // removed by them — respect it
    out.push(mine);
  }
  return out;
}

/**
 * A run was dispatched (markStarted) and never acknowledged (markRun /
 * markUnacked / recovery). Within a live daemon that just means "in flight";
 * read at scheduler start it means the previous daemon died mid-run.
 *
 * Compares run *tokens*, not timestamps: `lastStartedAt > lastRunAt` would
 * misjudge a job whose clock stepped backwards between dispatch and
 * completion, in the direction that re-fires work.
 *
 * Jobs written before these fields existed have no `lastRunId`, so they read
 * as never-interrupted — the pre-upgrade backlog is not retro-flagged.
 */
export function isInterrupted(job: CronJob): boolean {
  const runId = job.lastRunId;
  if (runId == null) return false;
  return (job.lastCompletedRunId ?? null) !== runId;
}

export function computeNextRun(schedule: CronSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case "at": {
      const ts = parseAtSchedule(schedule.at);
      return ts > fromMs ? ts : null;
    }
    case "every":
      return fromMs + schedule.everyMs;
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
    const unit = relMatch[2].toLowerCase();
    const ms = unit.startsWith("s") ? val * 1000
      : unit.startsWith("m") ? val * 60_000
      : unit.startsWith("h") ? val * 3_600_000
      : val * 86_400_000;
    return { kind: "at", at: new Date(Date.now() + ms).toISOString() };
  }

  // "every 30m", "every 2h"
  const everyMatch = input.match(/^every\s+(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (everyMatch) {
    const val = Number(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const ms = unit.startsWith("s") ? val * 1000
      : unit.startsWith("m") ? val * 60_000
      : unit.startsWith("h") ? val * 3_600_000
      : val * 86_400_000;
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
