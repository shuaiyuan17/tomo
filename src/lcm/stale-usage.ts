import { closeSync, existsSync, openSync } from "node:fs";
import { writeFileAtomicSync } from "../fs-utils.js";
import { getSdkSessionPath } from "../sessions/index.js";
import { isRawJsonlLine, parseJsonl, reportRawJsonlLines, serializeJsonlRecord } from "../jsonl.js";
import { log } from "../logger.js";
import { errorMessage } from "../error-text.js";
import { computeContextStatsFromEvents } from "./stats.js";
import {
  drainOldInodeAfterRename,
  readSinceOffsetFromFd,
  readWholeFileFromFd,
  sleepMs,
  type SdkEntry,
} from "./compact.js";

/**
 * STALE USAGE AFTER A REWRITE — why a compacted session can still be refused.
 *
 * Before it sends a turn, the Claude Code CLI decides locally whether the
 * conversation still fits the window, and it does not count the conversation
 * to decide. It walks the loaded messages back from the end to the newest
 * assistant message that carries a real `message.usage` (not a `<synthetic>`
 * error frame, not an all-zero reading), takes that reading as the size of
 * everything up to it — input + cache creation + cache read + output, from the
 * last valid entry of `usage.iterations` when there is one — and adds a rough
 * character estimate of what came after. Over the blocking limit, the turn
 * ends with "Prompt is too long" without any API call (CLI 2.1.330:
 * `VQr`/`ip`/`Imt`/`EM`; the 11/25 incident: a 977K reading on the last
 * assistant message kept refusing a session that a rewrite had already cut to
 * a fraction of that).
 *
 * A rewrite that removes or shrinks events does not change that number: the
 * message keeps the usage it was answered with. So a forced compaction ends by
 * capping it: every assistant record whose reading exceeds `ceiling` gets a
 * reading of `ceiling` (iterations dropped, cache fields zeroed, the original
 * total kept in `tomoUsageCapped`). Zeroing it would not work — the CLI skips
 * a zero reading and falls through to the next older one, which is just as
 * stale. Under-reading is safe: the CLI then sends the turn, and the API's
 * reply carries the true usage, which becomes the new anchor. Over-reading is
 * the failure mode, so the ceiling is never above the harness's own estimate.
 */

/** input + cache creation + cache read + output, as the CLI totals one reading (`EM`). */
function usageTotal(u: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
}

/** The reading the CLI takes from one usage object: the last valid `iterations` entry, else the top level (`Q9`). */
export function effectiveUsageTotal(usage: unknown): number {
  if (usage === null || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const top = usageTotal(u);
  const its = u.iterations;
  if (top === 0 || !Array.isArray(its)) return top;
  for (let i = its.length - 1; i >= 0; i--) {
    const it = its[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type === "advisor_message" || it.type === "compaction") continue;
    if ((it.type === "message" || it.type === "fallback_message") && usageTotal(it) - (typeof it.output_tokens === "number" ? it.output_tokens : 0) > 0) {
      return usageTotal(it);
    }
    return top;
  }
  return top;
}

const SYNTHETIC_MODEL = "<synthetic>";

/**
 * The CLI's anchor reading for a message list, as described above: the
 * effective total of the newest assistant message with a non-zero, non-
 * synthetic usage, or undefined when there is none (the CLI then estimates
 * the whole conversation). The rough estimate of what follows the anchor is
 * not included. Exported for tests and diagnostics.
 */
export function cliAnchorUsage(events: readonly unknown[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; subtype?: string; message?: { model?: string; usage?: unknown }; isUnmetered?: boolean } | null;
    if (!e || typeof e !== "object") continue;
    if (e.type === "system" && e.subtype === "compact_boundary") return 0;
    if (e.type !== "assistant" || !e.message || !("usage" in e.message)) continue;
    if (e.message.model === SYNTHETIC_MODEL || e.isUnmetered === true) continue;
    const u = e.message.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    const inputSide = usageTotal(u) - (typeof u.output_tokens === "number" ? u.output_tokens : 0);
    if (inputSide <= 0) continue;
    return effectiveUsageTotal(u);
  }
  return undefined;
}

/**
 * Cap every assistant reading above `ceiling` in place. Returns how many
 * records were changed. Pure over the entries (raw unparseable lines are
 * skipped untouched).
 */
export function capStaleUsage(entries: SdkEntry[], ceiling: number | ((index: number) => number), now: Date = new Date()): number {
  let changed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (isRawJsonlLine(e)) continue;
    const cap = Math.max(2, Math.floor(typeof ceiling === "number" ? ceiling : ceiling(i)));
    if (e.type !== "assistant" || !e.message || typeof e.message !== "object") continue;
    const usage = (e.message as { usage?: unknown }).usage;
    if (usage === null || typeof usage !== "object") continue;
    const before = Math.max(effectiveUsageTotal(usage), usageTotal(usage as Record<string, unknown>));
    if (before <= cap) continue;
    const u = usage as Record<string, unknown>;
    const output = Math.min(typeof u.output_tokens === "number" && u.output_tokens >= 0 ? u.output_tokens : 0, Math.floor(cap / 2));
    const capped: Record<string, unknown> = {
      ...u,
      input_tokens: cap - output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: output,
    };
    delete capped.iterations;
    if (capped.cache_creation && typeof capped.cache_creation === "object") {
      capped.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    }
    entries[i] = {
      ...e,
      message: { ...(e.message as object), usage: capped } as unknown as typeof e.message,
      tomoUsageCapped: { from: before, to: cap, at: now.toISOString() },
    };
    changed++;
  }
  return changed;
}

export interface CapUsageResult {
  success: boolean;
  capped: number;
  error?: string;
}

/**
 * Rewrite the session file with every stale reading capped at `ceiling`
 * (see above). Same concurrent-append machinery as prune-tools: a pinned
 * snapshot, late appends spliced (and capped too), an atomic rename, the old
 * inode drained. Only usage fields change, so the parentUuid chain is the one
 * that was on disk. Leaves no compact trigger: the caller has already closed
 * the live session. Nothing is written when nothing needs capping.
 */
/**
 * Per record: `overhead` plus the estimated content of the active chain up to
 * and including it — what the context really held when that reply was
 * written. The CLI adds its own estimate of everything AFTER its anchor, so a
 * ceiling for the whole conversation would count that tail twice.
 */
export function ceilingsThrough(entries: SdkEntry[], overhead: number): (index: number) => number {
  const through: number[] = [];
  let sum = 0;
  for (const e of entries) {
    if (!isRawJsonlLine(e)) {
      if (e.type === "system" && (e as { subtype?: string }).subtype === "compact_boundary") sum = 0;
      else if (e.type === "user" || e.type === "assistant") sum += computeContextStatsFromEvents([e as never]).totalTokens;
    }
    through.push(sum);
  }
  return (i) => overhead + (through[i] ?? sum);
}

export function capStaleUsageInFile(args: { sdkSessionId: string; sdkSessionsDir: string; overhead: number }): CapUsageResult {
  const path = getSdkSessionPath(args.sdkSessionId, args.sdkSessionsDir);
  if (!existsSync(path)) return { success: false, capped: 0, error: "Session file not found" };
  const fd = openSync(path, "r");
  try {
    const snapshot = readWholeFileFromFd(fd);
    const events: SdkEntry[] = parseJsonl(snapshot.text, { preserveUnparseable: true }) as SdkEntry[];
    reportRawJsonlLines(events, { sessionId: args.sdkSessionId, op: "cap-usage" });
    const late: SdkEntry[] = [];
    const seenLateUuids = new Set<string>();
    let cursor = snapshot.size;
    let partial = false;
    for (let pass = 0; pass < 8; pass++) {
      const r = readSinceOffsetFromFd(fd, cursor);
      for (const e of r.events) {
        if (!isRawJsonlLine(e) && e.uuid) {
          if (seenLateUuids.has(e.uuid)) continue;
          seenLateUuids.add(e.uuid);
        }
        late.push(e);
      }
      cursor = r.readUpTo;
      partial = r.hasPartialTail;
      if (!partial) break;
      if (pass < 7) sleepMs(5);
    }
    if (partial) return { success: false, capped: 0, error: "Partial SDK write in flight; retry" };
    const all = [...events, ...late];
    const capped = capStaleUsage(all, ceilingsThrough(all, args.overhead));
    if (capped === 0) return { success: true, capped: 0 };
    writeFileAtomicSync(path, all.map(serializeJsonlRecord).join("\n") + "\n");
    drainOldInodeAfterRename({ sourceFd: fd, startOffset: cursor, path, removedUuids: new Set(), summaryUuid: "", seenLateUuids });
    log.info({ sessionId: args.sdkSessionId, capped, overhead: args.overhead }, "Capped stale usage readings after a forced compaction");
    return { success: true, capped };
  } catch (err) {
    return { success: false, capped: 0, error: errorMessage(err) };
  } finally {
    closeSync(fd);
  }
}
