import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";
import { getSdkSessionPath } from "./store.js";

const EMPTY_TEXT_PLACEHOLDER = "[empty text block repaired by Tomo]";

export interface SdkSessionRepairResult {
  path: string;
  repaired: boolean;
  changedEvents: number;
  changedBlocks: number;
  error?: string;
}

export function repairSdkSessionForResume(sessionId: string): SdkSessionRepairResult {
  return repairSdkSessionFile(getSdkSessionPath(sessionId));
}

export function repairSdkSessionFile(path: string): SdkSessionRepairResult {
  const result: SdkSessionRepairResult = {
    path,
    repaired: false,
    changedEvents: 0,
    changedBlocks: 0,
  };
  if (!existsSync(path)) return result;

  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return result;

  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (trailingNewline) lines.pop();

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

    const changed = repairSdkEvent(event);
    if (changed > 0) {
      result.changedEvents++;
      result.changedBlocks += changed;
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

function repairSdkEvent(event: unknown): number {
  if (!isRecord(event)) return 0;
  const message = event.message;
  if (!isRecord(message)) return 0;

  const content = message.content;
  if (Array.isArray(content)) {
    const repaired = repairContentArray(content);
    if (repaired.changedBlocks > 0) {
      message.content = repaired.content;
    }
    return repaired.changedBlocks;
  }

  if (content === "") {
    message.content = EMPTY_TEXT_PLACEHOLDER;
    return 1;
  }

  return 0;
}

function repairContentArray(content: unknown[]): { content: unknown[]; changedBlocks: number } {
  let changedBlocks = 0;
  const repairedBlocks = content.map((block) => {
    if (!isRecord(block)) return block;
    const nested = block.content;
    if (Array.isArray(nested)) {
      const repaired = repairContentArray(nested);
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
    first.text = EMPTY_TEXT_PLACEHOLDER;
  }
  return { content: [first], changedBlocks };
}

function isEmptyTextBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && value.text === "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

