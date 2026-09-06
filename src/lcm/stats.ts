import { existsSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";
import { readJsonlFileSync } from "../jsonl.js";

interface SdkEvent {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    content?: unknown;
  };
}

export interface ResolvedTimeRange {
  fromIdx: number;
  toIdx: number;
  firstUuid?: string;
  lastUuid?: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;
const CJK_TOKEN_WEIGHT = 0.76;

/**
 * Estimate tokens for mixed-script text. Latin/ASCII is roughly 4 chars/token;
 * CJK (Han/Hiragana/Katakana/Hangul plus CJK punctuation/fullwidth forms) is
 * roughly 1 token per 1.3 chars. chars/4 alone underestimates Chinese by ~3x.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * CJK_TOKEN_WEIGHT + other / 4);
}

/**
 * Parse an agent-provided timestamp as LOCAL time.
 *
 * Datetime strings without a timezone ("2026-03-28T16:29") already parse as
 * local per the ECMAScript spec, but date-only strings ("2026-03-28") parse
 * as UTC midnight — shifted by the local UTC offset. Normalize those to the
 * local day: start-of-day for a range start, end-of-day for a range end (so
 * `--to-time 2026-03-28` includes that whole day rather than excluding it).
 */
function parseLocalTimeBoundary(value: string, edge: "start" | "end"): number {
  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    const suffix = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
    return new Date(trimmed + suffix).getTime();
  }
  return new Date(trimmed).getTime();
}

/**
 * Resolve a time range to conversation event indices in the SDK JSONL.
 * Returns the first and last user/assistant event indices within the range.
 */
export function resolveTimeRange(
  sdkSessionId: string,
  fromTime: string,
  toTime: string,
  sdkSessionsDir: string,
): ResolvedTimeRange | null {
  const path = getSdkSessionPath(sdkSessionId, sdkSessionsDir);
  if (!existsSync(path)) return null;

  const fromMs = parseLocalTimeBoundary(fromTime, "start");
  const toMs = parseLocalTimeBoundary(toTime, "end");
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const events = readJsonlFileSync<SdkEvent>(path);
  let convIdx = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  let firstUuid: string | undefined;
  let lastUuid: string | undefined;

  for (const e of events) {
    // Read-only mode hands out every valid-JSON line as a value, `null` and
    // arrays included; neither is an event.
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    if (e.type !== "user" && e.type !== "assistant") continue;

    const tsMs = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
    if (Number.isFinite(tsMs) && tsMs >= fromMs && tsMs <= toMs) {
      if (firstIdx === -1) {
        firstIdx = convIdx;
        firstUuid = e.uuid;
      }
      lastIdx = convIdx;
      lastUuid = e.uuid;
    }
    convIdx++;
  }

  if (firstIdx === -1) return null;
  return { fromIdx: firstIdx, toIdx: lastIdx, firstUuid, lastUuid };
}

export interface ContextSection {
  /** Section index (1-based) */
  id: number;
  /** First message seq in this section (by position in JSONL) */
  fromIdx: number;
  /** Last message seq in this section */
  toIdx: number;
  /** Estimated token count */
  tokens: number;
  /** Number of messages */
  messageCount: number;
  /** Section type */
  type: "conversation" | "tool_ops" | "mixed";
  /** Time range */
  earliestAt: string;
  latestAt: string;
  /** Tool names used (for tool_ops/mixed sections) */
  toolsUsed: string[];
  /** Number of tool calls */
  toolCallCount: number;
}

export interface ContextStatsResult {
  totalMessages: number;
  totalTokens: number;
  sections: ContextSection[];
}

interface ParsedEvent {
  type: string;
  timestamp: string;
  /** "text" | "tool_use" | "tool_result" | "thinking" */
  activity: "conversation" | "tool";
  tokens: number;
  /** Every tool this ONE message called. An assistant message can carry
   *  several tool_use blocks; it is still one message with one token count. */
  toolNames?: string[];
}

/**
 * Scan an SDK session JSONL file and segment messages by activity type.
 * Returns sections with token counts and labels.
 */
export function computeContextStats(
  sdkSessionId: string,
  sdkSessionsDir: string,
): ContextStatsResult | null {
  const path = getSdkSessionPath(sdkSessionId, sdkSessionsDir);
  if (!existsSync(path)) return null;

  const sdkEvents = readJsonlFileSync<SdkEvent>(path);
  const events: ParsedEvent[] = [];

  for (const e of sdkEvents) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const type = e.type;
    if (type !== "user" && type !== "assistant") continue;

    const msg = e.message;
    if (!msg) continue;

    const timestamp = e.timestamp || "";
    const content = msg.content;

    if (type === "assistant") {
      if (!Array.isArray(content)) continue;

      const hasToolUse = content.some((c: any) => c?.type === "tool_use");
      const hasText = content.some((c: any) => c?.type === "text" && c.text?.trim());
      const hasThinking = content.some((c: any) => c?.type === "thinking" && c.thinking?.trim());

      // Estimate tokens from content
      let tokens = 0;
      const toolNames: string[] = [];
      for (const c of content) {
        if (c?.type === "text") tokens += estimateTokens(c.text ?? "");
        else if (c?.type === "tool_use") {
          tokens += estimateTokens(JSON.stringify(c.input || {}));
          toolNames.push(c.name || "unknown");
        }
        else if (c?.type === "thinking") tokens += estimateTokens(c.thinking ?? "");
      }

      // ONE event per message, whatever it contains. Pushing one per tool_use
      // — each carrying the WHOLE message's token count — multiplied a
      // parallel-tool turn's tokens by its tool count and inflated its share
      // of every section it touched, so `tomo lcm stats` reported tool-heavy
      // ranges as far bigger than they are and pointed compaction at the
      // wrong ones. The per-tool detail lives in `toolNames`, which is what
      // the section's tool tally reads.
      if (hasToolUse) {
        events.push({
          type: "assistant",
          timestamp,
          activity: "tool",
          tokens,
          toolNames,
        });
      } else if (hasText || hasThinking) {
        // Thinking-only assistant messages used to be dropped entirely — real
        // tokens, sitting in the window, missing from every section's total.
        events.push({
          type: "assistant",
          timestamp,
          activity: "conversation",
          tokens,
        });
      }
    } else if (type === "user") {
      // User messages: check if it's a tool_result or actual user input
      if (Array.isArray(content)) {
        const hasToolResult = content.some((c: any) => c?.type === "tool_result");
        if (hasToolResult) {
          let tokens = 0;
          for (const c of content) {
            const tc = c?.content;
            if (typeof tc === "string") tokens += estimateTokens(tc);
            else if (Array.isArray(tc)) {
              for (const inner of tc) {
                if (inner?.type === "text") tokens += estimateTokens(inner.text ?? "");
              }
            }
          }
          events.push({
            type: "user",
            timestamp,
            activity: "tool",
            tokens,
          });
        } else {
          let tokens = 0;
          for (const c of content) {
            if (c?.type === "text") tokens += estimateTokens(c.text ?? "");
          }
          events.push({
            type: "user",
            timestamp,
            activity: "conversation",
            tokens,
          });
        }
      } else if (typeof content === "string") {
        events.push({
          type: "user",
          timestamp,
          activity: "conversation",
          tokens: estimateTokens(content),
        });
      }
    }
  }

  if (events.length === 0) return { totalMessages: 0, totalTokens: 0, sections: [] };

  // Segment by activity type transitions
  const sections: ContextSection[] = [];
  let sectionStart = 0;
  let currentActivity = events[0].activity;

  function flushSection(endIdx: number) {
    const slice = events.slice(sectionStart, endIdx + 1);
    const toolNames = new Map<string, number>();
    let toolCallCount = 0;
    let totalTokens = 0;

    for (const ev of slice) {
      totalTokens += ev.tokens;
      for (const name of ev.toolNames ?? []) {
        toolNames.set(name, (toolNames.get(name) || 0) + 1);
        toolCallCount++;
      }
    }

    const toolRatio = slice.filter(e => e.activity === "tool").length / slice.length;
    let type: ContextSection["type"];
    if (toolRatio > 0.6) type = "tool_ops";
    else if (toolRatio < 0.2) type = "conversation";
    else type = "mixed";

    sections.push({
      id: sections.length + 1,
      fromIdx: sectionStart,
      toIdx: endIdx,
      tokens: totalTokens,
      messageCount: slice.length,
      type,
      earliestAt: slice[0].timestamp,
      latestAt: slice[slice.length - 1].timestamp,
      toolsUsed: Array.from(toolNames.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`),
      toolCallCount,
    });
  }

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];

    // Detect transition: activity type changed AND we have a real user message
    // (tool_result → assistant → tool_use is NOT a transition, it's a tool chain)
    // Transition happens when: user text appears after tool chain, or tool_use starts after conversation
    if (ev.activity !== currentActivity) {
      // Only transition on meaningful boundaries:
      // conversation → tool: when assistant starts using tools
      // tool → conversation: when assistant replies with text AND next is user text
      const isToolChainEnd = currentActivity === "tool" &&
        ev.activity === "conversation" &&
        ev.type === "user";

      const isToolChainStart = currentActivity === "conversation" &&
        ev.activity === "tool";

      if (isToolChainEnd || isToolChainStart) {
        // Include the assistant's final text response in the tool chain
        // (it's the "here's what I did" message)
        if (isToolChainEnd && i > 0 && events[i - 1].activity === "conversation" && events[i - 1].type === "assistant") {
          flushSection(i - 1);
          sectionStart = i;
        } else {
          flushSection(i - 1);
          sectionStart = i;
        }
        currentActivity = ev.activity;
      }
    }
  }

  // Flush the last section
  flushSection(events.length - 1);

  // Merge small adjacent sections of the same type to reduce fragmentation.
  // A section is "small" if it has fewer than 10 messages AND under 2K tokens.
  const MIN_MESSAGES = 10;
  const MIN_TOKENS = 2000;
  const merged: ContextSection[] = [];

  for (const section of sections) {
    const prev = merged[merged.length - 1];
    const isSmall = section.messageCount < MIN_MESSAGES && section.tokens < MIN_TOKENS;
    const prevSmall = prev && prev.messageCount < MIN_MESSAGES && prev.tokens < MIN_TOKENS;

    if (prev && (isSmall || prevSmall) && prev.type === section.type) {
      // Merge into previous
      prev.toIdx = section.toIdx;
      prev.tokens += section.tokens;
      prev.messageCount += section.messageCount;
      prev.latestAt = section.latestAt;
      prev.toolCallCount += section.toolCallCount;
      // Merge tool names
      const toolMap = new Map<string, number>();
      for (const t of [...prev.toolsUsed, ...section.toolsUsed]) {
        const [name, countStr] = t.split(":");
        toolMap.set(name, (toolMap.get(name) || 0) + parseInt(countStr || "0"));
      }
      prev.toolsUsed = Array.from(toolMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`);
    } else if (prev && isSmall && prev.type !== section.type) {
      // Small section of different type — absorb into previous as "mixed"
      prev.toIdx = section.toIdx;
      prev.tokens += section.tokens;
      prev.messageCount += section.messageCount;
      prev.latestAt = section.latestAt;
      prev.toolCallCount += section.toolCallCount;
      prev.type = "mixed";
      const toolMap = new Map<string, number>();
      for (const t of [...prev.toolsUsed, ...section.toolsUsed]) {
        const [name, countStr] = t.split(":");
        toolMap.set(name, (toolMap.get(name) || 0) + parseInt(countStr || "0"));
      }
      prev.toolsUsed = Array.from(toolMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`);
    } else {
      merged.push({ ...section });
    }
  }

  // Re-number section IDs
  for (let i = 0; i < merged.length; i++) {
    merged[i].id = i + 1;
  }

  const totalTokens = events.reduce((sum, e) => sum + e.tokens, 0);

  return {
    totalMessages: events.length,
    totalTokens,
    sections: merged,
  };
}
