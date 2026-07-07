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

export const WATCH_PROTOCOL_VERSION = 1;

export type TurnSource = "user" | "cron" | "continuity";

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
  | { type: "turn.start"; ts: number; sessionKey: string; source: TurnSource }
  | { type: "turn.end"; ts: number; sessionKey: string; source: TurnSource; ok: boolean; durationMs: number }
  /** Per-query stats from the SDK result (cost, context) — follows turn.end. */
  | { type: "turn.stats"; ts: number; sessionKey: string; costUsd: number; contextUsed: number; contextMax: number }
  | { type: "tool.start"; ts: number; sessionKey?: string; tool: string; agent?: string; detail?: string }
  | { type: "tool.end"; ts: number; sessionKey?: string; tool: string; ok: boolean; durationMs?: number; agent?: string }
  | { type: "cron.fired"; ts: number; jobId: string; name: string }
  | { type: "cron.done"; ts: number; jobId: string; name: string; ok: boolean }
  | { type: "heartbeat"; ts: number }
  | { type: "compact"; ts: number; sessionKey?: string; preTokens?: number; postTokens?: number }
  | { type: "issue"; ts: number; level: "warn" | "error"; msg: string };

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
  lastStatus: "ok" | "error" | null;
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
