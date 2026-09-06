import { join } from "node:path";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { BLOCK_SUMMARY_TOKEN_BUDGETS, findDuePromotions, type DuePromotion } from "./blocks.js";
import { usesLcmCompact } from "../agent/sdk-options.js";
import { config } from "../config.js";
import { formatTomoEvent } from "../tomo-event.js";
import { NudgeCooldownStore, nudgeCooldownStore } from "./nudge-cooldown-store.js";

/**
 * Periodic rollup promotion checker.
 *
 * Scans each active session for completed calendar units with un-promoted
 * children (daily, weekly, monthly, yearly) and nudges the agent to run the
 * matching rollup command. Idempotent — if the agent skipped a Monday, the
 * next check catches it.
 */

const INITIAL_DELAY_MS = 2 * 60 * 1000;       // 2 min after startup
const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // every hour
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;
// Debounce: don't re-nudge the same promotion more than once per 6h (agent
// might be busy; give it time to act). Persisted (see NudgeCooldownStore), so
// the window survives a daemon restart.
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Where the cooldown lives — alongside the other daemon state under ~/.tomo/data. */
export function defaultNudgeCooldownPath(): string {
  return join(config.tomoHome, "data", "lcm", "nudge-cooldown.json");
}

function isDaytime(): boolean {
  const h = new Date().getHours();
  return h >= DAY_START_HOUR && h < DAY_END_HOUR;
}

function commandFor(p: DuePromotion): string {
  const flag = p.level === "daily" ? "--date" :
               p.level === "weekly" ? "--week" :
               p.level === "monthly" ? "--month" : "--year";
  return `tomo lcm ${p.level} --session-id <SESSION_ID> ${flag} ${p.period} --summary "..."`;
}

export function nudgeText(p: DuePromotion, sdkSessionId: string, sessionKey: string): string {
  const flag = p.level === "daily" ? "--date" :
               p.level === "weekly" ? "--week" :
               p.level === "monthly" ? "--month" : "--year";
  const childLabel = p.level === "daily" ? "raw events" : "child blocks";
  const higherLevelBudget = Math.max(
    BLOCK_SUMMARY_TOKEN_BUDGETS.weekly,
    BLOCK_SUMMARY_TOKEN_BUDGETS.monthly,
    BLOCK_SUMMARY_TOKEN_BUDGETS.yearly,
  );
  const lines = [
    `An LCM rollup is due. The completed period \`${p.level} ${p.period}\` has ${p.childCount} ${childLabel} ready to consolidate.`,
    "",
    ...(p.replacesExistingBlock ? [
      `IMPORTANT: \`${p.level} ${p.period}\` already has a rollup block. The command below REPLACES that block; it does not append to it.`,
      "Write a fresh summary covering the WHOLE period. Preserve the existing block's important content and integrate the newly eligible source material.",
      "",
    ] : []),
    "The source blocks are already visible in your context — read them and write the rollup summary in one turn. Run:",
    `  tomo lcm ${p.level} --session-id ${sdkSessionId} ${flag} ${p.period} --summary "<your text>"`,
    "",
    "Style: note-to-self, dated facts, key decisions/arcs/quotes over paragraphs of abstraction.",
    "When an elapsed interval carries meaning, write the interval next to the date, not just the date:",
    '  "opened 8/7, sat 17 days" — not "opened 8/7". "took 8 hours" — not "01:30 → 09:30".',
    "  A date is the durable truth; the interval is the form a later reader can act on without",
    "  doing arithmetic they will not actually do. Cases where it matters: how long something took,",
    "  how long something has gone untouched, and how long since two events were connected.",
    "  Skip it where duration is not load-bearing — an interval on every line is noise.",
    "Token budget per block:",
    `  - daily: ≤ ${BLOCK_SUMMARY_TOKEN_BUDGETS.daily} tokens (texture-curate, not texture-collect — pick 1-2 texture pieces worth keeping; let the rest stay in raw events)`,
    `  - weekly / monthly / yearly: ~500-${higherLevelBudget} tokens (compress harder at each level)`,
    "If a period genuinely has more irreducible texture than fits, exceed the budget and flag it in the summary.",
    "",
    "Note: this is the only rollup nudge for this tick. If other periods are also due, the next heartbeat (~1h) will pick up the next one. Don't chain multiple compacts in a single turn — running two `tomo lcm` calls back-to-back can race the SDK's in-memory state and orphan the chain.",
    "",
    "After the rollup finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.",
  ];
  if (isGroupSessionKey(sessionKey)) {
    lines.splice(5, 0,
      "Group scope: this is a group session — keep the rollup focused on this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere.",
      "",
    );
  }
  void commandFor; // keep reference for potential future use
  return formatTomoEvent("lcm-rollup", lines.join("\n"), { name: `${p.level} ${p.period}` });
}

export class RollupRunner {
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Initial delayed check. Held so stop() can cancel it — see VersionChecker. */
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * `${sessionKey}:${level}:${period}` → timestamp of the last nudge. Backed by
   * a JSON file so a restart doesn't re-arm every period (2026-08-29: daemon up
   * at 08:14, `daily 2026-08-28` re-nudged at 08:16, 1h after the 07:15 nudge).
   * Reads stay in memory; only a nudge touches the disk.
   */
  private lastNudged: NudgeCooldownStore;
  /** Guards against a second check starting while one is still awaiting a turn. */
  private checking = false;

  constructor(agent: Agent, cooldowns?: NudgeCooldownStore) {
    this.agent = agent;
    // Shared per path and loaded on first construction — i.e. before start()
    // can fire the first check, and without a second runner in this process
    // holding an independent snapshot of the same file.
    this.lastNudged = cooldowns ?? nudgeCooldownStore(defaultNudgeCooldownPath());
  }

  start(): void {
    log.info("Rollup runner started (hourly)");
    this.initialTimer = setTimeout(() => this.runCheckAll(), INITIAL_DELAY_MS);
    this.timer = setInterval(() => this.runCheckAll(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /** Timer entry point. `checkAll()` is async and unawaited; its per-session
   *  body is guarded but `listActiveSessions()` (a disk read) is not, so an
   *  unguarded rejection here would take the daemon down with it. */
  private runCheckAll(): void {
    this.checkAll().catch((err) => log.warn({ err }, "Rollup check failed"));
  }

  private async checkAll(): Promise<void> {
    if (!isDaytime()) {
      log.debug("Rollup check deferred (outside daytime hours)");
      return;
    }
    // One check at a time. A pass awaits a full model turn per session, which
    // can run longer than the hour between ticks (and the 2-minute startup
    // check overlaps the first interval tick by construction); a second pass
    // walking the same sessions concurrently would interleave nudges with the
    // first pass's cooldown writes and could put two rollup turns in flight —
    // exactly the back-to-back compact the one-nudge-per-tick rule exists to
    // avoid, since running two `tomo lcm` calls close together races the SDK's
    // in-memory state.
    if (this.checking) {
      log.debug("Rollup check skipped (previous check still running)");
      return;
    }
    this.checking = true;
    try {
      await this.checkAllSessions();
    } finally {
      this.checking = false;
    }
  }

  private async checkAllSessions(): Promise<void> {
    const now = Date.now();
    for (const [sessionKey, sdkSessionId] of this.agent.listActiveSessions()) {
      // Skip sessions on SDK auto-compact (only groups with
      // config.lcm.groupCompactStyle="sdk"; DMs and groups by default use LCM).
      if (!usesLcmCompact(sessionKey)) continue;
      // Held outside the try so the catch can give the cooldown back. It is
      // armed before the nudge turn is awaited (see below), so an exception
      // out of that await would otherwise leave a 6h debounce on work that
      // was never asked for.
      let cooldownKey: string | null = null;
      try {
        const due = findDuePromotions(sdkSessionId, config.sdkSessionsDir);
        if (due.length === 0) continue;

        // Debounce — filter out ones we nudged recently
        const fresh = due.filter((p) => {
          const k = `${sessionKey}:${p.level}:${p.period}`;
          const last = this.lastNudged.get(k, now);
          return !last || now - last >= NUDGE_COOLDOWN_MS;
        });
        if (fresh.length === 0) continue;

        // Emit ONE nudge per tick (per session). Stuffing multiple due levels
        // into a single system message lets the LLM run them all in one turn,
        // and back-to-back compacts mid-turn race the SDK's in-memory state
        // (orphaning the parent chain). Order by level (daily before weekly
        // before monthly before yearly) and within a level oldest period
        // first; the next heartbeat will pick up whatever's still due.
        fresh.sort((a, b) =>
          LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
          a.period.localeCompare(b.period),
        );
        const next = fresh[0];

        log.info(
          { sessionKey, picking: `${next.level} ${next.period}`, deferred: fresh.length - 1 },
          "Rollup nudge (one level/tick)",
        );
        // ALWAYS suppressed, in every session type. A rollup turn is internal
        // housekeeping: it reads context, runs `tomo lcm`, and has nothing to
        // say to anyone. It used to rely on the prompt's closing "reply
        // NO_REPLY", which worked only while delivery happened at END of turn
        // and the whole turn was suppressed by that trailing token. Per-block
        // delivery ships an early narration block ("Rolling up 8/27…") the
        // moment it completes — long before the NO_REPLY that was supposed to
        // silence it. The prompt cannot retract a sent message, so silence
        // here must not depend on the model's cooperation.
        // Armed BEFORE the await, not after. A rollup turn is a full model
        // turn that queues behind whatever else the session is doing and can
        // easily outlive the hourly tick; with the cooldown written only on
        // completion, the next tick sees the same period still un-nudged and
        // asks for it a second time — the duplicate lands the moment the first
        // one finishes, and rewrites the whole period again.
        cooldownKey = `${sessionKey}:${next.level}:${next.period}`;
        this.lastNudged.set(cooldownKey, now);
        const delivered = await this.agent.handleCronMessage(
          nudgeText(next, sdkSessionId, sessionKey), sessionKey, {
            showTyping: false,
            suppressDelivery: true,
          },
        );
        // handleCronMessage resolves FALSE rather than rejecting when the turn
        // never happened (no deliverable target for the session, the turn
        // ended on an error result, the per-session queue threw). Holding a 6h
        // cooldown on that answer buys nothing but a 6h hole: the rollup is
        // still due, still un-nudged, and the next five heartbeats skip it.
        // The cooldown is a debounce on work we asked for, so give it back
        // when the ask did not land.
        if (!delivered) {
          this.lastNudged.clear(cooldownKey);
          log.warn(
            { sessionKey, level: next.level, period: next.period },
            "Rollup nudge turn failed; leaving it due for the next check",
          );
        }
      } catch (err) {
        // Same reasoning as the `!delivered` branch above, for the louder
        // failure mode: whatever threw, the rollup did not happen, and a
        // cooldown armed for a turn that never completed is a 6h hole in which
        // the period stays due and every heartbeat skips it. That
        // `handleCronMessage` cannot currently reject is a property of ITS
        // implementation (a terminal `.catch(() => false)`) — this loop should
        // not silently depend on that.
        if (cooldownKey) this.lastNudged.clear(cooldownKey);
        log.warn({ err, sessionKey }, "Rollup check failed");
      }
    }
  }
}

const LEVEL_ORDER: Record<DuePromotion["level"], number> = {
  daily: 0,
  weekly: 1,
  monthly: 2,
  yearly: 3,
};
