import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { findDuePromotions, type DuePromotion } from "./blocks.js";

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

function nudgeText(dues: DuePromotion[], sdkSessionId: string): string {
  const lines = [
    "System: LCM rollups are due. The following completed periods have un-promoted children — please consolidate them in order (oldest first):",
    "",
  ];
  for (const p of dues) {
    lines.push(`  - ${p.level} ${p.period} (${p.childCount} ${p.level === "daily" ? "raw events" : "child blocks"})`);
  }
  lines.push("");
  lines.push("The source blocks are already visible in your context — read them and write the rollup summary in one turn. Run:");
  for (const p of dues) {
    const flag = p.level === "daily" ? "--date" :
                 p.level === "weekly" ? "--week" :
                 p.level === "monthly" ? "--month" : "--year";
    lines.push(`  tomo lcm ${p.level} --session-id ${sdkSessionId} ${flag} ${p.period} --summary "<your text>"`);
  }
  lines.push("");
  lines.push("Style: note-to-self, dated facts, key decisions/arcs/quotes over paragraphs of abstraction. ~500-1000 tokens per block.");
  void commandFor; // keep reference for potential future use
  return lines.join("\n");
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
      try {
        const due = findDuePromotions(sdkSessionId);
        if (due.length === 0) continue;

        // Debounce — filter out ones we nudged recently
        const fresh = due.filter((p) => {
          const k = `${sessionKey}:${p.level}:${p.period}`;
          const last = this.lastNudged.get(k);
          return !last || now - last >= NUDGE_COOLDOWN_MS;
        });
        if (fresh.length === 0) continue;

        log.info({ sessionKey, due: fresh.map((p) => `${p.level} ${p.period}`) }, "Rollup nudge");
        await this.agent.handleCronMessage(nudgeText(fresh, sdkSessionId), sessionKey);

        for (const p of fresh) {
          this.lastNudged.set(`${sessionKey}:${p.level}:${p.period}`, now);
        }
      } catch (err) {
        log.warn({ err, sessionKey }, "Rollup check failed");
      }
    }
  }
}
