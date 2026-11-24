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
import { OPEN_STATUSES, PENDING_INPUT_MAX, TERMINAL_STATUSES, type SubsessionRecord } from "./types.js";

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
export const MAX_INTERRUPT_STREAK = 3;
export const MAX_TURNS_WITHOUT_PROGRESS = 3;
export const MAX_FAIL_STREAK = 2;
const REPORT_NOTE_EXCERPT = 600;
/** A report note that could not be written is retried in-process, this often, this many times. */
export const REPORT_RETRY_MS = 60_000;
export const REPORT_RETRY_MAX = 5;
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
   * The leading pendingInput entries this turn carries. They stay on the
   * record (marked in flight) until the turn completes.
   */
  inputs: string[];
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
      patch: (r) => { r.pendingInput.push(prompt); },
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
          r.pendingInput.push(formatTomoEvent("subsession-continue", "A background task of yours reported back. Continue with the task: finish it, or schedule a check-back if you still have to wait."));
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

  /** Reconcile, recover from the restart, sweep, schedule. Called once, after channels are up. */
  start(): void {
    if (this.started || !this.deps.config().enabled) return;
    this.started = true;
    try {
      this.store.read();
    } catch (err) {
      this.broken = true;
      log.error({ err, path: this.store.path }, "Sub-session table unreadable; sub-sessions are off until it is repaired. Nothing was unlinked or cancelled.");
      void this.noticeOwner(ownerT("subsessions")("tableUnreadable"));
      return;
    }
    this.safely(() => this.recoverInflight(), "in-flight input recovery");
    this.safely(() => this.reconcile(), "reconcile");
    this.safely(() => this.recoverFromRestart(), "restart recovery");
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
  }

  /**
   * No turn runs at start, so inputs marked in flight belong to a turn that a
   * crash or a shutdown cut short. They are still on the record (inputs leave
   * it only after a completed turn) and go out again, marked as possibly
   * seen, so the task checks before acting on them twice.
   */
  private recoverInflight(): void {
    for (const task of this.store.list()) {
      if (task.inflightInputs === 0) continue;
      log.warn({ id: task.id, inputs: task.inflightInputs }, "Sub-session turn was cut short with inputs in flight; redelivering them");
      this.store.update(task.id, (r) => {
        r.redeliveredInputs = Math.min(r.pendingInput.length, Math.max(r.redeliveredInputs, r.inflightInputs));
        r.inflightInputs = 0;
      });
    }
  }

  /**
   * The table rules, at start. The table wins; writes go table-first.
   * Unlinking a registry entry the table does not know happens only when the
   * table read cleanly AND holds tasks: an empty or recovered table next to
   * task entries in the registry is a lost table, not a cleanup.
   */
  private reconcile(): void {
    const table = this.store.read();
    const state = this.store.state();
    const known = new Set(table.tasks.map((t) => t.sessionKey));
    const orphans = this.deps.registryTaskKeys().filter((k) => !known.has(k));
    if (orphans.length > 0) {
      // Whatever happens to them, no new task may take one of their ids.
      const highest = Math.max(0, ...orphans.map(taskNumber));
      if (highest >= table.nextId) this.store.reserveIdsThrough(highest);
      if (state === "ok" && table.tasks.length > 0) {
        for (const key of orphans) {
          log.warn({ key }, "Registry has a task session the task table does not know; unlinking it");
          this.safely(() => this.deps.unlinkRegistryEntry(key), "unlink orphan");
        }
      } else {
        log.error({ orphans, state, tasks: table.tasks.length }, "Task table looks lost or recovered while the registry has task sessions; unlinking nothing");
        void this.noticeOwner(ownerT("subsessions")("tableLost", { count: orphans.length }));
      }
    }
    for (const task of this.store.list()) {
      if (TERMINAL_STATUSES.has(task.status) || task.status === "finished") {
        // Unknown (cron unreadable) is tried too; removing throws then, and is logged.
        if (this.deps.cronJobCount(task.sessionKey) !== 0) this.safely(() => this.deps.removeCronJobs(task.sessionKey), "remove cron jobs");
      }
      if (task.status === "finished" && !task.reportDelivered) this.deliverReport(task);
      if (OPEN_STATUSES.has(task.status) && !this.deps.hasSdkSession(task.sessionKey)) {
        if (task.startDelivered) {
          // A turn completed, so there was a conversation, and the registry
          // came back without its link: it cannot resume, and starting it
          // over would repeat side effects.
          const failed = this.store.transition(task.id, "fail", { reason: "its conversation could not be found after a restart" });
          if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedNoSession", { id: task.id, title: task.title }));
          continue;
        }
        // No turn ever completed (the daemon stopped before or during the
        // first one): nothing to lose. It starts again, with the resume
        // warning when a turn may have begun (restart recovery sets it).
        this.safely(() => this.deps.ensureRegistryEntry(task.sessionKey), "registry entry");
      }
      if (task.status === "waiting" && task.waitingOn === "external" && this.deps.cronJobCount(task.sessionKey) === 0) {
        // The check-back job is gone (the cron store is not fsynced): let the
        // task run again and schedule a new one itself.
        this.store.transition(task.id, "cron_wake", {
          reason: "its check-back job was missing after a restart",
          patch: (r) => { r.pendingInput.push(formatTomoEvent("subsession-continue", "Your scheduled check-back was lost in a restart. Check on what you were waiting for, and schedule a new check-back if you still need to wait.")); },
        });
      }
    }
  }

  /** Active at shutdown: resume through the scheduler, unless the task asked for the restart itself. */
  private recoverFromRestart(): void {
    for (const task of this.store.list()) {
      if (task.status !== "active") continue;
      if (task.restartRequested) {
        const outcome = this.store.transition(task.id, "self_restart", {
          reason: "it restarted Tomo itself",
          patch: (r) => { r.restartRequested = false; },
        });
        if (outcome.ok) void this.tellScope(outcome.record, ownerT("subsessions")("selfRestart", { id: task.id, title: task.title }));
        continue;
      }
      if (task.interruptStreak + 1 > MAX_INTERRUPT_STREAK) {
        const failed = this.store.transition(task.id, "fail", { reason: `interrupted by ${MAX_INTERRUPT_STREAK + 1} restarts in a row` });
        if (failed.ok) this.reportFailure(failed.record, ownerT("subsessions")("failedInterrupted", { id: task.id, title: task.title, restarts: MAX_INTERRUPT_STREAK + 1 }));
        continue;
      }
      this.store.transition(task.id, "restart", {
        reason: "Tomo restarted",
        patch: (r) => { r.resumeNeeded = true; r.interruptStreak += 1; },
      });
    }
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
      patch: (r) => { r.pendingInput.push(prompt); },
    });
    if (!outcome.ok) return outcome;
    // Queued: it waits for its slot, and the message goes with its first turn.
    if (outcome.record.status !== "queued") this.kick(id);
    return outcome;
  }

  /** Run the task's driver unless one is running. */
  private kick(id: string): void {
    if (this.driving.has(id) || this.deps.isStopping()) return;
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
      // Marked, never removed: they leave the record when this turn completes.
      if (turn.inputs.length > 0) this.store.update(id, (r) => { r.inflightInputs = turn.inputs.length; });
      if (turn.kind === "continue") this.continueOwed.delete(id);
      this.toolCalls.delete(id);
      this.progressChanged.delete(id);
      const outcome = await this.deps.runTaskTurn(record.sessionKey, turn.prompt, { bare: turn.kind === "compact" });
      this.afterTurn(id, turn, outcome);
      if (outcome.shutdown) return;
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
    const inputs = [...record.pendingInput];
    const owed = record.status === "active" && this.continueOwed.has(record.id);
    if (!start && !resume && inputs.length === 0 && !owed) return undefined;
    // Compact first, but only ahead of a turn the task has anyway: an idle or
    // finished task is not woken just to be compacted.
    if (record.compactPending) {
      return { kind: "compact", prompt: `/compact ${compactInstructions(record)}`, inputs: [], afterCompact: false, resume: false, start: false };
    }
    const afterCompact = record.postCompactReminder;
    const parts: string[] = [];
    if (afterCompact) parts.push(formatPostCompactReminder(record));
    if (start) parts.push(formatStartEvent(record));
    if (resume) parts.push(formatResumeEvent(record));
    const seen = Math.min(record.redeliveredInputs, inputs.length);
    if (seen > 0) {
      parts.push(formatRedeliveryNote(seen));
      parts.push(...inputs.slice(0, seen));
      if (inputs.length > seen) parts.push(formatNewInputNote(), ...inputs.slice(seen));
    } else {
      parts.push(...inputs);
    }
    const kind = start || resume || inputs.length > 0 ? "wake" : "continue";
    if (kind === "continue") parts.push(formatContinueEvent());
    return { kind, prompt: parts.join("\n\n"), inputs, afterCompact, resume, start };
  }

  private afterTurn(id: string, turn: PlannedTurn, outcome: TaskTurnOutcome): void {
    if (outcome.shutdown) {
      // Never an outcome. Its inputs are still on the record, marked in
      // flight; the next start redelivers them as possibly seen.
      return;
    }
    const tools = this.toolCalls.get(id) ?? 0;
    const progressed = tools > 0 || this.progressChanged.has(id);
    this.toolCalls.delete(id);
    this.progressChanged.delete(id);

    if (turn.kind === "compact") {
      this.safely(() => this.store.update(id, (r) => {
        r.compactPending = false;
        if (outcome.ok) r.postCompactReminder = true;
      }), "after compact");
      return;
    }

    let record: SubsessionRecord | undefined;
    // A finished task's answer to a relay that keeps failing (or that the
    // owner stopped) is given up rather than retried forever: plan() would run
    // a finished task again at once while its input is pending.
    let gaveUp = false;
    try {
      record = this.store.update(id, (r) => {
        const carried = Math.min(turn.inputs.length, r.pendingInput.length);
        const consume = () => {
          r.pendingInput = r.pendingInput.slice(carried);
          r.redeliveredInputs = Math.max(0, r.redeliveredInputs - carried);
        };
        r.inflightInputs = 0;
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
            gaveUp = carried > 0;
            consume();
          } else {
            // They stay first in line for the next turn, marked as possibly
            // seen: a failed turn may have acted on part of them.
            r.redeliveredInputs = Math.max(r.redeliveredInputs, carried);
          }
        }
        const usage = this.deps.contextUsage(r.sessionKey);
        if (outcome.ok && usage && !usage.estimated && usage.used > this.deps.config().maxContextTokens && !r.compactPending) {
          log.info({ id, used: usage.used, limit: this.deps.config().maxContextTokens }, "Sub-session context over its limit; compacting before the next turn");
          r.compactPending = true;
        }
      });
    } catch (err) {
      log.error({ err, id }, "Could not record a sub-session turn's outcome");
      return;
    }
    if (!record || record.status !== "active") {
      this.continueOwed.delete(id);
      if (record && gaveUp) void this.tellScope(record, ownerT("subsessions")("finishedUnanswered", { id: record.id, title: record.title }));
      return;
    }

    if (!outcome.ok) {
      if (outcome.stopped) {
        this.pause(record, "stopped by the owner", ownerT("subsessions")("stopped", { id: record.id, title: record.title }));
        return;
      }
      if (record.failStreak >= MAX_FAIL_STREAK) {
        this.pause(record, "its turns keep failing", ownerT("subsessions")("failing", { id: record.id, title: record.title }));
        return;
      }
      this.continueOwed.add(id);
      return;
    }
    // Input that arrived during the turn gets a turn before any wait: the
    // waits below are also guarded under the lock, for input that lands
    // between this read and the transition.
    if (record.pendingInput.length > 0) return;
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
      if (!waited.ok && waited.refused) return;
      this.continueOwed.delete(id);
      this.schedule();
      return;
    }
    if (!turn.afterCompact) {
      const streak = progressed ? 0 : record.turnsWithoutProgress + 1;
      this.store.update(id, (r) => { r.turnsWithoutProgress = streak; });
      if (streak >= MAX_TURNS_WITHOUT_PROGRESS) {
        this.pause(record, `${streak} turns in a row without progress`, ownerT("subsessions")("stuck", { id: record.id, title: record.title, turns: streak }), true);
        return;
      }
    }
    this.continueOwed.add(id);
  }

  /**
   * active → waiting(owner), and say why. `unlessInput`: not while input is
   * pending (it gets a turn first). The failure and stop pauses go anyway:
   * their own inputs are still pending, and stay for the next wake.
   */
  private pause(record: SubsessionRecord, reason: string, notice: OwnerText, unlessInput = false): void {
    this.continueOwed.delete(record.id);
    const outcome = this.store.transition(record.id, "stuck", { reason, expectFrom: ["active"], ...(unlessInput ? { guard: hasPendingInput } : {}) });
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
    const marker = `<tomo-event type="subsession-report" name="${record.id}"`;
    const present = this.deps.hasPendingNote(record.parentKey, (n) => n.includes(marker));
    if (!present) {
      const report = record.report ?? "";
      const excerpt = report.length > REPORT_NOTE_EXCERPT ? `${report.slice(0, REPORT_NOTE_EXCERPT - 1)}…` : report;
      const note = formatTomoEvent("subsession-report", [
        `Sub-session ${record.id} ("${record.title}") finished. Its report${report.length > REPORT_NOTE_EXCERPT ? " (start; read the whole report with task_status)" : ""}:`,
        excerpt,
      ].join("\n"), { name: record.id });
      if (!this.deps.queuePendingNote(record.parentKey, note)) {
        this.retryReport(record.id);
        return;
      }
    }
    this.clearReportRetry(record.id);
    // Wake first, then mark: a crash between the two redelivers (the note is
    // not queued twice) rather than leaving a note nobody is woken to read.
    this.deps.wakeScope(record.parentKey, formatTomoEvent("subsession-report",
      "A sub-session finished; its report is in a note above. Tell the owner the result in a few lines, in your own words, and read the full report with task_status if they will want details. Decide what, if anything, belongs in memory.",
      { name: "check" }));
    this.safely(() => this.store.update(record.id, (r) => { r.reportDelivered = true; }), "mark report delivered");
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
