import { query, type Query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { resetTurnBudget, type TurnBudget, type sdkOptions } from "./sdk-options.js";

export interface MessageRequest {
  message: SDKUserMessage;
  /** Called for each text-delta as it streams (cumulative running text). */
  onText?: (text: string) => void;
  /**
   * Called once per text block when an `assistant` event arrives, after the
   * block's deltas have all been streamed. Receives the block's full text.
   * Channels can use this to seal the in-flight streamed message and start
   * fresh on the next block, so multi-block turns ship as multiple messages
   * instead of a single edit-in-place that drops earlier blocks.
   */
  onBlockComplete?: (text: string) => void | Promise<void>;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

/**
 * Sentinel resolution for a steered message that merged into the in-flight
 * turn: that turn's owner request receives (and delivers) the combined
 * response, so the steered caller gets this empty marker instead. The empty
 * string is safe as a sentinel only because send()/steer() can never
 * legitimately resolve with "" — empty turns fall back to "I'm not sure how
 * to respond to that." in the result handler.
 */
export const STEER_MERGED = "";

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()/steer()

export interface QueryResult {
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
    default: return `${name}: ${JSON.stringify(input).slice(0, 500)}`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return isObject(block) && block.type === "text" && typeof block.text === "string";
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
  // stream and it resolves with the turn's full response.
  private currentRequest: MessageRequest | null = null;
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
  private parts: string[] = [];
  private streamingText = "";
  private sessionId: string | null = null;
  private alive = true;
  lastResult: QueryResult | null = null;
  private prevTotalCost = 0;
  private eventLoopDone: Promise<void>;
  private sessionKey: string | undefined;
  private turnBudget: TurnBudget | undefined;
  // Maps tool_use_id → tool name so we can label tool_result log lines
  // (the result event only carries the use id, not the original name).
  private pendingToolNames = new Map<string, string>();
  private activeStreamBlockTypes = new Map<number, string>();

  constructor(options: ReturnType<typeof sdkOptions>, sessionKey?: string, turnBudget?: TurnBudget) {
    this.sessionKey = sessionKey;
    this.turnBudget = turnBudget;
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
    const requests: MessageRequest[] = [];
    if (this.currentRequest) requests.push(this.currentRequest);
    requests.push(...this.mergedRequests, ...this.pendingSteers.map((e) => e.req));
    this.currentRequest = null;
    this.mergedRequests = [];
    this.pendingSteers = [];
    this.promotedSteerText = null;
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

  /**
   * True while a turn is in flight — including steered messages the CLI may
   * still run as a follow-up turn after the current one resolves.
   */
  isBusy(): boolean {
    return this.currentRequest !== null || this.mergedRequests.length > 0 || this.pendingSteers.length > 0;
  }

  private async handleEvent(event: SDKMessage): Promise<void> {
    const req = this.currentRequest;

    if (event.type === "stream_event") {
      const se = event as unknown as {
        event?: {
          type: string;
          index?: number;
          content_block?: { type?: string };
          delta?: { type: string; text?: string };
        };
      };
      const streamEvent = se.event;

      if (streamEvent?.type === "content_block_start" && typeof streamEvent.index === "number") {
        const blockType = streamEvent.content_block?.type;
        if (blockType) this.activeStreamBlockTypes.set(streamEvent.index, blockType);
      }

      if (streamEvent?.type === "content_block_delta" && streamEvent.delta?.type === "text_delta" && streamEvent.delta.text) {
        const blockType = typeof streamEvent.index === "number"
          ? this.activeStreamBlockTypes.get(streamEvent.index)
          : undefined;
        if (blockType === "text") {
          this.streamingText += streamEvent.delta.text;
          req?.onText?.(this.streamingText);
        }
      }

      if (streamEvent?.type === "content_block_stop" && typeof streamEvent.index === "number") {
        this.activeStreamBlockTypes.delete(streamEvent.index);
      } else if (streamEvent?.type === "message_start" || streamEvent?.type === "message_stop") {
        this.activeStreamBlockTypes.clear();
      }
    }

    if (event.type === "assistant" && event.message?.content) {
      const hadStreamDeltas = this.streamingText.length > 0;
      this.streamingText = "";
      for (const block of event.message.content) {
        if (isTextBlock(block)) {
          this.parts.push(block.text);
          // Some SDK-originated errors arrive as an assistant text block
          // without preceding stream deltas. Push the full block into the
          // channel stream before sealing it so the user sees the message.
          if (!hadStreamDeltas) req?.onText?.(block.text);
          // Signal block boundary so channels can seal the streamed message
          // and start fresh on the next block (text → tool → text turns).
          if (req?.onBlockComplete) {
            await req.onBlockComplete(block.text);
          }
        } else if (isToolUseBlock(block)) {
          if (block.id) this.pendingToolNames.set(block.id, block.name);
          log.info({ tool: block.name }, summarizeToolInput(block.name, block.input));
        }
      }
    }

    if (event.type === "user" && event.message?.content && (event as { isReplay?: boolean }).isReplay === true) {
      this.matchSteerEchoes(event.message.content);
    }

    if (event.type === "user" && event.message?.content && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block && typeof block === "object" && "type" in block && block.type === "tool_result") {
          const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          const name = tr.tool_use_id ? this.pendingToolNames.get(tr.tool_use_id) : undefined;
          if (tr.tool_use_id) this.pendingToolNames.delete(tr.tool_use_id);
          log.info(
            { tool: name ?? "?", is_error: tr.is_error ?? false },
            `result: ${summarizeToolResult(tr.content)}`,
          );
        }
      }
    }

    if (event.type === "system" && (event as { subtype?: string }).subtype === "compact_boundary") {
      const compact = event as { compact_metadata?: { pre_tokens?: number; post_tokens?: number } };
      log.info(
        { pre: compact.compact_metadata?.pre_tokens, post: compact.compact_metadata?.post_tokens },
        "Context compacted",
      );
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
        costUsd: totalCost,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreated,
        contextUsed: 0,
        contextMax: 0,
      };

      // Await context usage before resolving so stats are complete
      await this.logContextUsage(result, turnCost, totalCost, input, output, cacheRead, cacheCreated);

      // Trim each block; drop empty ones; rejoin for the response string
      // returned to callers (used for transcript storage and logging).
      // Per-block delivery happens during the stream via `onBlockComplete`,
      // not from this final snapshot.
      const trimmed = this.parts.map((p) => p.trim()).filter((p) => p.length > 0);
      const response = trimmed.join("\n").trim() || "I'm not sure how to respond to that.";
      this.parts = [];
      this.streamingText = "";
      this.activeStreamBlockTypes.clear();
      req?.resolve(response);
      for (const m of this.mergedRequests) m.resolve(STEER_MERGED);
      this.mergedRequests = [];
      this.currentRequest = null;
      this.promotedSteerText = null;

      if (this.pendingSteers.length > 0) {
        // Steered messages that missed this turn's tool boundaries were
        // queued by the CLI and run next. Promote only the FIRST as the
        // next turn's owner (its callbacks receive the stream); the rest
        // stay pending — if the CLI batches them into the promoted turn we
        // detect it via replay echoes (see matchSteerEchoes), otherwise
        // they're promoted in order by subsequent results.
        const [first, ...rest] = this.pendingSteers;
        this.pendingSteers = rest;
        this.currentRequest = first.req;
        this.promotedSteerText = first.text;
      } else {
        this.notifyIdle();
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
   *     batched ALL remaining queued steers into that turn. (The batch echo
   *     skips its last member, so the members can't each be matched
   *     individually — the promoted owner's echo is the reliable signal.)
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
    onText?: (text: string) => void,
    images?: Array<{ data: string; mediaType: string }>,
    onBlockComplete?: (text: string) => void | Promise<void>,
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
      const timer = setTimeout(() => {
        this.failTurn(new Error("Query timed out after 10 minutes"));
      }, TIMEOUT_MS);

      const wrappedResolve = (val: string) => { clearTimeout(timer); resolve(val); };
      const wrappedReject = (err: Error) => { clearTimeout(timer); reject(err); };

      this.currentRequest = {
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null },
        onText,
        onBlockComplete,
        resolve: wrappedResolve,
        reject: wrappedReject,
      };
      this.parts = [];
      this.streamingText = "";
      this.activeStreamBlockTypes.clear();
      this.pushInput(this.currentRequest.message);
    });
  }

  /**
   * Inject a message into the in-flight turn instead of waiting behind it
   * (config `steering`). The CLI delivers it at the next tool-call boundary;
   * if the turn has no boundary left, the CLI queues it and runs it as the
   * next turn. Resolution:
   *   - merged into the in-flight turn → resolves with STEER_MERGED; the
   *     turn's owner request streams and resolves the combined response.
   *   - ran as its own follow-up turn → resolves with that turn's response,
   *     streamed through the callbacks passed here.
   * Falls back to a plain send() when no turn is in flight.
   */
  async steer(
    text: string,
    onText?: (text: string) => void,
    images?: Array<{ data: string; mediaType: string }>,
    onBlockComplete?: (text: string) => void | Promise<void>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
  ): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");
    if (!this.isBusy()) return this.send(text, onText, images, onBlockComplete, documents);

    // New instructions arrived — refresh the turn budget like any user message.
    if (this.turnBudget) resetTurnBudget(this.turnBudget);

    const content = buildContentBlocks(text, images, documents);

    return new Promise<string>((resolve, reject) => {
      let req: MessageRequest | null = null;
      const timer = setTimeout(() => {
        if (req) this.dropRequest(req, new Error("Query timed out after 10 minutes"));
      }, TIMEOUT_MS);

      req = {
        // priority "next" is the CLI's default for queued commands; set it
        // explicitly so mid-turn injection (drained at tool boundaries via
        // getCommandsByMaxPriority("next")) doesn't depend on the default.
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, priority: "next" },
        onText,
        onBlockComplete,
        resolve: (val: string) => { clearTimeout(timer); resolve(val); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };
      this.pendingSteers.push({ req, text });
      this.pushInput(req.message);
    });
  }

  /**
   * Timeout path for a steered request: detach it from whichever slot it
   * occupies; if it owns the in-flight turn, fail the whole turn.
   */
  private dropRequest(req: MessageRequest, err: Error): void {
    if (this.currentRequest === req) {
      this.failTurn(err);
      return;
    }
    const mi = this.mergedRequests.indexOf(req);
    if (mi !== -1) this.mergedRequests.splice(mi, 1);
    const si = this.pendingSteers.findIndex((e) => e.req === req);
    if (si !== -1) this.pendingSteers.splice(si, 1);
    req.reject(err);
    if (!this.isBusy()) this.notifyIdle();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
    this.inputWaiter?.();
    this.q.close();
  }
}
