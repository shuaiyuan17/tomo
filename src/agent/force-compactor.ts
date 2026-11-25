import { config } from "../config.js";
import { log } from "../logger.js";
import { errorMessage } from "../error-text.js";
import { joinText, ownerT, type OwnerText } from "../i18n/index.js";
import { formatTomoEvent } from "../tomo-event.js";
import { isGroupSessionKey, isTaskSessionKey } from "../sessions/keys.js";
import type { ForceCompactReport } from "../lcm/force-compact.js";
import type { ForceCompactHold } from "./live-session-manager.js";
import type { QueryResult } from "./sdk-result.js";
import type { RunningTaskRecord } from "./running-agents-ledger.js";

/**
 * FORCED COMPACTION — the daemon half (the disk half is lcm/force-compact.ts).
 *
 * When a session's context is about to blow up (a turn ends at or over
 * `lcm.forceCompactAtPct`) or already has (a turn ends on "Prompt is too
 * long", the CLI's local refusal included), the harness compacts it itself
 * instead of asking the session's model, which has no room left to do it:
 *
 *   0. Hold the key, synchronously, at the end of the triggering turn
 *      (`LiveSessionManager.holdForForceCompact`): the one rewrite slot of the
 *      session is reserved (no `tomo lcm` / `lcm_rollup` / second forced run
 *      can start, and none already running is overtaken), and no turn is
 *      handed a session until the compaction is over — the session never runs
 *      a model turn in the middle of it. Unlike a normal compact, background
 *      work does NOT defer it: that is the point.
 *   1. Stop the background work: its running subagents and commands are
 *      recorded as interrupted in the running-agents ledger (the same record a
 *      restart leaves, #623), THEN the session is closed — which is what stops
 *      them — and its CLI child is waited for. A ledger write that fails
 *      aborts before anything is closed.
 *   2–5. `forceCompactSession`: prune, summarize the oldest stretch with a
 *      separate model call, archive as a fallback, cap stale usage readings.
 *   6. One note into the session (what was done), the interrupted-agents note
 *      and its resume turn (like after a restart), and ONE owner notice —
 *      for a group only its name, never its content.
 *
 * A key that keeps refilling is not compacted forever: at most
 * FORCE_COMPACT_MAX_PER_HOUR runs per key in an hour, then the owner is told
 * once and the session is left alone until the hour has passed.
 */

export const FORCE_COMPACT_MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export interface ForceCompactorDeps {
  hold(key: string): ForceCompactHold | null;
  quiesce(hold: ForceCompactHold, beforeClose: () => boolean): Promise<string | null>;
  /** Record the session's running background work as interrupted; null when the write failed, [] without a ledger. */
  markInterrupted(key: string): RunningTaskRecord[] | null;
  /** The session `markInterrupted` was called for is closed. */
  sessionClosed(key: string): void;
  compact(args: { key: string; sdkSessionId: string; contextUsed?: number; contextMax: number }): Promise<ForceCompactReport>;
  queueNote(key: string, note: string): boolean;
  notifyOwner(text: OwnerText): Promise<boolean>;
  /** A group's title, for the owner notice. */
  groupTitle(key: string): string | undefined;
  /** Tell the session about the interrupted work and queue the turn that resumes it (after the hold is released). */
  reportInterrupted(key: string, records: RunningTaskRecord[]): void;
  now?: () => number;
}

export type ForceCompactReason = "threshold" | "prompt-too-long";

export class ForceCompactor {
  private inFlight = new Map<string, Promise<void>>();
  private runs = new Map<string, number[]>();
  private gaveUpNoticeAt = new Map<string, number>();
  /** Last real window seen per key: a "Prompt is too long" result may carry none. */
  private windows = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ForceCompactorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Off at 0 and at 100, for both triggers. */
  static enabled(): boolean {
    const pct = config.lcm.forceCompactAtPct;
    return pct > 0 && pct < 100;
  }

  /** A run in progress for the key (tests, shutdown). */
  running(key: string): Promise<void> | undefined {
    return this.inFlight.get(key);
  }

  /**
   * Called after every turn. True when a forced compaction is running for
   * the key (started now or already) — the caller then skips the nudge.
   * Synchronous up to the hold, so no other turn can slip in between.
   */
  maybeStart(key: string, reading: QueryResult | null, reason: ForceCompactReason): boolean {
    if (!ForceCompactor.enabled()) return false;
    const real = reading && !reading.contextEstimated && reading.contextMax > 0 ? reading : null;
    if (real) this.windows.set(key, real.contextMax);
    if (this.inFlight.has(key)) return true;
    const pct = real ? (real.contextUsed / real.contextMax) * 100 : undefined;
    if (reason === "threshold" && (pct === undefined || pct < config.lcm.forceCompactAtPct)) return false;
    const contextMax = real?.contextMax ?? this.windows.get(key);
    if (!contextMax) {
      log.warn({ key, reason }, "Forced compaction skipped: no context window known for this session yet");
      return false;
    }
    const now = this.now();
    const recent = (this.runs.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    this.runs.set(key, recent);
    if (recent.length >= FORCE_COMPACT_MAX_PER_HOUR) {
      this.giveUp(key, recent.length, now);
      return false;
    }
    const hold = this.deps.hold(key);
    if (!hold) {
      log.info({ key, reason }, "Forced compaction deferred: another rewrite or a rewind holds the session");
      return false;
    }
    recent.push(now);
    const beforePct = Math.round(pct ?? 100);
    // The reading calibrates the compaction's estimate only when the turn
    // reached the API: a turn the CLI refused locally (no tokens in or out)
    // reports the CLI's own estimate, built on the very stale usage this run
    // is about to cap — taking it as the truth would compact far too much.
    const reachedApi = !!real && real.inputTokens + real.cacheReadTokens + real.cacheCreationTokens > 0;
    const run = this.run(hold, { reason, contextUsed: reachedApi ? real.contextUsed : undefined, contextMax, beforePct })
      .catch((err) => log.error({ err, key }, "Forced compaction failed"))
      .finally(() => { if (this.inFlight.get(key) === run) this.inFlight.delete(key); });
    this.inFlight.set(key, run);
    return true;
  }

  private async run(
    hold: ForceCompactHold,
    args: { reason: ForceCompactReason; contextUsed?: number; contextMax: number; beforePct: number },
  ): Promise<void> {
    const { key } = hold;
    log.warn({ key, reason: args.reason, pct: args.beforePct }, "Context full: the harness is compacting the session itself");
    let interrupted: RunningTaskRecord[] = [];
    let report: ForceCompactReport | null = null;
    let failure: string | null = null;
    try {
      const sdkSessionId = await this.deps.quiesce(hold, () => {
        const recorded = this.deps.markInterrupted(key);
        if (recorded === null) return false;
        interrupted = recorded;
        return true;
      });
      if (!sdkSessionId) {
        failure = "no session to compact, or its background work could not be recorded";
      } else {
        report = await this.deps.compact({ key, sdkSessionId, contextUsed: args.contextUsed, contextMax: args.contextMax });
        if (report.summarized.length === 0 && report.archived.length === 0 && !report.pruned && report.usageCapped === 0) {
          failure = report.errors.join("; ") || "nothing could be compacted";
        }
      }
    } catch (err) {
      failure = errorMessage(err);
    } finally {
      this.deps.sessionClosed(key);
      // Still inside the hold: the notes are on disk before any turn can run.
      // (A resume turn queued here waits for the hold like any other turn.)
      try {
        if (report && !failure) this.deps.queueNote(key, formatTomoEvent("force-compacted", sessionNote(args, report, interrupted)));
      } catch (err) {
        log.warn({ err, key }, "Could not queue the forced-compaction note");
      }
      if (interrupted.length > 0) {
        try {
          this.deps.reportInterrupted(key, interrupted);
        } catch (err) {
          log.error({ err, key }, "Could not report the work a forced compaction interrupted");
        }
      }
      hold.release();
    }
    const t = ownerT("notices");
    const session = this.sessionName(key);
    let notice: OwnerText;
    if (failure || !report) {
      log.error({ key, failure }, "Forced compaction did not compact anything");
      notice = t("forceCompact.failed", { session, before: args.beforePct });
    } else {
      const after = Math.round((report.afterTokens / report.contextMax) * 100);
      const parts = [
        report.reachedSafe
          ? t("forceCompact.done", { session, before: args.beforePct, after })
          : t("forceCompact.doneStillHigh", { session, before: args.beforePct, after }),
        ...(report.archived.length > 0 ? [t("forceCompact.archived")] : []),
        ...(interrupted.length > 0 ? [t("forceCompact.agents", { count: interrupted.length })] : []),
      ];
      notice = joinText(parts, " ");
    }
    await this.deps.notifyOwner(notice).catch((err) => log.warn({ err, key }, "Could not tell the owner about a forced compaction"));
  }

  private giveUp(key: string, count: number, now: number): void {
    const last = this.gaveUpNoticeAt.get(key);
    if (last !== undefined && now - last < HOUR_MS) return;
    this.gaveUpNoticeAt.set(key, now);
    log.error({ key, count }, "Forced compaction keeps refilling; not trying again for now");
    void this.deps.notifyOwner(ownerT("notices")("forceCompact.gaveUp", { session: this.sessionName(key), count }))
      .catch((err) => log.warn({ err, key }, "Could not tell the owner about a refilling session"));
  }

  /** Never a group's content: its title at most. */
  private sessionName(key: string): string {
    const t = ownerT("notices");
    if (isTaskSessionKey(key)) return t("forceCompact.sessionTask", { id: key.slice("task:".length) });
    if (isGroupSessionKey(key)) return t("forceCompact.sessionGroup", { title: this.deps.groupTitle(key) ?? key });
    return t("forceCompact.sessionDm");
  }
}

/** The `force-compacted` note the session reads on its next turn (for the model: English). Exported for tests. */
export function sessionNote(
  args: { reason: ForceCompactReason; beforePct: number },
  report: ForceCompactReport,
  interrupted: readonly RunningTaskRecord[],
): string {
  const after = Math.round((report.afterTokens / report.contextMax) * 100);
  const why = args.reason === "prompt-too-long"
    ? `the last turn was refused with "Prompt is too long" (context ~${args.beforePct}%)`
    : `the context reached ${args.beforePct}%`;
  const done: string[] = [];
  if (report.pruned) done.push(`pruned ${report.pruned.entries} bulky tool results / images`);
  for (const s of report.summarized) done.push(`summarized ${s.from} → ${s.to} (${s.events} events) into the "${s.blockTag}" block, written by a separate summary model`);
  for (const s of report.archived) done.push(`archived ${s.from} → ${s.to} (${s.events} events) without a summary — use \`tomo lcm search\` to recall it`);
  if (done.length === 0) done.push("found nothing to remove");
  const lines = [
    `The harness force-compacted this conversation because ${why}; you did not do this yourself.`,
    `What was done: ${done.join("; ")}. Context is now about ${after}%.`,
  ];
  if (interrupted.length > 0) {
    lines.push(`It had to close the session for that, which stopped ${interrupted.length} background task(s); they are listed in the interrupted-agents note and resumable ones will be resumed.`);
  }
  if (!report.reachedSafe) lines.push("Context is still high: keep this turn short and run `tomo lcm daily` / prune when you can.");
  return lines.join("\n");
}
