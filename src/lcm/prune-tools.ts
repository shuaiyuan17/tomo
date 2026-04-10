import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getSdkSessionPath } from "../sessions/index.js";
import { getCompactTriggerPath } from "./compact.js";
import { log } from "../logger.js";

export interface PruneToolsRequest {
  sdkSessionId: string;
  /** Only prune results with content larger than this (default 500) */
  minSize?: number;
  /** Only prune these tool names (e.g. ["Read", "Bash"]). Prunes all if empty. */
  tools?: string[];
  /** Also prune base64 image blocks (default true) */
  includeImages?: boolean;
  /** Preview only, don't modify the file */
  dryRun?: boolean;
  /** Path to archive original content */
  archivePath?: string;
}

export interface PrunedEntry {
  category: "tool" | "image";
  tool?: string;
  mediaType?: string;
  originalSize: number;
}

export interface PruneToolsResult {
  success: boolean;
  pruned: PrunedEntry[];
  totalCharsRemoved: number;
  error?: string;
}

interface SdkEvent {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: {
    role: string;
    content: any;
  };
  [key: string]: any;
}

/**
 * Prune tool result content in an SDK session JSONL file.
 *
 * Replaces bulky tool_result content with a short stub while preserving
 * the event structure, parentUuid chain, and tool_use_id pairing.
 */
export function pruneTools(req: PruneToolsRequest): PruneToolsResult {
  const minSize = req.minSize ?? 500;
  const path = getSdkSessionPath(req.sdkSessionId);
  if (!existsSync(path)) {
    return { success: false, pruned: [], totalCharsRemoved: 0, error: "Session file not found" };
  }

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const events: SdkEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { continue; }
  }

  // Build a map of tool_use_id -> tool name from assistant tool_use events
  const toolNameById = new Map<string, string>();
  for (const evt of events) {
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id && block.name) {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  const pruned: PrunedEntry[] = [];
  const toolFilter = req.tools ? new Set(req.tools.map((t) => t.toLowerCase())) : null;
  const includeImages = req.includeImages !== false; // default true

  for (const evt of events) {
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];

      // Prune tool results
      if (block.type === "tool_result") {
        const toolName = toolNameById.get(block.tool_use_id) ?? "unknown";

        if (toolFilter && !toolFilter.has(toolName.toLowerCase())) continue;

        const resultContent = block.content;
        let size: number;
        if (typeof resultContent === "string") {
          size = resultContent.length;
        } else if (Array.isArray(resultContent)) {
          size = resultContent.reduce((sum: number, c: any) => sum + JSON.stringify(c).length, 0);
        } else {
          continue;
        }

        if (size < minSize) continue;

        pruned.push({ category: "tool", tool: toolName, originalSize: size });

        if (!req.dryRun) {
          block.content = `[pruned — ${size.toLocaleString()} chars from ${toolName}]`;
        }
        continue;
      }

      // Prune base64 images
      if (includeImages && block.type === "image" && block.source?.type === "base64") {
        const data = block.source.data ?? "";
        const size = data.length;
        if (size < minSize) continue;

        const mediaType = block.source.media_type ?? "image/unknown";
        const sizeKb = Math.round(size / 1024);
        pruned.push({ category: "image", mediaType, originalSize: size });

        if (!req.dryRun) {
          // Replace with a tiny text block preserving the event structure
          content[i] = {
            type: "text",
            text: `[pruned — ${mediaType}, ${sizeKb}KB base64]`,
          };
        }
        continue;
      }
    }

    // Prune toolUseResult at event level (SDK visual previews)
    if (includeImages && evt.toolUseResult && typeof evt.toolUseResult === "object") {
      const tur = evt.toolUseResult;
      if (tur.type === "image" && tur.file) {
        const data = tur.file.base64 ?? tur.file.data ?? "";
        const size = data.length;
        if (size >= minSize) {
          const mediaType = tur.file.type ?? tur.file.media_type ?? "image/unknown";
          const sizeKb = Math.round(size / 1024);
          pruned.push({ category: "image", mediaType, originalSize: size });

          if (!req.dryRun) {
            evt.toolUseResult = { type: "text", text: `[pruned — ${mediaType}, ${sizeKb}KB base64]` };
          }
        }
      }
    }
  }

  if (pruned.length === 0) {
    return { success: true, pruned: [], totalCharsRemoved: 0 };
  }

  const totalCharsRemoved = pruned.reduce((sum, p) => sum + p.originalSize, 0);

  if (!req.dryRun) {
    // Archive originals if requested
    if (req.archivePath) {
      archiveOriginals(req.archivePath, path, req.sdkSessionId);
    }

    // Write modified session file
    const output = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, output);

    // Write trigger file so the harness reloads the live session on next turn
    writeFileSync(getCompactTriggerPath(req.sdkSessionId), new Date().toISOString());

    log.info({
      sessionId: req.sdkSessionId,
      prunedCount: pruned.length,
      charsRemoved: totalCharsRemoved,
    }, "Tool results pruned");
  }

  return { success: true, pruned, totalCharsRemoved };
}

/** Save a copy of the original session file before pruning */
function archiveOriginals(archivePath: string, sessionPath: string, sessionId: string): void {
  const dir = dirname(archivePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const original = readFileSync(sessionPath, "utf-8");
  appendFileSync(archivePath, `# pre-prune snapshot of ${sessionId} at ${new Date().toISOString()}\n`);
  appendFileSync(archivePath, original);
}
