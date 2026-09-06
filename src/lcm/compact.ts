import {
  writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync,
  openSync, fstatSync, readSync, closeSync, readdirSync, statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSdkSessionPath } from "../sessions/index.js";
import { writeFileAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import { isRawJsonlLine, parseJsonl, reportRawJsonlLines, serializeJsonlRecord, type RawJsonlLine } from "../jsonl.js";

/** Path to the compact trigger file for a given session */
export function getCompactTriggerPath(sdkSessionId: string, sdkSessionsDir: string): string {
  return join(sdkSessionsDir, `${sdkSessionId}.compact-trigger`);
}

/** Check if a compact happened and clear the trigger */
export function checkAndClearCompactTrigger(sdkSessionId: string, sdkSessionsDir: string): boolean {
  const triggerPath = getCompactTriggerPath(sdkSessionId, sdkSessionsDir);
  // Unlink directly and treat ENOENT as "no trigger": an existsSync pre-check
  // races with a concurrent caller clearing the same trigger, and the loser's
  // unlinkSync would throw out of post-turn bookkeeping.
  try {
    unlinkSync(triggerPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * One line of an SDK JSONL file as a rewriting caller sees it: either a parsed
 * event, or an opaque carrier for a line that could not be parsed and is being
 * preserved verbatim. Narrow with `isRawJsonlLine` before touching any field.
 */
export type SdkEntry = SdkEvent | RawJsonlLine;

export interface CompactRequest {
  /** SDK session ID to compact */
  sdkSessionId: string;
  /** Claude SDK project directory derived from the configured workspace. */
  sdkSessionsDir: string;
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
  /**
   * Drop lines that cannot be parsed instead of preserving them verbatim.
   * Off by default, and there is no reason to turn it on except to deliberately
   * discard corruption that is jamming a session — see `tomo lcm compact
   * --drop-unparseable`. The dropped bytes are not archived anywhere.
   */
  dropUnparseable?: boolean;
  /**
   * Expected UUIDs of the events at fromIdx/toIdx, captured at range-resolution
   * time. If the file was rewritten between resolution and this call (e.g. two
   * compacts chained in one turn), conversation indices shift; a mismatch here
   * aborts instead of compacting the wrong events. Undefined anchors skip the
   * check (back-compat / anchor event had no uuid).
   */
  expectedFirstUuid?: string;
  expectedLastUuid?: string;
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
  // Before anything else: clear out staging corpses. A compact/prune killed
  // between writing its temp file and renaming it (SIGKILL, an OOM, a laptop
  // lid) leaves a FULL COPY of the session file behind under a name nothing
  // will ever look at again, and these sessions run to tens of megabytes. The
  // in-process error paths already unlink their own, so anything still here
  // after an hour belongs to a process that is not coming back.
  sweepStaleStagingFiles(req.sdkSessionsDir);

  const path = getSdkSessionPath(req.sdkSessionId, req.sdkSessionsDir);
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
  // preserveUnparseable: this function REWRITES the file it just read, so a
  // line that only the parser could not understand must still be in the
  // output. Carried lines have no `type`, so they never enter convIndices,
  // never anchor a range, and are never archived — they are only relocated.
  const allEvents: SdkEntry[] = req.dropUnparseable
    ? parseJsonl<SdkEvent>(snapshot.text)
    : parseJsonl<SdkEvent>(snapshot.text, { preserveUnparseable: true });
  if (!req.dropUnparseable) {
    reportRawJsonlLines(allEvents, { sessionId: req.sdkSessionId, op: "compact" });
  }

  // Separate conversation events (user/assistant) from metadata events
  // We need to track the original indices so we can reconstruct
  const convIndices: number[] = []; // indices into allEvents for user/assistant
  for (let i = 0; i < allEvents.length; i++) {
    const entry = allEvents[i];
    if (isRawJsonlLine(entry)) continue;
    if (entry.type === "user" || entry.type === "assistant") {
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

  // convIndices only ever holds real events, so these two are never carriers;
  // the guard is what tells the compiler that, and is a genuine abort if the
  // invariant is ever broken.
  const firstAnchor = allEvents[removeStartGlobal];
  const lastAnchor = allEvents[removeEndGlobal];
  if (isRawJsonlLine(firstAnchor) || isRawJsonlLine(lastAnchor)) {
    return {
      success: false, eventsRemoved: 0, eventsAfter: allEvents.length,
      error: "Internal: compaction range anchor resolved to an unparseable line",
    };
  }

  if (
    (req.expectedFirstUuid && firstAnchor.uuid !== req.expectedFirstUuid) ||
    (req.expectedLastUuid && lastAnchor.uuid !== req.expectedLastUuid)
  ) {
    log.warn({
      sessionId: req.sdkSessionId,
      fromIdx: req.fromIdx,
      toIdx: req.toIdx,
      expectedFirstUuid: req.expectedFirstUuid,
      actualFirstUuid: firstAnchor.uuid,
      expectedLastUuid: req.expectedLastUuid,
      actualLastUuid: lastAnchor.uuid,
    }, "Compact aborted: range anchors moved");
    return {
      success: false,
      eventsRemoved: 0,
      eventsAfter: allEvents.length,
      error: "Range anchors moved (file rewritten since range resolution); re-resolve the range and retry",
    };
  }

  const origStartGlobal = removeStartGlobal;
  const origEndGlobal = removeEndGlobal;

  // Rebuild semantics: if blockTag matches an existing summary event, expand
  // the range to include it so the new summary replaces the old in place.
  if (req.blockTag) {
    for (let i = 0; i < allEvents.length; i++) {
      const entry = allEvents[i];
      if (isRawJsonlLine(entry)) continue;
      if (entry.isCompactSummary && entry.blockTag === req.blockTag) {
        if (i < removeStartGlobal) removeStartGlobal = i;
        if (i > removeEndGlobal) removeEndGlobal = i;
      }
    }

    const gapConflict = findUnrelatedSummaryInExpansionGap(
      allEvents,
      req.blockTag,
      removeStartGlobal,
      removeEndGlobal,
      origStartGlobal,
      origEndGlobal,
    );
    if (gapConflict) {
      log.warn({
        sessionId: req.sdkSessionId,
        blockTag: req.blockTag,
        conflictTag: gapConflict.tag,
        conflictIndex: gapConflict.index,
        leftGapStart: removeStartGlobal,
        leftGapEnd: origStartGlobal - 1,
        rightGapStart: origEndGlobal + 1,
        rightGapEnd: removeEndGlobal,
      }, "Compact aborted: blockTag expansion would swallow unrelated summary block");
      return {
        success: false,
        eventsRemoved: 0,
        eventsAfter: allEvents.length,
        error: `blockTag expansion would swallow unrelated summary block "${gapConflict.tag}" at index ${gapConflict.index}; ` +
          "adjust the time range to include it explicitly or drop --block-tag",
      };
    }
  }

  // Find events to remove: all events between removeStartGlobal and removeEndGlobal (inclusive),
  // including any metadata events (queue-operation, last-prompt, attachment) that sit between them
  const removeSet = new Set<number>();
  for (let i = removeStartGlobal; i <= removeEndGlobal; i++) {
    // A line we could not parse is not something we can claim to have
    // summarized, and archiveEvents would write `{"_archived":true}` with no
    // payload. It is carried through to the output below instead.
    if (isRawJsonlLine(allEvents[i])) continue;
    removeSet.add(i);
  }

  // Find the parentUuid chain endpoints. Expansion only ever moves the bounds
  // onto an isCompactSummary event, so this is a real event too.
  const firstRemoved = allEvents[removeStartGlobal];
  if (isRawJsonlLine(firstRemoved)) {
    return {
      success: false, eventsRemoved: 0, eventsAfter: allEvents.length,
      error: "Internal: compaction range start resolved to an unparseable line",
    };
  }
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
    const entry = allEvents[idx];
    if (isRawJsonlLine(entry)) continue; // removeSet already excludes these
    if (entry.uuid) removedUuids.add(entry.uuid);
  }

  const newEvents: SdkEntry[] = [];

  for (let i = 0; i < removeStartGlobal; i++) {
    newEvents.push(allEvents[i]);
  }

  newEvents.push(summaryEvent);

  // Unparseable lines that sat inside the collapsed range. The span they were
  // in is gone, so "in place" is immediately after the summary that replaced
  // it — the closest surviving position, and still before everything that
  // followed them.
  for (let i = removeStartGlobal; i <= removeEndGlobal; i++) {
    if (isRawJsonlLine(allEvents[i])) newEvents.push(allEvents[i]);
  }

  for (let i = removeEndGlobal + 1; i < allEvents.length; i++) {
    const entry = allEvents[i];
    if (isRawJsonlLine(entry)) {
      newEvents.push(entry);
      continue;
    }
    const event = { ...entry };
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
      if (isRawJsonlLine(e)) {
        newEvents.push(e);
        lateAppended++;
        continue;
      }
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

  // Archive the removed events to the transcript BEFORE the rewrite is
  // published. The ordering picks between two failure modes and this is the
  // recoverable one:
  //
  //   archive-after-rename: the rename commits, then the archive throws
  //     (ENOSPC, EACCES, a transcript directory that is not a directory) —
  //     and the events are gone. They are not in the session file any more
  //     and they never reached `_archive_<sdkSessionId>.jsonl`. The throw
  //     also skips the post-rename old-inode drain and the trigger file, and
  //     escapes `compactSession` as a raw stack rather than a result the CLI
  //     can print as `{"status":"error"}`. Nothing recovers that.
  //
  //   archive-before-rename: the archive lands, the rewrite then fails, and
  //     the transcript holds events that are still in the session too. The
  //     retry used to append them a second time — which is why this moved.
  //     `archiveEvents` now skips uuids already present in the archive tail,
  //     so the retry is a no-op and the duplicate never happens.
  //
  // A failure here is therefore reported, not thrown, and leaves the session
  // file exactly as it was: everything above this line is undone by simply
  // not renaming.
  try {
    archiveEvents(req.transcriptPath, allEvents, removeSet);
  } catch (err) {
    log.warn({
      err,
      sessionId: req.sdkSessionId,
      transcriptPath: req.transcriptPath,
    }, "Compact aborted: could not archive the removed events");
    return {
      success: false,
      eventsRemoved: 0,
      eventsAfter: allEvents.length,
      error: `Could not archive removed events to ${req.transcriptPath}: ` +
        `${err instanceof Error ? err.message : String(err)}; session left unchanged`,
    };
  }

  // Atomic write: stage the new content in a sibling temp file and rename
  // into place. The rename is atomic at the filesystem level, so the SDK's
  // appender (which re-opens the path on each append) either sees the old
  // file fully or the new file fully — never a half-written state. The
  // post-rename drain below covers appends that land on the old inode after
  // this final tail read.
  //
  // `writeFileAtomicSync` is that staging, and its temp name carries pid +
  // uuid: `tomo lcm` is a CLI, so two invocations — an agent-triggered
  // compact and a hand-run one, or two sessions' housekeeping turns — can be
  // staging over the same session file at once, and one fixed staging name
  // means one writes into the file the other is about to publish. It also
  // unlinks its own corpse on failure instead of leaving a full copy of the
  // session beside it, and preserves the file's mode across the rename.
  const output = newEvents.map(serializeJsonlRecord).join("\n") + "\n";
  writeFileAtomicSync(path, output, { beforeRename: req.beforeRenameForTest });
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
  writeFileSync(getCompactTriggerPath(req.sdkSessionId, req.sdkSessionsDir), new Date().toISOString());

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

function findUnrelatedSummaryInExpansionGap(
  events: readonly SdkEntry[],
  blockTag: string,
  removeStartGlobal: number,
  removeEndGlobal: number,
  origStartGlobal: number,
  origEndGlobal: number,
): { index: number; tag: string } | null {
  for (let i = removeStartGlobal; i < origStartGlobal; i++) {
    const conflict = unrelatedSummaryConflict(events[i], blockTag, i);
    if (conflict) return conflict;
  }
  for (let i = origEndGlobal + 1; i <= removeEndGlobal; i++) {
    const conflict = unrelatedSummaryConflict(events[i], blockTag, i);
    if (conflict) return conflict;
  }
  return null;
}

function unrelatedSummaryConflict(
  event: SdkEntry,
  blockTag: string,
  index: number,
): { index: number; tag: string } | null {
  // A line nobody could parse is not a summary block.
  if (isRawJsonlLine(event)) return null;
  if (!event.isCompactSummary) return null;
  if (event.blockTag === blockTag) return null;
  return { index, tag: event.blockTag ?? "legacy" };
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
): { events: SdkEntry[]; readUpTo: number; hasPartialTail: boolean } {
  const fd = openSync(path, "r");
  try {
    return readSinceOffsetFromFd(fd, offset);
  } finally {
    closeSync(fd);
  }
}

/** Shared with prune-tools, which rewrites the same live JSONL files. */
export function readWholeFileFromFd(fd: number): {
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

/** Shared with prune-tools, which rewrites the same live JSONL files. */
export function readSinceOffsetFromFd(
  fd: number,
  offset: number,
): { events: SdkEntry[]; readUpTo: number; hasPartialTail: boolean } {
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
  // preserveUnparseable: both callers splice these events straight back into
  // the file they are rewriting.
  const events: SdkEntry[] = parseJsonl<SdkEvent>(completeBytes, { preserveUnparseable: true });
  return {
    events,
    readUpTo: offset + lastNl + 1,
    hasPartialTail: total > lastNl + 1,
  };
}

/**
 * Shared with prune-tools. Pass empty `removedUuids` (and any value for
 * `summaryUuid`) when the rewrite removed no events — the re-stitch is then
 * a no-op and this purely drains late appends from the old inode.
 */
export function drainOldInodeAfterRename(args: {
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
      if (isRawJsonlLine(e)) {
        lines.push(serializeJsonlRecord(e));
        appended++;
        continue;
      }
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
export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A staging corpse is stale once it is older than this. */
const STAGING_CORPSE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Names every session-rewrite staging file this codebase produces:
 * `<sessionId>.jsonl` plus a per-call suffix and `.tmp` — the
 * `.<pid>.<uuid>.tmp` of `writeFileAtomicSync`, prune-tools' `.pruning.tmp`,
 * and the `.compacting.tmp` compact used to write (both the historical fixed
 * name and the pid+uuid one). Anchored on `.jsonl.` so it can never match a
 * session file itself.
 */
const STAGING_TMP_RE = /\.jsonl\..+\.tmp$/;

/**
 * Delete session-rewrite staging files older than `maxAgeMs` from `dir`.
 *
 * Best-effort and never throws: this is housekeeping in front of the real
 * work, and a compact must not fail because a directory listing did.
 * Returns the number of files removed (for logging and tests).
 */
export function sweepStaleStagingFiles(
  dir: string,
  now: number = Date.now(),
  maxAgeMs: number = STAGING_CORPSE_MAX_AGE_MS,
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // no directory yet, or unreadable — nothing to sweep
  }
  for (const name of entries) {
    if (!STAGING_TMP_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      // mtime, not ctime: a corpse is never touched again after it is written,
      // so its last write IS its age.
      if (now - statSync(full).mtimeMs < maxAgeMs) continue;
      unlinkSync(full);
      removed++;
    } catch { /* raced with another sweep, or not ours to delete */ }
  }
  if (removed > 0) log.info({ dir, removed }, "Swept stale session staging files");
  return removed;
}

/**
 * How much of the archive tail to scan for uuids that are already there.
 *
 * The duplicate this guards against is a retry of a compact that archived its
 * range and then failed to publish the rewrite, so the lines it would repeat
 * are the newest ones in the file — a bounded tail is enough, and the whole
 * transcript (which grows without limit) is not something to parse on every
 * compact. Both caps apply; whichever bites first wins.
 */
const ARCHIVE_DEDUPE_TAIL_BYTES = 4 * 1024 * 1024;
const ARCHIVE_DEDUPE_TAIL_LINES = 5000;

/**
 * uuids of the events in the tail of an existing archive file.
 *
 * Best-effort by construction: an unreadable or unparseable archive yields an
 * empty set, which only means the caller archives the range as it always did.
 */
function archivedUuidsInTail(transcriptPath: string): Set<string> {
  const uuids = new Set<string>();
  if (!existsSync(transcriptPath)) return uuids;
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return uuids;
    const want = Math.min(size, ARCHIVE_DEDUPE_TAIL_BYTES);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString("utf-8").split("\n");
    // A byte-offset start almost never lands on a line boundary, so the first
    // chunk is half a line. Drop it rather than fail to parse it.
    if (start > 0) lines.shift();
    for (const line of lines.slice(-ARCHIVE_DEDUPE_TAIL_LINES)) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { uuid?: unknown };
        if (typeof parsed?.uuid === "string") uuids.add(parsed.uuid);
      } catch { /* a line we cannot read is a line we cannot dedupe on */ }
    }
  } catch (err) {
    log.debug({ err, transcriptPath }, "Could not read the archive tail for dedupe");
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return uuids;
}

/**
 * Archive removed events to a transcript JSONL file.
 *
 * Idempotent over the archive's tail: an event whose uuid is already there is
 * not written again. That is what lets the archive run BEFORE the session
 * rewrite is published (see the call site) — a compact that archives and then
 * fails to publish can simply be re-run, instead of leaving the events in
 * neither place if the ordering were reversed and the archive threw.
 */
function archiveEvents(transcriptPath: string, allEvents: readonly SdkEntry[], removeSet: Set<number>): void {
  const dir = dirname(transcriptPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const alreadyArchived = archivedUuidsInTail(transcriptPath);
  const archiveLines: string[] = [];
  let skipped = 0;
  for (const idx of Array.from(removeSet).sort((a, b) => a - b)) {
    const event = allEvents[idx];
    // removeSet never contains a carrier — archiving one would write an
    // `{_archived:true}` stub with no payload and claim it was summarized.
    if (isRawJsonlLine(event)) continue;
    // An event with no uuid cannot be recognised on a retry; archiving it
    // twice is better than losing it.
    if (event.uuid && alreadyArchived.has(event.uuid)) { skipped++; continue; }
    archiveLines.push(JSON.stringify({
      _archived: true,
      _archivedAt: new Date().toISOString(),
      _originalIdx: idx,
      ...event,
    }));
  }

  if (skipped > 0) {
    log.info({ transcriptPath, skipped, archived: archiveLines.length }, "Archive skipped events already in the transcript");
  }
  if (archiveLines.length === 0) return;
  appendFileSync(transcriptPath, archiveLines.join("\n") + "\n");
}
