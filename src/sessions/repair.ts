import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";
import type { SessionMessage } from "./types.js";
import { getSdkSessionPath } from "./store.js";

const EMPTY_TEXT_PLACEHOLDER = "[empty text block repaired by Tomo]";

export interface SdkSessionRepairResult {
  path: string;
  repaired: boolean;
  changedEvents: number;
  changedBlocks: number;
  transcriptFilled: number;
  placeholderFilled: number;
  error?: string;
}

export function repairSdkSessionForResume(sessionId: string, transcript?: SessionMessage[]): SdkSessionRepairResult {
  return repairSdkSessionFile(getSdkSessionPath(sessionId), transcript);
}

export function repairSdkSessionFile(path: string, transcript: SessionMessage[] = []): SdkSessionRepairResult {
  const result: SdkSessionRepairResult = {
    path,
    repaired: false,
    changedEvents: 0,
    changedBlocks: 0,
    transcriptFilled: 0,
    placeholderFilled: 0,
  };
  if (!existsSync(path)) return result;

  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return result;

  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (trailingNewline) lines.pop();

  const assistantTranscript = transcript
    .filter((m) => m.role === "assistant" && m.content.trim())
    .sort((a, b) => a.timestamp - b.timestamp);
  let transcriptCursor = 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (err) {
      result.error = `Could not parse SDK session JSONL line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    const replacement = chooseTranscriptReplacement(event, assistantTranscript, transcriptCursor);
    if (replacement) transcriptCursor = replacement.nextCursor;

    const changed = repairSdkEvent(event, replacement?.text);
    if (changed > 0) {
      result.changedEvents++;
      result.changedBlocks += changed;
      if (replacement) {
        result.transcriptFilled++;
      } else {
        result.placeholderFilled++;
      }
    }
    out.push(JSON.stringify(event));
  }

  if (result.changedBlocks === 0) return result;

  copyFileSync(path, `${path}.repair.bak`);
  writeFileSync(path, out.join("\n") + (trailingNewline ? "\n" : ""));
  result.repaired = true;
  log.warn(
    { path, changedEvents: result.changedEvents, changedBlocks: result.changedBlocks },
    "Repaired SDK session empty text blocks before resume",
  );
  return result;
}

function repairSdkEvent(event: unknown, replacementText?: string): number {
  if (!isRecord(event)) return 0;
  const message = event.message;
  if (!isRecord(message)) return 0;

  const content = message.content;
  if (Array.isArray(content)) {
    const repaired = repairContentArray(content, replacementText);
    if (repaired.changedBlocks > 0) {
      message.content = repaired.content;
    }
    return repaired.changedBlocks;
  }

  if (content === "") {
    message.content = replacementText ?? EMPTY_TEXT_PLACEHOLDER;
    return 1;
  }

  return 0;
}

function repairContentArray(
  content: unknown[],
  replacementText?: string,
): { content: unknown[]; changedBlocks: number } {
  let changedBlocks = 0;
  const repairedBlocks = content.map((block) => {
    if (!isRecord(block)) return block;
    const nested = block.content;
    if (Array.isArray(nested)) {
      const repaired = repairContentArray(nested, replacementText);
      if (repaired.changedBlocks > 0) {
        block.content = repaired.content;
        changedBlocks += repaired.changedBlocks;
      }
    }
    return block;
  });

  const emptyTextBlocks = repairedBlocks.filter(isEmptyTextBlock);
  if (emptyTextBlocks.length === 0) {
    return { content: repairedBlocks, changedBlocks };
  }

  const nonEmptyBlocks = repairedBlocks.filter((block) => !isEmptyTextBlock(block));
  changedBlocks += emptyTextBlocks.length;
  if (nonEmptyBlocks.length > 0) {
    return { content: nonEmptyBlocks, changedBlocks };
  }

  const first = emptyTextBlocks[0];
  if (isRecord(first)) {
    first.text = replacementText ?? EMPTY_TEXT_PLACEHOLDER;
  }
  return { content: [first], changedBlocks };
}

function chooseTranscriptReplacement(
  event: unknown,
  assistantTranscript: SessionMessage[],
  cursor: number,
): { text: string; nextCursor: number } | null {
  if (!isRecord(event) || event.type !== "assistant") return null;
  const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  if (!Number.isFinite(timestamp)) return null;

  let bestIdx = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  const windowMs = 120_000;
  for (let i = cursor; i < assistantTranscript.length; i++) {
    const msg = assistantTranscript[i];
    const delta = Math.abs(msg.timestamp - timestamp);
    if (delta < bestDelta) {
      bestIdx = i;
      bestDelta = delta;
    }
    if (msg.timestamp > timestamp + windowMs) break;
  }

  if (bestIdx === -1 || bestDelta > windowMs) return null;
  return { text: assistantTranscript[bestIdx].content, nextCursor: bestIdx + 1 };
}

function isEmptyTextBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && value.text === "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
