import { readFileSync, existsSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";

/**
 * Resolve a time range to conversation event indices in the SDK JSONL.
 * Returns the first and last user/assistant event indices within the range.
 */
export function resolveTimeRange(
  sdkSessionId: string,
  fromTime: string,
  toTime: string,
): { fromIdx: number; toIdx: number } | null {
  const path = getSdkSessionPath(sdkSessionId);
  if (!existsSync(path)) return null;

  // Parse inputs as Date. If no timezone is specified, JS treats them as
  // local time — which is what we want for agent-provided timestamps.
  const fromMs = new Date(fromTime).getTime();
  const toMs = new Date(toTime).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  let convIdx = 0;
  let firstIdx = -1;
  let lastIdx = -1;

  for (const line of lines) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;

    const tsMs = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
    if (Number.isFinite(tsMs) && tsMs >= fromMs && tsMs <= toMs) {
      if (firstIdx === -1) firstIdx = convIdx;
      lastIdx = convIdx;
    }
    convIdx++;
  }

  if (firstIdx === -1) return null;
  return { fromIdx: firstIdx, toIdx: lastIdx };
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
  toolName?: string;
}

/**
 * Scan an SDK session JSONL file and segment messages by activity type.
 * Returns sections with token counts and labels.
 */
export function computeContextStats(sdkSessionId: string): ContextStatsResult | null {
  const path = getSdkSessionPath(sdkSessionId);
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const events: ParsedEvent[] = [];

  for (const line of lines) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }

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

      // Estimate tokens from content
      let chars = 0;
      const toolNames: string[] = [];
      for (const c of content) {
        if (c?.type === "text") chars += (c.text?.length || 0);
        else if (c?.type === "tool_use") {
          chars += JSON.stringify(c.input || {}).length;
          toolNames.push(c.name || "unknown");
        }
        else if (c?.type === "thinking") chars += (c.thinking?.length || 0);
      }

      if (hasToolUse) {
        for (const name of toolNames) {
          events.push({
            type: "assistant",
            timestamp,
            activity: "tool",
            tokens: Math.ceil(chars / 4),
            toolName: name,
          });
        }
      } else if (hasText) {
        events.push({
          type: "assistant",
          timestamp,
          activity: "conversation",
          tokens: Math.ceil(chars / 4),
        });
      }
    } else if (type === "user") {
      // User messages: check if it's a tool_result or actual user input
      if (Array.isArray(content)) {
        const hasToolResult = content.some((c: any) => c?.type === "tool_result");
        if (hasToolResult) {
          let chars = 0;
          for (const c of content) {
            const tc = c?.content;
            if (typeof tc === "string") chars += tc.length;
            else if (Array.isArray(tc)) {
              for (const inner of tc) {
                if (inner?.type === "text") chars += (inner.text?.length || 0);
              }
            }
          }
          events.push({
            type: "user",
            timestamp,
            activity: "tool",
            tokens: Math.ceil(chars / 4),
          });
        } else {
          let chars = 0;
          for (const c of content) {
            if (c?.type === "text") chars += (c.text?.length || 0);
          }
          events.push({
            type: "user",
            timestamp,
            activity: "conversation",
            tokens: Math.ceil(chars / 4),
          });
        }
      } else if (typeof content === "string") {
        events.push({
          type: "user",
          timestamp,
          activity: "conversation",
          tokens: Math.ceil(content.length / 4),
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
      if (ev.toolName) {
        toolNames.set(ev.toolName, (toolNames.get(ev.toolName) || 0) + 1);
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
