import { writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSdkSessionPath } from "../sessions/index.js";
import {
  drainOldInodeAfterRename,
  getCompactTriggerPath,
  readSinceOffsetFromFd,
  readWholeFileFromFd,
  sleepMs,
  type SdkEntry,
} from "./compact.js";
import { log } from "../logger.js";
import { isRawJsonlLine, parseJsonl, reportRawJsonlLines, serializeJsonlRecord } from "../jsonl.js";

export interface PruneToolsRequest {
  sdkSessionId: string;
  /** Claude SDK project directory derived from the configured workspace. */
  sdkSessionsDir: string;
  /** Only prune results with content larger than this (default 500) */
  minSize?: number;
  /** Only prune these tool names (e.g. ["Read", "Bash"]). Prunes all if empty. */
  tools?: string[];
  /** Also prune base64 image blocks (default true) */
  includeImages?: boolean;
  /** Preview only, don't modify the file */
  dryRun?: boolean;
  /**
   * Drop lines that cannot be parsed instead of preserving them verbatim.
   * See `tomo lcm prune-tools --drop-unparseable`; off by default.
   */
  dropUnparseable?: boolean;
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
 *
 * The rewrite uses the same concurrent-append machinery as compactSession:
 * this typically runs (via `tomo lcm prune-tools` from the agent's Bash tool)
 * while the daemon's SDK is appending the very turn that triggered it to the
 * same file. A plain read + in-place write would truncate those appends.
 */
export function pruneTools(req: PruneToolsRequest): PruneToolsResult {
  const path = getSdkSessionPath(req.sdkSessionId, req.sdkSessionsDir);
  if (!existsSync(path)) {
    return { success: false, pruned: [], totalCharsRemoved: 0, error: "Session file not found" };
  }

  const sourceFd = openSync(path, "r");
  try {
    return pruneToolsWithFd(req, path, sourceFd);
  } finally {
    // Keeping this fd open across the rename lets us drain SDK writes that
    // land on the old inode (see compactSession for the full rationale).
    closeSync(sourceFd);
  }
}

function pruneToolsWithFd(req: PruneToolsRequest, path: string, sourceFd: number): PruneToolsResult {
  const minSize = req.minSize ?? 500;

  // Pinned snapshot up to the last complete line; partial mid-write bytes
  // stay outside it and are handled by the late-splice loop below.
  const snapshot = readWholeFileFromFd(sourceFd);
  // preserveUnparseable: this function rewrites the file it just read. Carried
  // lines have no `message`, so every prune loop below skips them on its own
  // `evt.message?.content` guard; they are simply re-emitted where they were.
  const events: SdkEntry[] = req.dropUnparseable
    ? parseJsonl<SdkEvent>(snapshot.text)
    : parseJsonl<SdkEvent>(snapshot.text, { preserveUnparseable: true });
  if (!req.dropUnparseable) {
    reportRawJsonlLines(events, { sessionId: req.sdkSessionId, op: "prune-tools" });
  }

  // Build a map of tool_use_id -> tool name from assistant tool_use events
  const toolNameById = new Map<string, string>();
  for (const evt of events) {
    if (isRawJsonlLine(evt)) continue;
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
    if (isRawJsonlLine(evt)) continue;
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

  if (req.dryRun) {
    return { success: true, pruned, totalCharsRemoved };
  }

  // Late-arrival splice: pick up events the SDK appended after our snapshot
  // so the rewrite doesn't truncate them. Mirrors compactSession's loop;
  // late events are appended as-is (they're this turn's fresh activity).
  const lateEvents: SdkEntry[] = [];
  const seenLateUuids = new Set<string>();
  let cursor = snapshot.size;
  let partialStillPending = false;
  for (let pass = 0; pass < 8; pass++) {
    const { events: late, readUpTo, hasPartialTail } = readSinceOffsetFromFd(sourceFd, cursor);
    for (const e of late) {
      if (isRawJsonlLine(e)) {
        lateEvents.push(e);
        continue;
      }
      if (e.uuid && seenLateUuids.has(e.uuid)) continue;
      lateEvents.push(e);
      if (e.uuid) seenLateUuids.add(e.uuid);
    }
    cursor = readUpTo;
    partialStillPending = hasPartialTail;
    if (!hasPartialTail) break;
    if (pass < 7) sleepMs(5);
  }

  // An SDK write is still mid-flight: rewriting now would clobber it.
  // Abort with no side effects; the caller can simply retry.
  if (partialStillPending) {
    log.warn({ sessionId: req.sdkSessionId }, "Prune aborted: SDK partial write still pending after retries");
    return { success: false, pruned: [], totalCharsRemoved: 0, error: "Partial SDK write in flight; retry" };
  }

  // Archive the snapshot if requested (from the pinned read, not a re-read
  // of the file, which could race with further appends).
  if (req.archivePath) {
    archiveOriginals(req.archivePath, snapshot.text, req.sdkSessionId);
  }

  // Atomic write: stage in a sibling temp file and rename into place, so the
  // SDK's appender sees the old file fully or the new file fully — never a
  // half-written state. The temp name is per-process/per-call so two
  // concurrent prune invocations can't overwrite or rename each other's file.
  const output = [...events, ...lateEvents].map(serializeJsonlRecord).join("\n") + "\n";
  const tmp = `${path}.${process.pid}.${randomUUID()}.pruning.tmp`;
  try {
    writeFileSync(tmp, output);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }

  // Drain any appends that landed on the old inode around the rename.
  const postRenameDrain = drainOldInodeAfterRename({
    sourceFd,
    startOffset: cursor,
    path,
    removedUuids: new Set(),
    summaryUuid: "",
    seenLateUuids,
  });
  if (postRenameDrain.partialStillPending) {
    log.warn({ sessionId: req.sdkSessionId }, "Post-rename old-inode drain stopped with partial SDK write still pending");
  }

  // Write trigger file so the harness reloads the live session on next turn
  writeFileSync(getCompactTriggerPath(req.sdkSessionId, req.sdkSessionsDir), new Date().toISOString());

  log.info({
    sessionId: req.sdkSessionId,
    prunedCount: pruned.length,
    charsRemoved: totalCharsRemoved,
    lateAppended: lateEvents.length,
    postRenameDrained: postRenameDrain.appended,
  }, "Tool results pruned");

  return { success: true, pruned, totalCharsRemoved };
}

/** Archive the pre-prune snapshot text (already read via the pinned fd) */
function archiveOriginals(archivePath: string, snapshotText: string, sessionId: string): void {
  const dir = dirname(archivePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(archivePath, `# pre-prune snapshot of ${sessionId} at ${new Date().toISOString()}\n`);
  appendFileSync(archivePath, snapshotText);
}
