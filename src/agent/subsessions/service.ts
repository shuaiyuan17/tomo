import { log } from "../../logger.js";
import { ownerT, type OwnerText } from "../../i18n/index.js";
import type { SubsessionConfig } from "../../config.js";
import { isTaskSessionKey } from "../../sessions/keys.js";
import { formatTomoEvent } from "../../tomo-event.js";
import { MODEL_ALIASES } from "../../models.js";
import { SubsessionStoreError, type SubsessionStore, type TransitionOutcome } from "./store.js";
import type { SubsessionEvent } from "./state-machine.js";
import {
  compactInstructions,
  formatContinueEvent,
  formatPostCompactReminder,
  formatNewInputNote,
  formatRedeliveryNote,
  formatRelayEvent,
  formatResumeEvent,
  formatStartEvent,
} from "./prompt.js";
import { OPEN_STATUSES, PENDING_INPUT_MAX, TERMINAL_STATUSES, appendInput, lastInputSeq, type SubsessionRecord } from "./types.js";

/** How a task turn ended, as the agent's turn runner saw it. */
export interface TaskTurnOutcome {
  /** Ran to its normal result. */
  ok: boolean;
  /** The owner stopped it. */
  stopped?: boolean;
  /** Shutdown refused or cut it short: not an outcome at all. */
  shutdown?: boolean;
}

export interface SubsessionServiceDeps {
  store: SubsessionStore;
  config(): SubsessionConfig;
  /**
   * Run one silent turn on a task key, queued on that key like any other
   * turn. `bare`: send the prompt exactly as given (a `/compact` command must
   * lead its message), with no pending notes or stamp in front.
   */
  runTaskTurn(key: string, prompt: string, opts: { bare: boolean }): Promise<TaskTurnOutcome>;
  /**
   * Put `text` (the task's own words, prefix included) into the owning
   * session's chat, recorded there like any direct send. `taskKey` is the
   * caller, whose audience decides which attachments may go.
   */
  sendToScope(parentKey: string, text: string, taskKey: string, noteFrom: string): Promise<{ ok: boolean; error?: string }>;
  /** A harness notice about a task, to the owning scope's chat. */
  noticeToScope(parentKey: string, text: OwnerText): Promise<void>;
  queuePendingNote(key: string, note: string): boolean;
  hasPendingNote(key: string, predicate: (note: string) => boolean): boolean;
  /**
   * Write the session's pending notes (queued and in flight) to disk again.
   * A note whose first write failed is still held in memory, so finding it
   * there does not mean it is durable. Returns false when the write fails.
   */
  persistPendingNotes?(key: string): boolean;
  /** A harness notice to the owner's own chat (no task to attribute it to). */
  noticeOwner(text: OwnerText): Promise<void>;
  /** A silent turn on the owning session that reads the notes queued for it. */
  wakeScope(parentKey: string, prompt: string): void;
  /** The last turn's context reading on a key, if any. */
  contextUsage(key: string): { used: number; estimated: boolean } | undefined;
  /** Enabled cron jobs that deliver to `key`; undefined when the cron store cannot be read (unknown, not zero). */
  cronJobCount(key: string): number | undefined;
  removeCronJobs(key: string): void;
  /** Soft-stop the key's live session, then close it; hard close after `timeoutMs`. */
  stopSession(key: string, timeoutMs: number): Promise<void>;
  /** Registry: does the key have an SDK session to resume? */
  hasSdkSession(key: string): boolean;
  ensureRegistryEntry(key: string): void;
  /** Unlink the key's registry entry (it then expires with the usual 30-day TTL). */
  unlinkRegistryEntry(key: string): void;
  /** Active registry keys that are task keys. */
  registryTaskKeys(): string[];
  isStopping(): boolean;
  now?(): number;
}

export const STOP_TIMEOUT_MS = 30_000;
export const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A task parked while the cron store could not be read: how soon it is looked at again. */
export const CRON_RECHECK_MS = 60_000;
export const MAX_INTERRUPT_STREAK = 3;
export const MAX_TURNS_WITHOUT_PROGRESS = 3;
export const MAX_FAIL_STREAK = 2;
const REPORT_NOTE_EXCERPT = 600;
/** A report note that could not be written is retried in-process, this often, this many times. */
export const REPORT_RETRY_MS = 60_000;
export const REPORT_RETRY_MAX = 5;
/** A turn whose result could not be written: how soon the task gets its next turn. */
export const SETTLE_RETRY_MS = 60_000;
const ACTIVITY_NOTE_EXCERPT = 1500;

/** Models a task may use: aliases opus / sonnet / fable, or any full id that is not a Haiku model. */
export function validateTaskModel(model: string): string | null {
  const name = model.trim();
  if (!name) return "model is empty";
  if (/haiku/i.test(name)) return "Haiku is not offered for sub-sessions: a sub-session means a long task, and the savings don't cover the rework. Use sonnet for routine work.";
  if (name in MODEL_ALIASES || /^claude-/.test(name)) return null;
  return `unknown model "${name}"; use opus, sonnet or fable`;
}

export type SpawnResult = { ok: true; record: SubsessionRecord } | { ok: false; error: string };

interface PlannedTurn {
  kind: "compact" | "wake" | "continue";
  prompt: string;
  /**
   * The highest input seq this turn carries (0: none). Held in memory only:
   * the inputs stay on the record until the write that records this turn's
   * result removes them.
   */
  throughSeq: number;
  /** Carries the post-compact reminder: does not count as progress or as no progress. */
  afterCompact: boolean;
  resume: boolean;
  start: boolean;
}

/**
 * The sub-session state machine at work: spawn, the scheduler, the per-task
 * driver that runs turns and decides what follows each one, the task's own
 * tool calls, cron wakes, restart recovery and the startup reconcile.
 *
 * Every status change goes through `store.transition` (see state-machine.ts).
 * Runtime facts — which task has a driver running, tool calls seen in the
 * current turn, whether a "continue" is owed — live here in memory and are
 * never persisted: after a restart, the persisted lifecycle plus
 * `resumeNeeded` is all that is needed.
 */
export class SubsessionService {
  private readonly driving = new Set<string>();
  private readonly continueOwed = new Set<string>();
  private readonly toolCalls = new Map<string, number>();
  private readonly progressChanged = new Set<string>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly reportTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportAttempts = new Map<string, number>();
  /** Reports whose note write failed: the note may sit in memory only. */
  private readonly unpersistedReports = new Set<string>();
  private cronRecheckTimer?: NodeJS.Timeout;
  /**
   * Inputs a completed turn carried whose result could not be written: they
   * are still on the record, and the next turn in this process says they may
   * have been acted on. (After a restart, recovery marks them on disk.)
   */
  private readonly unsavedSeen = new Map<string, number>();
  /** Tasks whose last result could not be written: no turn until the retry timer. */
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private started = false;
  /** The table could not be read at start: the feature stays off until the next start. */
  private broken = false;

  constructor(private readonly deps: SubsessionServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get store(): SubsessionStore {
    return this.deps.store;
  }

  /** Usable right now (enabled, and the table was readable at start). */
  available(): boolean {
    return this.deps.config().enabled && !this.broken;
  }

  get(id: string): SubsessionRecord | undefined {
    return this.store.get(id);
  }

  byKey(key: string): SubsessionRecord | undefined {
    return this.store.byKey(key);
  }

  /** The owning session of a task key, or undefined when unknown (callers fail closed). */
  parentKeyOf(key: string): string | undefined {
    if (!isTaskSessionKey(key)) return undefined;
    try {
      return (this.store.peek() ?? this.store.read()).tasks.find((t) => t.sessionKey === key)?.parentKey;
    } catch {
      return undefined;
    }
  }

  /** The model recorded for a task key, if any. */
  modelFor(key: string): string | undefined {
    const record = this.safeByKey(key);
    return record?.model ?? this.deps.config().defaultModel ?? undefined;
  }

  effortFor(key: string): string | undefined {
    return this.safeByKey(key)?.effort;
  }

  list(parentKey?: string): SubsessionRecord[] {
    const all = this.store.list();
    return parentKey === undefined ? all : all.filter((t) => t.parentKey === parentKey);
  }

  // ---------------------------------------------------------------------
  // Owning-session side (task_spawn / task_status / task_cancel / task_message)
  // ---------------------------------------------------------------------

  spawn(parentKey: string, input: { title: string; brief: string; quote?: string[]; model?: string; effort?: string }): SpawnResult {
    if (!this.available()) return { ok: false, error: "Sub-sessions are not available right now." };
    const cfg = this.deps.config();
    if (input.model !== undefined) {
      const problem = validateTaskModel(input.model);
      if (problem) return { ok: false, error: problem };
    }
    const open = this.store.list().filter((t) => OPEN_STATUSES.has(t.status)).length;
    if (open >= cfg.maxOpen) {
      return { ok: false, error: `${open} sub-sessions are already open (limit ${cfg.maxOpen}). Finish or cancel one first.` };
    }
    const record = this.store.create({ parentKey, ...input, ...(input.model ? { model: input.model.trim() } : {}) });
    this.deps.ensureRegistryEntry(record.sessionKey);
    this.schedule();
    return { ok: true, record: this.store.get(record.id) ?? record };
  }

  async cancel(id: string, reason: string): Promise<TransitionOutcome> {
    const outcome = this.store.transition(id, "cancel", { reason });
    if (!outcome.ok || !outcome.changed) return outcome;
    this.continueOwed.delete(id);
    this.safely(() => this.deps.removeCronJobs(outcome.record.sessionKey), "remove cron jobs");
    await this.deps.stopSession(outcome.record.sessionKey, STOP_TIMEOUT_MS).catch((err) => {
      log.warn({ err, id }, "Stopping a cancelled sub-session's live session failed");
    });
    this.schedule();
    return outcome;
  }

  /** The owning session passes something on (Phase 1a: how the owner answers). */
  relay(id: string, text: string): TransitionOutcome {
    return this.deliverInput(id, "relay", formatRelayEvent(text));
  }

  // ---------------------------------------------------------------------
  // Task side (task_notify / task_progress / task_checkpoint / task_finish / task_reopen)
  // ---------------------------------------------------------------------

  async notify(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, error: "No task record for this session." };
    if (TERMINAL_STATUSES.has(record.status)) return { ok: false, error: `This task is ${record.status}; nothing more is sent.` };
    const body = text.trim();
    if (!body) return { ok: false, error: "text is empty" };
    const result = await this.deps.sendToScope(record.parentKey, `${taskPrefix(record)} ${body}`, key,
      `Your sub-session ${record.id} ("${record.title}")`);
    if (result.ok) {
      this.store.update(record.id, (r) => { r.sent.push({ at: this.now(), kind: "notify", text: body }); });
    }
    return result;
  }

  progress(key: string, line: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    const value = line.trim().split("\n")[0].slice(0, 300);
    const updated = this.store.update(record.id, (r) => { r.progress = value; });
    if (updated && value !== record.progress) this.progressChanged.add(record.id);
    return updated;
  }

  checkpoint(key: string, summary: string): SubsessionRecord | undefined {
    const record = this.store.byKey(key);
    if (!record) return undefined;
    this.progressChanged.add(record.id);
    return this.store.update(record.id, (r) => { r.checkpoint = summary.trim().slice(0, 8000); });
  }

  finish(key: string, report: string): TransitionOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, from: null };
    const outcome = this.store.transition(record.id, "finish", {
      patch: (r) => { r.report = report.trim(); r.reportDelivered = false; },
    });
    if (!outcome.ok) return outcome;
    this.continueOwed.delete(record.id);
    this.safely(() => this.deps.removeCronJobs(key), "remove cron jobs");
    this.deliverReport(outcome.record);
    this.schedule();
    return outcome;
  }

  reopen(key: string): TransitionOutcome {
    const record = this.store.byKey(key);
    if (!record) return { ok: false, from: null };
    const outcome = this.store.transition(record.id, "reopen", { patch: (r) => { r.turnsWithoutProgress = 0; } });
    // The turn that reopened it is running now; its end decides what follows.
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Agent hooks
  // ---------------------------------------------------------------------

  /** A tool call finished on a task session. */
  noteToolUse(key: string): void {
    const record = this.safeByKey(key);
    if (!record) return;
    this.toolCalls.set(record.id, (this.toolCalls.get(record.id) ?? 0) + 1);
  }

  /** A cron job fired on a task key. Returns true when the task took it. */
  onCronFire(key: string, prompt: string): boolean {
    const record = this.safeByKey(key);
    if (!record) {
      log.warn({ key }, "Cron fired on an unknown sub-session; dropping it");
      return false;
    }
    if (!this.available()) {
      log.warn({ key }, "Cron fired on a sub-session while sub-sessions are off; dropping it");
      return false;
    }
    if (TERMINAL_STATUSES.has(record.status) || record.status === "finished") {
      log.info({ id: record.id, status: record.status }, "Cron fired on an ended sub-session; removing its jobs");
      this.safely(() => this.deps.removeCronJobs(key), "remove cron jobs");
      return false;
    }
    if (record.status === "waiting" && record.waitingOn === "owner") {
      // Only the owner wakes a task that is waiting on the owner.
      log.info({ id: record.id }, "Cron fired on a sub-session waiting for the owner; ignored");
      return false;
    }
    const outcome = this.store.transition(record.id, "cron_wake", {
      reason: "scheduled check-back",
      guard: inputQueueFull,
      patch: (r) => { appendInput(r, prompt); },
    });
    if (!outcome.ok) {
      if (outcome.refused) void this.tellScope(record, ownerT("subsessions")("inputFull", { id: record.id, title: record.title, max: PENDING_INPUT_MAX }));
      return false;
    }
    if (outcome.record.status === "queued") this.schedule();
    else this.kick(record.id);
    return true;
  }

  /**
   * A turn the SDK started on its own (a background subagent reporting back)
   * just ended on a task key. It ran silently and could not be held; what it
   * changes is the lifecycle. A task waiting on something external is queued
   * with a "continue" owed (the scheduler gives it a slot, as for a cron
   * check-back); an active task with no driver gets one, so auto-continue
   * applies. Waiting on the owner, or finished: nothing changes.
   */
  onBackgroundReport(key: string): void {
    const record = this.safeByKey(key);
    if (!record || TERMINAL_STATUSES.has(record.status)) return;
    const outcome = this.store.transition(record.id, "background_report", {
      reason: "a background task reported back",
      // Only when it was queued by this event (the status is judged under the lock).
      patch: (r) => {
        const last = r.transitions.at(-1);
        if (r.status === "queued" && last?.event === "background_report" && last.at === r.lastActivityAt) {
          appendInput(r, formatTomoEvent("subsession-continue", "A background task of yours reported back. Continue with the task: finish it, or schedule a check-back if you still have to wait."));
        }
      },
    });
    if (!outcome.ok) return;
    if (outcome.record.status === "queued") {
      this.schedule();
      return;
    }
    if (outcome.record.status === "active" && !this.driving.has(record.id)) {
      this.continueOwed.add(record.id);
      this.kick(record.id);
    }
  }

  /** The restart the task claimed was not launched: it is not the task's own any more. */
  onRestartClaimFailed(key: string): void {
    const record = this.safeByKey(key);
    if (!record?.restartRequested) return;
    try {
      this.store.update(record.id, (r) => { r.restartRequested = false; });
    } catch (err) {
      log.error({ err, key }, "Could not withdraw a sub-session's own restart request");
    }
  }

  /** The task itself asked for the daemon restart: remembered before the restart starts. */
  onRestartClaimed(key: string): void {
    const record = this.safeByKey(key);
    if (!record) return;
    try {
      this.store.update(record.id, (r) => { r.restartRequested = true; });
    } catch (err) {
      log.error({ err, key }, "Could not record a sub-session's own restart request");
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle of the service
  // ---------------------------------------------------------------------

  /**
   * Startup, in a fixed order: recovery (synchronous, idempotent) runs to
   * completion first; then reconcile and the sweep, which never schedule;
   * then the one schedule() call. Called once, after channels are up.
   */
  start(): void {
    if (this.started || !this.deps.config().enabled) return;
    this.started = true;
    let startState: ReturnType<SubsessionStore["state"]>;
    try {
      this.store.read();
      // Captured before anything below writes: a write turns "recovered" or
      // "missing" into "ok", and reconcile must judge the table as it was read.
      startState = this.store.state();
    } catch (err) {
      this.broken = true;
      log.error({ err, path: this.store.path }, "Sub-session table unreadable; sub-sessions are off until it is repaired. Nothing was unlinked or cancelled.");
      void this.noticeOwner(ownerT("subsessions")("tableUnreadable"));
      return;
    }
    try {
      this.recover();
    } catch (err) {
      // Half a recovery must not be scheduled on: what is left is done by the
      // next start (recovery is idempotent).
      this.broken = true;
      log.error({ err }, "Sub-session restart recovery could not finish; sub-sessions are off until the next start");
      void this.noticeOwner(ownerT("subsessions")("recoveryFailed"));
      return;
    }
    this.safely(() => this.reconcile(startState), "reconcile");
    this.safely(() => this.sweep(), "sweep");
    this.schedule();
    // A finished task that still owes an answer (its turn was cut short) has
    // no scheduler slot to wait for: its driver starts now.
    this.safely(() => {
      for (const task of this.store.list()) {
        if (task.status === "finished" && task.pendingInput.length > 0) this.kick(task.id);
      }
    }, "resume owed answers");
    this.sweepTimer = setInterval(() => this.safely(() => this.sweep(), "sweep"), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.reportTimers.values()) clearTimeout(timer);
    this.reportTimers.clear();
    this.reportAttempts.clear();
    this.unpersistedReports.clear();
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    if (this.cronRecheckTimer) clearTimeout(this.cronRecheckTimer);
    this.cronRecheckTimer = undefined;
  }

  /**
   * Restart recovery: one synchronous pass over the table, before reconcile
   * and before anything is scheduled. No turn runs at start, so:
   * - an ACTIVE task was cut short: it is queued to resume (or waits for the
   *   owner, if it restarted Tomo itself; or fails after too many restarts);
   * - a WAITING task that still owes inputs (or its start) it does not hold
   *   on purpose (`heldThrough`) had its last turn cut short after that turn
   *   moved it to waiting (task_ask): they are still owed a completed turn,
   *   so it is queued to resume too;
   * - every input still pending on those, and on a finished task, may have
   *   gone out in the turn that was cut short: `seenThrough` says so.
   * Each task's decision is ONE transition (or update) that also moves it
   * out of the state that triggers it, so running this twice (a crash in the
   * middle of it) gives the same table as running it once.
   */
  private recover(): void {
    for (const task of this.store.list()) {
      const last = lastInputSeq(task);
      // Owed and not held: inputs above heldThrough, or a start no turn
      // completed when nothing was ever held.
      const cutShortWaiting = task.status === "waiting"
        && (last > (task.heldThrough ?? 0) || (!task.startDelivered && task.heldThrough === undefined));
      if (task.status === "active" && task.restartRequested) {
        const outcome = this.store.transition(task.id, "self_restart", {
          reason: "it restarted Tomo itself",
          expectFrom: ["active"],
          patch: (r) => {
            r.restartRequested = false;
            // Waiting on the owner now: anything it held is the owner's to wake.
            r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r));
            r.heldThrough = lastInputSeq(r);
          },
        });
        if (outcome.ok && outcome.changed) void this.tellScope(outcome.record, ownerT("subsessions")("selfRestart", { id: task.id, title: task.title }));
        continue;
      }
      if (task.status === "active" || cutShortWaiting) {
        if (task.interruptStreak + 1 > MAX_INTERRUPT_STREAK) {
          const failed = this.store.transition(task.id, "fail", { reason: `interrupted by ${MAX_INTERRUPT_STREAK + 1} restarts in a row`, expectFrom: [task.status] });
          if (failed.ok && failed.changed) this.reportFailure(failed.record, ownerT("subsessions")("failedInterrupted", { id: task.id, title: task.title, restarts: MAX_INTERRUPT_STREAK + 1 }));
          continue;
        }
        if (cutShortWaiting) log.warn({ id: task.id, inputs: task.pendingInput.length }, "Sub-session's last turn was cut short while it waited; resuming it");
        this.store.transition(task.id, cutShortWaiting ? "recover_cut_short" : "restart", {
          reason: cutShortWaiting ? "Tomo restarted before its last turn completed" : "Tomo restarted",
          expectFrom: [task.status],
          patch: (r) => {
            r.resumeNeeded = true;
            r.interruptStreak += 1;
            r.restartRequested = false;
            r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r));
          },
        });
        continue;
      }
      if (task.status === "finished" && last > task.seenThrough) {
        // Its answer turn may have been cut short with these in it.
        this.store.update(task.id, (r) => { r.seenThrough = Math.max(r.seenThrough, lastInputSeq(r)); });
      }
    }
  }

  /**
   * The table rules, at start. The table wins; writes go table-first.
   * Unlinking a registry entry the table does not know happens only when the
   * table read cleanly AND holds tasks: an empty or recovered table next to
   * task entries in the registry is a lost table, not a cleanup.
   */
  private reconcile(startState: ReturnType<SubsessionStore["state"]>): void {
    const table = this.store.read();
    const known = new Set(table.tasks.map((t) => t.sessionKey));
    const orphans = this.deps.registryTaskKeys().filter((k) => !known.has(k));
    if (orphans.length === 0) {
      if (table.untrusted) {
        log.info({ since: table.untrusted.since, reason: table.untrusted.reason }, "Every registry task session is known to the task table again; trusting it");
        this.store.clearUntrusted();
      }
    } else {
      // Whatever happens to them, no new task may take one of their ids.
      const highest = Math.max(0, ...orphans.map(taskNumber));
      if (highest >= table.nextId) this.store.reserveIdsThrough(highest);
      // "ok" as it was READ at start, and never recovered or lost since (the
      // mark survives every write and restart): a table recovered from an
      // older backup is "ok" on disk after its first write.
      const trusted = startState === "ok" && !table.untrusted && table.tasks.length > 0;
      if (trusted) {
        for (const key of orphans) {
          log.warn({ key }, "Registry has a task session the task table does not know; unlinking it");
          this.safely(() => this.deps.unlinkRegistryEntry(key), "unlink orphan");
        }
      } else {
        log.error({ orphans, startState, untrusted: table.untrusted, tasks: table.tasks.length }, "Task table looks lost or recovered while the registry has task sessions; unlinking nothing");
        // Told once per loss: a later start finds the mark and stays quiet.
        if (!table.untrusted || startState === "recovered") void this.noticeOwner(ownerT("subsessions")("tableLost", { count: orphans.length }));
        if (!table.untrusted) this.store.markUntrusted(startState === "recovered" ? "recovered" : "lost");
      }
    }
    for (const task of this.store.list()) {
      if (TERMINAL_STATUSES.has(task.status) || task.status === "finished") {
        // Unknown (cron unreadable) is tried too; removing throws then, and is logged.
        if (this.deps.cronJobCount(task.sessionKey) !== 0) this.safely(() => this.deps.removeCronJobs(task.sessionKey), "remove cron jobs");
      }
      if (task.status === "finished" && !task.reportDelivered) this.deliverReport(task);
      else if (task.status === "finished" && this.reportNotePending(task)) {
        // Delivered, and its note still unread: the wake that was queued for
        // it lived in memory and may have died with the process. The note is
        // on disk, so the wake is owed again.
        this.wakeForReport(task);
      }
      if (OPEN_STATUSES.has(task.status) && !this.deps.hasSdkSession(task.sessionKey)) {
        if (task.startDelivered) {
          // A turn completed, so it did things, and the registry came back
          // without its conversation: it cannot resume, and starting it over
          // without that history could repeat what it did.
          const failed = this.store.transition(task.id, "fail", { reason: "its conversation could not be found after a restart" });
          if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: task.id, title: task.title }));
          continue;
        }
        // No turn of it ever completed. If its first turn was cut short, the
        // SDK session id is linked as soon as the SDK reports it (before any
        // tool call), so without one that turn almost surely did nothing; it
        // starts over, and recovery has set resumeNeeded, so the new first
        // turn also tells it to check for side effects first.
        this.safely(() => this.deps.ensureRegistryEntry(task.sessionKey), "registry entry");
      }
    }
    // Queues what it wakes; start() schedules once everything here is done.
    this.checkExternalWaits("after a restart");
  }

  /**
   * A task waiting on its check-back whose job is gone (the cron store is
   * not fsynced, or was unreadable when the task parked) would wait forever:
   * let it run again and schedule a new one itself. A store that still
   * cannot be read is looked at again shortly, in this process. Never
   * schedules: the caller does, once it is safe to.
   */
  private checkExternalWaits(when: string): void {
    let unknown = false;
    for (const task of this.store.list()) {
      if (task.status !== "waiting" || task.waitingOn !== "external") continue;
      const jobs = this.deps.cronJobCount(task.sessionKey);
      if (jobs === undefined) { unknown = true; continue; }
      if (jobs > 0) continue;
      this.store.transition(task.id, "cron_wake", {
        reason: `its check-back job was missing ${when}`,
        guard: inputQueueFull,
        patch: (r) => { appendInput(r, formatTomoEvent("subsession-continue", "Your scheduled check-back is missing (lost in a restart, or never saved). Check on what you were waiting for, and schedule a new check-back if you still need to wait.")); },
      });
    }
    if (unknown) this.armCronRecheck();
  }

  private armCronRecheck(): void {
    if (this.cronRecheckTimer || this.deps.isStopping()) return;
    this.cronRecheckTimer = setTimeout(() => {
      this.cronRecheckTimer = undefined;
      this.safely(() => this.checkExternalWaits("once the cron store could be read again"), "cron recheck");
      this.schedule();
    }, CRON_RECHECK_MS);
    this.cronRecheckTimer.unref?.();
  }

  /** Archive finished tasks after 7 days; forget ended ones after 30. */
  private sweep(): void {
    const now = this.now();
    const forget: string[] = [];
    for (const task of this.store.list()) {
      if (task.status === "finished" && task.reportDelivered && now - (task.endedAt ?? task.lastActivityAt) > FINISHED_KEEP_MS) {
        const outcome = this.store.transition(task.id, "archive", { reason: "finished more than 7 days ago" });
        if (outcome.ok) this.safely(() => this.deps.unlinkRegistryEntry(task.sessionKey), "unlink archived");
      } else if (TERMINAL_STATUSES.has(task.status) && now - (task.endedAt ?? task.lastActivityAt) > ENDED_KEEP_MS) {
        forget.push(task.id);
      }
    }
    // Cancelled and failed tasks keep their registry link until here, so /s
    // can still show them; dropped together with the record.
    for (const id of forget) {
      const task = this.store.get(id);
      if (task && task.status !== "archived") this.safely(() => this.deps.unlinkRegistryEntry(task.sessionKey), "unlink ended");
    }
    this.store.remove(forget);
  }

  // ---------------------------------------------------------------------
  // Scheduler and driver
  // ---------------------------------------------------------------------

  /**
   * THE one place autonomous work gets a slot: a queued task (new, woken by
   * cron, or resuming after a restart) becomes active while fewer than
   * maxRunning are. Owner input never waits here.
   */
  schedule(): void {
    if (!this.available() || this.deps.isStopping()) return;
    let tasks: SubsessionRecord[];
    try {
      tasks = this.store.list();
    } catch (err) {
      log.error({ err }, "Sub-session scheduler could not read the task table");
      return;
    }
    let active = tasks.filter((t) => t.status === "active").length;
    const queued = tasks.filter((t) => t.status === "queued")
      .sort((a, b) => Number(b.resumeNeeded) - Number(a.resumeNeeded) || a.createdAt - b.createdAt);
    for (const task of queued) {
      if (active >= this.deps.config().maxRunning) break;
      if (this.startTask(task.id, "a slot is free")) active += 1;
    }
  }

  /** queued → active and run. `/s <id> start` (Phase 1b) calls this past the slot cap. */
  startTask(id: string, reason: string): boolean {
    const outcome = this.store.transition(id, "start", { reason, expectFrom: ["queued"] });
    if (!outcome.ok) return false;
    this.kick(id);
    return true;
  }

  private deliverInput(id: string, event: Extract<SubsessionEvent, "relay" | "owner_message">, prompt: string): TransitionOutcome {
    const outcome = this.store.transition(id, event, {
      reason: event === "relay" ? "a message from the main session" : "a message from the owner",
      guard: inputQueueFull,
      patch: (r) => { appendInput(r, prompt); },
    });
    if (!outcome.ok) return outcome;
    // Queued: it waits for its slot, and the message goes with its first turn.
    if (outcome.record.status !== "queued") this.kick(id);
    return outcome;
  }

  /** Run the task's driver unless one is running. */
  private kick(id: string): void {
    if (this.driving.has(id) || this.settleTimers.has(id) || this.deps.isStopping()) return;
    this.driving.add(id);
    void this.drive(id)
      .catch((err) => log.error({ err, id }, "Sub-session driver failed"))
      .finally(() => {
        this.driving.delete(id);
        // Input that arrived while the last turn was ending.
        const record = this.safeGet(id);
        if (record && record.status !== "queued" && !TERMINAL_STATUSES.has(record.status) && this.plan(record)) this.kick(id);
        this.schedule();
      });
  }

  private async drive(id: string): Promise<void> {
    for (;;) {
      if (this.deps.isStopping()) return;
      const record = this.safeGet(id);
      if (!record || record.status === "queued" || TERMINAL_STATUSES.has(record.status)) return;
      const turn = this.plan(record);
      if (!turn) return;
      // Nothing is written before the turn: its inputs are only read here,
      // and leave the record with the write that records its result.
      if (turn.kind === "continue") this.continueOwed.delete(id);
      this.toolCalls.delete(id);
      this.progressChanged.delete(id);
      const outcome = await this.deps.runTaskTurn(record.sessionKey, turn.prompt, { bare: turn.kind === "compact" });
      if (!this.afterTurn(id, turn, outcome)) return;
    }
  }

  /** What the task's next turn is, if it has one. */
  private plan(record: SubsessionRecord): PlannedTurn | undefined {
    // Waiting: only the events that wake it (and move it out of waiting) give it a turn.
    if (record.status === "queued" || record.status === "waiting" || TERMINAL_STATUSES.has(record.status)) return undefined;
    // Finished: it answers what it is sent (a message, a relay), nothing more.
    const active = record.status === "active";
    const start = active && !record.startDelivered;
    // A first turn cut short gets both: the start event (it never completed)
    // and the resume warning (it may have done things before it was cut).
    const resume = active && record.resumeNeeded;
    const inputs = record.pendingInput;
    const throughSeq = inputs.at(-1)?.seq ?? 0;
    const owed = record.status === "active" && this.continueOwed.has(record.id);
    if (!start && !resume && inputs.length === 0 && !owed) return undefined;
    // Compact first, but only ahead of a turn the task has anyway: an idle or
    // finished task is not woken just to be compacted.
    if (record.compactPending) {
      return { kind: "compact", prompt: `/compact ${compactInstructions(record)}`, throughSeq: 0, afterCompact: false, resume: false, start: false };
    }
    const afterCompact = record.postCompactReminder;
    const parts: string[] = [];
    if (afterCompact) parts.push(formatPostCompactReminder(record));
    if (start) parts.push(formatStartEvent(record));
    if (resume) parts.push(formatResumeEvent(record));
    // Seq order: the inputs that may have been seen are a prefix.
    const seenThrough = Math.max(record.seenThrough, this.unsavedSeen.get(record.id) ?? 0);
    const seen = inputs.filter((i) => i.seq <= seenThrough).length;
    if (seen > 0) {
      parts.push(formatRedeliveryNote(seen));
      parts.push(...inputs.slice(0, seen).map((i) => i.text));
      if (inputs.length > seen) parts.push(formatNewInputNote(), ...inputs.slice(seen).map((i) => i.text));
    } else {
      parts.push(...inputs.map((i) => i.text));
    }
    const kind = start || resume || inputs.length > 0 ? "wake" : "continue";
    if (kind === "continue") parts.push(formatContinueEvent());
    return { kind, prompt: parts.join("\n\n"), throughSeq, afterCompact, resume, start };
  }

  /**
   * Record a turn's result. The inputs it carried leave the record in this
   * one write, with everything else the result changes; until it succeeds,
   * none of them is consumed. Returns false when the driver must stop.
   */
  private afterTurn(id: string, turn: PlannedTurn, outcome: TaskTurnOutcome): boolean {
    if (outcome.shutdown) {
      // Never an outcome. Its inputs are still on the record; the next
      // start's recovery marks them as possibly seen.
      return false;
    }
    const tools = this.toolCalls.get(id) ?? 0;
    const progressed = tools > 0 || this.progressChanged.has(id);
    this.toolCalls.delete(id);
    this.progressChanged.delete(id);

    if (turn.kind === "compact") {
      try {
        this.store.update(id, (r) => {
          r.compactPending = false;
          if (outcome.ok) r.postCompactReminder = true;
        });
      } catch (err) {
        log.error({ err, id }, "Could not record a sub-session compact; trying again later");
        this.retryAfterSettleFailure(id);
        return false;
      }
      return true;
    }

    let record: SubsessionRecord | undefined;
    // A finished task's answer to a relay that keeps failing (or that the
    // owner stopped) is given up rather than retried forever: plan() would run
    // a finished task again at once while its input is pending.
    let gaveUp = false;
    try {
      record = this.store.update(id, (r) => {
        const consume = () => {
          const before = r.pendingInput.length;
          r.pendingInput = r.pendingInput.filter((i) => i.seq > turn.throughSeq);
          return r.pendingInput.length < before;
        };
        if (outcome.ok) {
          r.failStreak = 0;
          r.interruptStreak = 0;
          if (turn.start) r.startDelivered = true;
          if (turn.resume) r.resumeNeeded = false;
          if (turn.afterCompact) r.postCompactReminder = false;
          consume();
        } else {
          r.failStreak += 1;
          if (r.status === "finished" && (outcome.stopped || r.failStreak >= MAX_FAIL_STREAK)) {
            r.failStreak = 0;
            gaveUp = consume();
          } else {
            // They stay first in line for the next turn, marked as possibly
            // seen: a failed turn may have acted on part of them.
            r.seenThrough = Math.max(r.seenThrough, turn.throughSeq);
          }
        }
        const usage = this.deps.contextUsage(r.sessionKey);
        if (outcome.ok && usage && !usage.estimated && usage.used > this.deps.config().maxContextTokens && !r.compactPending) {
          log.info({ id, used: usage.used, limit: this.deps.config().maxContextTokens }, "Sub-session context over its limit; compacting before the next turn");
          r.compactPending = true;
        }
      });
    } catch (err) {
      // Nothing was consumed: the inputs go out again, said to be possibly
      // seen (this turn may have acted on them), after a pause so a disk that
      // keeps failing does not spin the task.
      log.error({ err, id }, "Could not record a sub-session turn's result; its inputs stay and go out again");
      if (turn.throughSeq > 0) this.unsavedSeen.set(id, Math.max(this.unsavedSeen.get(id) ?? 0, turn.throughSeq));
      this.retryAfterSettleFailure(id);
      return false;
    }
    this.unsavedSeen.delete(id);
    if (!record || record.status !== "active") {
      this.continueOwed.delete(id);
      if (record && gaveUp) void this.tellScope(record, ownerT("subsessions")("finishedUnanswered", { id: record.id, title: record.title }));
      return true;
    }

    if (!outcome.ok) {
      if (outcome.stopped) {
        this.pause(record, "stopped by the owner", ownerT("subsessions")("stopped", { id: record.id, title: record.title }));
        return true;
      }
      if (record.failStreak >= MAX_FAIL_STREAK) {
        this.pause(record, "its turns keep failing", ownerT("subsessions")("failing", { id: record.id, title: record.title }));
        return true;
      }
      this.continueOwed.add(id);
      return true;
    }
    // Input that arrived during the turn gets a turn before any wait: the
    // waits below are also guarded under the lock, for input that lands
    // between this read and the transition.
    if (record.pendingInput.length > 0) return true;
    const jobs = this.deps.cronJobCount(record.sessionKey);
    if (jobs === undefined || jobs > 0) {
      // Unknown (the cron store cannot be read) parks it too: auto-continuing
      // could spin on a check-back that exists. A fire, or the next start's
      // reconcile once the store reads again, wakes it.
      const waited = this.store.transition(id, "wait_external", {
        reason: jobs === undefined ? "waiting for its check-back (the cron store could not be read)" : "waiting for its scheduled check-back",
        expectFrom: ["active"],
        guard: hasPendingInput,
      });
      if (!waited.ok && waited.refused) return true;
      if (jobs === undefined) this.armCronRecheck();
      this.continueOwed.delete(id);
      this.schedule();
      return true;
    }
    if (!turn.afterCompact) {
      const streak = progressed ? 0 : record.turnsWithoutProgress + 1;
      this.store.update(id, (r) => { r.turnsWithoutProgress = streak; });
      if (streak >= MAX_TURNS_WITHOUT_PROGRESS) {
        this.pause(record, `${streak} turns in a row without progress`, ownerT("subsessions")("stuck", { id: record.id, title: record.title, turns: streak }), true);
        return true;
      }
    }
    this.continueOwed.add(id);
    return true;
  }

  /** The result could not be written: no turn for this task until a timer gives it one. */
  private retryAfterSettleFailure(id: string): void {
    if (this.settleTimers.has(id) || this.deps.isStopping()) return;
    const timer = setTimeout(() => {
      this.settleTimers.delete(id);
      this.kick(id);
    }, SETTLE_RETRY_MS);
    timer.unref?.();
    this.settleTimers.set(id, timer);
  }

  /**
   * active → waiting(owner), and say why. `unlessInput`: not while input is
   * pending (it gets a turn first). The failure and stop pauses go anyway:
   * their own inputs are still pending, and stay for the next wake.
   */
  private pause(record: SubsessionRecord, reason: string, notice: OwnerText, unlessInput = false): void {
    this.continueOwed.delete(record.id);
    const outcome = this.store.transition(record.id, "stuck", {
      reason,
      expectFrom: ["active"],
      ...(unlessInput ? { guard: hasPendingInput } : {}),
      // What it holds now waits for the owner's wake; restart recovery must
      // not take it for a turn cut short.
      patch: (r) => { r.heldThrough = lastInputSeq(r); },
    });
    if (outcome.ok) void this.tellScope(outcome.record, notice);
    this.schedule();
  }

  // ---------------------------------------------------------------------
  // Reporting back
  // ---------------------------------------------------------------------

  /**
   * The report goes to the owning session as a PINNED pending note (never
   * dropped by the note cap), then a silent turn there to tell the owner.
   * `reportDelivered` is set only once the note is on disk; a note already
   * queued or in flight for the same task is not added twice (a restart
   * redelivery can meet the normal one).
   */
  private deliverReport(record: SubsessionRecord): void {
    let present = this.reportNotePending(record);
    if (present && this.unpersistedReports.has(record.id)) {
      // The note found is our own, held in memory after its write failed: it
      // is not durable until a write succeeds.
      if (!this.deps.persistPendingNotes?.(record.parentKey)) {
        if (!this.deps.persistPendingNotes) present = false;
        else {
          this.retryReport(record.id);
          return;
        }
      }
    }
    if (!present) {
      const report = record.report ?? "";
      const excerpt = report.length > REPORT_NOTE_EXCERPT ? `${report.slice(0, REPORT_NOTE_EXCERPT - 1)}…` : report;
      const note = formatTomoEvent("subsession-report", [
        `Sub-session ${record.id} ("${record.title}") finished. Its report${report.length > REPORT_NOTE_EXCERPT ? " (start; read the whole report with task_status)" : ""}:`,
        excerpt,
      ].join("\n"), { name: record.id });
      if (!this.deps.queuePendingNote(record.parentKey, note)) {
        this.unpersistedReports.add(record.id);
        this.retryReport(record.id);
        return;
      }
    }
    this.unpersistedReports.delete(record.id);
    this.clearReportRetry(record.id);
    // Wake first, then mark. The wake itself is in memory; what makes it
    // durable is the note: every start wakes the owning session again for a
    // delivered report whose note is still unread (see reconcile).
    this.wakeForReport(record);
    this.safely(() => this.store.update(record.id, (r) => { r.reportDelivered = true; }), "mark report delivered");
  }

  private reportNotePending(record: SubsessionRecord): boolean {
    const marker = `<tomo-event type="subsession-report" name="${record.id}"`;
    return this.deps.hasPendingNote(record.parentKey, (n) => n.includes(marker));
  }

  private wakeForReport(record: SubsessionRecord): void {
    this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-report",
      "A sub-session finished; its report is in a note above. Tell the owner the result in a few lines, in your own words, and read the full report with task_status if they will want details. Decide what, if anything, belongs in memory.",
      { name: "check" }));
  }

  /** The report note could not be written: try again in-process, a few times, then on the next start. */
  private retryReport(id: string): void {
    const attempts = (this.reportAttempts.get(id) ?? 0) + 1;
    if (attempts > REPORT_RETRY_MAX) {
      this.clearReportRetry(id);
      log.error({ id, attempts }, "Could not persist a sub-session report note; retried on the next start");
      return;
    }
    log.warn({ id, attempts }, "Could not persist a sub-session report note; retrying");
    this.reportAttempts.set(id, attempts);
    const old = this.reportTimers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.reportTimers.delete(id);
      const record = this.safeGet(id);
      if (!record || record.status !== "finished" || record.reportDelivered) {
        this.clearReportRetry(id);
        return;
      }
      this.deliverReport(record);
    }, REPORT_RETRY_MS);
    timer.unref?.();
    this.reportTimers.set(id, timer);
  }

  private clearReportRetry(id: string): void {
    const timer = this.reportTimers.get(id);
    if (timer) clearTimeout(timer);
    this.reportTimers.delete(id);
    this.reportAttempts.delete(id);
  }

  private reportFailure(record: SubsessionRecord, notice: OwnerText): void {
    void this.tellScope(record, notice);
  }

  /** A harness notice to the owner, and a note so the owning session knows it was said. */
  private async tellScope(record: SubsessionRecord, notice: OwnerText): Promise<void> {
    this.deps.queuePendingNote(record.parentKey, formatTomoEvent("subsession-activity",
      `The harness told the owner about sub-session ${record.id} ("${record.title}"): ${truncate(notice, ACTIVITY_NOTE_EXCERPT)}`,
      { name: record.id }));
    await this.deps.noticeToScope(record.parentKey, notice).catch((err) => log.warn({ err, id: record.id }, "Sub-session notice failed"));
  }

  private async noticeOwner(text: OwnerText): Promise<void> {
    await this.deps.noticeOwner(text).catch((err) => log.warn({ err }, "Sub-session notice failed"));
  }

  private safeByKey(key: string): SubsessionRecord | undefined {
    if (!isTaskSessionKey(key)) return undefined;
    try { return this.store.byKey(key); } catch (err) {
      if (!(err instanceof SubsessionStoreError)) log.warn({ err, key }, "Sub-session lookup failed");
      return undefined;
    }
  }

  private safeGet(id: string): SubsessionRecord | undefined {
    try { return this.store.get(id); } catch { return undefined; }
  }

  private safely(fn: () => void, what: string): void {
    try { fn(); } catch (err) { log.error({ err }, "Sub-session %s failed", what); }
  }
}

function inputQueueFull(record: SubsessionRecord): string | undefined {
  return record.pendingInput.length >= PENDING_INPUT_MAX ? `${record.pendingInput.length} inputs already waiting (limit ${PENDING_INPUT_MAX})` : undefined;
}

function hasPendingInput(record: SubsessionRecord): string | undefined {
  return record.pendingInput.length > 0 ? "input is pending" : undefined;
}

/** `s12` → 12 (0 for anything else). */
function taskNumber(key: string): number {
  const m = /^task:s(\d+)$/.exec(key);
  return m ? Number(m[1]) : 0;
}

/** `[s3 · title]`: how a task's messages are marked in the owner's chat. */
export function taskPrefix(record: Pick<SubsessionRecord, "id" | "title">): string {
  return `[${record.id} · ${record.title}]`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
