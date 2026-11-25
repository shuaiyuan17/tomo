import { join } from "node:path";
import { existsSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";
import { readJsonlFileSync } from "../jsonl.js";
import { log } from "../logger.js";
import { errorMessage } from "../error-text.js";
import { textOfContent, type TranscriptEvent } from "../sessions/transcript-event.js";
import { compactSessionChecked, type ChainCheckOptions } from "./chain-check.js";
import { checkAndClearCompactTrigger } from "./compact.js";
import { globalFreshTailStartIdx, localDateTag } from "./blocks.js";
import { pruneTools } from "./prune-tools.js";
import { computeContextStatsFromEvents, estimateTokens } from "./stats.js";
import { capStaleUsageInFile } from "./stale-usage.js";

/**
 * FORCED COMPACTION — the disk half (the daemon half, which stops the session
 * and its background work first, is `agent/force-compactor.ts`).
 *
 * The normal path asks the session's own model to roll its history up. That
 * fails exactly when it matters: a session at the edge of its window has no
 * room left to write a summary, and one past it cannot run a turn at all
 * ("Prompt is too long"). Here the harness does it without the session:
 *
 *   1. prune-tools — purely mechanical; stop if the estimate is now under the
 *      safe line.
 *   2. Summarize the OLDEST raw stretch (one local day, or a prefix of it when
 *      that day alone is over `maxInputTokens`) with a separate, clean model
 *      call fed only that stretch's original text, and publish it through the
 *      same checked rewrite as `tomo lcm daily` (`compactSessionChecked`: the
 *      SDK's own loader must see an intact chain, or nothing is written). The
 *      block is tagged `daily <day>`, so a later rollup of that day rebuilds it
 *      in place like any other daily block. Repeat while over the safe line.
 *   3. When the summary call or its validation fails: archive the stretch
 *      instead — the same checked rewrite with a one-line placeholder. The
 *      raw events go to the session's archive file like any compacted range
 *      and stay searchable (`tomo lcm search`). When even that rewrite is
 *      refused, stop: fail closed, the file stays as it is.
 *   4. Cap stale usage readings (`stale-usage.ts`), so the CLI's local window
 *      check reads the rewritten session and not the last pre-compaction
 *      reply's usage.
 *
 * Estimates: the file's content estimate (`computeContextStats`) calibrated
 * once against the last real reading — `overhead` is what the reading had on
 * top of the content (system prompt, tools), carried over unchanged.
 */

/** Estimated usage a forced compaction aims to get under, % of the window. */
export const FORCE_COMPACT_SAFE_PCT = 70;
/** Most original text one summary call is fed. */
export const FORCE_COMPACT_MAX_INPUT_TOKENS = 150_000;
/** Summary rounds per forced compaction. */
export const FORCE_COMPACT_MAX_ROUNDS = 8;
/** Fresh tail kept when the configured one leaves nothing older to compact. */
export const FORCE_COMPACT_MIN_TAIL = 4;
/** A summary longer than this (estimated tokens) is refused and the stretch archived instead. */
export const FORCE_SUMMARY_MAX_TOKENS = 8_000;
/** Per-message caps when rendering a stretch for the summary call. */
const TOOL_RESULT_CHARS = 1_500;
const TOOL_INPUT_CHARS = 300;

interface Ev extends TranscriptEvent {
  type: string;
  uuid?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  blockTag?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown; id?: string; model?: string };
  [k: string]: unknown;
}

/** What the summary call is given. */
export interface StretchForSummary {
  /** Local "YYYY-MM-DD HH:MM" of the first and last event. */
  from: string;
  to: string;
  events: number;
  /** "whole day 2026-11-24" or "part of 2026-11-24". */
  label: string;
  /** The stretch's original text, rendered. */
  text: string;
}

interface Stretch extends StretchForSummary {
  blockTag: string;
  fromConv: number;
  toConv: number;
  firstUuid?: string;
  lastUuid?: string;
  /** The text of an existing block with the same tag, absorbed by the rewrite. */
  existingBlock?: string;
}

export interface ForceCompactOptions {
  /** Shutdown: no rewrite starts once this is aborted (the summary call is cut short too). */
  signal?: AbortSignal;
  sdkSessionId: string;
  sdkSessionsDir: string;
  /** Tomo's sessions dir: the archive (`_archive_<id>.jsonl`) lives there. */
  sessionsDir: string;
  /** The workspace the SDK resolves the session under (chain check). */
  workspaceDir: string;
  /** Last real context reading (tokens), if any: calibrates the estimate. */
  contextUsed?: number;
  /** The window (tokens). */
  contextMax: number;
  freshTail: number;
  summarize: (stretch: StretchForSummary) => Promise<string>;
  safePct?: number;
  maxInputTokens?: number;
  maxRounds?: number;
  /** @internal test seam for the chain check's loader. */
  loadChain?: ChainCheckOptions["loadChain"];
}

export interface ForceCompactStep {
  from: string;
  to: string;
  events: number;
  blockTag: string;
}

export interface ForceCompactReport {
  /** Estimated tokens before / after (the "before" is the real reading when there was one). */
  beforeTokens: number;
  afterTokens: number;
  contextMax: number;
  pruned: { entries: number; chars: number } | null;
  summarized: ForceCompactStep[];
  archived: ForceCompactStep[];
  usageCapped: number;
  /** The estimate ended at or under the safe line. */
  reachedSafe: boolean;
  /**
   * The run left the session usable: no rewrite was refused and the stale
   * usage readings were capped. False means a failure the owner must hear of,
   * whatever else was done.
   */
  ok: boolean;
  /** Anything that failed along the way (a refused rewrite stops the run). */
  errors: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");
function localStamp(ts: string | undefined): string {
  if (!ts) return "?";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "?";
  return `${localDateTag(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [${s.length - n} more chars]`;
}

/** One event as the summary call reads it. Exported for tests. */
export function renderEventForSummary(e: Ev): string {
  const stamp = `[${localStamp(e.timestamp)}]`;
  const content = e.message?.content;
  if (e.isCompactSummary) return `${stamp} [earlier summary]\n${textOfContent(content, "\n")}`;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use") {
        parts.push(`[called ${String(block.name ?? "tool")} ${clip(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS)}]`);
      } else if (block.type === "tool_result") {
        const c = block.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? textOfContent(c, "\n") : "";
        parts.push(`[tool result${block.is_error ? " (error)" : ""}: ${clip(text, TOOL_RESULT_CHARS)}]`);
      } else if (block.type === "image") parts.push("[image]");
      else if (block.type === "document") parts.push("[document]");
    }
  }
  const body = parts.join("\n").trim();
  return body ? `${stamp} ${e.type}: ${body}` : "";
}

function isToolResultTurn(e: Ev | undefined): boolean {
  return !!e && e.type === "user" && Array.isArray(e.message?.content)
    && (e.message!.content as Array<{ type?: string }>).some((b) => b?.type === "tool_result");
}

/**
 * The oldest raw stretch to compact, or null. Exported for tests.
 *
 * Starts at the oldest raw (non-summary) user/assistant event after the last
 * SDK compact boundary; runs over that one local day, stops before the fresh
 * tail, before any summary block that is not that day's own, and before the
 * rendered text passes `maxInputTokens` (at least one event is always taken).
 * The end is then moved so the retained side does not begin with a tool
 * result whose call was removed, or in the middle of one assistant message
 * (records sharing a message id): back first, forward if backing off empties
 * the range.
 */
export function selectOldestStretch(events: Ev[], opts: { freshTail: number; maxInputTokens: number }): Stretch | null {
  let boundary = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "system" && events[i].subtype === "compact_boundary") { boundary = i + 1; break; }
  }
  const tailStart = globalFreshTailStartIdx(events.slice(boundary) as never, opts.freshTail) + boundary;
  const isConv = (e: Ev) => e.type === "user" || e.type === "assistant";
  let start = -1;
  for (let i = boundary; i < tailStart; i++) {
    if (isConv(events[i]) && !events[i].isCompactSummary) { start = i; break; }
  }
  if (start < 0) return null;
  const day = events[start].timestamp ? localDateTag(new Date(events[start].timestamp!)) : undefined;
  if (!day) return null;
  const blockTag = `daily ${day}`;

  const included: number[] = [];
  let tokens = 0;
  let wholeDay = true;
  for (let i = start; i < tailStart; i++) {
    const e = events[i];
    if (!isConv(e)) continue;
    if (e.isCompactSummary) {
      if (e.blockTag === blockTag) continue; // absorbed by the rewrite's own expansion
      wholeDay = false;
      break;
    }
    if (e.timestamp && localDateTag(new Date(e.timestamp)) !== day) break;
    const t = estimateTokens(renderEventForSummary(e));
    if (included.length > 0 && tokens + t > opts.maxInputTokens) { wholeDay = false; break; }
    included.push(i);
    tokens += t;
  }
  if (included.length === 0) return null;
  if (included[included.length - 1] < tailStart - 1) {
    // Did the day end, or did something cut it short? A later event of the same day still ahead means a partial day.
    for (let i = included[included.length - 1] + 1; i < events.length; i++) {
      const e = events[i];
      if (!isConv(e) || e.isCompactSummary) continue;
      if (e.timestamp && localDateTag(new Date(e.timestamp)) === day) wholeDay = false;
      break;
    }
  } else if (tailStart < events.length) {
    wholeDay = false;
  }

  const nextConv = (after: number): Ev | undefined => {
    for (let i = after + 1; i < events.length; i++) if (isConv(events[i])) return events[i];
    return undefined;
  };
  const badCut = (endIdx: number): boolean => {
    const next = nextConv(endIdx);
    if (isToolResultTurn(next)) return true;
    const id = events[endIdx].message?.id;
    return !!next && next.type === "assistant" && !!id && next.message?.id === id;
  };
  let endPos = included.length - 1;
  while (endPos >= 0 && badCut(included[endPos])) endPos--;
  let chosen = included.slice(0, endPos + 1);
  if (chosen.length === 0) {
    // Back-off emptied it: extend forward over the tool round instead (the
    // input cap is soft; tool results are clipped when rendered anyway).
    chosen = [...included];
    let end = chosen[chosen.length - 1];
    for (let guard = 0; badCut(end) && guard < 10_000; guard++) {
      let next = -1;
      for (let i = end + 1; i < tailStart; i++) if (isConv(events[i])) { next = i; break; }
      if (next < 0 || events[next].isCompactSummary) return null;
      chosen.push(next);
      end = next;
    }
    if (badCut(end)) return null;
    wholeDay = false;
  } else if (chosen.length < included.length) {
    wholeDay = false;
  }

  let conv = 0;
  const convIdx = new Map<number, number>();
  for (let i = 0; i < events.length; i++) if (isConv(events[i])) convIdx.set(i, conv++);
  const first = chosen[0];
  const last = chosen[chosen.length - 1];
  // The rewrite absorbs every block with the same tag, and everything between
  // it and the range. A same-day block BEFORE the stretch only spans non-raw
  // events (the stretch starts at the oldest raw one); one AFTER it would pull
  // in events the summary call never saw — then the block gets a tag of its own.
  const sameDay = events.map((e, i) => (e.isCompactSummary && e.blockTag === blockTag ? i : -1)).filter((i) => i >= 0);
  const tag = sameDay.some((i) => i > last)
    ? `forced ${day} ${localStamp(events[first].timestamp).slice(11)}`
    : blockTag;
  const existing = tag === blockTag ? events.find((e) => e.isCompactSummary && e.blockTag === blockTag) : undefined;
  const existingBlock = existing ? textOfContent(existing.message?.content, "\n").replace(/^\[[^\]\n]*\]\s*/, "").trim() : undefined;
  const lines = chosen.map((i) => renderEventForSummary(events[i])).filter(Boolean);
  if (existingBlock) lines.unshift(`[earlier summary of ${day}, to be merged into the new block]\n${existingBlock}`);
  return {
    blockTag: tag,
    fromConv: convIdx.get(first)!,
    toConv: convIdx.get(last)!,
    firstUuid: events[first].uuid,
    lastUuid: events[last].uuid,
    from: localStamp(events[first].timestamp),
    to: localStamp(events[last].timestamp),
    events: chosen.length,
    label: wholeDay ? `whole day ${day}` : `part of ${day}`,
    text: lines.join("\n\n"),
    ...(existingBlock ? { existingBlock } : {}),
  };
}

/** Why a summary is refused (then the stretch is archived instead), or null. Exported for tests. */
export function summaryRejection(summary: string | null | undefined): string | null {
  const s = (summary ?? "").trim();
  if (s.length < 40) return "summary empty or too short";
  if (/^(API Error|Prompt is too long|Error:)/i.test(s)) return "summary call returned an error text";
  if (estimateTokens(s) > FORCE_SUMMARY_MAX_TOKENS) return `summary over ${FORCE_SUMMARY_MAX_TOKENS} tokens`;
  return null;
}

export function forceArchivePlaceholder(stretch: Pick<Stretch, "events" | "from" | "to" | "existingBlock">): string {
  const line = `[force-archived ${stretch.events} events from ${stretch.from} to ${stretch.to}; use \`tomo lcm search\` to recall]`;
  return stretch.existingBlock ? `${line}\n\nEarlier summary of this day, kept as it was:\n${stretch.existingBlock}` : line;
}

function loadEvents(sdkSessionId: string, sdkSessionsDir: string): Ev[] {
  const path = getSdkSessionPath(sdkSessionId, sdkSessionsDir);
  return existsSync(path) ? readJsonlFileSync<Ev>(path) : [];
}

export async function forceCompactSession(o: ForceCompactOptions): Promise<ForceCompactReport> {
  const window = o.contextMax;
  if (!existsSync(getSdkSessionPath(o.sdkSessionId, o.sdkSessionsDir))) {
    return {
      beforeTokens: o.contextUsed ?? 0, afterTokens: o.contextUsed ?? 0, contextMax: window, pruned: null,
      summarized: [], archived: [], usageCapped: 0, reachedSafe: false, ok: false, errors: ["session file not found"],
    };
  }
  const safeTokens = Math.floor(window * (o.safePct ?? FORCE_COMPACT_SAFE_PCT) / 100);
  // The active chain only: nothing before the last SDK compact boundary is loaded.
  const fileEstimate = () => {
    const events = loadEvents(o.sdkSessionId, o.sdkSessionsDir);
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "system" && events[i].subtype === "compact_boundary") { start = i + 1; break; }
    }
    return computeContextStatsFromEvents(events.slice(start)).totalTokens;
  };
  const est0 = fileEstimate();
  const overhead = o.contextUsed && o.contextUsed > 0
    ? Math.min(Math.max(0, o.contextUsed - est0), Math.floor(window * 0.5))
    : Math.min(40_000, Math.floor(window * 0.2));
  const estimate = () => overhead + fileEstimate();
  const report: ForceCompactReport = {
    beforeTokens: o.contextUsed && o.contextUsed > 0 ? o.contextUsed : overhead + est0,
    afterTokens: 0,
    contextMax: window,
    pruned: null,
    summarized: [],
    archived: [],
    usageCapped: 0,
    reachedSafe: false,
    ok: false,
    errors: [],
  };
  const archivePath = join(o.sessionsDir, `_archive_${o.sdkSessionId}.jsonl`);
  const chainOpts: ChainCheckOptions = {
    workspaceDir: o.workspaceDir,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.loadChain ? { loadChain: o.loadChain } : {}),
  };

  const aborted = () => {
    if (!o.signal?.aborted) return false;
    if (!report.errors.includes("aborted (shutdown)")) report.errors.push("aborted (shutdown)");
    return true;
  };

  // ② Prune: mechanical, no model.
  if (!aborted()) try {
    const pr = pruneTools({ sdkSessionId: o.sdkSessionId, sdkSessionsDir: o.sdkSessionsDir, archivePath });
    if (pr.success) {
      if (pr.pruned.length > 0) report.pruned = { entries: pr.pruned.length, chars: pr.totalCharsRemoved };
    } else report.errors.push(`prune: ${pr.error ?? "failed"}`);
  } catch (err) {
    report.errors.push(`prune: ${errorMessage(err)}`);
  }

  // ③ / ④ Summarize (or archive) the oldest stretch until under the safe line.
  let stopped = false;
  for (let round = 0; round < (o.maxRounds ?? FORCE_COMPACT_MAX_ROUNDS) && !stopped && !aborted() && estimate() > safeTokens; round++) {
    const events = loadEvents(o.sdkSessionId, o.sdkSessionsDir);
    const maxInputTokens = o.maxInputTokens ?? FORCE_COMPACT_MAX_INPUT_TOKENS;
    const stretch = selectOldestStretch(events, { freshTail: o.freshTail, maxInputTokens })
      ?? (o.freshTail > FORCE_COMPACT_MIN_TAIL ? selectOldestStretch(events, { freshTail: FORCE_COMPACT_MIN_TAIL, maxInputTokens }) : null);
    if (!stretch) break;
    const step: ForceCompactStep = { from: stretch.from, to: stretch.to, events: stretch.events, blockTag: stretch.blockTag };
    const range = {
      sdkSessionId: o.sdkSessionId,
      sdkSessionsDir: o.sdkSessionsDir,
      fromIdx: stretch.fromConv,
      toIdx: stretch.toConv,
      expectedFirstUuid: stretch.firstUuid,
      expectedLastUuid: stretch.lastUuid,
      transcriptPath: archivePath,
      blockTag: stretch.blockTag,
      dropUnparseable: false,
    };

    let summary: string | null = null;
    try {
      summary = await o.summarize(stretch);
    } catch (err) {
      report.errors.push(`summary ${stretch.from}–${stretch.to}: ${errorMessage(err)}`);
    }
    const rejection = summary === null ? "summary call failed" : summaryRejection(summary);
    if (summary !== null && rejection) report.errors.push(`summary ${stretch.from}–${stretch.to}: ${rejection}`);
    if (aborted()) break;
    if (!rejection) {
      const text = `(Forced compaction: written by a separate summary model from the original messages, ${stretch.from} → ${stretch.to}.)\n\n${summary!.trim()}`;
      const res = await compactSessionChecked({ ...range, summary: text }, chainOpts);
      if (res.success) {
        report.summarized.push(step);
        continue;
      }
      report.errors.push(`summary rewrite ${stretch.from}–${stretch.to}: ${res.error ?? "failed"}`);
    }
    // ④ Fallback: archive the stretch with a one-line placeholder.
    if (aborted()) break;
    const res = await compactSessionChecked({ ...range, summary: forceArchivePlaceholder(stretch) }, chainOpts);
    if (res.success) {
      report.archived.push(step);
    } else {
      report.errors.push(`archive rewrite ${stretch.from}–${stretch.to}: ${res.error ?? "failed"}`);
      stopped = true; // fail closed: the same rewrite would be refused again
    }
  }

  // ⑤ Stale usage: the CLI must not read the pre-compaction reply's usage.
  // Capped at the honest estimate of what is left (never below it), and not
  // at all after a refused rewrite or a shutdown: that would only hide a
  // session that is still too big from the CLI's check.
  const after = estimate();
  report.afterTokens = after;
  report.reachedSafe = after <= safeTokens;
  if (!stopped && !aborted()) {
    const capped = capStaleUsageInFile({ sdkSessionId: o.sdkSessionId, sdkSessionsDir: o.sdkSessionsDir, overhead });
    if (capped.success) {
      report.usageCapped = capped.capped;
      // A run that changed nothing did not recover anything.
      report.ok = !!report.pruned || report.summarized.length > 0 || report.archived.length > 0 || capped.capped > 0;
      if (!report.ok) report.errors.push("nothing could be compacted");
    } else report.errors.push(`usage cap: ${capped.error ?? "failed"}`);
  }

  // The live session is already closed and resumes from disk: a trigger left
  // by the rewrites above would only close the NEXT session after its first turn.
  try {
    checkAndClearCompactTrigger(o.sdkSessionId, o.sdkSessionsDir);
  } catch (err) {
    report.errors.push(`trigger: ${errorMessage(err)}`);
  }
  log.info({
    sessionId: o.sdkSessionId,
    beforeTokens: report.beforeTokens,
    afterTokens: report.afterTokens,
    pruned: report.pruned,
    summarized: report.summarized.length,
    archived: report.archived.length,
    usageCapped: report.usageCapped,
    errors: report.errors,
  }, "Forced compaction finished");
  return report;
}
