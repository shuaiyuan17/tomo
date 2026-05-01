import {
  writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync,
  statSync, openSync, fstatSync, readSync, closeSync, renameSync,
} from "node:fs";
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

  // Atomic read: open once, fstat the FD to get the byte count we're about
  // to read, then read exactly that many bytes. This pins `bytesAtRead` to
  // the bytes we actually loaded — anything the SDK appends after this is
  // strictly outside `allEvents` and will be picked up by the late-splice
  // pass at write time. Doing `statSync` then `readFileSync` separately
  // would let an SDK append slip into both reads (counted in `allEvents`
  // AND in the late tail), producing duplicate uuids in the output.
  const snapshot = readWholeFile(path);
  const bytesAtRead = snapshot.size;
  const allEvents: SdkEvent[] = [];
  for (const line of snapshot.text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { allEvents.push(JSON.parse(t)); } catch { continue; }
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

  // Late-arrival splice: re-read any bytes the SDK appended after our initial
  // read. These are events written while we were processing — typically the
  // agent's own thinking/tool_use that triggered this compact via Bash. If we
  // truncate-rewrite without splicing them in, they're lost and any later
  // tool_result lands with a parentUuid pointing at a vanished tool_use.
  //
  // We loop: re-read the tail, splice it, then re-stat. If the file grew
  // again while we were splicing, repeat. This drives the residual race
  // window down to "between the final tail-read and the rename" — typically
  // microseconds. Closing it fully would require either an advisory lock
  // honored by the SDK or daemon-side coordination that pauses appends
  // during compact. See followup.
  let cursor = bytesAtRead;
  let lateAppended = 0;
  const seenLateUuids = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const lateEvents = readSinceOffset(path, cursor);
    if (lateEvents.length === 0) break;
    for (const e of lateEvents) {
      // Defense in depth against the duplication race: skip any uuid we've
      // already spliced in. (The atomic read above should make this
      // impossible, but a duplicated splice would corrupt the chain.)
      if (e.uuid && seenLateUuids.has(e.uuid)) continue;
      const event = { ...e };
      if (event.parentUuid && removedUuids.has(event.parentUuid)) {
        event.parentUuid = summaryUuid;
      }
      newEvents.push(event);
      lateAppended++;
      if (e.uuid) seenLateUuids.add(e.uuid);
    }
    cursor = statSync(path).size;
  }

  // Atomic write: stage the new content in a sibling temp file and rename
  // into place. The rename is atomic at the filesystem level, so the SDK's
  // appender (which re-opens the path on each append) either sees the old
  // file fully or the new file fully — never a half-written state. Any SDK
  // append landing strictly between the final tail-read above and this
  // rename is still lost; that residual window is sub-millisecond and would
  // need lock cooperation to close fully.
  const output = newEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
  const tmp = path + ".compacting.tmp";
  writeFileSync(tmp, output);
  renameSync(tmp, path);

  // Write trigger file so the harness knows to reload the session
  writeFileSync(getCompactTriggerPath(req.sdkSessionId), new Date().toISOString());

  const eventsRemoved = removeSet.size;
  log.info({
    sessionId: req.sdkSessionId,
    eventsRemoved,
    eventsAfter: newEvents.length,
    fromIdx: req.fromIdx,
    toIdx: req.toIdx,
    lateAppended,
  }, "Session compacted");

  return {
    success: true,
    eventsRemoved,
    eventsAfter: newEvents.length,
  };
}

/**
 * Read the entire file atomically, pinning the byte count to what was
 * actually read. Returning `{text, size}` lets the caller use `size` as a
 * lower-bound cursor for any later append-splice without risk of an
 * overlap (i.e. the same event being counted in both `allEvents` and the
 * late tail).
 *
 * Exported for testing only.
 */
export function readWholeFile(path: string): { text: string; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let total = 0;
    while (total < size) {
      const n = readSync(fd, buf, total, size - total, total);
      if (n === 0) break; // EOF earlier than fstat reported (shouldn't happen)
      total += n;
    }
    return { text: buf.subarray(0, total).toString("utf-8"), size: total };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read events appended to a JSONL file after a given byte offset.
 *
 * Used to recover events the SDK wrote between our initial read and our
 * truncate-rewrite. Skips trailing partial lines (the SDK was mid-append) —
 * those will be re-written cleanly to the new file by the SDK's next attempt.
 *
 * Exported for testing only.
 */
export function readSinceOffset(path: string, offset: number): SdkEvent[] {
  const size = statSync(path).size;
  if (size <= offset) return [];
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const out: SdkEvent[] = [];
    for (const line of buf.toString("utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* partial / malformed — skip */ }
    }
    return out;
  } finally {
    closeSync(fd);
  }
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
