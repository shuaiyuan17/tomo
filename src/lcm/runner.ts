import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { BLOCK_SUMMARY_TOKEN_BUDGETS, findDuePromotions, type DuePromotion } from "./blocks.js";
import { usesLcmCompact } from "../agent/sdk-options.js";
import { config } from "../config.js";
import { formatTomoEvent } from "../tomo-event.js";

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
// Debounce: don't re-nudge the same promotion more than once per 6h within
// a single daemon run (agent might be busy; give it time to act).
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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

function nudgeText(p: DuePromotion, sdkSessionId: string, sessionKey: string): string {
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
    "The source blocks are already visible in your context — read them and write the rollup summary in one turn. Run:",
    `  tomo lcm ${p.level} --session-id ${sdkSessionId} ${flag} ${p.period} --summary "<your text>"`,
    "",
    "Style: note-to-self, dated facts, key decisions/arcs/quotes over paragraphs of abstraction.",
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
  private lastNudged = new Map<string, number>(); // `${sessionKey}:${level}:${period}` → timestamp

  constructor(agent: Agent) {
    this.agent = agent;
  }

  start(): void {
    log.info("Rollup runner started (hourly)");
    setTimeout(() => this.checkAll(), INITIAL_DELAY_MS);
    this.timer = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAll(): Promise<void> {
    if (!isDaytime()) {
      log.debug("Rollup check deferred (outside daytime hours)");
      return;
    }
    const now = Date.now();
    for (const [sessionKey, sdkSessionId] of this.agent.listActiveSessions()) {
      // Skip sessions on SDK auto-compact (only groups with
      // config.lcm.groupCompactStyle="sdk"; DMs and groups by default use LCM).
      if (!usesLcmCompact(sessionKey)) continue;
      try {
        const due = findDuePromotions(sdkSessionId, config.sdkSessionsDir);
        if (due.length === 0) continue;

        // Debounce — filter out ones we nudged recently
        const fresh = due.filter((p) => {
          const k = `${sessionKey}:${p.level}:${p.period}`;
          const last = this.lastNudged.get(k);
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
        await this.agent.handleCronMessage(nudgeText(next, sdkSessionId, sessionKey), sessionKey, {
          showTyping: false,
          suppressDelivery: isGroupSessionKey(sessionKey),
        });
        this.lastNudged.set(`${sessionKey}:${next.level}:${next.period}`, now);
      } catch (err) {
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
