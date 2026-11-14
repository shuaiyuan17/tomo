import { config } from "../config.js";
import { log } from "../logger.js";
import type { SessionStore } from "../sessions/index.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { resolveBlockRange } from "../lcm/blocks.js";
import { pruneTools } from "../lcm/index.js";
import { formatTomoEvent } from "../tomo-event.js";
import { decideContextNudge, type ContextNudgeLatch } from "./context-nudge.js";
import type { QueryResult } from "./live-session.js";
import { usesLcmCompact } from "./sdk-options.js";
import type { CronTurnOptions } from "./agent-turn-types.js";

// Context-usage percentage at which the nudge escalates from a daily rollup
// (config.lcm.nudgeAtPct) to a full lcm compact.
const COMPACT_NUDGE_PCT = 80;

// Prune-first only when the dry run shows enough reclaimable volume to
// plausibly drop usage below the reset threshold; otherwise skip straight to
// the daily rollup rung. chars/4 is fine here because tool output is mostly
// ASCII (JSON, logs, file contents).
const PRUNE_NUDGE_MIN_FRAC = 0.10;

/**
 * Dispatches the context-usage nudge turns (prune → daily → compact) and owns
 * their per-session hysteresis latch. The decision itself is
 * `decideContextNudge`; this is the side that reads the session and queues
 * the housekeeping turn through the Agent's cron path.
 */
export class ContextNudger {
  // Context-usage hysteresis: the highest nudge level already fired for the
  // current over-threshold episode. Cleared when usage drops back below
  // config.lcm.nudgeResetPct.
  private contextNudged = new Map<string, ContextNudgeLatch>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly handleCronMessage: (message: string, sessionKey: string, options: CronTurnOptions) => Promise<boolean>,
  ) {}

  /**
   * Single context-pressure nudge path, evaluated once per completed turn:
   * runWithRetry covers owned turns (user, cron, continuity); unowned SDK
   * background turns call it from their resolve handler. Skips when SDK
   * auto-compact owns this session.
   *
   * The prune → daily → compact ladder shares one hysteresis latch, so a turn
   * queues exactly one housekeeping turn: first try deterministic
   * `tomo lcm prune-tools` when enough bulky tool output is reclaimable, then
   * `tomo lcm daily`, then the lcm compact skill at COMPACT_NUDGE_PCT. The
   * latch re-arms when usage drops back below nudgeResetPct.
   *
   * The nudge goes through handleCronMessage so it runs in the per-session
   * queue. Calling runWithRetry directly here would overlap with the next
   * user message's send() and stomp LiveSession's single currentRequest slot,
   * silently swallowing one of the two responses.
   *
   * Callers that hold the turn's session pass its lastResult explicitly —
   * the compact-trigger reload may have already dropped the session from
   * liveSessions, and the latch must still see the result to stay accurate.
   */
  maybeNudgeCompact(key: string, ctx: QueryResult | null): void {
    if (!usesLcmCompact(key)) return;
    if (!ctx || ctx.contextMax <= 0) return;
    // A turn whose context reading failed carries an approximation of its OWN
    // tokens over the last known window — a small fraction of a full session.
    // Acting on it would read as "the session just emptied", clear the latch,
    // and re-issue housekeeping that has already run. An unknown reading is
    // not a low one: skip the turn and leave the latch where it is.
    if (ctx.contextEstimated) {
      log.debug({ key }, "Context nudge skipped (usage reading unavailable this turn)");
      return;
    }

    const usedFrac = ctx.contextUsed / ctx.contextMax;
    const nudged = this.contextNudged.get(key);
    const thresholds = {
      nudgeAtPct: config.lcm.nudgeAtPct,
      nudgeResetPct: config.lcm.nudgeResetPct,
      compactNudgePct: COMPACT_NUDGE_PCT,
    };
    const compactFrac = Math.max(COMPACT_NUDGE_PCT, config.lcm.nudgeAtPct) / 100;
    const shouldPrecheckContextNudge = usedFrac >= config.lcm.nudgeAtPct / 100 &&
      usedFrac < compactFrac &&
      (!nudged || nudged === "prune");
    let sid: string | undefined;
    let prunableTokens = 0;
    let prunableSufficient = false;
    let dailyRangeAvailable = true;

    if (shouldPrecheckContextNudge) {
      sid = this.sessions.getSdkSessionId(key);
      if (!sid) return;
      if (!nudged) {
        const dry = pruneTools({ sdkSessionId: sid, sdkSessionsDir: config.sdkSessionsDir, dryRun: true });
        prunableTokens = dry.success ? Math.ceil(dry.totalCharsRemoved / 4) : 0;
        prunableSufficient = prunableTokens >= PRUNE_NUDGE_MIN_FRAC * ctx.contextMax;
      }
      if (nudged === "prune" || !prunableSufficient) {
        dailyRangeAvailable = resolveBlockRange(sid, "daily", undefined, config.sdkSessionsDir) !== null;
      }
    }

    const decision = decideContextNudge({
      usedFrac,
      latchState: nudged,
      prunableSufficient,
      dailyRangeAvailable,
      thresholds,
    });

    if (decision.kind === "none") {
      if (decision.newLatch === null && nudged) {
        this.contextNudged.delete(key);
      }
      return;
    }

    // Latched BEFORE dispatch (the nudge turn must not re-trigger itself) and
    // rolled back below if the turn never happened — see the .then()/.catch().
    const latch = decision.newLatch;
    if (latch) {
      this.contextNudged.set(key, latch);
    }
    // Undo that arming — but only if the latch is still OURS: a later turn may
    // have escalated it (prune → daily → compact) while this nudge was in
    // flight, and clearing that one would re-issue a rung the session has
    // already moved past.
    const rollBackLatch = (why: string): void => {
      if (!latch || this.contextNudged.get(key) !== latch) return;
      this.contextNudged.delete(key);
      log.warn({ key, latch }, why);
    };

    const pct = Math.round(usedFrac * 100);
    const groupNote = isGroupSessionKey(key)
      ? " This is a group session — scope the rollup to this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere."
      : "";
    const compactNudgeText = () => formatTomoEvent(
      "context-nudge",
      `Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Use the lcm compact skill to free up space before the next user message.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
      { name: "compact" },
    );

    let nudge: string;
    if (decision.kind === "compact") {
      nudge = compactNudgeText();
      if (decision.reason === "daily-empty") {
        log.info({ key, usedPct: `${pct}%` }, "Context nudge (daily rollup empty; escalating to lcm compact)");
      } else {
        log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm compact)");
      }
    } else if (decision.kind === "daily") {
      nudge = formatTomoEvent(
        "context-nudge",
        `Context usage is at ${pct}% of the window. Please run \`tomo lcm daily --session-id ${sid} --summary "<today-so-far>"\` to roll up today's activity. Two things to know: (1) the daily compact OVERRIDES today's existing daily block — it does not append; write a fresh summary covering the whole day. (2) The command preserves the last ${config.lcm.dailyFreshTail} raw events as fresh tail.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
        { name: "daily" },
      );
      log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm daily)");
    } else if (decision.kind === "prune") {
      nudge = formatTomoEvent(
        "context-nudge",
        `Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Bulky tool results are holding roughly ${prunableTokens} reclaimable tokens. Run \`tomo lcm prune-tools --session-id ${sid}\` to stub them out — this is cheaper than a rollup and loses nothing conversational.${groupNote} After it finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
        { name: "prune" },
      );
      log.info({ key, usedPct: `${pct}%`, prunableTokens }, "Context nudge (agent should run lcm prune-tools)");
    } else {
      return;
    }

    // ALWAYS suppressed, in every session type. A context nudge (compact /
    // daily / prune-tools) is internal housekeeping: it runs an `lcm` command
    // and has nothing to say to anyone. It used to rely on the prompt's
    // closing "reply NO_REPLY", which only worked while delivery happened at
    // END of turn and that trailing token suppressed the whole turn. Per-block
    // delivery ships an early narration block ("Compacting context…") as soon
    // as it completes, before the NO_REPLY that was meant to silence it — and
    // a sent message cannot be recalled. Silence here must not depend on the
    // model's cooperation.
    this.handleCronMessage(nudge, key, {
      showTyping: false,
      suppressDelivery: true,
    }).then((ok) => {
      if (ok) return;
      // handleCronMessage does not REJECT on failure — it resolves false (no
      // deliverable target, the turn ended on an error result, the queue threw
      // and was swallowed). Leaving the latch set on that answer means the
      // housekeeping never ran AND nothing will ask for it again until usage
      // falls back below nudgeResetPct, which is precisely what it cannot do
      // with the rollup unwritten. Roll the latch back so the next completed
      // turn re-evaluates the ladder from where it actually stands.
      rollBackLatch("Context nudge turn failed; latch cleared for a retry");
    }).catch((err) => {
      // And a REJECTION is the same outcome with a louder failure mode. That
      // handleCronMessage cannot currently reject is a property of ITS
      // implementation (a terminal `.catch(() => false)`), not of this call
      // site, and a latch stuck on for the rest of the session's life is too
      // quiet a thing to leave resting on that.
      log.warn({ err, key }, "Compact nudge failed");
      rollBackLatch("Context nudge turn threw; latch cleared for a retry");
    });
  }
}
