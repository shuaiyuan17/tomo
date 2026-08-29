import {
  query,
  type McpServerConfig,
  type McpSetServersResult,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
  type SDKMessageOrigin,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { watchBus } from "../watch/bus.js";
import { clip, TOOL_DETAIL_LIMIT } from "../watch/protocol.js";
import { resetTurnBudget, type TurnBudget, type sdkOptions } from "./sdk-options.js";
import { endsWithTrailingNoReply } from "./text-utils.js";
import { filterScaffoldLeak } from "./scaffold-filter.js";

export interface TurnRequest {
  resolve: (response: string) => void | Promise<void>;
  reject: (err: Error) => void | Promise<void>;
  /**
   * Out-channel for ONE completed delivery unit, called the moment the SDK
   * closes that content block — WHILE THE TURN IS STILL RUNNING, not after it
   * ends. That is the whole point: a turn that spends twenty minutes in a
   * subagent still answers the owner with the text it produced first, twenty
   * minutes before the turn resolves.
   *
   * What this does NOT promise is that the block lands before the tool the
   * model just announced starts running. It usually does not. See handleEvent.
   *
   * Awaited, so the event loop backpressures on delivery and blocks reach the
   * channel in the order the model produced them. Never rejects — a failed
   * send is logged by the sink, not allowed to kill the turn.
   */
  onBlock?: (block: string) => void | Promise<void>;
  /**
   * The block most recently handed to `onBlock` has been GIVEN UP ON: its
   * delivery blew the budget (or the sink threw), the turn is moving on, and
   * the still-running promise must no longer be treated as this block's
   * outcome.
   *
   * Called synchronously, before the next block is handed over, so a sink that
   * keeps ordered transcript slots can close this one out IN ORDER. The
   * abandoned send may still complete — there is no cancellation to hand a
   * channel — but by then its slot is closed and it changes nothing.
   *
   * Unambiguous because delivery is serialized: `handleEvent` does not pull the
   * next SDK event until the current `shipBlock` has returned, so exactly one
   * block is outstanding when this fires.
   */
  onBlockAbandoned?: () => void;
}

export interface MessageRequest extends TurnRequest {
  message: SDKUserMessage;
}

/**
 * One block's in-flight delivery. `abandoned` is the latch that keeps
 * `onBlockAbandoned` to exactly one call per block, whoever gives up first —
 * the delivery budget expiring, the sink throwing, or the session closing.
 */
interface OutstandingDelivery {
  req: TurnRequest;
  abandoned: boolean;
}

export type UnownedTurnFactory = () => TurnRequest | undefined;

/**
 * Sentinel resolution for a steered message that merged into the in-flight
 * turn: that turn's owner request receives (and delivers) the combined
 * response, so the steered caller gets this empty marker instead. The empty
 * string is safe as a sentinel only because send()/steer() can never
 * legitimately resolve with "" — empty turns fall back to "I'm not sure how
 * to respond to that." in the result handler.
 */
export const STEER_MERGED = "";
export const QUERY_TIMEOUT_ERROR_PREFIX = "Query timed out after";

/** Fabricated reply for a turn the CLI cut short at the max-turns limit. */
export const MAX_TURNS_RESPONSE = "I ran out of steps trying to complete that. Can you try a simpler request?";
/** Fabricated reply for a turn the CLI cut short at the per-query budget. */
export const MAX_BUDGET_RESPONSE = "I hit the spending limit for this turn before finishing.";
/** Fabricated reply for a turn that died inside the CLI (`error_during_execution` and friends). */
export const EXECUTION_ERROR_RESPONSE = "Something went wrong while I was working on that and the turn stopped early.";

/**
 * The slice of `SDKResultMessage` the result handler reads. Typed by hand
 * rather than imported so an SDK release that adds result subtypes keeps
 * compiling — `subtype` is compared as a string and unknown values fall into
 * the generic execution-error branch.
 */
interface SdkResultLike {
  subtype: string;
  is_error?: boolean;
  /** Error subtypes: why the turn stopped. */
  errors?: string[];
  /** `success` subtype: the final assistant text — or, with `is_error`, the API error text. */
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
  session_id?: string;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreated: number;
}

/**
 * A turn the CLI ended on a non-success result. Thrown (rejected) from
 * send()/steer() so the failure travels the same path as any other turn
 * error and TurnRunner's `TurnErrorPolicy` decides what the chat sees —
 * delivered to a DM, note-only for a group cron, ignored for continuity —
 * and CronScheduler records the run as failed. `message` is owner-facing
 * (or, for an API-error result, the API error text, which the delivery
 * pipeline's `isAgentErrorResponse` already classifies).
 */
export class SdkResultError extends Error {
  constructor(message: string, readonly subtype: string, readonly errors: string[] = []) {
    super(message);
    this.name = "SdkResultError";
  }
}

/**
 * Classify a turn-ending result. `null` for a clean success; otherwise the
 * typed error the turn should reject with.
 *
 * The SDK's result union (`SDKResultSuccess | SDKResultError`) is closed
 * today, but new error subtypes have been added before; every one so far is
 * `error_*`, so an unrecognised `error_*` subtype is treated as an execution
 * error rather than as success.
 */
export function describeResultFailure(result: SdkResultLike): SdkResultError | null {
  const errors = result.errors ?? [];
  switch (result.subtype) {
    case "success":
      if (!result.is_error) return null;
      return new SdkResultError(result.result?.trim() || "API Error: the turn ended on an API error", result.subtype, errors);
    case "error_max_turns":
      return new SdkResultError(MAX_TURNS_RESPONSE, result.subtype, errors);
    case "error_max_budget_usd":
      return new SdkResultError(MAX_BUDGET_RESPONSE, result.subtype, errors);
    default:
      return result.subtype.startsWith("error") || result.is_error
        ? new SdkResultError(EXECUTION_ERROR_RESPONSE, result.subtype, errors)
        : null;
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()/steer()

/**
 * How long ONE block's delivery may take before we give up on it.
 *
 * Separate from the inactivity timeout on purpose, and much shorter. The
 * inactivity timeout asks "is the MODEL still working?" and kills the session
 * when the answer is no. This one asks "is the CHANNEL still taking bytes?"
 * and answers only for this block — a wedged iMessage send loses its own
 * message and nothing else. Sixty seconds is far beyond a healthy send (tens
 * of milliseconds) and far below the ten-minute inactivity window, so it fires
 * only on a genuine hang.
 */
export const DELIVERY_TIMEOUT_MS = 60 * 1000;

/** Reject after `ms` unless `work` settles first. Always clears its timer. */
async function withDeliveryTimeout(work: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LiveSessionSettings {
  timeoutMs?: number;
  /** Include `thinking` content blocks in the turn response (config.showThinking). */
  showThinking?: boolean;
}

/**
 * Marker prefixed to a thinking block when showThinking is on, so the reader
 * can tell the model's reasoning from its reply. Chosen over a fenced block
 * because chat channels render neither Markdown nor code fences.
 *
 * Only ever applied with the flag ON. With it off, a thinking block that
 * survives to delivery is not being shown as reasoning — it IS the message
 * (see renderBlock) — so it ships plain.
 */
export const THINKING_MARKER = "💭 ";

/** An assistant content block worth keeping for the turn response. */
export interface ResponseBlock {
  type: "text" | "thinking";
  text: string;
}

/**
 * A rendered turn. Delivery units are NOT part of it: blocks ship as they
 * complete (see renderBlock), so by the time a turn is rendered there is
 * nothing left to hand a channel — only the joined text the turn-level
 * bookkeeping needs.
 */
export interface RenderedTurn {
  /** The kept blocks joined with "\n" — logging, transcript, error/silence checks. */
  text: string;
  /** True when at least one block had a training-scaffold leak stripped. */
  scaffoldFiltered: boolean;
}

/** What one content block turns into once the per-block rules have run. */
export type BlockRender =
  /** Ships as one channel message. */
  | { kind: "ship"; text: string; scaffoldFiltered: boolean }
  /** Trailing line(s) were the bare control token — the block ships nothing. */
  | { kind: "no-reply"; scaffoldFiltered: boolean }
  /** Wrong type for this session, or nothing left after filtering. */
  | { kind: "empty"; scaffoldFiltered: boolean };

/**
 * Decide what ONE completed content block ships, from its `type` and its
 * LENGTH alone.
 *
 * This is the ONLY place that decides what reaches a channel, and it never
 * inspects the text to judge whether it is "really" a reply. A `text` block is
 * the model's chosen words and always ships, even when it happens to read like
 * reasoning (`思考: ...`) or like tool debris (`count`).
 * `redacted_thinking` carries no readable text and is dropped at collection
 * time.
 *
 * A `thinking` block:
 *   - showThinking ON  → ships prefixed with THINKING_MARKER, so the reader can
 *     tell reasoning from reply.
 *   - showThinking OFF → the SDK is running thinking `display: "omitted"`,
 *     which strips the reasoning and leaves a signature-only block whose text
 *     is EMPTY. An empty one is therefore the normal case and is dropped
 *     silently. A NON-EMPTY one under `omitted` is not reasoning that leaked;
 *     it is the model having written a message in the wrong block type, and it
 *     ships EXACTLY LIKE A `text` BLOCK — unmarked, through the same scaffold
 *     filter, the same bare-NO_REPLY rule and the same downstream attachment
 *     and `[[NL]]` handling.
 *
 * WHERE THAT LAST RULE COMES FROM (owner decision, 2026-08-28). One session's
 * SDK transcript for the day, flag off, held 173 thinking blocks with a 0-char
 * `thinking` string — what `omitted` produces for real reasoning — and 21 with
 * non-empty text. Every one of the 21 was prose aimed at the owner (a reply
 * after a tool result, a progress line after a steer); six were answers he was
 * waiting for and never received, because dropping the block was the specified
 * behaviour. None was leaked reasoning. So the correct reading of a non-empty
 * thinking block under `omitted` is "misplaced message", and it is delivered
 * on that basis — deterministically, from type and length, with no round trip
 * and no look at what the prose says.
 *
 * The two remaining rules are per block by design (#292) and now also per
 * block in TIME — they run as the block completes, because that is when it
 * ships:
 *   1. scaffold-leak filter — a leak truncates its own block, not the turn, so
 *      blocks after a `<system-reminder>` slip still ship;
 *   2. bare-NO_REPLY drop — a block whose trailing line(s) are only the token
 *      is dropped WHOLE (text, MEDIA: and STICKER: alike), so housekeeping
 *      narration and its attachments never leak out of a mid-turn slip.
 */
export function renderBlock(block: ResponseBlock, showThinking: boolean): BlockRender {
  const scaffold = filterScaffoldLeak(block.text);
  const scaffoldFiltered = scaffold.filtered;
  const text = scaffold.text.trim();
  if (!text) return { kind: "empty", scaffoldFiltered };
  if (endsWithTrailingNoReply(text)) return { kind: "no-reply", scaffoldFiltered };

  return {
    kind: "ship",
    // Marked only when thinking is being shown AS thinking. With the flag off
    // this block is a message, and a message does not get a 💭 on it.
    text: block.type === "thinking" && showThinking ? `${THINKING_MARKER}${text}` : text,
    scaffoldFiltered,
  };
}

/**
 * Join a turn's collected content blocks into its RESPONSE STRING.
 *
 * Delivery no longer goes through here — each block was already shipped by
 * `renderBlock` as it completed. What is left is everything that legitimately
 * needs the whole turn: the transcript, the response log line, the value
 * `send()`/`steer()` resolve with, and the end-of-turn silence and
 * agent-error checks.
 *
 * Because those checks read this string, the trailing bare NO_REPLY is still
 * represented here even though the block itself shipped nothing — otherwise a
 * housekeeping turn would render as empty and be replaced by the "I'm not sure
 * how to respond to that." fallback in the transcript.
 */
export function renderResponseBlocks(blocks: ResponseBlock[], showThinking: boolean): RenderedTurn {
  const rendered: string[] = [];
  let scaffoldFiltered = false;
  // Tracks whether the last block that carried any content was a NO_REPLY
  // block — a TRAILING one is load-bearing (see below), a mid-turn one is not.
  let lastKeptWasNoReply = false;

  for (const block of blocks) {
    const result = renderBlock(block, showThinking);
    if (result.scaffoldFiltered) scaffoldFiltered = true;
    if (result.kind === "empty") continue;
    if (result.kind === "no-reply") {
      lastKeptWasNoReply = true;
      continue;
    }
    lastKeptWasNoReply = false;
    rendered.push(result.text);
  }

  // NO_REPLY is Tomo's own control token, not the model's prose. A block whose
  // trailing line(s) are the bare token MID-turn is a slip and is dropped —
  // under per-block delivery the channels dropped it too. A TRAILING one is
  // load-bearing: it marks the whole turn as not-for-the-channel (owner
  // decision 2026-07-08), so exactly one is kept at the end for the delivery
  // layer's trailing-NO_REPLY check to find.
  const kept = lastKeptWasNoReply ? [...rendered, "NO_REPLY"] : rendered;

  return { text: kept.join("\n").trim(), scaffoldFiltered };
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (timeoutMs % 1000 === 0) {
    const seconds = timeoutMs / 1000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs}ms`;
}

function queryTimeoutError(timeoutMs: number): string {
  return `${QUERY_TIMEOUT_ERROR_PREFIX} ${formatTimeout(timeoutMs)}`;
}

export interface QueryResult {
  /** Cost of this turn only (delta of the SDK's cumulative per-process total) */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextUsed: number;
  contextMax: number;
  contextBreakdown?: { name: string; tokens: number }[];
}

function summarizeToolResult(content: unknown): string {
  // Tool results arrive as either a string or an array of content blocks
  // ({type:"text",text:"..."} | {type:"image",...} | etc.). We flatten to a
  // short readable string for log lines — no need to be exhaustive.
  if (content == null) return "(empty)";
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        if ("text" in b && typeof (b as { text: unknown }).text === "string") {
          parts.push((b as { text: string }).text);
        } else if ("type" in b) {
          parts.push(`<${(b as { type: string }).type}>`);
        }
      }
    }
    return parts.join(" ").slice(0, 500);
  }
  return JSON.stringify(content).slice(0, 500);
}

function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Read": return `Read ${input.file_path}`;
    case "Write": return `Write ${input.file_path}`;
    case "Edit": return `Edit ${input.file_path}`;
    case "Bash": return `Bash: ${String(input.command).slice(0, 500)}`;
    case "Glob": return `Glob ${input.pattern}`;
    case "Grep": return `Grep "${input.pattern}"`;
    case "WebSearch": return `WebSearch: ${input.query}`;
    case "WebFetch": return `WebFetch: ${input.url}`;
    case "Agent": case "Task": return `Agent → ${input.subagent_type ?? "?"}: ${String(input.description ?? "").slice(0, 80)}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 500)}`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return isObject(block) && block.type === "text" && typeof block.text === "string";
}

function isThinkingBlock(block: unknown): block is { type: "thinking"; thinking: string } {
  return isObject(block) && block.type === "thinking" && typeof block.thinking === "string";
}

function isToolUseBlock(block: unknown): block is { type: "tool_use"; id?: string; name: string; input?: Record<string, unknown> } {
  return isObject(block) && block.type === "tool_use" && typeof block.name === "string";
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function buildContentBlocks(
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
  documents?: Array<{ data: string; mediaType: string; filename?: string }>,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType as ImageMediaType, data: img.data },
      });
    }
  }
  if (documents && documents.length > 0) {
    for (const doc of documents) {
      const block: Record<string, unknown> = {
        type: "document",
        source: { type: "base64", media_type: doc.mediaType, data: doc.data },
      };
      if (doc.filename) block.title = doc.filename;
      content.push(block);
    }
  }
  content.push({ type: "text", text });
  return content;
}

export class LiveSession {
  private q: Query;
  // Input messages waiting for the SDK to pull them through messageGenerator.
  // The SDK pumps this eagerly (writes to the CLI as soon as we yield), which
  // is what lets steer() inject a message while a turn is in flight.
  private inputQueue: SDKUserMessage[] = [];
  private inputWaiter: (() => void) | null = null;
  // The request that owns the in-flight turn: its callbacks receive the
  // turn's collected blocks and it resolves with the turn's full response.
  private currentRequest: TurnRequest | null = null;
  // Steered requests confirmed merged into the in-flight turn (we saw the CLI
  // echo their message back mid-turn). Resolved with STEER_MERGED at result.
  private mergedRequests: MessageRequest[] = [];
  // Steered requests injected but not yet seen in the event stream. If they
  // miss the in-flight turn's tool boundaries, the CLI queues them and runs
  // them as the next turn (promoted at result time).
  private pendingSteers: Array<{ req: MessageRequest; text: string }> = [];
  // Text of the steered request promoted to own the current turn, if any.
  // Used to detect the CLI batching the remaining queued steers into that
  // turn (see matchSteerEchoes).
  private promotedSteerText: string | null = null;
  // send() callers waiting for the session to go idle (steered messages can
  // keep the session busy past the turn the agent-level queue saw finish).
  private idleWaiters: Array<() => void> = [];
  private parts: ResponseBlock[] = [];
  private sessionId: string | null = null;
  private alive = true;
  lastResult: QueryResult | null = null;
  private prevTotalCost = 0;
  /** Cumulative `modelUsage` token totals as of the previous result, for per-turn deltas. */
  private prevModelTokens: TokenTotals | null = null;
  private eventLoopDone: Promise<void>;
  private sessionKey: string | undefined;
  private turnBudget: TurnBudget | undefined;
  private unownedTurnDropLogged = false;
  private unownedTurnFactory: UnownedTurnFactory | undefined;
  private timeoutMs: number;
  private showThinking: boolean;
  // Maps tool_use_id → tool name so we can label tool_result log lines
  // (the result event only carries the use id, not the original name).
  private pendingToolNames = new Map<string, string>();
  /** tool_use_id → start time, for tool.end durations on the watch bus. */
  private pendingToolStarts = new Map<string, number>();
  /** Agent tool_use id → subagent_type, so a subagent's tool logs can name which agent ran them. */
  private subagentTypeById = new Map<string, string>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Depth of in-flight `onBlock` delivery. While > 0 the inactivity timer is
   * DISARMED and refreshes are ignored — see shipBlock for why.
   */
  private deliverySuspensions = 0;
  /**
   * The block whose `onBlock` is currently being awaited, if any. Published so
   * `close()` can give up on it SYNCHRONOUSLY — a session that is being torn
   * down must not leave a transcript slot open while the sink waits out the
   * delivery budget. At most one exists at any instant, because delivery is
   * serialized (handleEvent does not pull the next event until shipBlock has
   * returned).
   */
  private outstandingDelivery: OutstandingDelivery | null = null;

  constructor(
    options: ReturnType<typeof sdkOptions>,
    sessionKey?: string,
    turnBudget?: TurnBudget,
    unownedTurnFactory?: UnownedTurnFactory,
    settings: LiveSessionSettings = {},
  ) {
    this.sessionKey = sessionKey;
    this.turnBudget = turnBudget;
    this.unownedTurnFactory = unownedTurnFactory;
    this.timeoutMs = normalizeTimeoutMs(settings.timeoutMs);
    this.showThinking = settings.showThinking ?? false;
    this.q = query({ prompt: this.messageGenerator(), options });
    this.eventLoopDone = this.consumeEvents();
  }

  private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
    while (this.alive) {
      while (this.inputQueue.length === 0) {
        if (!this.alive) return;
        await new Promise<void>((resolve) => { this.inputWaiter = resolve; });
        this.inputWaiter = null;
      }
      yield this.inputQueue.shift()!;
    }
  }

  private pushInput(msg: SDKUserMessage): void {
    this.inputQueue.push(msg);
    this.inputWaiter?.();
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.q) {
        await this.handleEvent(event);
      }
    } catch (err) {
      this.failTurn(err instanceof Error ? err : new Error(String(err)));
    }
    this.alive = false;
    this.inputWaiter?.();
    // Reject anything still in flight so callers fail fast instead of
    // hanging until their timeout, and wake idle waiters so a queued send()
    // can observe the dead session.
    this.failTurn(new Error("Session is closed"));
  }

  /**
   * Reject the in-flight turn's owner plus any merged/pending steered
   * requests, clear turn state, and wake idle waiters. No-op when idle.
   */
  private failTurn(err: Error): void {
    const requests: TurnRequest[] = [];
    if (this.currentRequest) requests.push(this.currentRequest);
    requests.push(...this.mergedRequests, ...this.pendingSteers.map((e) => e.req));
    this.currentRequest = null;
    this.mergedRequests = [];
    this.pendingSteers = [];
    this.promotedSteerText = null;
    this.clearActivityTimeout();
    for (const r of requests) r.reject(err);
    this.notifyIdle();
  }

  /** Resolves when no turn is in flight (or the session dies). */
  async waitForIdle(): Promise<void> {
    while (this.alive && this.isBusy()) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private clearActivityTimeout(): void {
    if (!this.activityTimer) return;
    clearTimeout(this.activityTimer);
    this.activityTimer = null;
  }

  private refreshActivityTimeout(): void {
    // Inactivity accounting is SUSPENDED while a block is being delivered.
    // Guarded here as well as at the suspend site because send()/steer() can
    // refresh from another task while the event loop sits in `await onBlock`,
    // which would silently re-arm the timer we just disarmed.
    if (this.deliverySuspensions > 0) return;
    if (!this.alive || !this.isBusy()) {
      this.clearActivityTimeout();
      return;
    }
    this.clearActivityTimeout();
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (this.alive && this.isBusy()) {
        this.timeoutTurn(new Error(queryTimeoutError(this.timeoutMs)));
      }
    }, this.timeoutMs);
  }

  /**
   * A local timeout means the SDK child may still be working on input we have
   * already yielded. Retire the live child instead of merely clearing request
   * bookkeeping; otherwise later sends can be pushed into a stale in-flight
   * conversation that this wrapper now believes is idle.
   */
  private timeoutTurn(err: Error): void {
    // FAIL FIRST, THEN CLOSE. close() now rejects the in-flight turn itself,
    // with a generic "Session is closed" — running it first would hand the
    // caller that instead of this specific timeout, and LiveSessionManager
    // keys on the timeout prefix to retire the stale SDK session id.
    this.failTurn(err);
    this.close();
  }

  /**
   * True while a turn is in flight — including steered messages the CLI may
   * still run as a follow-up turn after the current one resolves.
   */
  isBusy(): boolean {
    return this.currentRequest !== null || this.mergedRequests.length > 0 || this.pendingSteers.length > 0;
  }

  /**
   * Claim an SDK-initiated (unowned) turn for the session's default delivery
   * target, synchronously.
   *
   * SYNCHRONOUS IS THE POINT. The check and the assignment happen in one step
   * with no await between them, so this can never interleave with the
   * check-and-claim in `acquireTurn` — whichever runs first wins and the other
   * observes a busy session. That is half of "wait for idle then claim is
   * atomic"; the other half is the loop in `acquireTurn`.
   *
   * Called on the FIRST event of an unowned turn whatever that event carries —
   * a root `tool_use` claims exactly like text does. It used to claim only on
   * `text`/`thinking`, which left a tool-first autonomous turn invisible to
   * `isBusy()`: a heartbeat, cron or user `send()` sailed through
   * `waitForIdle()`, took `currentRequest` for itself and cleared `parts`, and
   * the unowned turn's later text then flowed out through the WRONG turn's
   * sink.
   */
  private claimUnownedTurn(reason: string): TurnRequest | null {
    if (this.currentRequest) return this.currentRequest;
    const req = this.unownedTurnFactory?.();
    if (!req) return null;
    this.currentRequest = req;
    this.unownedTurnDropLogged = false;
    this.refreshActivityTimeout();
    log.info({ session: this.sessionKey, reason }, "Routing unowned SDK turn to default delivery target");
    return req;
  }

  /**
   * Claim an unowned turn from its first assistant event, labelling the claim
   * with the kind of block that opened it.
   *
   * The label is not decoration. On 2026-08-28 a DM reply the owner never
   * received was traced to `reason: "assistant_thinking"` in the log: the model
   * had written its answer inside a `thinking` block, and with `showThinking`
   * off that block was dropped. Nothing was broken and nothing was logged above
   * info — the reply simply did not exist as far as delivery was concerned, and
   * it took a log forensics pass to establish that. So an unowned turn that
   * opens with a thinking block the flag would hide is a warn, with the length
   * that made it worth noticing.
   *
   * The warn stays now that a NON-EMPTY such block is routed as text
   * (renderBlock): this is still a shape worth seeing in the log, and the
   * message says which of the two outcomes happened. Nothing about the claim
   * itself depends on the block's content — `shipBlock` decides delivery, as
   * it does for every other block.
   */
  private claimFirstUnownedEvent(content: unknown[]): void {
    let reason = "assistant_event";
    let openedWithHiddenThinking = false;
    let chars = 0;
    for (const block of content) {
      if (isTextBlock(block)) { reason = "assistant_text"; break; }
      if (isThinkingBlock(block)) {
        reason = "assistant_thinking";
        openedWithHiddenThinking = !this.showThinking;
        // TRIMMED, because that is the length the delivery rule reads: a
        // whitespace-only block is the `omitted` residue and delivers nothing,
        // and the warn must not claim otherwise.
        chars = block.thinking.trim().length;
        break;
      }
      if (isToolUseBlock(block)) { reason = "assistant_tool_use"; break; }
    }

    this.claimUnownedTurn(reason);

    if (openedWithHiddenThinking) {
      log.warn(
        { session: this.sessionKey, chars },
        chars > 0
          ? "Unowned SDK turn opened with a thinking block (showThinking off); routing it as text"
          : "Unowned SDK turn opened with an empty thinking block (showThinking off); nothing to route",
      );
    }
  }

  /**
   * Hand one completed content block to the turn's delivery sink.
   *
   * Awaited by the event loop, which is what keeps blocks in model order: the
   * next SDK event is not pulled until this one has shipped. A send that fails
   * is logged and swallowed — a dead channel must not abort a turn that is
   * still doing useful work.
   *
   * INACTIVITY ACCOUNTING IS SUSPENDED FOR THE DURATION OF THE SEND.
   *
   * The inactivity timer exists to notice a MODEL that has stopped producing.
   * A slow channel is not that, but it used to look exactly like it: the timer
   * was refreshed on the event that carried this block and then we sat in
   * `await onBlock`, unable to refresh again, because refreshes only happen
   * when we consume an SDK event and we are no longer consuming any. Real
   * events kept arriving and piling up in the SDK's own queue, invisible to
   * the timer. A wedged iMessage send therefore ran the clock down on a
   * perfectly healthy turn and killed the session — the owner got his late
   * block AND a spurious timeout error.
   *
   * So the timer is disarmed before the await and re-armed after, and delivery
   * gets its own, much shorter budget instead. A block that blows that budget
   * is abandoned: logged, reported to the sink as abandoned, turn continues.
   * The turn is never killed for it.
   *
   * ABANDONMENT IS DECIDED HERE, NOT DEFERRED TO THE LATE PROMISE. The promise
   * is left running because there is no cancellation to hand a channel, but the
   * block's OUTCOME OF RECORD is settled the moment we give up on it — the sink
   * is told (`onBlockAbandoned`) before the next block is handed over. Letting
   * the late promise write the outcome instead is what let block B's transcript
   * entry overtake block A's, or made A's vanish entirely when its send never
   * settled at all.
   */
  private async shipBlock(block: ResponseBlock): Promise<void> {
    // A scaffold leak is reported once per turn at `result`, over the same
    // per-block filter — not logged again here.
    const rendered = renderBlock(block, this.showThinking);
    if (rendered.kind !== "ship") return;

    const req = this.currentRequest;
    const onBlock = req?.onBlock;
    if (!req || !onBlock) {
      if (!this.unownedTurnDropLogged) {
        this.unownedTurnDropLogged = true;
        // ERROR, not warn: this is the one path on which a block the model
        // actually wrote reaches nobody and is never retried. Silent loss of
        // the owner's reply is the worst failure this subsystem has, so it must
        // not sit at a level that routine log reading skips. Latched to once
        // per turn so a chatty orphan turn cannot flood the log. Logged HERE,
        // at the drop, rather than at claim time: a turn that claims nothing
        // because it opened with a tool call has lost no content yet.
        log.error(
          { session: this.sessionKey },
          "Unowned SDK turn has no default delivery target; DROPPING the content block",
        );
      }
      return;
    }

    if (block.type === "thinking" && !this.showThinking) {
      // WARN, once per block, and only once we have a sink to hand it to —
      // the drop path above logs its own error and must not be preceded by a
      // line claiming delivery. Nothing is broken here; this is the specified
      // handling. But the model put a message where messages are not supposed
      // to be, and the rate at which that happens is the only signal that
      // would tell us this rule has stopped being the right one. Empty
      // thinking blocks (the overwhelming majority under `omitted`) never
      // reach this point, so it cannot flood the log. `chars` is the rendered
      // length, so it matches the message as the transcript records it.
      // Caveat: a suppressed turn's sink drops the block after this line —
      // suppression is a property of the TURN and is decided there.
      log.warn(
        { session: this.sessionKey, chars: rendered.text.length },
        "thinking block routed as text (showThinking off)",
      );
    }

    const outstanding: OutstandingDelivery = { req, abandoned: false };
    this.outstandingDelivery = outstanding;
    this.deliverySuspensions++;
    this.clearActivityTimeout();
    try {
      await withDeliveryTimeout(
        Promise.resolve(onBlock(rendered.text)),
        DELIVERY_TIMEOUT_MS,
        `Block delivery timed out after ${formatTimeout(DELIVERY_TIMEOUT_MS)}`,
      );
    } catch (err) {
      log.error({ err, session: this.sessionKey }, "Per-block delivery failed");
      this.abandonDelivery(outstanding);
    } finally {
      if (this.outstandingDelivery === outstanding) this.outstandingDelivery = null;
      this.deliverySuspensions--;
      // Back on the clock, with a FULL window: the turn has been making
      // progress the whole time, it was only our accounting that was paused.
      this.refreshActivityTimeout();
    }
  }

  /**
   * Report this block to the sink as given up on, exactly once. The send
   * itself keeps running — there is no cancellation to hand a channel — but
   * its OUTCOME OF RECORD is settled here, in order, at the moment we stop
   * treating it as pending.
   */
  private abandonDelivery(outstanding: OutstandingDelivery): void {
    if (outstanding.abandoned) return;
    outstanding.abandoned = true;
    outstanding.req.onBlockAbandoned?.();
  }

  private async handleEvent(event: SDKMessage): Promise<void> {
    this.refreshActivityTimeout();

    // Events originating inside a subagent (Agent tool) carry
    // parent_tool_use_id. They must never reach the channel-facing callbacks:
    // the subagent's interim narration would ship to the user as Tomo's own
    // words mid-turn, and its text would pollute `parts` (so it could also
    // surface in the final response — or be silently dropped, depending on
    // whether a request happened to be in flight when the block arrived).
    // The subagent's outcome reaches the user when the main agent folds the
    // Agent tool result into its own reply.
    const parentToolUseId = (event as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    if (parentToolUseId) {
      this.logSubagentEvent(event, this.subagentTypeById.get(parentToolUseId) ?? "subagent");
      return;
    }

    // An `assistant` event carries COMPLETE content blocks. There are no
    // deltas to reassemble (#292 removed streaming), so this is the earliest
    // moment a block is finished and can ship. Waiting for `result` instead is
    // what left the owner unanswered for the length of a turn.
    //
    // WHAT AWAITING shipBlock DOES AND DOES NOT BUY US. It orders our own
    // sends: the next SDK event is not handled until this block has reached
    // the channel, so blocks arrive in model order. It does NOT hold back the
    // CLI. `Query.readMessages()` (SDK 0.3.246) drains the transport into an
    // internal queue on its own schedule, independent of how fast we consume
    // it — so by the time block A is on the owner's phone the CLI has very
    // likely already started, and may already have finished, the tool_use that
    // A precedes. Blocking the CLI is not something this layer can do and is
    // not what the feature needs: the requirement is "my text reaches him
    // while the turn is still running", which is exactly what awaiting here
    // delivers.
    if (event.type === "assistant" && event.message?.content) {
      // CLAIM ON THE FIRST EVENT OF THE TURN, WHATEVER IT CARRIES.
      //
      // An assistant event with no owner is an SDK-initiated (autonomous /
      // task-notification) turn, and it is in flight from this instant — even
      // when its first event is only a root `tool_use` and the text comes
      // minutes later. Claiming here is what makes `isBusy()` true for the
      // whole of such a turn, so a heartbeat, cron or user `send()` queues
      // behind it instead of stealing `currentRequest` (and clearing `parts`)
      // out from under it and receiving its text in the wrong sink.
      if (!this.currentRequest) this.claimFirstUnownedEvent(event.message.content);

      for (const block of event.message.content) {
        if (isTextBlock(block)) {
          this.parts.push({ type: "text", text: block.text });
          await this.shipBlock({ type: "text", text: block.text });
        } else if (isThinkingBlock(block)) {
          // Kept as a typed block; whether it reaches the channel is decided
          // by renderBlock from the TYPE, never from the text.
          // `redacted_thinking` carries no readable text and never gets here.
          this.parts.push({ type: "thinking", text: block.thinking });
          await this.shipBlock({ type: "thinking", text: block.thinking });
        } else if (isToolUseBlock(block)) {
          if (block.id) this.pendingToolNames.set(block.id, block.name);
          if (block.id && (block.name === "Agent" || block.name === "Task")) {
            const subType = (block.input as { subagent_type?: string } | undefined)?.subagent_type;
            if (subType) this.subagentTypeById.set(block.id, subType);
          }
          log.info({ tool: block.name }, summarizeToolInput(block.name, block.input));
          this.publishToolStart(block);
        }
      }
    }

    if (event.type === "user" && event.message?.content && (event as { isReplay?: boolean }).isReplay === true) {
      this.matchSteerEchoes(event.message.content);
    }

    if (event.type === "user" && event.message?.content && Array.isArray(event.message.content)) {
      this.logToolResults(event.message.content);
    }

    if (event.type === "system" && (event as { subtype?: string }).subtype === "compact_boundary") {
      const compact = event as { compact_metadata?: { pre_tokens?: number; post_tokens?: number } };
      log.info(
        { pre: compact.compact_metadata?.pre_tokens, post: compact.compact_metadata?.post_tokens },
        "Context compacted",
      );
      watchBus.publish({
        type: "compact",
        ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
        preTokens: compact.compact_metadata?.pre_tokens,
        postTokens: compact.compact_metadata?.post_tokens,
      });
    }

    if (event.type === "tool_use_summary") {
      log.debug((event as { summary: string }).summary);
    }

    if (event.type === "result") {
      const result = event as unknown as SdkResultLike;

      if (result.session_id) {
        this.sessionId = result.session_id;
      }

      // Token accounting. `usage` is the MAIN AGENT LOOP ONLY (per the SDK's
      // own doc comment) — a turn that fans out to subagents undercounts by
      // everything they consumed. `modelUsage` covers the whole query
      // pipeline but is cumulative across turns in a streaming-input session,
      // so it is differenced against the previous result, like the cost.
      const { input, output, cacheRead, cacheCreated } = this.turnTokenUsage(result);

      // Per-turn cost as the delta from the cumulative total. A total that
      // went BACKWARDS is a reset, not a refund — crash results carry zeroed
      // totals and a mid-session /clear restarts the running sum — so the
      // cumulative value is then this turn's own; never persist a negative.
      const totalCost = result.total_cost_usd ?? 0;
      const turnCost = totalCost >= this.prevTotalCost ? totalCost - this.prevTotalCost : totalCost;
      this.prevTotalCost = totalCost;

      // A NON-SUCCESS RESULT IS STILL THE END OF THE TURN — but not a
      // successful one. `subtype` names why the CLI stopped early (max turns,
      // budget, an execution error); `is_error` on a `success` result marks a
      // turn that ended on an API error, with the error text in `result`.
      // Neither throws: the SDK yields these like any other result, so
      // without this branch they resolved as ordinary turns — the owner got
      // partial text or the generic "I'm not sure how to respond to that.",
      // cron recorded a clean run, and nothing was logged.
      const failure = describeResultFailure(result);
      if (failure) {
        log.warn(
          { session: this.sessionKey, subtype: result.subtype, errors: result.errors, turns: result.num_turns },
          "SDK turn ended on an error result",
        );
      }

      // Store result stats, get context usage, then resolve
      this.lastResult = {
        costUsd: turnCost,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreated,
        contextUsed: 0,
        contextMax: 0,
      };

      // Await context usage before resolving so stats are complete
      await this.logContextUsage(result, turnCost, totalCost, input, output, cacheRead, cacheCreated);

      // The turn is over. Its blocks have ALREADY shipped, one by one, as they
      // completed; what is assembled here is only the response string — the
      // transcript, the log line, and the value send()/steer() resolve with.
      const rendered = renderResponseBlocks(this.parts, this.showThinking);
      if (rendered.scaffoldFiltered) {
        log.warn({ sessionKey: this.sessionKey }, "model scaffold leak filtered");
      }
      const response = rendered.text || "I'm not sure how to respond to that.";
      this.parts = [];
      this.unownedTurnDropLogged = false;
      const req = this.currentRequest;
      if (this.pendingSteers.length === 0) this.clearActivityTimeout();
      // A failed turn REJECTS its owner (blocks already shipped stay shipped;
      // the sink flushes their transcript slots on the rejection path) rather
      // than resolving with a note the block sink would deliver as if the
      // model had said it — bypassing the turn's error policy and reporting
      // a clean run to cron.
      if (failure) await req?.reject(failure);
      else await req?.resolve(response);
      for (const m of this.mergedRequests) await m.resolve(STEER_MERGED);
      this.mergedRequests = [];
      this.currentRequest = null;
      this.promotedSteerText = null;

      if (this.pendingSteers.length > 0) {
        // Steered messages that missed this turn's tool boundaries were
        // queued by the CLI and run next. Promote only the FIRST as the
        // next turn's owner (it resolves with that turn's response); the rest
        // stay pending — if the CLI batches them into the promoted turn we
        // detect it via replay echoes (see matchSteerEchoes), otherwise
        // they're promoted in order by subsequent results.
        const [first, ...rest] = this.pendingSteers;
        this.pendingSteers = rest;
        this.currentRequest = first.req;
        this.promotedSteerText = first.text;
      } else {
        this.clearActivityTimeout();
        this.notifyIdle();
      }
    }
  }

  /**
   * Observability-only path for subagent events (parent_tool_use_id set):
   * log tool activity so subagent work shows up in the logs, but never touch
   * turn state (parts) or the owning request.
   */
  private logSubagentEvent(event: SDKMessage, agentName: string): void {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (isToolUseBlock(block)) {
          if (block.id) this.pendingToolNames.set(block.id, block.name);
          // A subagent can itself spawn a subagent — track the nested
          // Agent/Task id so its descendants log the right agent name too.
          if (block.id && (block.name === "Agent" || block.name === "Task")) {
            const subType = (block.input as { subagent_type?: string } | undefined)?.subagent_type;
            if (subType) this.subagentTypeById.set(block.id, subType);
          }
          log.info({ tool: block.name, agent: agentName }, summarizeToolInput(block.name, block.input));
          this.publishToolStart(block, agentName);
        }
      }
    }
    if (event.type === "user" && event.message?.content && Array.isArray(event.message.content)) {
      this.logToolResults(event.message.content, agentName);
    }
  }

  private publishToolStart(
    block: { id?: string; name: string; input?: Record<string, unknown> },
    agent?: string,
  ): void {
    if (block.id) this.pendingToolStarts.set(block.id, Date.now());
    watchBus.publish({
      type: "tool.start",
      ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
      tool: block.name,
      ...(agent ? { agent } : {}),
      detail: clip(summarizeToolInput(block.name, block.input), TOOL_DETAIL_LIMIT),
    });
  }

  private logToolResults(content: unknown[], agent?: string): void {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
        const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
        const name = tr.tool_use_id ? this.pendingToolNames.get(tr.tool_use_id) : undefined;
        const startedAt = tr.tool_use_id ? this.pendingToolStarts.get(tr.tool_use_id) : undefined;
        if (tr.tool_use_id) {
          this.pendingToolNames.delete(tr.tool_use_id);
          this.pendingToolStarts.delete(tr.tool_use_id);
          this.subagentTypeById.delete(tr.tool_use_id);
        }
        log.info(
          { tool: name ?? "?", ...(tr.is_error ? { is_error: true } : {}), ...(agent ? { agent } : {}) },
          `${tr.is_error ? "[ERR] " : ""}${name ?? "?"} result: ${summarizeToolResult(tr.content)}`,
        );
        watchBus.publish({
          type: "tool.end",
          ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
          tool: name ?? "?",
          ok: !tr.is_error,
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
          ...(agent ? { agent } : {}),
        });
      }
    }
  }

  /**
   * Steered-message bookkeeping from the CLI's replay events (requires the
   * --replay-user-messages flag, passed via extraArgs when config.steering
   * is on; non-replay user events never carry steered text verbatim, so
   * matching is restricted to isReplay events to avoid false positives).
   * Two shapes appear:
   *   - A pending steer's text echoed mid-turn → the CLI injected it into
   *     the in-flight turn at a tool boundary; fold it into this turn.
   *   - The promoted steer's own text echoed at its turn's start → the CLI
   *     batched the remaining queued steers into that promoted turn.
   */
  private matchSteerEchoes(content: unknown): void {
    if (this.pendingSteers.length === 0) return;

    const texts: string[] = [];
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isTextBlock(block)) texts.push(block.text);
      }
    }

    for (const text of texts) {
      if (this.promotedSteerText !== null && text === this.promotedSteerText) {
        log.info(
          { session: this.sessionKey, count: this.pendingSteers.length },
          "Queued steered messages batched into the promoted turn",
        );
        this.mergedRequests.push(...this.pendingSteers.map((e) => e.req));
        this.pendingSteers = [];
        return;
      }
      const idx = this.pendingSteers.findIndex((e) => e.text === text);
      if (idx !== -1) {
        const [entry] = this.pendingSteers.splice(idx, 1);
        this.mergedRequests.push(entry.req);
        log.info({ session: this.sessionKey }, "Steered message joined the in-flight turn");
      }
    }
  }

  /**
   * Per-turn token counts for this result. Prefers `modelUsage` (whole query
   * pipeline, cumulative — differenced against the previous result) and
   * falls back to `usage` (main loop only, already per-turn) when a result
   * carries no `modelUsage` (older CLIs, crash results with zeroed totals).
   */
  private turnTokenUsage(result: SdkResultLike): TokenTotals {
    const models = result.modelUsage ? Object.values(result.modelUsage) : [];
    if (models.length > 0) {
      const cumulative = models.reduce<TokenTotals>((acc, m) => ({
        input: acc.input + (m.inputTokens ?? 0),
        output: acc.output + (m.outputTokens ?? 0),
        cacheRead: acc.cacheRead + (m.cacheReadInputTokens ?? 0),
        cacheCreated: acc.cacheCreated + (m.cacheCreationInputTokens ?? 0),
      }), { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 });
      const prev = this.prevModelTokens;
      this.prevModelTokens = cumulative;
      // A counter that went backwards means the CLI reset its totals (a
      // resume, a /clear); the cumulative value is then this turn's own.
      const delta = (now: number, before: number) => (now >= before ? now - before : now);
      return prev
        ? {
          input: delta(cumulative.input, prev.input),
          output: delta(cumulative.output, prev.output),
          cacheRead: delta(cumulative.cacheRead, prev.cacheRead),
          cacheCreated: delta(cumulative.cacheCreated, prev.cacheCreated),
        }
        : cumulative;
    }
    const u = result.usage as Record<string, number> | undefined;
    return {
      input: u?.input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheCreated: u?.cache_creation_input_tokens ?? 0,
    };
  }

  private async logContextUsage(
    result: { subtype: string; num_turns?: number; duration_ms?: number },
    turnCost: number, totalCost: number,
    input: number, output: number, cacheRead: number, cacheCreated: number,
  ): Promise<void> {
    const contextInfo = await (async () => {
      try {
        const ctx = await this.q.getContextUsage();
        const pct = Math.round(ctx.percentage);
        if (this.lastResult) {
          this.lastResult.contextUsed = ctx.totalTokens;
          this.lastResult.contextMax = ctx.maxTokens;
          this.lastResult.contextBreakdown = ctx.categories
            .filter((c) => c.tokens > 0)
            .map((c) => ({ name: c.name, tokens: c.tokens }));
        }
        if (pct >= 80) {
          log.warn({ used: ctx.totalTokens, max: ctx.maxTokens, pct: `${pct}%` }, "Context nearing compaction");
        }
        return `${ctx.totalTokens}/${ctx.maxTokens} (${pct}%)`;
      } catch {
        const approx = input + cacheRead + cacheCreated;
        if (this.lastResult) {
          this.lastResult.contextUsed = approx;
          this.lastResult.contextMax = 1_000_000;
        }
        return `~${approx}/1000000`;
      }
    })();

    log.info(
      {
        session: this.sessionKey,
        turns: result.num_turns,
        duration: `${result.duration_ms}ms`,
        cost: `$${turnCost.toFixed(4)}`,
        totalCost: `$${totalCost.toFixed(4)}`,
        tokens: `in:${input} out:${output}`,
        cache: `read:${cacheRead} created:${cacheCreated}`,
        context: contextInfo,
      },
      "Run completed (%s)", result.subtype,
    );
  }

  /**
   * Serialize the whole "wait for idle, then claim" sequence.
   *
   * Held only until the claim is made, never for the length of the turn, so a
   * second caller enters the section and starts its own wait as soon as the
   * first has dispatched. Nothing on the event-loop side takes this lock —
   * `claimUnownedTurn` is synchronous — so the section can never be waiting on
   * a turn that is waiting on it.
   */
  private claimLock: Promise<void> = Promise.resolve();

  private async withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.claimLock;
    let release!: () => void;
    this.claimLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Take ownership of the next turn for `req` and dispatch it.
   *
   * ATOMIC CHECK-AND-CLAIM. `await waitForIdle(); this.currentRequest = req;`
   * was not: two woken waiters both observed an idle session and both claimed
   * (the second silently clearing the first's `parts`), and an unowned turn
   * could claim in the window between the wait resolving and the assignment,
   * after which the turn's text left through the wrong sink. Here the busy
   * check and the assignment are in ONE synchronous step with no await between
   * them, re-tested after every wake, so exactly one claimant can win — against
   * another `send()` and against `claimUnownedTurn` alike. The lock around it
   * keeps waiters in arrival order rather than letting them race on wake.
   */
  private async acquireTurn(req: MessageRequest): Promise<void> {
    await this.withClaimLock(async () => {
      for (;;) {
        if (!this.alive) throw new Error("Session is closed");
        if (!this.isBusy()) {
          // Fresh maxTurns budget per user message — warnings fire once per
          // send(), and it is reset when the turn actually starts rather than
          // when the caller began waiting for it.
          if (this.turnBudget) resetTurnBudget(this.turnBudget);
          this.currentRequest = req;
          this.parts = [];
          this.refreshActivityTimeout();
          this.pushInput(req.message);
          return;
        }
        // Steered messages can keep the session busy past the turn that the
        // agent-level queue serialized against (they may run as a follow-up
        // turn), so wait for true idleness before dispatching.
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      }
    });
  }

  async send(
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
    onBlock?: (block: string) => void | Promise<void>,
    onBlockAbandoned?: () => void,
    origin?: SDKMessageOrigin,
  ): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");

    const content = buildContentBlocks(text, images, documents);

    return new Promise<string>((resolve, reject) => {
      const req: MessageRequest = {
        message: {
          type: "user",
          message: { role: "user", content: content as never },
          parent_tool_use_id: null,
          // Provenance. The SDK treats an absent origin as unattributed and
          // fails closed at its strict isHuman() gates, so a host relaying a
          // person's message must stamp {kind:"human"} explicitly; harness
          // turns (cron, continuity) carry their own kind. Omitted when the
          // caller gives none, which keeps the unattributed behaviour.
          ...(origin ? { origin } : {}),
        },
        resolve,
        reject,
        ...(onBlock ? { onBlock } : {}),
        ...(onBlockAbandoned ? { onBlockAbandoned } : {}),
      };
      // Rejects only if the session dies before the claim; once claimed, the
      // turn's own resolve/reject settle this promise.
      this.acquireTurn(req).catch(reject);
    });
  }

  /**
   * Inject a message into the in-flight turn instead of waiting behind it
   * (config `steering`). The CLI delivers it at the next tool-call boundary;
   * if the turn has no boundary left, the CLI queues it and runs it as the
   * next turn. Resolution:
   *   - merged into the in-flight turn → resolves with STEER_MERGED; the
   *     turn's owner request resolves with the combined response.
   *   - ran as its own follow-up turn → resolves with that turn's response.
   * Falls back to a plain send() when no turn is in flight.
   */
  async steer(
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
    onBlock?: (block: string) => void | Promise<void>,
    onBlockAbandoned?: () => void,
    origin?: SDKMessageOrigin,
  ): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");
    if (!this.isBusy()) return this.send(text, images, documents, onBlock, onBlockAbandoned, origin);

    // New instructions arrived — refresh the turn budget like any user message.
    if (this.turnBudget) resetTurnBudget(this.turnBudget);

    const content = buildContentBlocks(text, images, documents);

    return new Promise<string>((resolve, reject) => {
      const req: MessageRequest = {
        // priority "next" is the CLI's default for queued commands; set it
        // explicitly so mid-turn injection (drained at tool boundaries via
        // getCommandsByMaxPriority("next")) doesn't depend on the default.
        message: {
          type: "user",
          message: { role: "user", content: content as never },
          parent_tool_use_id: null,
          priority: "next",
          ...(origin ? { origin } : {}),
        },
        resolve,
        reject,
        ...(onBlock ? { onBlock } : {}),
        ...(onBlockAbandoned ? { onBlockAbandoned } : {}),
      };
      this.pendingSteers.push({ req, text });
      this.pushInput(req.message);
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  /** Replace the live query's complete dynamic MCP set when the SDK supports it. */
  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult | null> {
    const runtimeQuery = this.q as unknown as {
      setMcpServers?: (next: Record<string, McpServerConfig>) => Promise<McpSetServersResult>;
    };
    if (typeof runtimeQuery.setMcpServers !== "function") return null;
    return runtimeQuery.setMcpServers.call(this.q, servers);
  }

  /**
   * Retire the session. Everything here is SYNCHRONOUS on purpose: shutdown
   * has a few seconds at most, and both of the things that used to be left
   * asynchronous cost the owner transcript entries.
   *
   * OPEN DELIVERY, ABANDONED HERE. A block whose send is still outstanding
   * holds an open transcript slot, and every slot behind it. Waiting for the
   * 60s delivery budget to expire (it is the only other thing that closes the
   * slot) means the flush that follows shutdown finds it still dangling. So we
   * give up on it now, in order, before anything else can be dispatched.
   *
   * IN-FLIGHT TURN, REJECTED HERE. `consumeEvents` also rejects it, but only
   * once the SDK's async iterator has actually ended — and it cannot end while
   * the event loop is parked in `await onBlock` on a wedged send. That left
   * the owner's turn pending for a full delivery budget after the daemon had
   * decided to exit, which is exactly the window shutdown does not have.
   */
  close(): void {
    this.alive = false;
    if (this.outstandingDelivery) this.abandonDelivery(this.outstandingDelivery);
    this.inputWaiter?.();
    this.q.close();
    this.failTurn(new Error("Session is closed"));
  }
}
