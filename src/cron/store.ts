import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CronJob, CronOutcome, CronSchedule, InterruptNotice, InterruptedRun, InterruptedSkip, SkipNotice } from "./types.js";
import { closeSharedTomoDbs, DbDamagedError, sharedTomoDb, type TomoDb } from "../db/index.js";
import { deleteMeta, digestOf, isPlaceholder, keepAside, metaValue, setMeta, writePlaceholder } from "../db/legacy.js";
import { writeJsonAtomicSync, isEnoent } from "../fs-utils.js";
import { log } from "../logger.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { computeNextRun, everyIntervalReason, isSingleFire, missedSlots, staleWindowMs, type StaleSkip } from "./schedule.js";

/** Failed one-shot ("at") jobs retry this many times before being disabled. */
export const ONE_SHOT_MAX_RETRIES = 2;
/** Delay before a failed one-shot job's retry. */
export const ONE_SHOT_RETRY_DELAY_MS = 5 * 60_000;

/**
 * A schedule no writer may store, as opposed to one that is merely spent (a
 * fired one-shot). Thrown by `CronStore.add`; the creation surfaces refuse
 * earlier and more politely via `parseCreatableSchedule`, so reaching this is
 * a programming error or a caller that skipped validation.
 */
export class InvalidScheduleError extends Error {
  constructor(reason: string) {
    super(`invalid schedule: ${reason}`);
    this.name = "InvalidScheduleError";
  }
}

/**
 * The cron jobs, one row each in Tomo's database (`cron_jobs`, see
 * src/db/schema.ts). Every process that schedules or edits jobs (the daemon's
 * scheduler and schedule_* tools, `tomo cron`, `tomo config`, the web
 * process) goes through this class.
 *
 * EVERY CHANGE IS ONE WRITE TRANSACTION. A mutator reads the jobs, changes
 * them and writes back the rows it changed, all under SQLite's write lock
 * (`BEGIN IMMEDIATE`), so no other process can write in between. That is the
 * whole of the concurrency story: it replaces the old `jobs.json` lock, the
 * three-way merge against a stale snapshot and the revision check before the
 * rename (#356, a848a8f3). Reads see the last committed state.
 *
 * The record is kept as JSON (column `job`), with the fields worth querying
 * mirrored as generated columns for `tomo db dump` and `sqlite3`. The domain
 * logic below (run tokens, interruption settling, stale skips) is unchanged.
 *
 * THE OLD FILE (`data/cron/jobs.json`) is imported once, by the daemon at
 * start ({@link importLegacyCronJobs}), and then replaced by a placeholder an
 * older Tomo cannot read as a jobs file. Until a real jobs file is imported,
 * every call here refuses ({@link CronStoreReadError}): that file is newer
 * than the table (an older Tomo wrote it, or `tomo db export cron` did).
 */
export class CronStore {
  readonly dbPath: string;

  constructor(dbPath = defaultRuntimePaths.dbPath) {
    this.dbPath = dbPath;
  }

  /** The legacy jobs file this store's database replaced. */
  get legacyPath(): string {
    return legacyCronJobsPath(this.dbPath);
  }

  list(): CronJob[] {
    return readJobs(this.open());
  }

  get(id: string): CronJob | undefined {
    const row = this.open().get<{ job: string }>("SELECT job FROM cron_jobs WHERE id = ?", id);
    return row ? (JSON.parse(row.job) as CronJob) : undefined;
  }

  /** The database, ready for this store; throws CronStoreReadError when it is not. */
  private open(): TomoDb {
    let db: TomoDb;
    try {
      db = sharedDb(this.dbPath);
    } catch (err) {
      throw new CronStoreReadError(this.dbPath, err, err instanceof DbDamagedError ? "the database is damaged; stop Tomo and run `tomo db repair`" : undefined);
    }
    assertLegacyImported(db, this.legacyPath);
    return db;
  }

  /**
   * Run `fn` over every job inside one write transaction and write back what
   * it changed: rows whose record differs are updated, jobs it added are
   * inserted, jobs it took out of the array are deleted.
   */
  private mutate<T>(fn: (jobs: CronJob[]) => T): T {
    const db = this.open();
    return db.transaction(() => {
      // Again under the write lock: a rollback export may have committed
      // between the check in open() and BEGIN, and a change made after its
      // snapshot would be in neither the exported file nor, once that file is
      // imported back, the table.
      assertLegacyImported(db, this.legacyPath);
      const before = new Map(db.all<{ id: string; job: string }>("SELECT id, job FROM cron_jobs").map((r) => [r.id, r.job]));
      const jobs = readJobs(db);
      const result = fn(jobs);
      const kept = new Set(jobs.map((j) => j.id));
      for (const id of before.keys()) if (!kept.has(id)) db.run("DELETE FROM cron_jobs WHERE id = ?", id);
      for (const job of jobs) {
        const json = JSON.stringify(job);
        const prev = before.get(job.id);
        if (prev === undefined) db.run("INSERT INTO cron_jobs (id, job) VALUES (?, ?)", job.id, json);
        else if (prev !== json) db.run("UPDATE cron_jobs SET job = ? WHERE id = ?", json, job.id);
      }
      return result;
    });
  }

  add(opts: {
    name: string;
    schedule: CronSchedule;
    message: string;
    sessionKey: string;
    deleteAfterRun?: boolean;
    staleAfterMs?: number;
  }): CronJob {
    // The one schedule check the store itself owes: an unusable `every`
    // interval is not a state this store may represent at all (unlike a past
    // `at` time, which every fired one-shot is). A caller that skipped
    // `parseCreatableSchedule` — an older CLI, a future surface — must not be
    // able to write `every 0s` in.
    if (opts.schedule.kind === "every") {
      const bad = everyIntervalReason(opts.schedule.everyMs);
      if (bad !== null) throw new InvalidScheduleError(bad);
    }
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
      ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
    };
    this.mutate((jobs) => jobs.push(job));
    return job;
  }

  /** Rewrite sessionKey on all jobs matching oldKey. Returns count changed. */
  rewriteSessionKey(oldKey: string, newKey: string): number {
    return this.mutate((jobs) => {
      let count = 0;
      for (const job of jobs) {
        if (job.sessionKey === oldKey) {
          job.sessionKey = newKey;
          count++;
        }
      }
      return count;
    });
  }

  /**
   * Enable or disable a job. Enabling recomputes the next run; a one-shot
   * ("at") job whose time already passed fires on the next poll, with its
   * retry budget reset — re-enabling a failed reminder is a manual retry.
   *
   * `guard` runs against the job inside the write transaction, so ownership
   * is checked against the state the change applies to. Returns `"refused"`
   * when the guard rejects, distinct from `undefined` (not found).
   *
   * Returns `"unschedulable"` — leaving the job as it was — when enabling it
   * would produce the dead-job shape `enabled: true, nextRunAt: null`: a job
   * every surface reports as scheduled and the 30s scan never picks up. Note
   * this is NOT the same test as `unschedulableReason` alone: a one-shot whose
   * time has passed is re-armed to fire on the next poll, which is the whole
   * point of re-enabling one. It bites the recurring kinds — most obviously a
   * `cron` expression with no future occurrence left, which `add`-time
   * validation never saw because the job was created while it still had one.
   * Callers wanting the WHY call `unschedulableReason(job.schedule, now)`.
   */
  setEnabled(id: string, enabled: boolean): CronJob | undefined | "unschedulable";
  setEnabled(id: string, enabled: boolean, guard: (job: CronJob) => boolean): CronJob | undefined | "refused" | "unschedulable";
  setEnabled(id: string, enabled: boolean, guard?: (job: CronJob) => boolean): CronJob | undefined | "refused" | "unschedulable" {
    return this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      if (guard && !guard(job)) return "refused";
      if (job.enabled === enabled) return job;
      if (enabled) {
        const next = computeNextRun(job.schedule, Date.now());
        if (next === null && job.schedule.kind !== "at") return "unschedulable";
      }
      job.enabled = enabled;
      if (enabled) {
        const now = Date.now();
        const next = computeNextRun(job.schedule, now);
        job.nextRunAt = job.schedule.kind === "at" && next === null ? now : next;
        if (job.schedule.kind === "at") delete job.retryCount;
        // Whoever re-enabled it has seen it; a later interruption is news again.
        if (job.interruptNotifiedAt != null) job.interruptNotifiedAt = null;
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
      return job;
    });
  }

  /**
   * Set (`ms`, 0 = always catch up) or clear (`null` = back to the default)
   * a job's staleness window. `guard` as for setEnabled/remove.
   */
  setStaleAfter(id: string, ms: number | null): CronJob | undefined;
  setStaleAfter(id: string, ms: number | null, guard: (job: CronJob) => boolean): CronJob | undefined | "refused";
  setStaleAfter(id: string, ms: number | null, guard?: (job: CronJob) => boolean): CronJob | undefined | "refused" {
    if (ms !== null && !(Number.isSafeInteger(ms) && ms >= 0)) throw new RangeError(`invalid staleAfterMs: ${ms}`);
    return this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      if (guard && !guard(job)) return "refused";
      if (ms === null) delete job.staleAfterMs;
      else job.staleAfterMs = ms;
      return job;
    });
  }

  /**
   * Remove a job. `guard` is checked against the job inside the same write
   * transaction as the delete. Returns `"refused"` when the guard rejects,
   * distinct from `false` (not found) so the caller can say which happened.
   */
  remove(id: string): boolean;
  remove(id: string, guard: (job: CronJob) => boolean): boolean | "refused";
  remove(id: string, guard?: (job: CronJob) => boolean): boolean | "refused" {
    return this.mutate((jobs) => {
      const i = jobs.findIndex((j) => j.id === id);
      if (i === -1) return false;
      if (guard && !guard(jobs[i])) return "refused";
      jobs.splice(i, 1);
      return true;
    });
  }

  /**
   * Record — durably, BEFORE the agent turn is dispatched — that a run has
   * started. `nextRunAt` only advances once a run completes (markRun), and the
   * scheduler's in-flight guard lives in memory, so without this a daemon that
   * restarts mid-run comes back up, sees a due job, and fires it a second time.
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
    return this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      const runId = randomUUID().slice(0, 8);
      job.lastStartedAt = Date.now();
      job.lastRunId = runId;
      // This dispatch supersedes any earlier interrupted run: whatever marker
      // recovery left is being delivered right now. The status goes with it:
      // from here on the interruption is being acted on, not waiting to be.
      // Leaving `lastStatus: "interrupted"` behind on a live run makes the job
      // look settled to anything that reads the status (setEnabled did
      // exactly that), and it is stale besides — this run's outcome is what
      // markRun is about to write.
      if (job.interruptedAt != null) {
        job.interruptedAt = null;
        if (job.lastStatus === "interrupted") job.lastStatus = null;
      }
      return runId;
    });
  }

  /**
   * Undo `markStarted` for a run that never reached the model — shutdown
   * refused its turn while it was still queued. Nothing ran, so nothing is
   * recorded: the run token is acknowledged (recovery must not read it as an
   * interrupted run, which would burn a one-shot's single retry and stamp a
   * misleading [resumed] marker), and the fields markStarted overwrote are put
   * back. `nextRunAt` was never advanced, so the job is still due and fires
   * normally on the next start. A no-op if another dispatch has since taken
   * the token.
   */
  rollbackStarted(
    id: string,
    runId: string,
    prior: { lastStartedAt: number | null; interruptedAt: number | null; lastStatus: CronJob["lastStatus"] },
  ): void {
    this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.lastRunId !== runId) return;
      job.lastCompletedRunId = runId;
      job.lastStartedAt = prior.lastStartedAt;
      if (prior.interruptedAt != null) {
        job.interruptedAt = prior.interruptedAt;
        job.lastStatus = prior.lastStatus;
      }
    });
  }

  /**
   * A run that graceful shutdown cut short mid-turn (`tomo restart` / `update`
   * / `stop`, including one the job's own turn ran). Settled exactly as
   * restart recovery settles any interrupted run (settleInterruptedRun): never
   * re-run automatically, owner told once after the restart. A no-op if
   * another dispatch has since taken the token.
   */
  markInterruptedByShutdown(id: string, runId: string): void {
    this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.lastRunId !== runId) return;
      const now = Date.now();
      settleInterruptedRun(job, now, now);
    });
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
  markUnacked(id: string, status: CronOutcome): void {
    this.mutate((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return;
      job.lastRunAt = Date.now();
      job.lastStatus = status;
      job.lastCompletedRunId = job.lastRunId ?? null;
      job.enabled = false;
      job.nextRunAt = null;
    });
  }

  /**
   * Settle runs that were dispatched but never acknowledged — the daemon was
   * restarted, crashed or killed mid-turn, or a graceful shutdown could not
   * write the interrupted status. Called before the scheduler's first
   * due-scan, so the normal path never sees a job in a half state.
   *
   * POLICY (decided 2026-11-14): an interrupted run may have done all, some or
   * none of its work, so it is NEVER re-run automatically — no [resumed]
   * fire. Every interrupted run is settled by settleInterruptedRun: a
   * single-fire job is parked and the owner asked whether to run it again; a
   * recurring job records "interrupted", moves to its next normal slot and the
   * owner is told once.
   *
   * Also settles state older versions left behind for an automatic resume (a
   * job still carrying an `interruptedAt` marker): a one-shot queued for its
   * retry is parked instead, a recurring job's pending resume is dropped.
   */
  recoverInterrupted(): { parked: InterruptedSkip[]; recurring: CronJob[] } {
    return this.mutate((jobs) => {
      const now = Date.now();
      const parked: InterruptedSkip[] = [];
      const recurring: CronJob[] = [];
      for (const job of jobs) {
        const legacyResume = !isInterrupted(job) && job.interruptedAt != null;
        if (!isInterrupted(job) && !legacyResume) continue;
        const wasEnabled = job.enabled;
        // legacyResume: an older daemon settled the run and queued an automatic
        // resume. Same incident, new policy: no resume. Either way the moment
        // of the interruption is unknown here — the daemon was not alive to see
        // it — so it is not invented.
        settleInterruptedRun(job, now, null);
        if (isSingleFire(job)) {
          parked.push({ job: { ...job }, reason: wasEnabled ? "once-interrupted" : "once-disabled" });
        } else {
          recurring.push({ ...job });
        }
      }
      return { parked, recurring };
    });
  }

  markRun(id: string, status: CronOutcome): void {
    this.mutate((jobs) => {
      const i = jobs.findIndex((j) => j.id === id);
      if (i === -1) return;
      const job = jobs[i];

      const now = Date.now();
      job.lastRunAt = now;
      job.lastStatus = status;
      // Acknowledge the dispatch token — this is what makes the run "completed"
      // for isInterrupted, independent of any clock.
      job.lastCompletedRunId = job.lastRunId ?? null;
      // A run that got all the way to an outcome clears the crash-loop budget:
      // the cap exists for jobs that keep taking the daemon down mid-turn.
      if (status !== "error") delete job.resumeAttempts;

      if (status !== "error" && job.deleteAfterRun) {
        jobs.splice(i, 1);
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
    });
  }

  /**
   * Skip recurring runs that are due but so far past their slot that firing
   * now would be wrong — the daemon was down across it. Each such job moves
   * to its next slot from `now` and does not fire for the missed one.
   * Single-fire jobs are never skipped (they are the deliverable), nor are
   * the ids in `exclude` (in flight, or awaiting an outcome write: their
   * nextRunAt has not advanced yet for a reason that is not lateness).
   */
  skipStaleRuns(exclude: ReadonlySet<string> = new Set(), now = Date.now()): StaleSkip[] {
    return this.mutate((jobs) => {
      const skipped: StaleSkip[] = [];
      for (const job of jobs) {
        if (!job.enabled || job.nextRunAt === null || exclude.has(job.id) || isSingleFire(job)) continue;
        // A resumed run (recovery left it due with the marker) is the
        // interrupted run being finished, not a missed slot: never skip it.
        if (job.interruptedAt != null) continue;
        const windowMs = staleWindowMs(job, job.nextRunAt);
        const lateByMs = now - job.nextRunAt;
        if (windowMs === 0 || lateByMs <= windowMs) continue;
        // `every`: keep the phase — the next slot on the job's own grid, not
        // `now + interval` (a 09:00 daily job skipped at 16:00 stays a 09:00 job).
        const next = job.schedule.kind === "every" && everyIntervalReason(job.schedule.everyMs) === null
          ? job.nextRunAt + (Math.floor(lateByMs / job.schedule.everyMs) + 1) * job.schedule.everyMs
          : computeNextRun(job.schedule, now);
        // No future slot: leave it due rather than store the dead shape
        // `enabled: true, nextRunAt: null` that nothing ever fires.
        if (next === null) continue;
        job.nextRunAt = next;
        job.lastSkippedAt = now;
        // Durable, so the owner still hears about it after a restart or a
        // failed DM; cleared by markSkipNoticesSent.
        const prior = job.skipNotice ?? null;
        job.skipNotice = { seq: (prior?.seq ?? 0) + 1, count: (prior?.count ?? 0) + 1, lateByMs, windowMs };
        skipped.push({ job: { ...job }, lateByMs, windowMs });
      }
      return skipped;
    });
  }

  /**
   * Interrupted one-shots that were parked (not retried) and that the owner
   * has not been told about yet — including ones parked by older versions,
   * which did so silently. The scheduler reports each once.
   */
  unreportedParkedOneShots(): CronJob[] {
    return this.list().filter((job) =>
      !job.enabled && job.lastStatus === "interrupted" && isSingleFire(job) && job.interruptNotifiedAt == null);
  }

  /** Recurring jobs with an interrupted run the owner has not been told about. */
  unreportedInterruptedRecurring(): CronJob[] {
    return this.list().filter((job) => job.interruptNotice != null);
  }

  /**
   * Record that the owner was told about these recurring interruptions. Only
   * the notices actually reported are cleared (by sequence number), so an
   * interruption landing while the DM is in flight is not lost.
   */
  markRecurringInterruptNoticesSent(sent: ReadonlyArray<{ id: string; notice: InterruptNotice }>): void {
    if (sent.length === 0) return;
    this.mutate((jobs) => {
      for (const { id, notice } of sent) {
        const job = jobs.find((j) => j.id === id);
        const current = job?.interruptNotice;
        if (!job || current == null) continue;
        if (current.seq <= notice.seq) {
          job.interruptNotice = null;
        } else {
          // Interrupted again while the DM was in flight: drop only what was
          // reported, keep the newer ones (they are appended after it).
          const newer = current.seq - notice.seq;
          job.interruptNotice = {
            seq: current.seq,
            count: Math.max(1, current.count - notice.count),
            runs: current.runs.slice(-newer),
          };
        }
      }
    });
  }

  /** Recurring jobs with a stale skip the owner has not been told about. */
  unreportedSkips(): CronJob[] {
    return this.list().filter((job) => job.skipNotice != null);
  }

  /**
   * Record that the owner was told about these skips — exactly the notices
   * that were sent. A job skipped again since then keeps the newer skips.
   */
  markSkipNoticesSent(sent: ReadonlyArray<{ id: string; notice: SkipNotice }>): void {
    if (sent.length === 0) return;
    this.mutate((jobs) => {
      for (const { id, notice } of sent) {
        const job = jobs.find((j) => j.id === id);
        const current = job?.skipNotice;
        if (!job || current == null) continue;
        if (current.seq <= notice.seq) job.skipNotice = null;
        else job.skipNotice = { ...current, count: Math.max(1, current.count - notice.count) };
      }
    });
  }

  /** Record that the owner was told about these parked one-shots. */
  markInterruptNotified(ids: readonly string[], now = Date.now()): void {
    if (ids.length === 0) return;
    this.mutate((jobs) => {
      for (const job of jobs) if (ids.includes(job.id)) job.interruptNotifiedAt = now;
    });
  }

  getDueJobs(): CronJob[] {
    const now = Date.now();
    return this.list().filter((j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now);
  }
}

function readJobs(db: TomoDb): CronJob[] {
  return db.all<{ job: string }>("SELECT job FROM cron_jobs ORDER BY seq").map((r) => JSON.parse(r.job) as CronJob);
}

// --- Connections --------------------------------------------------------------

/** See sharedTomoDb (src/db): one connection per database per process. */
function sharedDb(path: string): TomoDb {
  return sharedTomoDb(path);
}

/** Close the shared connections (tests that remove their database). */
export function closeCronStoreConnections(): void {
  closeSharedTomoDbs();
}

// --- The legacy jobs file -------------------------------------------------------

/** `data/cron/jobs.json`, beside the database's `data/` directory. */
export function legacyCronJobsPath(dbPath: string): string {
  return join(dirname(dbPath), "cron", "jobs.json");
}

/**
 * `meta` row: the digest of the last jobs file imported. A file at the legacy
 * path with that digest is already in the table and is never imported again:
 * a crash between the import's commit and the placeholder leaves it there, and
 * so does restoring a backup that copied `data/` before the daemon's first
 * start imported it (the database snapshot was taken after), even one taken
 * across a later rollback export. The export's own file carries `exportedAt`,
 * so it never has the digest of a file imported before.
 */
export const CRON_IMPORTED_KEY = "legacy_cron_jobs_imported";

/**
 * `meta` row set by the rollback export (`tomo db export cron`), from its
 * snapshot on: the jobs file at the legacy path continues from the table, so
 * every store call refuses (the file is the truth now), and when this
 * version's daemon imports it, it REPLACES the table (an older Tomo may have
 * removed jobs since). Without it, a jobs file there did not start from the
 * table — someone deleted the placeholder and an older Tomo began a new file,
 * as its error message suggests — so it is MERGED in and no job in the table
 * is lost. Cleared by that import, or by a start that finds only the
 * placeholder (an export that never wrote its file).
 */
export const CRON_EXPORTED_KEY = "legacy_cron_jobs_exported";

/**
 * What the daemon leaves at `data/cron/jobs.json` once the jobs live in the
 * database. Valid JSON with no `jobs` array: an older Tomo started without an
 * export reads it as an unreadable store and refuses to schedule (and says
 * so), instead of reading a missing file as a fresh install with no jobs.
 */
export function cronPlaceholder(dbPath: string): { movedToDatabase: string; note: string } {
  return {
    movedToDatabase: dbPath,
    note: "Tomo keeps its scheduled tasks in its database now (table cron_jobs). This file is deliberately not a jobs file, "
      + "so an older Tomo refuses to schedule instead of seeing no tasks. To go back to an older Tomo: "
      + "`tomo stop && tomo db export cron`, then install it.",
  };
}

type LegacyState =
  | { kind: "absent" }
  | { kind: "placeholder" }
  | { kind: "jobs"; jobs: CronJob[]; digest: string; raw: string }
  | { kind: "unreadable"; error: CronStoreReadError };

function readLegacy(path: string): LegacyState {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    return { kind: "unreadable", error: new CronStoreReadError(path, err) };
  }
  try {
    const data = JSON.parse(raw.toString("utf-8")) as Record<string, unknown> | null;
    if (isPlaceholder(data, ["jobs"])) {
      return { kind: "placeholder" };
    }
  } catch {
    /* parseCronStore below says why */
  }
  try {
    const { jobs } = parseCronStore(path, raw.toString("utf-8"));
    return { kind: "jobs", jobs, digest: digestOf(raw), raw: raw.toString("utf-8") };
  } catch (err) {
    return { kind: "unreadable", error: err as CronStoreReadError };
  }
}

/**
 * Refuse after a rollback export, and while a real jobs file sits at the
 * legacy path that is not in the table: it is newer than the table (written
 * by an older Tomo, or by `tomo db export cron`), and only the daemon's start
 * imports it. One that will not read refuses too: as before, an unreadable
 * store is not an empty one.
 */
function assertLegacyImported(db: TomoDb, legacyPath: string): void {
  if (metaValue(db, CRON_EXPORTED_KEY) !== undefined) {
    throw new CronStoreReadError(legacyPath, null, "the jobs were exported for a rollback (`tomo db export cron`); Tomo imports that file when it starts");
  }
  // Not existsSync: it says "absent" for a file it cannot reach too (a
  // directory without search permission). readLegacy tells ENOENT apart.
  const state = readLegacy(legacyPath);
  if (state.kind === "absent" || state.kind === "placeholder") return;
  if (state.kind === "unreadable") throw state.error;
  if (metaValue(db, CRON_IMPORTED_KEY) === state.digest) return;
  throw new CronStoreReadError(legacyPath, null, "this jobs file has not been imported into the database yet; Tomo imports it when it starts");
}

export type CronImportOutcome =
  | { kind: "none" }
  | { kind: "imported"; jobs: number; aside: string | null }
  | { kind: "unreadable"; error: CronStoreReadError };

/**
 * THE DAEMON'S, at start, before anything schedules: import a jobs file at the
 * legacy path into the database, in one transaction, and replace it with the
 * placeholder.
 *
 * After a rollback export (CRON_EXPORTED_KEY) the file replaces the table:
 * the older Tomo continued from it, so it is the newest truth, deletions
 * included. Otherwise (a first upgrade, or an older Tomo that started a new
 * file after the placeholder was deleted) it is merged in: its jobs are
 * added, and win over a row with the same id. Its digest is recorded in the same transaction until the rename
 * lands, so a crash in between does not import it again later over newer
 * rows. No dual writes: the file is never written again, apart from the
 * placeholder; `tomo db export cron` writes it for a rollback.
 *
 * Jobs with an `every` interval that could never be honoured (a hand-edited
 * file, a version predating the bounds) are imported disabled with no next
 * run, and logged: firing one would spin the scheduler.
 *
 * A file that will not read is left where it is and the outcome says so;
 * every store call then refuses with the same error until it is fixed and
 * Tomo restarted, as an unreadable jobs file always did.
 */
export function importLegacyCronJobs(dbPath: string): CronImportOutcome {
  const path = legacyCronJobsPath(dbPath);
  const state = readLegacy(path);
  if (state.kind === "unreadable") {
    log.error({ err: state.error.cause ?? state.error, file: path }, "Cron jobs file could not be read; not imported, and scheduled tasks stay off until it is fixed");
    return { kind: "unreadable", error: state.error };
  }
  const db = sharedDb(dbPath);
  if (state.kind === "absent" || state.kind === "placeholder") {
    if (state.kind === "absent") writePlaceholder(path, cronPlaceholder(dbPath));
    // A rollback export that marked the table but never wrote its file (it
    // failed or was killed): the table is still the truth.
    if (deleteMeta(db, CRON_EXPORTED_KEY) > 0) {
      log.warn({ file: path }, "A cron rollback export never wrote its file; the jobs stay in the database");
    }
    return { kind: "none" };
  }
  const imported = db.transaction(() => {
    if (metaValue(db, CRON_IMPORTED_KEY) === state.digest) {
      // Already in the table. Beside an export mark it is not the export
      // (that one never has an imported digest): the export never landed in
      // this state of things (a restored backup), and the table is the truth.
      deleteMeta(db, CRON_EXPORTED_KEY);
      return null;
    }
    const replace = metaValue(db, CRON_EXPORTED_KEY) !== undefined;
    const before = Number(db.get<{ n: number }>("SELECT count(*) AS n FROM cron_jobs")?.n ?? 0);
    if (replace) db.run("DELETE FROM cron_jobs");
    const seen = new Set<string>();
    for (const job of state.jobs) {
      if (seen.has(job.id)) {
        log.warn({ jobId: job.id, name: job.name }, "Cron jobs file has two jobs with one id; importing the first");
        continue;
      }
      seen.add(job.id);
      holdBadInterval(job, path);
      db.run("INSERT INTO cron_jobs (id, job) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET job = excluded.job", job.id, JSON.stringify(job));
    }
    setMeta(db, CRON_IMPORTED_KEY, state.digest);
    deleteMeta(db, CRON_EXPORTED_KEY);
    return { jobs: seen.size, before, replace };
  });
  if (imported) {
    log.info({ file: path, jobs: imported.jobs, replaced: imported.replace }, "Imported the cron jobs file into the database");
    if (imported.before > 0) {
      log.warn({ inTable: imported.before }, imported.replace
        ? "The imported cron jobs file (an older Tomo continued from the rollback export) replaced the jobs in the database"
        : "Merged a cron jobs file an older Tomo started into the jobs already in the database (none removed)");
    }
  } else {
    log.info({ file: path }, "The cron jobs file is already in the database; replacing it with the placeholder");
  }
  // After the commit, and never leaving the path empty (an older Tomo reads a
  // missing file as a fresh install): a copy aside first, then the
  // placeholder renamed over the file. A crash in between leaves the file,
  // whose digest now matches.
  let aside: string | null = null;
  try {
    aside = keepAside(path, state.raw);
    writePlaceholder(path, cronPlaceholder(dbPath));
  } catch (err) {
    log.warn({ err, file: path }, "Imported the cron jobs file but could not replace it with the placeholder; will retry next start");
  }
  return { kind: "imported", jobs: imported?.jobs ?? state.jobs.length, aside };
}

/**
 * An `every` interval that could never be honoured is stored disabled, with
 * no next run: firing it would spin the scheduler. `setEnabled` refuses to
 * re-arm it (unschedulable).
 */
function holdBadInterval(job: CronJob, path: string): void {
  if (job.schedule.kind !== "every") return;
  const bad = everyIntervalReason(job.schedule.everyMs);
  if (bad === null) return;
  job.enabled = false;
  job.nextRunAt = null;
  log.warn({ jobId: job.id, name: job.name, schedule: job.schedule, reason: bad, file: path }, "Cron job has an unusable interval; imported it disabled");
}

/**
 * `tomo db export cron`: write every job to `out` in the format of the old
 * jobs file (`{ version: 1, revision, jobs }`), fsynced. With `mark` (the
 * rollback, to the legacy path) the table is marked exported in the same
 * transaction, so the next import replaces the table with the file; since a
 * real jobs file is there again, every store call refuses until this
 * version's daemon imports it. The jobs themselves are not changed. Returns
 * how many jobs were written.
 */
export function exportCronJobsToFile(db: TomoDb, out: string, opts: { mark: boolean }): number {
  const write = (jobs: CronJob[]): number => {
    mkdirSync(dirname(out), { recursive: true });
    // `exportedAt` is ignored by an older Tomo; it keeps this file's digest
    // from ever matching a file imported before (CRON_IMPORTED_KEY).
    writeJsonAtomicSync(out, { version: 1, revision: 1, exportedAt: new Date().toISOString(), jobs }, { fsync: true });
    return jobs.length;
  };
  if (!opts.mark) return write(readJobs(db));
  // The snapshot and the mark commit together, BEFORE the file is written:
  // from the mark on, every store call refuses, so nothing changes the table
  // behind the snapshot, and the file is never on disk without the mark (a
  // file without it would be merged on import, bringing back jobs the older
  // Tomo deleted). A mark whose file never landed is undone below, or by the
  // next start, which finds only the placeholder.
  const jobs = db.transaction(() => {
    setMeta(db, CRON_EXPORTED_KEY, new Date().toISOString());
    return readJobs(db);
  });
  try {
    return write(jobs);
  } catch (err) {
    // Only when the file did not land: the atomic write can still fail after
    // its rename (the chmod, the directory fsync), and a landed file without
    // the mark would be merged on import instead of replacing the table.
    if (legacyCronFileReplaceable(out)) {
      try { deleteMeta(db, CRON_EXPORTED_KEY); } catch { /* the next start undoes it */ }
    }
    throw err;
  }
}

/** Is the file at `path` absent, or only the placeholder (safe for a rollback export to replace)? */
export function legacyCronFileReplaceable(path: string): boolean {
  const state = readLegacy(path);
  return state.kind === "absent" || state.kind === "placeholder";
}

/**
 * The store could not be read. Distinct from "no jobs": an unreadable or
 * corrupt store must never be mistaken for an empty one — that reading would
 * let interrupted-run recovery "succeed" with nothing to recover. `path` is
 * the database, or the jobs file that is in the way.
 */
export class CronStoreReadError extends Error {
  readonly path: string;
  /** What is wrong, in a phrase the CLI can print. */
  readonly detail: string | undefined;

  constructor(path: string, cause: unknown, detail?: string) {
    super(`cron store could not be read: ${path}${detail ? ` (${detail})` : cause ? ` (${(cause as Error)?.message ?? cause})` : ""}`, { cause });
    this.name = "CronStoreReadError";
    this.path = path;
    this.detail = detail ?? (cause ? String((cause as Error)?.message ?? cause) : undefined);
  }
}

/**
 * Parse and shape-check the text of a legacy jobs file, with no I/O and no
 * side effects.
 */
export function parseCronStore(path: string, raw: string): { jobs: CronJob[] } {
  let data: { jobs?: unknown };
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
  return { jobs: data.jobs as CronJob[] };
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

/**
 * Settle one interrupted run under the never-auto-re-run policy. Shared by
 * graceful shutdown (markInterruptedByShutdown) and restart recovery, so a
 * crash, a hard kill and a `tomo restart` all end the same way.
 *
 * - The run token is acknowledged: the interruption is accounted for, and is
 *   never settled twice.
 * - `lastStatus: "interrupted"` and `lastInterruptedAt` record it. The latter
 *   survives later runs, so the history keeps the interruption.
 * - `interruptedAt` is the moment of the interruption when it was seen
 *   (graceful shutdown); null when it was not (crash / kill, settled on the
 *   next start), in which case the run's start time stands in.
 * - No `interruptedAt` marker: there is no automatic resume to carry it.
 * - Single-fire (deleteAfterRun, or any "at" schedule): kept, parked —
 *   disabled, no next run — and left unreported, so the owner report names it
 *   and asks whether to run it again (unreportedParkedOneShots).
 * - Recurring: moves to its next NORMAL slot from now (no catch-up), and gets
 *   an `interruptNotice` the owner report sends once.
 */
export function settleInterruptedRun(job: CronJob, now: number, interruptedAt: number | null): void {
  const startedAt = job.lastStartedAt ?? null;
  job.lastCompletedRunId = job.lastRunId ?? null;
  job.lastRunAt = interruptedAt ?? startedAt ?? now;
  job.lastStatus = "interrupted";
  job.lastInterruptedAt = interruptedAt ?? startedAt ?? now;
  if (job.interruptedAt != null) job.interruptedAt = null;
  if (job.resumeAttempts !== undefined) delete job.resumeAttempts;
  if (isSingleFire(job)) {
    job.enabled = false;
    job.nextRunAt = null;
    // A new incident: the owner has not been told about THIS one.
    if (job.interruptNotifiedAt != null) job.interruptNotifiedAt = null;
    return;
  }
  let missed: InterruptedRun["missed"];
  if (job.enabled) {
    const slot = job.nextRunAt;
    const every = job.schedule.kind === "every" ? job.schedule.everyMs : null;
    if (every !== null && everyIntervalReason(every) === null && job.nextRunAt !== null) {
      // Keep the job's own grid: advance the interrupted run's scheduled slot
      // by whole periods to the first one in the future — however long the
      // downtime — rather than re-anchoring the cadence at recovery time.
      const scheduled = job.nextRunAt;
      job.nextRunAt = scheduled + (Math.floor(Math.max(0, now - scheduled) / every) + 1) * every;
    } else {
      job.nextRunAt = computeNextRun(job.schedule, now);
    }
    if (slot !== null) missed = missedSlots(job.schedule, slot, now);
  }
  // Accumulated, never overwritten: a job interrupted again before the owner
  // heard about the first keeps both.
  const prior = job.interruptNotice ?? null;
  const run: InterruptedRun = { startedAt, interruptedAt, ...(missed ? { missed } : {}) };
  const runs = [...(prior?.runs ?? []), run].slice(-MAX_INTERRUPT_NOTICE_RUNS);
  job.interruptNotice = { seq: (prior?.seq ?? 0) + 1, count: (prior?.count ?? 0) + 1, runs };
}

/** Per-job cap on the interruption details kept for the owner report. */
export const MAX_INTERRUPT_NOTICE_RUNS = 10;

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
