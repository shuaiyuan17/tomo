import { query, type Query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import type { sdkOptions } from "./sdk-options.js";

export interface MessageRequest {
  message: SDKUserMessage;
  onText?: (text: string) => void;
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

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

export class LiveSession {
  private q: Query;
  private pendingMessage: ((msg: SDKUserMessage) => void) | null = null;
  private currentRequest: MessageRequest | null = null;
  private parts: string[] = [];
  private streamingText = "";
  private sessionId: string | null = null;
  private alive = true;
  lastResult: QueryResult | null = null;
  private prevTotalCost = 0;
  private eventLoopDone: Promise<void>;
  private sessionKey: string | undefined;
  // Maps tool_use_id → tool name so we can label tool_result log lines
  // (the result event only carries the use id, not the original name).
  private pendingToolNames = new Map<string, string>();

  constructor(options: ReturnType<typeof sdkOptions>, sessionKey?: string) {
    this.sessionKey = sessionKey;
    this.q = query({ prompt: this.messageGenerator(), options });
    this.eventLoopDone = this.consumeEvents();
  }

  private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
    while (this.alive) {
      const msg = await new Promise<SDKUserMessage>((resolve) => {
        this.pendingMessage = resolve;
      });
      this.pendingMessage = null;
      yield msg;
    }
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.q) {
        await this.handleEvent(event);
      }
    } catch (err) {
      // If there's a pending request, reject it
      if (this.currentRequest) {
        this.currentRequest.reject(err instanceof Error ? err : new Error(String(err)));
        this.currentRequest = null;
      }
    }
    this.alive = false;
  }

  private async handleEvent(event: SDKMessage): Promise<void> {
    const req = this.currentRequest;

    if (event.type === "stream_event") {
      const se = event as unknown as { event: { type: string; delta?: { type: string; text?: string } } };
      if (se.event?.type === "content_block_delta" && se.event.delta?.type === "text_delta" && se.event.delta.text) {
        this.streamingText += se.event.delta.text;
        req?.onText?.(this.streamingText);
      }
    }

    if (event.type === "assistant" && event.message?.content) {
      this.streamingText = "";
      for (const block of event.message.content) {
        if ("text" in block) {
          this.parts.push(block.text);
        } else if ("type" in block && block.type === "tool_use") {
          const tool = block as { id?: string; name: string; input?: Record<string, unknown> };
          if (tool.id && tool.name) this.pendingToolNames.set(tool.id, tool.name);
          log.info({ tool: tool.name }, summarizeToolInput(tool.name, tool.input));
        }
      }
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

      const response = this.parts.join("\n").trim() || "I'm not sure how to respond to that.";
      this.parts = [];
      this.streamingText = "";
      req?.resolve(response);
      this.currentRequest = null;
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

  async send(text: string, onText?: (text: string) => void, images?: Array<{ data: string; mediaType: string }>): Promise<string> {
    if (!this.alive) throw new Error("Session is closed");

    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()

    // Build content blocks
    type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const content: Array<Record<string, unknown>> = [];
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as ImageMediaType, data: img.data },
        });
      }
    }
    content.push({ type: "text", text });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.currentRequest = null;
        reject(new Error("Query timed out after 10 minutes"));
      }, TIMEOUT_MS);

      const wrappedResolve = (val: string) => { clearTimeout(timer); resolve(val); };
      const wrappedReject = (err: Error) => { clearTimeout(timer); reject(err); };

      this.currentRequest = {
        message: { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null },
        onText,
        resolve: wrappedResolve,
        reject: wrappedReject,
      };
      this.parts = [];
      this.streamingText = "";

      if (this.pendingMessage && this.currentRequest) {
        this.pendingMessage(this.currentRequest.message);
      } else {
        wrappedReject(new Error("Session not ready to receive messages"));
      }
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
    this.q.close();
  }
}
