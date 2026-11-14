/**
 * Wire protocol between the daemon's watch server and `tomo watch` clients.
 *
 * Frames travel as NDJSON over a Unix domain socket (~/.tomo/watch.sock).
 * On connect the server sends one `snapshot` frame, then relays `event`
 * frames as they happen. Clients may send `send` frames to route a chat
 * message into the owner's dm session.
 *
 * Versioning: bump WATCH_PROTOCOL_VERSION on breaking changes; clients
 * refuse to render snapshots from a different major version rather than
 * guessing at fields.
 */

// Type-only, so it is erased at compile time and cannot create a runtime
// import cycle with the agent modules that publish these events.
import type { FabricatedMarkerShape } from "../agent/inbound-markers.js";

export const WATCH_PROTOCOL_VERSION = 1;

export type TurnSource = "user" | "cron" | "continuity";

/** How a task ended, as reported by the SDK's `task_notification`. */
export type TaskEndStatus = "completed" | "failed" | "stopped";

/**
 * One live SDK task (subagent, background shell, monitor, workflow) of a
 * session, as tracked by `src/agent/task-tracker.ts`. Text fields are clipped
 * there; the subagent's prompt is never carried.
 */
export interface WatchTask {
  taskId: string;
  runId?: string;
  /** SDK `task_type` (e.g. `local_agent`, `local_bash`, `monitor`). */
  taskType: string;
  subagentType?: string;
  description: string;
  /** Unknown ids are possible (the parent may have ended); treat as no parent. */
  parentTaskId?: string;
  /** Not activity (watchers, skip_transcript tasks). */
  ambient: boolean;
  /** In the SDK's background set (false: a foreground, blocking tool call). */
  background: boolean;
  /** When this process first saw the task (ms epoch). */
  startedAt: number;
  /** From `task_progress`. */
  lastTool?: string;
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
  /** Reported by `task_notification` while the task is still in the set. */
  status?: TaskEndStatus;
}

export type WatchEvent =
  /** A message entered a session transcript (user inbound or Tomo outbound). */
  | {
      type: "transcript";
      ts: number;
      sessionKey: string;
      role: "user" | "assistant";
      channel: string;
      sender?: string;
      text: string;
    }
  | { type: "turn.start"; ts: number; sessionKey: string; source: TurnSource; requestId?: string }
  | { type: "turn.end"; ts: number; sessionKey: string; source: TurnSource; ok: boolean; durationMs: number; requestId?: string }
  /** Per-query stats from the SDK result (cost, context) — follows turn.end. */
  | {
    type: "turn.stats"; ts: number; sessionKey: string; costUsd: number;
    contextUsed: number; contextMax: number;
    /** The SDK could not report usage this turn: `contextUsed` is a crude
     *  approximation of the turn's OWN tokens over the last real window, so a
     *  consumer must not present the ratio as the session's actual pressure. */
    contextEstimated?: boolean;
  }
  | { type: "tool.start"; ts: number; sessionKey?: string; tool: string; agent?: string; detail?: string }
  | { type: "tool.end"; ts: number; sessionKey?: string; tool: string; ok: boolean; durationMs?: number; agent?: string }
  | { type: "cron.fired"; ts: number; jobId: string; name: string }
  | { type: "cron.done"; ts: number; jobId: string; name: string; ok: boolean }
  | { type: "heartbeat"; ts: number }
  | { type: "compact"; ts: number; sessionKey?: string; preTokens?: number; postTokens?: number }
  /** The session's live tasks after a change. REPLACE semantics, like the
   *  SDK's `background_tasks_changed`. `ended` carries end reports for tasks
   *  that already left the set (the SDK does not order the two streams). */
  | { type: "tasks"; ts: number; sessionKey: string; tasks: WatchTask[]; ended?: { taskId: string; status: TaskEndStatus }[] }
  | { type: "issue"; ts: number; level: "warn" | "error"; msg: string }
  /** The MODEL wrote a line shaped like an inbound harness marker into its own
   *  reply. The block still ships (marked, not truncated) — see
   *  src/agent/inbound-markers.ts. `shape` is the closed union rather than
   *  `string` so the compiler, not a comment, is what keeps the Prometheus
   *  label set bounded (the exporter labels its counter with it). */
  | { type: "fabricated-marker"; ts: number; sessionKey?: string; shape: FabricatedMarkerShape; marker: string };

export type WatchIssue = Extract<WatchEvent, { type: "issue" }>;

export interface WatchSessionInfo {
  key: string;
  chatTitle?: string;
  lastActiveAt: number;
  contextUsed: number;
  contextMax: number;
  totalCostUsd: number;
  totalQueries: number;
}

export interface WatchCronJobInfo {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** `interrupted`: dispatched, then the daemon restarted before it finished. */
  lastStatus: "ok" | "error" | "interrupted" | null;
}

export interface WatchSnapshot {
  protocolVersion: number;
  pid: number;
  /** Daemon start time (ms epoch). */
  startedAt: number;
  version: string;
  model: string;
  channels: string[];
  sessions: WatchSessionInfo[];
  cron: WatchCronJobInfo[];
  nextHeartbeatAt: number | null;
  costTodayUsd: number;
  costWeekUsd: number;
  turnsToday: number;
  /** Recent events (bus ring buffer) so a fresh client has feed history. */
  recent: WatchEvent[];
  lastIssue: WatchIssue | null;
}

export type ServerFrame =
  | { kind: "snapshot"; snapshot: WatchSnapshot }
  | { kind: "event"; event: WatchEvent }
  | { kind: "send-result"; ok: boolean; error?: string };

export type ClientFrame = { kind: "send"; text: string };

/** Truncation limits keep single frames small; feeds render a line or two. */
export const TRANSCRIPT_TEXT_LIMIT = 1500;
export const TOOL_DETAIL_LIMIT = 200;

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
