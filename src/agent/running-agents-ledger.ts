import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

interface LedgerFile {
  version: 1;
  running: RunningTaskRecord[];
  interrupted: RunningTaskRecord[];
}

export interface RunningAgentsLedgerOptions {
  path: string;
  now?: () => number;
  /** Where the SDK keeps this subagent's transcript, if it can be known yet. */
  resolveTranscriptPath?: (sessionKey: string, taskId: string) => string | undefined;
  /** Throttle for writes that only move `lastActivityAt`. Default 30 s. */
  activityWriteMs?: number;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
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

function validRecord(value: unknown): value is RunningTaskRecord {
  const r = value as Partial<RunningTaskRecord> | null;
  return !!r && typeof r.sessionKey === "string" && typeof r.taskId === "string"
    && (r.kind === "agent" || r.kind === "command") && typeof r.startedAt === "number"
    && typeof r.lastActivityAt === "number" && typeof r.description === "string";
}

export class RunningAgentsLedger {
  private running = new Map<string, Map<string, RunningTaskRecord>>();
  private interrupted: RunningTaskRecord[] = [];
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
    // Moved at once: from here `running` is this run's alone.
    if ((file.running?.length ?? 0) > 0) this.persist();
  }

  private persist(): void {
    const file: LedgerFile = {
      version: 1,
      running: [...this.running.values()].flatMap((m) => [...m.values()]),
      interrupted: this.interrupted,
    };
    try {
      mkdirSync(dirname(this.opts.path), { recursive: true });
      writeJsonAtomicSync(this.opts.path, file);
      this.lastWriteAt = this.now();
    } catch (err) {
      this.opts.warn?.({ err, path: this.opts.path }, "Could not write the running-agents ledger");
    }
  }
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Body of the `interrupted-agents` tomo-event for one session. */
export function formatInterruptedAgentsNotice(records: readonly RunningTaskRecord[], timeZone?: string): string {
  const lines = records.map((rec) => {
    const ran = minutes(rec.lastActivityAt - rec.startedAt);
    const last = formatZonedClock(new Date(rec.lastActivityAt), timeZone);
    const desc = JSON.stringify(rec.description || "(no description)");
    if (rec.kind === "command") {
      return `- ${rec.taskId} ${desc} (background command, ran ${ran}, last activity ${last}) — cannot be resumed; rerun it if it is still needed.`;
    }
    const type = rec.subagentType ?? "subagent";
    const resumable = isResumable(rec) ? "" : " — cannot be resumed";
    const transcript = rec.transcriptPath && existsSync(rec.transcriptPath) ? ` transcript: ${rec.transcriptPath}` : "";
    return `- ${rec.taskId} ${desc} (${type}, ran ${ran}, last activity ${last})${resumable}${transcript}`;
  });
  return [
    "When Tomo last restarted or crashed, these were still running in this conversation and were cut off:",
    ...lines,
    "Nothing has been resumed. To continue a resumable subagent, SendMessage to its id (names do not survive a restart; use the id) and it picks up from its saved transcript. "
      + "Explore/Plan subagents and background commands cannot be resumed; rerun them if still needed. "
      + "Decide for each whether it is still worth continuing.",
  ].join("\n");
}
