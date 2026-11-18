import { z } from "zod";
import type { ContextCategory, SessionMessage, SessionStats } from "../sessions/types.js";
import type { CronRunStatus, CronSchedule } from "../cron/types.js";
import type { HomeScene } from "../home/scene.js";
import type { HomeStatus } from "../home/status.js";
import type { ContextSection } from "../lcm/stats.js";
import type { SummaryBlock } from "../lcm/summary-reader.js";
import type { MessageReaction } from "../channels/types.js";
import { WEB_REPLY_TEXT_LIMIT } from "./reply-limits.js";

export const WEB_CHAT_ID = "owner";
// JSON can escape one UTF-16 code unit as six bytes (e.g. a lone surrogate).
// Leave room for 16,000 such units plus the validated request envelope.
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** The tapbacks a web message can carry: the channels' own MessageReaction set (iMessage tapback kinds, Telegram emoji). */
export const WEB_REACTIONS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const satisfies readonly MessageReaction[];
export type WebReaction = (typeof WEB_REACTIONS)[number];
export { WEB_REPLY_TEXT_LIMIT } from "./reply-limits.js";
/**
 * The earlier message a web message answers, as the iMessage channel sees a
 * long-press Reply or a tapback: its text, quoted to the agent by the same
 * `[replying to: "…"]` / `[reacting to: "…"] [tapback: …]` markers
 * (channels/text-utils.ts). With `reaction` the message IS the tapback, and
 * carries no text or attachments of its own.
 */
export const webReplySchema = z.object({
  text: z.string().max(WEB_REPLY_TEXT_LIMIT),
  reaction: z.enum(WEB_REACTIONS).optional(),
}).strict();
export type WebReply = z.infer<typeof webReplySchema>;
export const messageInputSchema = z.object({
  requestId: z.uuid(),
  targetId: z.string().max(128).optional(),
  text: z.string().trim().max(16_000),
  /** Staged uploads (POST /uploads) to attach, in order; at most 6 (see uploads.ts). */
  images: z.array(z.string().regex(/^[a-f0-9]{32}$/)).min(1).max(6).optional(),
  /** Staged non-image uploads, with the name and type the browser gave them
   *  (both sanitised when filed, exactly as iMessage's are); at most 6. */
  files: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    name: z.string().max(1024),
    type: z.string().max(255),
  }).strict()).min(1).max(6).optional(),
  /** Resending an interrupted message: files it already filed (their paths, as
   *  its request lists them), attached again from where they are — never a
   *  path the daemon did not file for an interrupted request. */
  refiled: z.array(z.string().min(1).max(4096)).min(1).max(6).optional(),
  /** Replying to (or, with `reaction`, reacting to) an earlier message. */
  reply: webReplySchema.optional(),
}).strict().refine((input) => {
  const content = input.text.length > 0 || (input.images?.length ?? 0) > 0 || (input.files?.length ?? 0) > 0 || (input.refiled?.length ?? 0) > 0;
  // A reaction is the whole message; anything else needs content of its own.
  return input.reply?.reaction ? !content : content;
}, { message: "empty message" });
/** A non-image file a web message filed (memory/incoming-files): where, and what its notice said. */
export interface WebFiledFile { path: string; name: string; type: string; size: number; typeUnknown?: boolean }
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
/** `images` / `files`: where an owner's attached images (incoming-images) and other files (incoming-files) were filed, while the request's text is kept. */
export interface WebRequest { requestId: string; state: RequestState; sessionId?: string; responseTurnId?: string; joined?: boolean; handedOff?: boolean;
  /** The agent has read (the SDK consumed) this message. In memory only; restored completed requests count as read. */
  read?: boolean; text?: string; timestamp?: number; images?: string[]; files?: WebFiledFile[];
  /** What this message replied or reacted to; its text cut to {@link WEB_REQUEST_QUOTE_LIMIT} code points. Kept while `text` is. */
  reply?: WebReply }
/** Code points of a reply's quoted text a request keeps for its pending bubble. */
export const WEB_REQUEST_QUOTE_LIMIT = 200;
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
  /**
   * Set while the task is in the SDK's background set: it runs on after Tomo has replied.
   * Absent for a foreground one (a blocking tool call the turn is waiting on).
   */
  background?: true;
  /** Daemon clock, ms epoch. */
  startedAt: number;
  endedAt?: number;
  state: WebTaskState;
  lastTool?: string;
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
}
/** A web page a turn used: a WebFetch URL, or a link a WebSearch returned. http(s) only, clipped and scrubbed. */
export interface WebSource { url: string; title?: string }
export type TodoStatus = "pending" | "in_progress" | "completed";
/** One entry of the agent's todo list (TodoWrite). `activeForm`: the present-tense label shown while it is in progress. */
export interface TodoEntry { content: string; status: TodoStatus; activeForm?: string }
/** One entry of a subagent's transcript, as the read-only task view shows it. */
export type SubagentItem =
  | { kind: "text"; id: string; text: string; truncated: boolean; ts?: number }
  /** `sources`: the page a WebFetch call reads. */
  | { kind: "tool"; id: string; toolUseId: string; name: string; summary: string; input: string; inputTruncated: boolean; ts?: number;
    sources?: WebSource[];
    /** `summary` is words the model wrote (a Bash description), not a command: shown in the text face. */
    prose?: true;
    /** Server-side only (session-tools.ts): the call reached memory/private, so its output is withheld. Never sent. */
    privateOutput?: boolean }
  /** `images`: image blocks in the output, counted and never served (the view shows a chip). `sources`: a WebSearch result's links. */
  | { kind: "result"; id: string; toolUseId: string; output: string; truncated: boolean; isError: boolean; images?: number; ts?: number;
    sources?: WebSource[] }
  /** A TodoWrite call, parsed: the whole list as the agent wrote it (at most MAX_TODOS entries; `more` says how many were left out). */
  | { kind: "todos"; id: string; toolUseId: string; todos: TodoEntry[]; more?: number; ts?: number }
  /** A message sent to the subagent while it ran (not its first prompt, which is the brief). */
  | { kind: "message"; id: string; text: string; truncated: boolean; ts?: number }
  /** A subagent's (non-empty) thinking block, clipped like text; shown folded. Never in the main chat's tool items. */
  | { kind: "thinking"; id: string; text: string; truncated: boolean; ts?: number };
/** A tool call as either view counts it: an ordinary call, or a parsed TodoWrite. */
export type CallItem = Extract<SubagentItem, { kind: "tool" | "todos" }>;
/** The prompt the subagent was given: the first entry of its transcript. */
export interface SubagentBrief { text: string; truncated: boolean }
/** A byte window of complete transcript lines: page back with `before=start`, tail with `after=end`. */
/** `unreadable`: lines in this window the reader did not recognise (sdk-transcript.ts); the view says some entries could not be read. */
export interface SubagentPage { items: SubagentItem[]; start: number; end: number; size: number; hasEarlier: boolean; unreadable?: number }
/**
 * The tool calls of a conversation's current SDK transcript, for the chat to
 * show inline. `end`: read on with `after=end&transcript=…`; `complete`: the
 * scan reached the requested time (or the transcript's start).
 */
export interface SessionTools { items: SubagentItem[]; end: number; transcript: string; complete: boolean;
  /** Lines read for this answer that the reader did not recognise. */
  unreadable?: number }
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
  /** When the cached value expires (ms epoch): the card schedules its next read from this. */
  expiresAt: number;
  /** The daemon's clock when it answered: the browser converts every time above to its own clock with it. */
  serverNow: number;
}
/**
 * RPC deadline for `usage`: under the HTTP socket timeout (30 s), above the
 * daemon's own usage deadline, so a slow endpoint becomes a "timeout" state
 * rather than a dropped connection.
 */
export const USAGE_RPC_TIMEOUT_MS = 24_000;
/**
 * `GET /api/v1/cost?from&to`: the Study Cost page, from the usage ledger
 * (`~/.tomo/data/usage/YYYY-MM.ndjson`). Every dollar figure is the SDK's
 * estimate at API list prices, never a bill. Dates are `YYYY-MM-DD` in
 * `timeZone` (the owner's), whose midnights are the day boundaries.
 */
export type WebCostCategory = "you" | "background" | "scheduled";
export type WebCostSplit = Record<WebCostCategory, number>;
export interface WebCostDay {
  date: string;
  costUsd: number;
  turns: number;
  byCategory: WebCostSplit;
  /** Before the first ledger row: nothing was recorded (not "a $0 day"). */
  recorded: boolean;
  /** Before the #389 fix (Sep 23): too high, shown marked, never compared. */
  overcounted: boolean;
  /** Rebuilt from the activity log (`tomo usage backfill`). */
  backfilled: boolean;
}
/** One local clock hour, summed over the range. */
export interface WebCostHour { hour: number; costUsd: number; turns: number; byCategory: WebCostSplit }
export interface WebCostSession {
  /** The web session id when the browser can open it (owner DM, groups). */
  id?: string;
  label: string;
  kind: "dm" | "group" | "other";
  costUsd: number;
  turns: number;
  byCategory: WebCostSplit;
}
export interface WebCostCron {
  /** null: scheduled turns with no job (LCM rollups, nudges, unpaired backfilled cron turns). */
  jobId: string | null;
  name: string;
  costUsd: number;
  runs: number;
}
export interface WebCostModel {
  model: string;
  costUsd: number;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreated: number };
}
export interface WebCostTurn {
  ts: number;
  date: string;
  session: { id?: string; label: string; kind: WebCostSession["kind"] };
  category: WebCostCategory;
  /** The ledger's finer source (owner, group, cron, heartbeat, …). */
  source: string;
  jobName?: string;
  costUsd: number;
  durationMs?: number;
  /** Main-loop tool calls; absent on rows from before it was recorded. */
  tools?: number;
  /** SDK round trips (`num_turns`). */
  numTurns?: number;
  /** Start of the message that triggered the turn, credentials scrubbed. */
  trigger?: string;
  overcounted?: true;
  backfilled?: true;
}
/** A rolling window ending today. `comparable: false`: it holds an over-counted day, so no ratio is given. */
export interface WebCostPeriod { from: string; to: string; costUsd: number; comparable: boolean }
export interface WebCostGlance {
  today: string;
  /** Today and the six days before. */
  thisWeek: WebCostPeriod;
  /** The seven days before thisWeek. */
  lastWeek: WebCostPeriod;
  /** thisWeek / lastWeek; null when either is not comparable or lastWeek is $0. */
  weekRatio: number | null;
  last30: WebCostPeriod;
  /** Median of the last 30 recorded, not over-counted days; null with none. */
  typicalDay: { costUsd: number; days: number } | null;
  /** Costliest of those days. */
  busiestDay: { date: string; costUsd: number } | null;
}
export interface WebCostLimitWindow {
  window: string;
  label?: string;
  group?: "session" | "weekly" | "other";
  scoped?: boolean;
  percent?: number;
  resetsAt?: string;
  status?: string;
}
/** The newest quota sample in `limits.ndjson`; null when there is none. */
export interface WebCostLimits { sampledAt: string; source: string; windows: WebCostLimitWindow[] }
export interface WebCost {
  from: string;
  to: string;
  timeZone: string;
  /** Ms epoch of the earliest ledger row; null: the ledger is empty. */
  recordedSince: number | null;
  totals: { costUsd: number; turns: number; byCategory: WebCostSplit; overcountedCostUsd: number };
  days: WebCostDay[];
  hours: WebCostHour[];
  sessions: WebCostSession[];
  crons: WebCostCron[];
  /** Per model, from rows that carry the split; `unsplitCostUsd` is the rest of the range's cost. */
  models: WebCostModel[];
  unsplitCostUsd: number;
  topTurns: WebCostTurn[];
  /** Relative to today, whatever the range. */
  glance: WebCostGlance;
  limits: WebCostLimits | null;
  generatedAt: number;
}
/**
 * What the SDK reports about a session's running turn besides its content.
 * `retry` and `tool` describe the moment and lapse as the turn moves on;
 * `refusal`, `error` and `stopped` say how it went and stay until the next
 * message.
 */
export type WebTurnStatus =
  | { kind: "retry"; attempt: number; max: number; delayMs: number; error: string }
  | { kind: "tool"; tool: string; elapsed: number }
  | { kind: "refusal"; model: string; fallbackModel?: string; category?: string }
  | { kind: "error"; error: string }
  | { kind: "stopped" };
/** The subscription's rate-limit state as the SDK last reported it (`rate_limit_event`). */
export interface WebRateLimit {
  status: "allowed" | "allowed_warning" | "rejected";
  /** five_hour, seven_day, seven_day_opus, … */
  limit?: string;
  /** ms epoch. */
  resetsAt?: number;
  /** 0–100. */
  utilization?: number;
  overage?: boolean;
  /** Daemon clock when it was reported (ms epoch). */
  at: number;
}
// ---- Tomo's home (see src/home/scene.ts) ----
/**
 * The scene the page draws: always a valid one. `problems` is set when the
 * file Tomo last wrote is not valid, and `scene` is then the last good one
 * (or the starter). `revision` changes whenever `scene` or an asset does.
 */
export interface WebHome { scene: HomeScene; revision: string; starter: boolean; problems?: string[]; status: HomeStatus }
/** A picture of the room as a browser drew it, for Tomo to look at: a PNG as base64, at most HOME_SNAPSHOT_MAX_BYTES decoded. */
export const HOME_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const homeSnapshotSchema = z.object({ requestId: z.uuid().optional(), revision: z.string().max(80), png: z.string().min(1).max(Math.ceil(HOME_SNAPSHOT_MAX_BYTES * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
/**
 * An open credential request the owner answers in the web UI's password card
 * (src/credentials/broker.ts). Name and purpose only: no event, snapshot or
 * response ever carries a value.
 */
export interface WebCredentialRequest { id: string; name: string; purpose: string; expiresAt: number }
/** The card's answer (POST /credentials/<id>): the value, or a refusal. Its own route, never /messages. */
export const credentialSubmitSchema = z.union([
  z.object({ value: z.string().min(1).max(8192) }).strict(),
  z.object({ cancel: z.literal(true) }).strict(),
]);
export type WebCredentialSubmit = z.infer<typeof credentialSubmitSchema>;
/** Answer to the card: the value was stored, or the request was refused. Never echoes the value. */
export interface WebCredentialResult { status: "stored" | "cancelled" }
export type WebEvent =
  /** `images`: ids of pictures this block sent, filed in the outgoing media store (see outgoing-media.ts). */
  | { type: "block"; sessionId: string; requestId: string; turnId?: string; id: string; text: string; images?: string[] }
  | { type: "request"; request: WebRequest }
  | { type: "invalidate"; sessionId?: string }
  /** The cron schedule may have changed (a job fired or finished). No payload: the page re-reads /cron. */
  | { type: "cron" }
  | { type: "tool"; sessionId: string; tool: string; state: "started" | "completed" | "failed" }
  | { type: "typing"; sessionId: string; active: boolean }
  /** The latest compact request changed state. */
  | { type: "compact"; request: WebCompactState }
  /** null: a new turn started, whatever the last one reported no longer applies. */
  | { type: "turn"; sessionId: string; status: WebTurnStatus | null }
  | { type: "rate-limit"; limit: WebRateLimit }
  /** The SDK's predicted next message for the composer; null withdraws it. */
  | { type: "suggestion"; sessionId: string; text: string | null }
  /** The home's scene or one of its pictures changed: the page re-reads /home. */
  | { type: "home"; revision: string }
  /** What Tomo is doing changed. REPLACE semantics. */
  | { type: "home-status"; status: HomeStatus }
  /** Tomo wants to look at its home: an open Home page answers with POST /home/snapshot. */
  | { type: "home-look"; requestId: string }
  /** The open credential request for the card; null: none (answered, refused, expired). REPLACE semantics. */
  | { type: "credential-request"; request: WebCredentialRequest | null }
  /** All tasks of one session, live and recently ended. REPLACE semantics. */
  | { type: "tasks"; sessionId: string; tasks: WebTask[] }
  /** Tomo reacted to (null: took back its reaction on) one of the owner's web messages. */
  | { type: "reaction"; sessionId: string; requestId: string; reaction: WebReaction | null };
export interface EventEnvelope { id: string; event: WebEvent }
export interface WebBootstrap extends WebCatalog {
  epoch: string;
  csrfToken: string;
  cursor: string;
  requests: WebRequest[];
  blocks: Extract<WebEvent, { type: "block" }>[];
  /** Every visible session's tasks; replaces the client's whole task list. */
  tasks: WebTask[];
  /** Optional features this daemon serves (absent on older daemons). */
  /** `uploads`: images can be attached; `files`: any other file can. */
  capabilities?: { screen: boolean; uploads?: boolean; files?: boolean };
  /** The latest compact request, so a reload still shows it. */
  compact?: WebCompactState;
  rateLimit?: WebRateLimit;
  /** The standing prompt suggestion per session. */
  suggestions?: Record<string, string>;
  /** Tomo's reactions on the owner's web messages, by request id (absent on older daemons). */
  reactions?: Record<string, WebReaction>;
  /** What the UI calls the agent (config `agent.name`, else IDENTITY.md, else "Tomo"); absent on older daemons. */
  agentName?: string;
  /** The open credential request, so a reload still shows the card (absent: none, or an older daemon). */
  credentialRequest?: WebCredentialRequest | null;
}
/** One tick of the read-only screen view: a JPEG when live, otherwise why there is none. */
export interface WebScreenFrame { status: "live" | "locked" | "away" | "unconfirmed" | "unavailable" | "too_large"; capturedAt: number; jpeg?: string }
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
/** One model the Study's Model page offers: an alias target, with every alias naming it. */
export interface WebModelOption { id: string; label: string; aliases: string[] }
/** The model of one browser session, and what it can be switched to (GET /models?session=). */
export interface WebModelView {
  sessionId: string;
  model: { id: string; label: string };
  /** config.model: what a conversation without its own choice runs on. */
  defaultModel: { id: string; label: string };
  /** The conversation has its own choice (sessionModelOverrides). */
  overridden: boolean;
  /** Only the owner's conversation can be switched from the browser; groups are read-only. */
  writable: boolean;
  /** A turn is in flight; a switch is refused (409 turn_in_flight) until it ends. */
  busy: boolean;
  options: WebModelOption[];
  /** A LiteLLM gateway is configured (provider/model ids are accepted); chatgptOnly: it routes chatgpt/* only. */
  gateway: { configured: boolean; chatgptOnly: boolean; example: string };
}
/** A confirmed model switch of the owner's conversation (POST /models). `from`: the model id the page showed. */
export const modelChangeSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), model: z.string().trim().min(1).max(200),
  from: z.string().min(1).max(200), confirm: z.literal(true) }).strict();
/** `unchanged`: it already ran on that model; nothing was written or restarted. */
export interface WebModelChangeResult { status: "switched" | "unchanged"; model: { id: string; label: string }; previous: { id: string; label: string } }
/** A confirmed cron change: PATCH sets `enabled`, DELETE removes. */
export const cronChangeSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true), enabled: z.boolean().optional() }).strict();
export class WebError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** What the owner can do to a running task from the task view. */
export const TASK_ACTIONS = ["stop", "background"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
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
  z.object({ method: z.literal("usage"), refresh: z.boolean() }).strict(),
  z.object({ method: z.literal("compact"), epoch: z.uuid() }).strict(),
  /** Stop the owner conversation's running turn. */
  z.object({ method: z.literal("stop"), epoch: z.uuid() }).strict(),
  /** A task the browser was shown, by its browser session: where to read it. */
  z.object({ method: z.literal("task"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), output: z.boolean(), command: z.boolean().optional() }).strict(),
  /** Stop a running task of the owner conversation, or move a foreground one to the background. */
  z.object({ method: z.literal("task-action"), epoch: z.uuid(), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    taskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), action: z.enum(TASK_ACTIONS) }).strict(),
  /** The model of a browser session (the Study's Model page). */
  z.object({ method: z.literal("model"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  /** Switch the owner conversation's model; `from` is the model the owner reviewed. */
  z.object({ method: z.literal("model-switch"), epoch: z.uuid(), sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    model: z.string().trim().min(1).max(200), from: z.string().min(1).max(200) }).strict(),
  /** Tomo's home as the page draws it (WebHome). */
  z.object({ method: z.literal("home") }).strict(),
  /** A picture of the home an open Home page drew, for Tomo's home_check (checked again by the daemon). */
  z.object({ method: z.literal("home-snapshot"), epoch: z.uuid(), snapshot: homeSnapshotSchema }).strict(),
  /** The credential card's answer, for the broker. The value goes no further than broker.fulfill. */
  z.object({ method: z.literal("credential-submit"), epoch: z.uuid(), id: z.uuid(), input: credentialSubmitSchema }).strict(),
]);
export type Rpc = z.infer<typeof rpcSchema>;
export type WebSnapshot = Pick<WebBootstrap, "epoch" | "cursor" | "requests" | "blocks" | "tasks" | "compact" | "rateLimit" | "suggestions" | "reactions" | "credentialRequest">;
export interface WebSync { snapshot: WebSnapshot; replay: EventEnvelope[] | null }
/** Daemon answer to the `task` RPC. `sessionKey` stays inside the web process. */
export interface WebTaskAccess { sessionKey: string; taskType: string; output?: TaskOutput;
  /** A shell task's full command, redacted and capped (see redact-command.ts). */
  command?: { text: string; truncated: boolean } }
/** Answer to a task action: whether the SDK took it (false: the task had already ended, or it refused). */
export interface WebTaskActionResult { done: boolean }
/** Answer to a stop request: whether a turn was running to stop. */
export interface WebStopResult { stopped: boolean }
/** Answer to a compact request: queued, or one is already outstanding. */
export interface WebCompactResult { status: "queued" | "already_requested"; requestId: string }
/**
 * The latest compact request and where it stands: accepted (queued for
 * Tomo), declined (refused: tasks were running), done (the turn finished and
 * the recorded context clearly dropped), unverified (the turn finished but
 * no drop is visible — Tomo may have skipped it), failed (it did not finish).
 */
export interface WebCompactState { requestId: string; state: "accepted" | "declined" | "done" | "unverified" | "failed"; at: number }
