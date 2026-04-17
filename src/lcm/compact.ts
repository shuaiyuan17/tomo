import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSdkSessionPath, getSdkSessionDir } from "../sessions/index.js";
import { log } from "../logger.js";

/** Path to the compact trigger file for a given session */
export function getCompactTriggerPath(sdkSessionId: string): string {
  return join(getSdkSessionDir(), `${sdkSessionId}.compact-trigger`);
}

/** Check if a compact happened and clear the trigger */
export function checkAndClearCompactTrigger(sdkSessionId: string): boolean {
  const triggerPath = getCompactTriggerPath(sdkSessionId);
  if (existsSync(triggerPath)) {
    unlinkSync(triggerPath);
    return true;
  }
  return false;
}

export interface CompactRequest {
  /** SDK session ID to compact */
  sdkSessionId: string;
  /** Start index in the event list (inclusive, 0-based among user/assistant events) */
  fromIdx: number;
  /** End index in the event list (inclusive) */
  toIdx: number;
  /** The summary text (generated externally via SDK query) */
  summary: string;
  /** Path to the transcript archive file */
  transcriptPath: string;
  /**
   * Optional block tag for hierarchical rollups (e.g. "daily 2026-04-17",
   * "weekly 2026-W16"). If a summary event with the same blockTag already
   * exists in the session, the range is expanded to include it so the new
   * summary replaces the old one — supports in-place rebuild (mid-day daily
   * refresh, re-running a weekly rollup, etc).
   */
  blockTag?: string;
}

export interface CompactResult {
  success: boolean;
  eventsRemoved: number;
  eventsAfter: number;
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
  timestamp?: string;
  sessionId?: string;
  [key: string]: any;
}

/**
 * Compact a range of events in an SDK session JSONL file.
 *
 * Replaces events[fromIdx..toIdx] (among user/assistant events) with a single
 * summary message, fixes the parentUuid chain, and archives the originals.
 */
export function compactSession(req: CompactRequest): CompactResult {
  const path = getSdkSessionPath(req.sdkSessionId);
  if (!existsSync(path)) {
    return { success: false, eventsRemoved: 0, eventsAfter: 0, error: "Session file not found" };
  }

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const allEvents: SdkEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try { allEvents.push(JSON.parse(line)); } catch { continue; }
  }

  // Separate conversation events (user/assistant) from metadata events
  // We need to track the original indices so we can reconstruct
  const convIndices: number[] = []; // indices into allEvents for user/assistant
  for (let i = 0; i < allEvents.length; i++) {
    const t = allEvents[i].type;
    if (t === "user" || t === "assistant") {
      convIndices.push(i);
    }
  }

  if (req.fromIdx < 0 || req.toIdx >= convIndices.length || req.fromIdx > req.toIdx) {
    return {
      success: false, eventsRemoved: 0, eventsAfter: allEvents.length,
      error: `Invalid range: ${req.fromIdx}-${req.toIdx} (${convIndices.length} conversation events)`,
    };
  }

  // Map fromIdx/toIdx (conversation-relative) to allEvents indices
  let removeStartGlobal = convIndices[req.fromIdx];
  let removeEndGlobal = convIndices[req.toIdx];

  // Rebuild semantics: if blockTag matches an existing summary event, expand
  // the range to include it so the new summary replaces the old in place.
  if (req.blockTag) {
    for (let i = 0; i < allEvents.length; i++) {
      if (allEvents[i].isCompactSummary && allEvents[i].blockTag === req.blockTag) {
        if (i < removeStartGlobal) removeStartGlobal = i;
        if (i > removeEndGlobal) removeEndGlobal = i;
      }
    }
  }

  // Find events to remove: all events between removeStartGlobal and removeEndGlobal (inclusive),
  // including any metadata events (queue-operation, last-prompt, attachment) that sit between them
  const removeSet = new Set<number>();
  for (let i = removeStartGlobal; i <= removeEndGlobal; i++) {
    removeSet.add(i);
  }

  // Also remove any non-conversation events that sit entirely within the range
  // (queue-operations, last-prompts, attachments between the conversation events)
  for (let i = removeStartGlobal; i <= removeEndGlobal; i++) {
    removeSet.add(i);
  }

  // Archive removed events to transcript
  archiveEvents(req.transcriptPath, allEvents, removeSet);

  // Find the parentUuid chain endpoints
  const firstRemoved = allEvents[removeStartGlobal];
  const parentBeforeRange = firstRemoved.parentUuid;

  // Create the summary event
  const summaryUuid = randomUUID();
  const prefix = req.blockTag
    ? `[${req.blockTag} — ${removeSet.size} events summarized]`
    : `[Compacted section — ${removeSet.size} events summarized]`;
  const summaryEvent: SdkEvent = {
    parentUuid: parentBeforeRange ?? null,
    type: "user",
    message: {
      role: "user",
      content: `${prefix}\n\n${req.summary}`,
    },
    uuid: summaryUuid,
    isSidechain: false,
    isCompactSummary: true,
    ...(req.blockTag ? { blockTag: req.blockTag } : {}),
    timestamp: firstRemoved.timestamp,
    sessionId: req.sdkSessionId,
    // Copy common fields from the first removed event
    userType: firstRemoved.userType ?? "external",
    entrypoint: firstRemoved.entrypoint ?? "cli",
    cwd: firstRemoved.cwd ?? "",
    version: firstRemoved.version ?? "2.1.94",
    gitBranch: firstRemoved.gitBranch ?? "HEAD",
    slug: firstRemoved.slug ?? "",
  };

  // Collect UUIDs of every removed event so we can re-stitch any post-range event
  // whose parent pointed into the removed range. The SDK walks parentUuid back from
  // the leaf to build the API payload; any broken link here silently falls back to
  // timestamp-based stitching, which skips the summary.
  const removedUuids = new Set<string>();
  for (const idx of removeSet) {
    const u = allEvents[idx].uuid;
    if (u) removedUuids.add(u);
  }

  const newEvents: SdkEvent[] = [];

  for (let i = 0; i < removeStartGlobal; i++) {
    newEvents.push(allEvents[i]);
  }

  newEvents.push(summaryEvent);

  for (let i = removeEndGlobal + 1; i < allEvents.length; i++) {
    const event = { ...allEvents[i] };
    if (event.parentUuid && removedUuids.has(event.parentUuid)) {
      event.parentUuid = summaryUuid;
    }
    newEvents.push(event);
  }

  // Write the new session file
  const output = newEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, output);

  // Write trigger file so the harness knows to reload the session
  writeFileSync(getCompactTriggerPath(req.sdkSessionId), new Date().toISOString());

  const eventsRemoved = removeSet.size;
  log.info({
    sessionId: req.sdkSessionId,
    eventsRemoved,
    eventsAfter: newEvents.length,
    fromIdx: req.fromIdx,
    toIdx: req.toIdx,
  }, "Session compacted");

  return {
    success: true,
    eventsRemoved,
    eventsAfter: newEvents.length,
  };
}

/** Archive removed events to a transcript JSONL file */
function archiveEvents(transcriptPath: string, allEvents: SdkEvent[], removeSet: Set<number>): void {
  const dir = dirname(transcriptPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const archiveLines: string[] = [];
  for (const idx of Array.from(removeSet).sort((a, b) => a - b)) {
    const event = allEvents[idx];
    archiveLines.push(JSON.stringify({
      _archived: true,
      _archivedAt: new Date().toISOString(),
      _originalIdx: idx,
      ...event,
    }));
  }

  appendFileSync(transcriptPath, archiveLines.join("\n") + "\n");
}
