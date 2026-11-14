import { z } from "zod";
import type { SessionMessage, SessionStats } from "../sessions/types.js";

export const WEB_CHAT_ID = "owner";
// JSON can escape one UTF-16 code unit as six bytes (e.g. a lone surrogate).
// Leave room for 16,000 such units plus the validated request envelope.
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const messageInputSchema = z.object({
  requestId: z.uuid(),
  targetId: z.string().max(128).optional(),
  text: z.string().trim().min(1).max(16_000),
}).strict();
export type MessageInput = z.infer<typeof messageInputSchema>;
export interface WebSession {
  id: string;
  title: string;
  kind: "dm" | "group";
  writable: boolean;
  stats: Pick<SessionStats, "contextUsed" | "contextMax" | "contextEstimated">;
  lastActiveAt: number | null;
}
export interface WebCatalog { sessions: WebSession[]; ownerId: string | null; setupRequired: boolean }
export type RequestState = "queued" | "running" | "completed" | "refused" | "failed" | "unknown";
export interface WebRequest { requestId: string; state: RequestState; sessionId?: string }
export interface HistoryMessage extends SessionMessage { id: string }
export interface HistoryPage { messages: HistoryMessage[]; nextCursor: string | null; revision?: string }
export type WebTaskState = "running" | "completed" | "failed" | "stopped" | "ended";
/** A subagent / background task for the read-only "working now" panel. */
export interface WebTask {
  sessionId: string;
  taskId: string;
  taskType: string;
  subagentType?: string;
  /** Model id from the subagent's transcript, once known (e.g. claude-opus-5-5). */
  model?: string;
  description: string;
  parentTaskId?: string;
  ambient: boolean;
  /** Daemon clock, ms epoch. */
  startedAt: number;
  endedAt?: number;
  state: WebTaskState;
  lastTool?: string;
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
}
/** One entry of a subagent's transcript, as the read-only task view shows it. */
export type SubagentItem =
  | { kind: "text"; id: string; text: string; truncated: boolean; ts?: number }
  | { kind: "tool"; id: string; toolUseId: string; name: string; summary: string; input: string; inputTruncated: boolean; ts?: number }
  | { kind: "result"; id: string; toolUseId: string; output: string; truncated: boolean; isError: boolean };
/** A byte window of complete transcript lines: page back with `before=start`, tail with `after=end`. */
export interface SubagentPage { items: SubagentItem[]; start: number; end: number; size: number; hasEarlier: boolean }
/** The end of a shell/Monitor task's output (SDK `get_task_output`: at most the last 8 KiB). */
export interface TaskOutput { output: string; size: number }
/** One subscription usage window for the Plan usage card. */
export interface WebUsageWindow {
  id: string; label: string; group: "session" | "weekly" | "other"; scoped: boolean;
  /** 0–100, or null. */
  percent: number | null;
  /** ms epoch, or null. */
  resetsAt: number | null;
  active: boolean; elevated: boolean;
}
/**
 * Claude subscription usage, as the `/usage` command reads it. `state` names
 * what happened: ok, empty (the endpoint returned no windows), or why it
 * failed (no_token, network, timeout, http_error, …).
 */
export interface WebUsage {
  state: "ok" | "empty" | "api_key" | "no_token" | "credentials_unreadable" | "token_expired" | "refresh_pending"
    | "unauthorized" | "network" | "timeout" | "http_error" | "bad_response" | "unavailable";
  message?: string;
  windows: WebUsageWindow[];
  plan?: string;
  /** When the daemon last asked the endpoint (ms epoch). */
  fetchedAt: number;
  /** When the windows shown were read (ms epoch); null if never. */
  updatedAt: number | null;
  /** The windows are from an earlier read; the last attempt failed. */
  stale?: boolean;
  /** A forced refresh before this is served from cache. */
  nextRefreshAt: number;
}
export type WebEvent =
  | { type: "block"; sessionId: string; requestId: string; id: string; text: string }
  | { type: "request"; request: WebRequest }
  | { type: "invalidate"; sessionId?: string }
  | { type: "tool"; sessionId: string; tool: string; state: "started" | "completed" | "failed" }
  | { type: "typing"; sessionId: string; active: boolean }
  /** All tasks of one session, live and recently ended. REPLACE semantics. */
  | { type: "tasks"; sessionId: string; tasks: WebTask[] };
export interface EventEnvelope { id: string; event: WebEvent }
export interface WebBootstrap extends WebCatalog {
  epoch: string;
  csrfToken: string;
  cursor: string;
  requests: WebRequest[];
  blocks: Extract<WebEvent, { type: "block" }>[];
  /** Every visible session's tasks; replaces the client's whole task list. */
  tasks: WebTask[];
}
export class WebError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** This is a closed RPC protocol, never a generic method/file/command proxy. */
export const rpcSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("message"), epoch: z.uuid(), input: messageInputSchema }).strict(),
  z.object({ method: z.literal("request"), requestId: z.uuid() }).strict(),
  z.object({ method: z.literal("snapshot"), cursor: z.string().max(128).optional() }).strict(),
  z.object({ method: z.literal("usage"), refresh: z.boolean() }).strict(),
  /** A task the browser was shown, by its browser session: where to read it. */
  z.object({ method: z.literal("task"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), output: z.boolean() }).strict(),
]);
export type Rpc = z.infer<typeof rpcSchema>;
export type WebSnapshot = Pick<WebBootstrap, "epoch" | "cursor" | "requests" | "blocks" | "tasks">;
export interface WebSync { snapshot: WebSnapshot; replay: EventEnvelope[] | null }
/** Daemon answer to the `task` RPC. `sessionKey` stays inside the web process. */
export interface WebTaskAccess { sessionKey: string; taskType: string; output?: TaskOutput }
