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
 * The text of a message's `content`: a string as-is, or the `text` of each
 * text block joined by `sep`. Anything else (missing, malformed) yields "".
 * The separator is the caller's: readers have historically differed (" " for
 * search/previews, "" for rollup classification), and that must not drift.
 */
export function textOfContent(content: unknown, sep: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isTextBlock).map((block) => block.text).join(sep);
}
