import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { formatZonedClock } from "../timezone.js";
import type { WatchBus } from "../watch/bus.js";
import type { WatchTask } from "../watch/protocol.js";

/**
 * Subagents and background commands that were running when the daemon went
 * away, kept on disk so the next start can tell each session what was cut off.
 *
 * WHY CONTINUOUS. A crash, SIGKILL or power loss runs no shutdown code, so a
 * list written only on the way down would cover just the graceful restart.
 * Instead every session's live set is mirrored on each start and end (the
 * `tasks` events the web Tasks panel reads: REPLACE semantics, so a task that
 * ended normally, was stopped, or finished with its turn simply drops out).
 * Each change is an atomic write (tmp + rename); progress-only changes are
 * written at most every `activityWriteMs`.
 *
 * ON START, whatever the previous run left under `running` moves to
 * `interrupted` (persisted at once, so a task of THIS run can never be mistaken
 * for one of the last). The daemon tells each session about its entries and
 * then acknowledges them: one notice per interruption, not one per restart.
 *
 * ON SHUTDOWN the ledger is frozen before sessions are closed: tearing a
 * session down empties its task set, and that must not read as "finished".
 *
 * RESUME CAP (`autoResume` on). The startup notice tells the session to resume
 * its resumable subagents, and nothing else keeps track of offers: the one
 * gate is `gateResume`, called by a PreToolUse hook on every SendMessage. A
 * resumable agent found interrupted gets an entry in `resumes`; a SendMessage
 * to it while it is not running counts one more resume, written to disk
 * before the call is allowed (a failed write denies it). Past
 * MAX_AUTO_RESUMES the call is denied, whichever turn makes it, so a subagent
 * that itself brings the daemon down (`tomo restart`, a deploy, exhausting
 * the machine) cannot be revived on every start. The entry is dropped when
 * the agent ends on its own (anything but a shutdown).
 */

export type InterruptedKind = "agent" | "command";

export interface RunningTaskRecord {
  sessionKey: string;
  taskId: string;
  /** `agent`: a subagent (resumable by id, Explore/Plan aside). `command`: a background shell — never resumable. */
  kind: InterruptedKind;
  taskType: string;
  subagentType?: string;
  description: string;
  startedAt: number;
  lastActivityAt: number;
  /** The subagent's saved SDK transcript, when known. */
  transcriptPath?: string;
}

/** Resumes of one interrupted subagent allowed before it counts as failed. */
export const MAX_AUTO_RESUMES = 3;

interface ResumeCount {
  sessionKey: string;
  taskId: string;
  /** Resumes since it was first found interrupted (cleared when it ends on its own). */
  count: number;
  /** Found interrupted again past the cap; the owner has not been told yet. */
  owedNotice?: boolean;
}

interface LedgerFile {
  version: 1;
  running: RunningTaskRecord[];
  interrupted: RunningTaskRecord[];
  /** `autoResume` only, and only when non-empty. */
  resumes?: ResumeCount[];
}

export interface RunningAgentsLedgerOptions {
  path: string;
  now?: () => number;
  /** Where the SDK keeps this subagent's transcript, if it can be known yet. */
  resolveTranscriptPath?: (sessionKey: string, taskId: string) => string | undefined;
  /** Throttle for writes that only move `lastActivityAt`. Default 30 s. */
  activityWriteMs?: number;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  /** Keep resume counts and gate SendMessage on them (see RESUME CAP). */
  autoResume?: boolean;
}

/** Subagent types the SDK cannot resume from their transcript. */
const NOT_RESUMABLE_SUBAGENTS = new Set(["Explore", "Plan"]);

function kindOf(task: WatchTask): InterruptedKind | undefined {
  if (task.ambient || task.status || task.parentTaskId) return undefined;
  if (task.taskType === "local_agent" || task.taskType === "remote_agent") return "agent";
  if (task.taskType === "local_bash") return "command";
  return undefined;
}

export function isResumable(rec: RunningTaskRecord): boolean {
  return rec.kind === "agent" && !NOT_RESUMABLE_SUBAGENTS.has(rec.subagentType ?? "");
}

const idOf = (sessionKey: string, taskId: string) => `${sessionKey}\0${taskId}`;

function validCount(value: unknown): value is ResumeCount {
  const c = value as Partial<ResumeCount> | null;
  return !!c && typeof c.sessionKey === "string" && typeof c.taskId === "string"
    && typeof c.count === "number" && Number.isInteger(c.count) && c.count >= 0;
}

function validRecord(value: unknown): value is RunningTaskRecord {
  const r = value as Partial<RunningTaskRecord> | null;
  return !!r && typeof r.sessionKey === "string" && typeof r.taskId === "string"
    && (r.kind === "agent" || r.kind === "command") && typeof r.startedAt === "number"
    && typeof r.lastActivityAt === "number" && typeof r.description === "string";
}

export class RunningAgentsLedger {
  private running = new Map<string, Map<string, RunningTaskRecord>>();
  private interrupted: RunningTaskRecord[] = [];
  private resumes = new Map<string, ResumeCount>();
  private frozen = false;
  /** Last progress seen per task (not persisted): only real progress moves `lastActivityAt`. */
  private progress = new Map<string, string>();
  private lastWriteAt = 0;
  private readonly now: () => number;
  private readonly activityWriteMs: number;

  constructor(private readonly opts: RunningAgentsLedgerOptions) {
    this.now = opts.now ?? Date.now;
    this.activityWriteMs = opts.activityWriteMs ?? 30_000;
    this.loadPrevious();
  }

  /** What the previous run(s) left running, by session, not yet acknowledged. */
  pendingBySession(): Map<string, RunningTaskRecord[]> {
    const out = new Map<string, RunningTaskRecord[]>();
    for (const rec of this.interrupted) out.set(rec.sessionKey, [...(out.get(rec.sessionKey) ?? []), rec]);
    return out;
  }

  /** The session has been told (or cannot be): forget its interrupted entries. */
  acknowledge(sessionKey: string): void {
    const before = this.interrupted.length;
    this.interrupted = this.interrupted.filter((r) => r.sessionKey !== sessionKey);
    if (this.interrupted.length !== before) this.persist();
  }

  /** Resumes counted for this agent since it was found interrupted. */
  resumeCount(sessionKey: string, taskId: string): number {
    return this.resumes.get(idOf(sessionKey, taskId))?.count ?? 0;
  }

  /**
   * PreToolUse gate for `SendMessage` to `taskId` from `sessionKey`: null to
   * allow, or the reason to deny. Only an interrupted agent that is not
   * running is gated; each allowed call is one resume, on disk before it runs.
   */
  gateResume(sessionKey: string, taskId: string): string | null {
    const entry = this.resumes.get(idOf(sessionKey, taskId));
    if (!entry || this.running.get(sessionKey)?.has(taskId)) return null;
    if (entry.count >= MAX_AUTO_RESUMES) {
      return `Not resumed: subagent ${taskId} has already been resumed ${MAX_AUTO_RESUMES} times after restarts cut it off, `
        + "so Tomo counts it as failed and blocks further resumes to stop a restart loop. "
        + "Tell the owner; if the work is still needed, start a new subagent for it.";
    }
    entry.count++;
    if (!this.persist()) {
      entry.count--;
      return `Not resumed: Tomo could not record the resume of subagent ${taskId} on disk (~/.tomo/data), and an unrecorded resume would not count toward its limit. Try again later.`;
    }
    return null;
  }

  /** Agents past their resume limit, found interrupted again: the owner is owed a notice (kept until sent). */
  owedFailureNotices(): { sessionKey: string; taskId: string }[] {
    return [...this.resumes.values()].filter((c) => c.owedNotice).map(({ sessionKey, taskId }) => ({ sessionKey, taskId }));
  }

  /** The owner has been told about these. */
  failureNoticeSent(sessionKey: string, taskIds: readonly string[]): void {
    for (const taskId of taskIds) delete this.resumes.get(idOf(sessionKey, taskId))?.owedNotice;
    this.persist();
  }

  /** Shutdown has begun: what is running now stays recorded as interrupted. */
  freeze(): void { this.frozen = true; }

  /** Mirror `tasks` events from the watch bus. Returns the unsubscribe. */
  attach(bus: WatchBus): () => void {
    return bus.subscribe((event) => {
      if (event.type === "tasks") this.observe(event.sessionKey, event.tasks);
    });
  }

  /** A session's full live task set after a change (REPLACE semantics). */
  observe(sessionKey: string, tasks: readonly WatchTask[]): void {
    if (this.frozen) return;
    const now = this.now();
    const old = this.running.get(sessionKey) ?? new Map<string, RunningTaskRecord>();
    const next = new Map<string, RunningTaskRecord>();
    let membershipChanged = false;
    let activityChanged = false;
    for (const task of tasks) {
      const kind = kindOf(task);
      if (!kind) continue;
      const prev = old.get(task.taskId);
      const progressKey = `${sessionKey}\0${task.taskId}`;
      const fingerprint = JSON.stringify([task.runId, task.lastTool, task.summary, task.toolUses]);
      const progressed = this.progress.get(progressKey) !== fingerprint;
      this.progress.set(progressKey, fingerprint);
      if (!prev) {
        membershipChanged = true;
        next.set(task.taskId, {
          sessionKey, taskId: task.taskId, kind, taskType: task.taskType,
          ...(task.subagentType ? { subagentType: task.subagentType } : {}),
          description: task.description,
          startedAt: task.startedAt || now,
          lastActivityAt: now,
          ...this.transcriptFor(sessionKey, task.taskId, kind),
        });
        continue;
      }
      const rec: RunningTaskRecord = {
        ...prev,
        ...(task.subagentType ? { subagentType: task.subagentType } : {}),
        description: task.description || prev.description,
        // A new run (SendMessage resumed it) restarts the clock.
        startedAt: task.startedAt || prev.startedAt,
        lastActivityAt: progressed ? now : prev.lastActivityAt,
        ...(prev.transcriptPath ? {} : this.transcriptFor(sessionKey, task.taskId, kind)),
      };
      if (rec.subagentType !== prev.subagentType || rec.description !== prev.description
        || rec.startedAt !== prev.startedAt || rec.transcriptPath !== prev.transcriptPath) membershipChanged = true;
      if (progressed) activityChanged = true;
      next.set(task.taskId, rec);
    }
    for (const id of old.keys()) {
      if (next.has(id)) continue;
      membershipChanged = true;
      this.progress.delete(`${sessionKey}\0${id}`);
      // Ended on its own (a shutdown is frozen out above): no longer gated.
      this.resumes.delete(idOf(sessionKey, id));
    }
    if (next.size > 0) this.running.set(sessionKey, next);
    else this.running.delete(sessionKey);
    if (membershipChanged || (activityChanged && now - this.lastWriteAt >= this.activityWriteMs)) this.persist();
  }

  private transcriptFor(sessionKey: string, taskId: string, kind: InterruptedKind): { transcriptPath?: string } {
    if (kind !== "agent" || !this.opts.resolveTranscriptPath) return {};
    try {
      const path = this.opts.resolveTranscriptPath(sessionKey, taskId);
      return path ? { transcriptPath: path } : {};
    } catch {
      return {};
    }
  }

  private loadPrevious(): void {
    let raw: string;
    try {
      if (!existsSync(this.opts.path)) return;
      raw = readFileSync(this.opts.path, "utf8");
    } catch (err) {
      this.opts.warn?.({ err, path: this.opts.path }, "Running-agents ledger unreadable; starting without it");
      return;
    }
    let file: Partial<LedgerFile>;
    try {
      file = JSON.parse(raw) as Partial<LedgerFile>;
      if (!file || typeof file !== "object") throw new Error("not an object");
    } catch (err) {
      this.opts.warn?.({ err, path: this.opts.path }, "Running-agents ledger is corrupt; starting without it");
      return;
    }
    const seen = new Set<string>();
    for (const rec of [...(Array.isArray(file.interrupted) ? file.interrupted : []), ...(Array.isArray(file.running) ? file.running : [])]) {
      if (!validRecord(rec)) continue;
      const id = `${rec.sessionKey}\0${rec.taskId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      this.interrupted.push(rec);
    }
    if (this.opts.autoResume) {
      for (const c of Array.isArray(file.resumes) ? file.resumes : []) {
        if (validCount(c)) this.resumes.set(idOf(c.sessionKey, c.taskId), { ...c });
      }
      // What was running a moment ago is now gated; past its limit, it failed.
      for (const rec of Array.isArray(file.running) ? file.running : []) {
        if (!validRecord(rec) || !isResumable(rec)) continue;
        const id = idOf(rec.sessionKey, rec.taskId);
        const entry = this.resumes.get(id) ?? { sessionKey: rec.sessionKey, taskId: rec.taskId, count: 0 };
        if (entry.count >= MAX_AUTO_RESUMES) entry.owedNotice = true;
        this.resumes.set(id, entry);
      }
    }
    // Moved at once: from here `running` is this run's alone.
    if ((file.running?.length ?? 0) > 0) this.persist();
  }

  /** Returns false when the write failed. */
  private persist(): boolean {
    const file: LedgerFile = {
      version: 1,
      running: [...this.running.values()].flatMap((m) => [...m.values()]),
      interrupted: this.interrupted,
      ...(this.resumes.size > 0 ? { resumes: [...this.resumes.values()] } : {}),
    };
    try {
      mkdirSync(dirname(this.opts.path), { recursive: true });
      writeJsonAtomicSync(this.opts.path, file);
      this.lastWriteAt = this.now();
      return true;
    } catch (err) {
      this.opts.warn?.({ err, path: this.opts.path }, "Could not write the running-agents ledger");
      return false;
    }
  }

  /** Tracking is off: drop what an earlier run recorded, so turning it back on cannot revive it. */
  static discard(path: string, warn?: (obj: Record<string, unknown>, msg: string) => void): void {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      warn?.({ err, path }, "Could not remove the running-agents ledger");
    }
  }
}

/**
 * PreToolUse hook on `SendMessage`: the resume cap's only enforcement point
 * (see RESUME CAP). `gate` is RunningAgentsLedger.gateResume for the session.
 */
export function resumeGateHooks(gate: (taskId: string) => string | null) {
  return {
    PreToolUse: [{
      matcher: "SendMessage",
      // A guard: a callback that throws denies the call rather than letting an uncounted resume through.
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        const to = (input.tool_input as { to?: unknown } | null)?.to;
        const reason = input.tool_name === "SendMessage" && typeof to === "string" ? gate(to) : null;
        return reason
          ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } }
          : {};
      }],
    }],
  };
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Body of the `interrupted-agents` tomo-event for one session. Without
 * `autoResume` the model is only told, and decides. With it, the notice asks
 * for each resumable subagent to be resumed now; `failed` are those past
 * their resume limit (the SendMessage hook would refuse them anyway).
 */
export function formatInterruptedAgentsNotice(
  records: readonly RunningTaskRecord[],
  timeZone?: string,
  autoResume?: { failed: ReadonlySet<string> },
): string {
  const lines = records.map((rec) => {
    const ran = minutes(rec.lastActivityAt - rec.startedAt);
    const last = formatZonedClock(new Date(rec.lastActivityAt), timeZone);
    const desc = JSON.stringify(rec.description || "(no description)");
    if (rec.kind === "command") {
      return `- ${rec.taskId} ${desc} (background command, ran ${ran}, last activity ${last}) — cannot be resumed; rerun it if it is still needed.`;
    }
    const type = rec.subagentType ?? "subagent";
    const resumable = !isResumable(rec) ? " — cannot be resumed"
      : !autoResume ? ""
      : autoResume.failed.has(rec.taskId)
        ? ` — FAILED: cut off again after ${MAX_AUTO_RESUMES} resumes; do not resume it (the owner has been told)`
        : !rec.subagentType ? " — type unknown (could be Explore/Plan); do not resume it automatically"
        : "";
    const transcript = rec.transcriptPath && existsSync(rec.transcriptPath) ? ` transcript: ${rec.transcriptPath}` : "";
    return `- ${rec.taskId} ${desc} (${type}, ran ${ran}, last activity ${last})${resumable}${transcript}`;
  });
  if (autoResume) {
    return [
      "When Tomo last restarted or crashed, these were still running in this conversation and were cut off:",
      ...lines,
      "For each resumable subagent above that is not marked otherwise, use SendMessage to its id right away to resume it "
        + "(names do not survive a restart; use the id), unless the owner has explicitly said not to. "
        + "Tell it it was interrupted by a restart, have it first check how far it got and which side effects "
        + "(commits, pushes, messages sent, files changed) already happened, then continue without redoing them. "
        + "Explore/Plan subagents and background commands cannot be resumed; rerun them if still needed.",
    ].join("\n");
  }
  return [
    "When Tomo last restarted or crashed, these were still running in this conversation and were cut off:",
    ...lines,
    "Nothing has been resumed. To continue a resumable subagent, SendMessage to its id (names do not survive a restart; use the id) and it picks up from its saved transcript. "
      + "Explore/Plan subagents and background commands cannot be resumed; rerun them if still needed. "
      + "Decide for each whether it is still worth continuing.",
  ].join("\n");
}
