import {
  query,
  type McpServerConfig,
  type McpSetServersResult,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { watchBus } from "../watch/bus.js";
import { clip, TOOL_DETAIL_LIMIT } from "../watch/protocol.js";
import { resetTurnBudget, type TurnBudget, type sdkOptions } from "./sdk-options.js";
import { isSilentReply } from "./text-utils.js";

export interface TurnRequest {
  resolve: (response: string) => void | Promise<void>;
  reject: (err: Error) => void | Promise<void>;
}

export interface MessageRequest extends TurnRequest {
  message: SDKUserMessage;
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

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()/steer()

export interface LiveSessionSettings {
  timeoutMs?: number;
  /** Include `thinking` content blocks in the turn response (config.showThinking). */
  showThinking?: boolean;
}

/**
 * Marker prefixed to a thinking block when showThinking is on, so the reader
 * can tell the model's reasoning from its reply. Chosen over a fenced block
 * because chat channels render neither Markdown nor code fences.
 */
export const THINKING_MARKER = "💭 ";

/** An assistant content block worth keeping for the turn response. */
export interface ResponseBlock {
  type: "text" | "thinking";
  text: string;
}

/**
 * Render a turn's collected content blocks into the response string.
 *
 * This is the ONLY place that decides what reaches a channel, and it decides
 * purely on the SDK block `type` — never by inspecting the text. A `text`
 * block is the model's chosen words and always ships, even when it happens to
 * read like reasoning (`思考: ...`) or like tool debris (`count`). A
 * `thinking` block ships only when showThinking is on, marked so it is
 * distinguishable. `redacted_thinking` carries no readable text and is
 * dropped at collection time.
 */
export function renderResponseBlocks(blocks: ResponseBlock[], showThinking: boolean): string {
  const rendered: string[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" && !showThinking) continue;
    const text = block.text.trim();
    if (!text) continue;
    rendered.push(block.type === "thinking" ? `${THINKING_MARKER}${text}` : text);
  }

  // NO_REPLY is Tomo's own control token, not the model's prose, so a block
  // that is nothing but the bare token is protocol rather than content.
  // A block like that MID-turn (the model emitted it between two real blocks)
  // is a slip and is dropped — under per-block delivery the channels dropped
  // it too. A TRAILING one is load-bearing: it marks the whole turn as
  // not-for-the-channel (owner decision 2026-07-08), so exactly one is kept at
  // the end for the delivery layer's trailing-NO_REPLY check to find.
  const endedWithNoReply = rendered.length > 0 && isSilentReply(rendered[rendered.length - 1]);
  const kept = rendered.filter((text) => !isSilentReply(text));
  if (endedWithNoReply) kept.push("NO_REPLY");

  return kept.join("\n").trim();
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
    this.close();
    this.failTurn(err);
  }

  /**
   * True while a turn is in flight — including steered messages the CLI may
   * still run as a follow-up turn after the current one resolves.
   */
  isBusy(): boolean {
    return this.currentRequest !== null || this.mergedRequests.length > 0 || this.pendingSteers.length > 0;
  }

  private claimUnownedTurn(reason: string): TurnRequest | null {
    if (this.currentRequest) return this.currentRequest;
    const req = this.unownedTurnFactory?.();
    if (req) {
      this.currentRequest = req;
      this.unownedTurnDropLogged = false;
      this.refreshActivityTimeout();
      log.info({ session: this.sessionKey, reason }, "Routing unowned SDK turn to default delivery target");
      return req;
    }
    if (!this.unownedTurnDropLogged) {
      this.unownedTurnDropLogged = true;
      log.warn({ session: this.sessionKey, reason }, "Unowned SDK turn has no default delivery target");
    }
    return null;
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

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (isTextBlock(block)) {
          // Claim the turn so an SDK-initiated (unowned) turn still has a
          // request to resolve into at result time. Delivery itself happens
          // once, after the turn completes — nothing ships per block.
          if (!this.currentRequest) this.claimUnownedTurn("assistant_text");
          this.parts.push({ type: "text", text: block.text });
        } else if (isThinkingBlock(block)) {
          // Kept as a typed block; whether it reaches the channel is decided
          // by renderResponseBlocks from the TYPE, never from the text.
          // `redacted_thinking` carries no readable text and never gets here.
          if (!this.currentRequest) this.claimUnownedTurn("assistant_thinking");
          this.parts.push({ type: "thinking", text: block.thinking });
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
      const result = event as unknown as {
        subtype: string;
        num_turns?: number;
        duration_ms?: number;
        total_cost_usd?: number;
        usage?: Record<string, unknown>;
        session_id?: string;
      };

      if (result.session_id) {
        this.sessionId = result.session_id;
      }

      const u = result.usage as Record<string, number> | undefined;
      const input = u?.input_tokens ?? 0;
      const output = u?.output_tokens ?? 0;
      const cacheRead = u?.cache_read_input_tokens ?? 0;
      const cacheCreated = u?.cache_creation_input_tokens ?? 0;

      // Compute per-turn cost as delta from cumulative total
      const totalCost = result.total_cost_usd ?? 0;
      const turnCost = totalCost - this.prevTotalCost;
      this.prevTotalCost = totalCost;

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

      // The turn is over: render its collected content blocks into the one
      // response string callers deliver, transcribe and log. Block TYPE alone
      // decides what is included (see renderResponseBlocks) — the text is
      // never inspected.
      const response = renderResponseBlocks(this.parts, this.showThinking)
        || "I'm not sure how to respond to that.";
      this.parts = [];
      this.unownedTurnDropLogged = false;
      const req = this.currentRequest;
      if (this.pendingSteers.length === 0) this.clearActivityTimeout();
      await req?.resolve(response);
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

  async send(
    text: string,
    images?: Array<{ data: string; mediaType: string }>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
  ): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");

    // Steered messages can keep the session busy past the turn that the
    // agent-level queue serialized against (they may run as a follow-up
    // turn), so wait for true idleness before dispatching.
    await this.waitForIdle();
    if (!this.alive) throw new Error("Session is closed");

    // Fresh maxTurns budget per user message — warnings fire once per send().
    if (this.turnBudget) resetTurnBudget(this.turnBudget);

    const content = buildContentBlocks(text, images, documents);

    return new Promise<string>((resolve, reject) => {
      const req: MessageRequest = {
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null },
        resolve,
        reject,
      };
      this.currentRequest = req;
      this.parts = [];
      this.refreshActivityTimeout();
      this.pushInput(req.message);
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
  ): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");
    if (!this.isBusy()) return this.send(text, images, documents);

    // New instructions arrived — refresh the turn budget like any user message.
    if (this.turnBudget) resetTurnBudget(this.turnBudget);

    const content = buildContentBlocks(text, images, documents);

    return new Promise<string>((resolve, reject) => {
      const req: MessageRequest = {
        // priority "next" is the CLI's default for queued commands; set it
        // explicitly so mid-turn injection (drained at tool boundaries via
        // getCommandsByMaxPriority("next")) doesn't depend on the default.
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, priority: "next" },
        resolve,
        reject,
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

  close(): void {
    this.alive = false;
    this.inputWaiter?.();
    this.q.close();
  }
}
