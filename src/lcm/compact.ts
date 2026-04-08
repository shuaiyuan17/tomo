import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSdkSessionPath } from "../sessions/index.js";
import { log } from "../logger.js";

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
  const removeStartGlobal = convIndices[req.fromIdx];
  const removeEndGlobal = convIndices[req.toIdx];

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

  // Find the first event AFTER the range
  let firstAfterGlobal = -1;
  for (let i = removeEndGlobal + 1; i < allEvents.length; i++) {
    if (allEvents[i].type === "user" || allEvents[i].type === "assistant") {
      firstAfterGlobal = i;
      break;
    }
  }

  // Create the summary event
  const summaryUuid = randomUUID();
  const summaryEvent: SdkEvent = {
    parentUuid: parentBeforeRange ?? null,
    type: "user",
    message: {
      role: "user",
      content: `[Compacted section — ${removeSet.size} events summarized]\n\n${req.summary}`,
    },
    uuid: summaryUuid,
    isSidechain: false,
    isCompactSummary: true,
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

  // Build the new event list
  const newEvents: SdkEvent[] = [];

  // Events before the range
  for (let i = 0; i < removeStartGlobal; i++) {
    newEvents.push(allEvents[i]);
  }

  // The summary event
  newEvents.push(summaryEvent);

  // Events after the range, with the first one re-parented to the summary
  let reparented = false;
  for (let i = removeEndGlobal + 1; i < allEvents.length; i++) {
    const event = { ...allEvents[i] };

    if (!reparented && (event.type === "user" || event.type === "assistant")) {
      event.parentUuid = summaryUuid;
      reparented = true;
    } else if (!reparented && event.parentUuid != null) {
      // Non-conversation event (attachment, etc.) that was parented to a removed event
      const parentInRemoveSet = removeSet.has(
        allEvents.findIndex(e => e.uuid === event.parentUuid)
      );
      if (parentInRemoveSet) {
        event.parentUuid = summaryUuid;
      }
    }

    newEvents.push(event);
  }

  // Write the new session file
  const output = newEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, output);

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
