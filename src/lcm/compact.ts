import {
  writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync,
  openSync, fstatSync, readSync, closeSync, renameSync,
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
  /** @internal Test hook for simulating SDK appends in the final pre-rename window. */
  beforeRenameForTest?: () => void;
  /** @internal Test hook for simulating SDK writes through a pre-rename fd. */
  afterRenameForTest?: () => void;
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

  const sourceFd = openSync(path, "r");
  try {
    return compactSessionWithFd(req, path, sourceFd);
  } finally {
    // Holding this fd keeps the old inode readable after rename, so we can
    // drain SDK writes that land there. Once closed, any SDK writer that had
    // opened the old path pre-rename but delayed writing past our drain window
    // can still write unreachable bytes. Without SDK lock cooperation, that
    // "fd opened but idle" tail is the remaining residual boundary.
    closeSync(sourceFd);
  }
}

function compactSessionWithFd(req: CompactRequest, path: string, sourceFd: number): CompactResult {
  // Atomic read: open once, fstat the FD, then read exactly that many bytes.
  // `bytesAtRead` is pinned to the last-newline boundary (NOT current EOF) so
  // that any partial mid-write tail stays *outside* the snapshot — the
  // late-splice loop will see it as `hasPartialTail` and either consume it
  // on a later pass or abort the compact. Doing `statSync` then
  // `readFileSync` separately would let an SDK append slip into both reads
  // (counted in `allEvents` AND in the late tail), producing duplicate uuids.
  const snapshot = readWholeFileFromFd(sourceFd);
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
  // Loop: re-read the tail and splice events one pass at a time, advancing
  // the cursor only to the precise offset readSinceOffset reports as fully
  // consumed (NOT a fresh statSync — that would skip bytes appended between
  // readSinceOffset's internal fstat and the outer stat). When a pass
  // observes a partial trailing line (SDK mid-write in another process),
  // sleep briefly before retrying so the SDK process gets scheduled and can
  // flush the rest. If the partial is *still* pending after all retries,
  // abort the compact rather than rename and clobber the partial bytes.
  let cursor = bytesAtRead;
  let lateAppended = 0;
  const seenLateUuids = new Set<string>();
  let partialStillPending = false;
  for (let pass = 0; pass < 8; pass++) {
    const { events: lateEvents, readUpTo, hasPartialTail } = readSinceOffsetFromFd(sourceFd, cursor);
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
    cursor = readUpTo;
    partialStillPending = hasPartialTail;
    if (!hasPartialTail) break; // file consumed cleanly through EOF
    // Sub-ms partial: yield enough wall time for the SDK process to flush.
    // 5ms × up-to-7 retries = 35ms worst case, plenty for kernel scheduling.
    if (pass < 7) sleepMs(5);
  }

  // If the SDK is mid-write through the final retry, the file still ends in
  // a partial line. Renaming now would clobber those bytes (the rename
  // unlinks the old inode; the SDK re-opens the path on next append, so the
  // partial bytes are unreachable). Abort instead — the caller's retry path
  // will pick this back up once the SDK finishes its write.
  if (partialStillPending) {
    log.warn({
      sessionId: req.sdkSessionId,
      fromIdx: req.fromIdx,
      toIdx: req.toIdx,
    }, "Compact aborted: SDK partial write still pending after retries");
    return {
      success: false,
      eventsRemoved: 0,
      eventsAfter: allEvents.length,
      error: "Partial SDK write in flight; retry",
    };
  }

  // Archive removed events to transcript. Done after the abort check so a
  // failed compact leaves no side effects (no duplicate archive lines on
  // retry).
  archiveEvents(req.transcriptPath, allEvents, removeSet);

  // Atomic write: stage the new content in a sibling temp file and rename
  // into place. The rename is atomic at the filesystem level, so the SDK's
  // appender (which re-opens the path on each append) either sees the old
  // file fully or the new file fully — never a half-written state. The
  // post-rename drain below covers appends that land on the old inode after
  // this final tail read.
  const output = newEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
  const tmp = path + ".compacting.tmp";
  writeFileSync(tmp, output);
  req.beforeRenameForTest?.();
  renameSync(tmp, path);
  req.afterRenameForTest?.();

  // The final pre-rename tail read still has a tiny race: the SDK can open
  // the old path just before our rename and complete an append to that old
  // inode after the tail read. Keep our read fd to the old inode alive across
  // rename and drain any complete JSONL lines from it into the new file.
  const postRenameDrain = drainOldInodeAfterRename({
    sourceFd,
    startOffset: cursor,
    path,
    removedUuids,
    summaryUuid,
    seenLateUuids,
  });
  lateAppended += postRenameDrain.appended;
  if (postRenameDrain.partialStillPending) {
    // Unlike the pre-rename splice, we cannot abort after rename has committed.
    // Keep the repaired file and warn; a future retry/repair can inspect it.
    log.warn({
      sessionId: req.sdkSessionId,
      fromIdx: req.fromIdx,
      toIdx: req.toIdx,
    }, "Post-rename old-inode drain stopped with partial SDK write still pending");
  }

  // Write trigger file so the harness knows to reload the session
  writeFileSync(getCompactTriggerPath(req.sdkSessionId), new Date().toISOString());

  const eventsRemoved = removeSet.size;
  const eventsAfter = newEvents.length + postRenameDrain.appended;
  log.info({
    sessionId: req.sdkSessionId,
    eventsRemoved,
    eventsAfter,
    fromIdx: req.fromIdx,
    toIdx: req.toIdx,
    lateAppended,
    postRenameDrained: postRenameDrain.appended,
    postRenamePartialPending: postRenameDrain.partialStillPending,
  }, "Session compacted");

  return {
    success: true,
    eventsRemoved,
    eventsAfter,
  };
}

/**
 * Read the file atomically up through the last complete line.
 *
 * Returns `{text, size, hasPartialTail}`:
 *   - `text`: bytes up to and including the last `\n` (no partial).
 *   - `size`: byte offset of the last-newline+1. The caller uses this as
 *     the cursor for any later append-splice. Pinning to the last-newline
 *     boundary (NOT current EOF) is critical: if the file ends mid-write,
 *     setting the cursor at EOF would cause the late-splice loop to never
 *     re-read those partial bytes once the SDK flushes the rest.
 *   - `hasPartialTail`: true when the file ends without a newline (an SDK
 *     write was in flight at read time). The caller must treat this as a
 *     pending write and refuse to rename until it resolves.
 *
 * Exported for testing only.
 */
export function readWholeFile(path: string): {
  text: string;
  size: number;
  hasPartialTail: boolean;
} {
  const fd = openSync(path, "r");
  try {
    return readWholeFileFromFd(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read events appended to a JSONL file after a given byte offset.
 *
 * Returns:
 *   - `events`: parsed events in the bytes read
 *   - `readUpTo`: the byte offset of the END of the last complete line we
 *     consumed. The caller must advance any cursor strictly to this — never
 *     to a fresh statSync, which would skip bytes appended after our internal
 *     fstat but before the outer stat. Partial trailing bytes (SDK mid-write)
 *     stay below `readUpTo` so a subsequent pass can re-read them once the
 *     write completes.
 *   - `hasPartialTail`: true when bytes exist past `readUpTo` (i.e. an SDK
 *     write is mid-flight). The caller must NOT proceed to a destructive
 *     rewrite while this is true — the partial bytes would be clobbered.
 *
 * Exported for testing only.
 */
export function readSinceOffset(
  path: string,
  offset: number,
): { events: SdkEvent[]; readUpTo: number; hasPartialTail: boolean } {
  const fd = openSync(path, "r");
  try {
    return readSinceOffsetFromFd(fd, offset);
  } finally {
    closeSync(fd);
  }
}

function readWholeFileFromFd(fd: number): {
  text: string;
  size: number;
  hasPartialTail: boolean;
} {
  const totalSize = fstatSync(fd).size;
  const buf = Buffer.alloc(totalSize);
  let total = 0;
  while (total < totalSize) {
    const n = readSync(fd, buf, total, totalSize - total, total);
    if (n === 0) break; // EOF earlier than fstat reported (shouldn't happen)
    total += n;
  }
  const lastNl = buf.subarray(0, total).lastIndexOf(0x0A);
  if (lastNl < 0) {
    // Empty file, or file is one in-flight partial line.
    return { text: "", size: 0, hasPartialTail: total > 0 };
  }
  return {
    text: buf.subarray(0, lastNl + 1).toString("utf-8"),
    size: lastNl + 1,
    hasPartialTail: total > lastNl + 1,
  };
}

function readSinceOffsetFromFd(
  fd: number,
  offset: number,
): { events: SdkEvent[]; readUpTo: number; hasPartialTail: boolean } {
  const size = fstatSync(fd).size;
  if (size <= offset) return { events: [], readUpTo: offset, hasPartialTail: false };
  const buf = Buffer.alloc(size - offset);
  let total = 0;
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, offset + total);
    if (n === 0) break;
    total += n;
  }
  // Locate the last newline. Bytes up to and including that newline form
  // complete lines; anything after is a partial mid-write tail we leave
  // alone so the next pass can re-read it.
  const lastNl = buf.subarray(0, total).lastIndexOf(0x0A);
  if (lastNl < 0) {
    // Entire tail is one partial line — caller's cursor must NOT advance.
    return { events: [], readUpTo: offset, hasPartialTail: total > 0 };
  }
  const completeBytes = buf.subarray(0, lastNl + 1).toString("utf-8");
  const events: SdkEvent[] = [];
  for (const line of completeBytes.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* malformed but complete — skip */ }
  }
  return {
    events,
    readUpTo: offset + lastNl + 1,
    hasPartialTail: total > lastNl + 1,
  };
}

function drainOldInodeAfterRename(args: {
  sourceFd: number;
  startOffset: number;
  path: string;
  removedUuids: Set<string>;
  summaryUuid: string;
  seenLateUuids: Set<string>;
}): { appended: number; partialStillPending: boolean } {
  let cursor = args.startOffset;
  let appended = 0;
  let partialStillPending = false;
  let quietPasses = 0;

  for (let pass = 0; pass < 10; pass++) {
    const { events, readUpTo, hasPartialTail } = readSinceOffsetFromFd(args.sourceFd, cursor);
    const lines: string[] = [];
    for (const e of events) {
      if (e.uuid && args.seenLateUuids.has(e.uuid)) continue;
      const event = { ...e };
      if (event.parentUuid && args.removedUuids.has(event.parentUuid)) {
        event.parentUuid = args.summaryUuid;
      }
      lines.push(JSON.stringify(event));
      appended++;
      if (e.uuid) args.seenLateUuids.add(e.uuid);
    }

    if (lines.length > 0) {
      appendFileSync(args.path, lines.join("\n") + "\n");
    }

    cursor = readUpTo;
    partialStillPending = hasPartialTail;
    quietPasses = events.length === 0 && !hasPartialTail ? quietPasses + 1 : 0;
    // Two empty reads give an SDK fd that survived rename a short chance to
    // flush one final append before we release our old-inode fd.
    if (quietPasses >= 2) break;
    if (pass < 9) sleepMs(5);
  }

  return { appended, partialStillPending };
}

/**
 * Synchronous millisecond sleep. Uses Atomics.wait on a SharedArrayBuffer
 * because compactSession's API contract is sync — we need the loop to yield
 * wall time so the SDK's separate-process appends get scheduled, without
 * restructuring the caller as async.
 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
