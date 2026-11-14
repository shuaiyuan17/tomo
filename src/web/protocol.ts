import { z } from "zod";
import type { ContextCategory, SessionMessage, SessionStats } from "../sessions/types.js";
import type { CronRunStatus, CronSchedule } from "../cron/types.js";
import type { ContextSection } from "../lcm/stats.js";
import type { SummaryBlock } from "../lcm/summary-reader.js";

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
/** `unknown`: may or may not have run (handed to the SDK, then the turn
 *  failed). `interrupted`: accepted, then the daemon restarted before it
 *  settled; never re-run automatically. Neither is retried. */
export type RequestState = "queued" | "running" | "completed" | "refused" | "failed" | "unknown" | "interrupted";
export interface WebRequest { requestId: string; state: RequestState; sessionId?: string; responseTurnId?: string; joined?: boolean; handedOff?: boolean; text?: string; timestamp?: number }
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
  | { kind: "result"; id: string; toolUseId: string; output: string; truncated: boolean; isError: boolean }
  /** A message sent to the subagent while it ran (not its first prompt, which is the brief). */
  | { kind: "message"; id: string; text: string; truncated: boolean; ts?: number };
/** The prompt the subagent was given: the first entry of its transcript. */
export interface SubagentBrief { text: string; truncated: boolean }
/** A byte window of complete transcript lines: page back with `before=start`, tail with `after=end`. */
export interface SubagentPage { items: SubagentItem[]; start: number; end: number; size: number; hasEarlier: boolean }
/** The end of a shell/Monitor task's output (SDK `get_task_output`: at most the last 8 KiB). */
export interface TaskOutput { output: string; size: number }
export type WebEvent =
  | { type: "block"; sessionId: string; requestId: string; turnId?: string; id: string; text: string }
  | { type: "request"; request: WebRequest }
  | { type: "invalidate"; sessionId?: string }
  /** The cron schedule may have changed (a job fired or finished). No payload: the page re-reads /cron. */
  | { type: "cron" }
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
// ---- The Study (read-only workspace inspection) ----
export interface WebMemoryEntry { path: string; kind: "directory" | "file" }
export interface WebMemoryTree { entries: WebMemoryEntry[]; truncated: boolean; missing: boolean }
export interface WebMemoryFile { path: string; content: string; modifiedAt: number; hiddenLines: number }
export interface WebTodos { files: Array<WebMemoryFile | { path: string; error: string }>; missing: boolean; truncated: boolean }
export interface WebMemorySearch { results: Array<{ path: string; line: number; text: string }>; truncated: boolean; unreadable: number; missing: boolean }
export interface WebCronJob {
  /** Hash of the job's intent; a confirmed change must name the revision it reviewed. */
  revision: string;
  id: string; name: string; enabled: boolean; schedule: CronSchedule; scheduleLabel: string; message: string; sessionKey: string;
  deleteAfterRun: boolean; createdAt: number; nextRunAt: number | null; lastRunAt: number | null; lastStatus: CronRunStatus | null; interruptedAt: number | null;
}
export interface WebCompaction { timestamp: number; preTokens?: number; postTokens?: number }
export interface WebContext {
  /** Persisted usage of the last recorded turn; null when no window was ever reported. */
  used: number | null; max: number | null; estimated: boolean; recordedAt: number | null; breakdown: ContextCategory[];
  analysisStatus: "available" | "unavailable" | "too_large";
  analysis: { totalMessages: number; totalTokens: number; sections: ContextSection[]; truncated: boolean } | null;
  summaries: Array<SummaryBlock & { truncated: boolean }>; summariesTruncated: boolean;
  /** Compactions seen on the watch bus since the daemon started (not a full audit log). */
  recentCompactions?: WebCompaction[];
}
export interface WebConfigField { path: string[]; secret: boolean; set: boolean; /** Length of a masked string. */ length?: number; value?: string | number | boolean | null | Array<string | number | boolean | null> | Record<string, never> }
export interface WebConfigView { missing: boolean; modifiedAt: number | null; fields: WebConfigField[]; truncated: boolean }
export type McpConnectionState = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
export interface WebMcpServer { name: string; enabled: boolean; type: string; oauth: boolean; timeout: number | null; alwaysLoad: boolean; configured: string[] }
export interface WebMcpLiveSession { sessionId: string; connections: Array<{ name: string; status: McpConnectionState }> | null }
export interface WebMcpView { missing: boolean; servers: WebMcpServer[]; live: { available: boolean; sessions: WebMcpLiveSession[] } }
/** A confirmed cron change: PATCH sets `enabled`, DELETE removes. */
export const cronChangeSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true), enabled: z.boolean().optional() }).strict();
export class WebError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** This is a closed RPC protocol, never a generic method/file/command proxy. */
export const rpcSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("message"), epoch: z.uuid(), input: messageInputSchema }).strict(),
  /** The daemon's current epoch, for local (web-process) mutations. */
  z.object({ method: z.literal("epoch") }).strict(),
  z.object({ method: z.literal("request"), requestId: z.uuid() }).strict(),
  /** The owner dealt with an interrupted request (resent it or let it go). */
  z.object({ method: z.literal("dismiss"), epoch: z.uuid(), requestId: z.uuid() }).strict(),
  z.object({ method: z.literal("snapshot"), cursor: z.string().max(128).optional() }).strict(),
  /** SDK-reported MCP connection state of live sessions (bounded; never probes). */
  z.object({ method: z.literal("mcp-status") }).strict(),
  /** Compactions of one browser session seen on the watch bus. */
  z.object({ method: z.literal("context-events"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  /** A task the browser was shown, by its browser session: where to read it. */
  z.object({ method: z.literal("task"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), output: z.boolean(), command: z.boolean().optional() }).strict(),
]);
export type Rpc = z.infer<typeof rpcSchema>;
export type WebSnapshot = Pick<WebBootstrap, "epoch" | "cursor" | "requests" | "blocks" | "tasks">;
export interface WebSync { snapshot: WebSnapshot; replay: EventEnvelope[] | null }
/** Daemon answer to the `task` RPC. `sessionKey` stays inside the web process. */
export interface WebTaskAccess { sessionKey: string; taskType: string; output?: TaskOutput;
  /** A shell task's full command, redacted and capped (see redact-command.ts). */
  command?: { text: string; truncated: boolean } }
