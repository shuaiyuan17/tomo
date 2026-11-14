import { readJsonlFileSync } from "../jsonl.js";
import { getSdkSessionPath } from "../sessions/index.js";

/** One LCM rollup / legacy compact summary as recorded in an SDK session. */
export interface SummaryBlock { tag: string; level: string; timestamp: string; eventsSummarized: number; content: string }

/** The summary blocks among `events`, in file order. Shared by `tomo lcm blocks` and the web Study. */
export function summaryBlocksFromEvents(events: Iterable<unknown>): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const e = event as Record<string, unknown>;
    if (!e.isCompactSummary) continue;
    const message = e.message as { content?: unknown } | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    const tag = typeof e.blockTag === "string" ? e.blockTag : "legacy";
    const match = content.match(/^\[(?:[^\]]+? — )?(\d+) events? summarized\]/);
    blocks.push({ tag, level: tag === "legacy" ? "legacy" : tag.split(" ")[0],
      timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
      eventsSummarized: match ? parseInt(match[1], 10) : 0, content });
  }
  return blocks;
}

export function readSummaryBlocks(sdkSessionId: string, sdkSessionsDir: string): SummaryBlock[] {
  return summaryBlocksFromEvents(readJsonlFileSync(getSdkSessionPath(sdkSessionId, sdkSessionsDir)));
}
