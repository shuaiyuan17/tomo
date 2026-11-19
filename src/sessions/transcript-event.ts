/** The shared shape of one SDK transcript (JSONL) event, and its text extraction. */
import { isTextBlock } from "../agent/content-blocks.js";

/**
 * Fields every reader of an SDK session JSONL relies on. Everything is
 * optional and `content` is `unknown`: a line is whatever was on disk, so
 * readers narrow it before use. A module that needs more fields extends this.
 */
export interface TranscriptEvent {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isCompactSummary?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * How a `type: "text"` block with an odd `text` field is read. Callers pass
 * whatever reproduces what they did before this helper existed, so malformed
 * but parseable lines read exactly as they always have.
 */
export interface TextOfContentOptions {
  /** `text` is null/undefined: "skip" the block (default), or read it as "" ("empty") so it still takes a separator. */
  missing?: "skip" | "empty";
  /** `text` is present but not a string: "drop" the block (default), or "stringify" it. */
  nonString?: "drop" | "stringify";
}

/**
 * The text of a message's `content`: a string as-is, or the `text` of each
 * text block joined by `sep`. Non-array content and non-text blocks yield
 * nothing. The separator is the caller's: readers have historically differed
 * (" " for search/previews, "" for rollup classification), and that must not
 * drift.
 */
export function textOfContent(content: unknown, sep: string, opts: TextOfContentOptions = {}): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      parts.push(block.text);
      continue;
    }
    if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "text") continue;
    const text = (block as { text?: unknown }).text;
    if (text === null || text === undefined) {
      if (opts.missing === "empty") parts.push("");
    } else if (opts.nonString === "stringify") {
      parts.push(String(text));
    }
  }
  return parts.join(sep);
}
