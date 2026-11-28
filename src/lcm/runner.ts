import { join } from "node:path";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";
import { isGroupSessionKey, sessionKind } from "../sessions/keys.js";
import { BLOCK_SUMMARY_TOKEN_BUDGETS, findDuePromotions, localDateTag, type DuePromotion } from "./blocks.js";
import { collectSaidLines, coreStatusLine, type SaidLines } from "../memory/said-check.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
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

/**
 * The memory step a rollup nudge carries (§4.2 / §15.2 of the memory design):
 * built by the runner for the owner's own DM session only, and only on the
 * daily and weekly levels. Absent: no memory step (a group, a task, a
 * monthly or yearly rollup).
 */
export type MemoryPass =
  /** The session has too little room left for the step: the rollup goes first. */
  | { skip: string }
  | {
      skip?: undefined;
      /** Weekly: both cores' sizes (coreStatusLine). */
      coreStatus?: string;
      /** Weekly: the week's `said` lines (collectSaidLines); undefined when the scan failed. */
      said?: SaidLines;
      /** Weekly: why the `said` check is left out this time (too little room), instead of the list. */
      saidSkipped?: string;
      /** Local YYYY-MM-DD the nudge is written on: the date in "(no source found, checked …)". */
      today: string;
    };

/** What both steps say about failure: the memory step never costs the rollup. */
const MEMORY_STEP_FAILURE = "The rollup matters more than this step: if a memory tool keeps failing, stop here, run the rollup anyway, and say what was left undone in the memory line.";

/** The daily memory pass (§15.2): save and fix what that day left, before the day is summarized. */
export function dailyMemoryPassText(period: string): string {
  return [
    `Before the rollup: the memory pass for ${period}. If memory already reflects that day (an earlier attempt at this rollup did it), change nothing. Otherwise read that day's raw events once and update memory with the memory tools.`,
    `- Save what future conversations need and wasn't saved then: preferences, decisions, commitments, plans and dates, outcomes. Put it in topic files; MEMORY.md takes only what most conversations need. Anything on the private list (Layout) goes under private/. A new line's leading date is when it was said, ${period}, not today. Mark a rule or goal \`said\` only when the owner stated it or agreed to it that day; when they agreed to your proposal, write "agreed to … (my proposal)".`,
    "- Skip subjects under `## Don't keep`, and anything the owner asked that day to forget or not to keep; leave them out of the rollup summary too.",
    "- Messages from a summoned group are its members' words: record anything worth keeping as `from:group`, never as `said` and never in either MEMORY.md.",
    "- Fix lines that day contradicted or made stale (booked, cancelled, done, corrected) where they live, and follow a correction into todos. Don't change scheduled jobs here, since the owner won't see it; if one relied on an old value, add a todo to raise it with them.",
    `Finding nothing worth keeping is a fine result. ${MEMORY_STEP_FAILURE} Then write the rollup, and end its summary with one line: \`memory: <files you changed, or none>\`, naming each correction as "X corrected to Y".`,
  ].join("\n");
}

/** The `said` check's part of the weekly step (§6.3), or "" when there is nothing to check. */
export function saidCheckText(said: SaidLines, today: string): string {
  if (said.lines.length === 0) return "";
  return [
    "Then check that week's `said` lines against what the owner actually wrote. For each line below, search the conversation around its date: recall_conversation with 2–4 distinctive words from the line, `after` the day before its date, `before` two days after, and `limit` 5. At most three searches a line. Also memory_search the fact, and bring any copy that disagrees into line with what you confirm.",
    ...said.lines.map((l) => `- ${l.path}:${l.line}: ${l.text}`),
    "- They said something else: correct the line to what they said, and keep `said` and its date.",
    "- The line says more than they did (a one-off written as a standing rule, a \"maybe\" as a decision, a wider scope): cut it back to what they said. Keep the extra as a separate `inferred` line only if it is still useful.",
    `- You find no source: look before you change it. If the owner only answered "ok" or "好" around then, read your own message just before that reply (recall_conversation with no query, \`before\` set to the reply's time, limit 3). When they agreed to something you proposed, the line is \`said\`: rewrite it as "agreed to <what> (my proposal)". If it came from a group, a task report, an email or a tool result, mark it \`from:<source>\`. Otherwise make it \`inferred\` and add "(no source found, checked ${today})". Don't delete it. If that line is a rule, a goal or a commitment, add a todo to ask the owner; you can't ask them in this turn.`,
    ...(said.more > 0 ? [`${said.more} more \`said\` ${said.more === 1 ? "line" : "lines"} from that week ${said.more === 1 ? "is" : "are"} not listed; leave ${said.more === 1 ? "it" : "them"}.`] : []),
    ...(said.truncated ? ["(The scan for these lines stopped early: some files were not read, so the list may be short.)"] : []),
  ].join("\n");
}

/** The weekly upkeep (§15.2): shrink and tidy, then check the week's `said` lines. */
export function weeklyMemoryUpkeepText(period: string, pass: Exclude<MemoryPass, { skip: string }>): string {
  const said = pass.said && pass.said.lines.length > 0 ? pass.said : undefined;
  const block = said ? saidCheckText(said, pass.today) : "";
  const notChecked = pass.saidSkipped !== undefined
    ? `This week's \`said\` lines are not checked this time: ${pass.saidSkipped}. Leave them.`
    : pass.said === undefined
      ? "This week's `said` lines could not be listed this time; leave them."
      : "";
  const summary = said
    ? "`memory: <what you moved or removed, or none>; said check: <n> checked, <a> misquoted, <b> overstated, <c> unsourced`"
    : "`memory: <what you moved or removed, or none>`";
  return [
    `Before the rollup: memory upkeep for ${period}.${pass.coreStatus ? ` ${pass.coreStatus}` : ""}`,
    "- If private/MEMORY.md or MEMORY.md is over budget, or holds things most conversations don't need, move those into topic files.",
    "- Remove lines about events that are over and no longer useful, and lines that are no longer true.",
    "- Move topic files about finished or dropped subjects into archive/ with memory_move.",
    "- If a shared file holds something on the private list (Layout), move it under private/.",
    "- When loose files in one folder clearly belong together, move them into a subfolder and give it a README.md with a description.",
    ...(block ? [block] : []),
    ...(notChecked ? [notChecked] : []),
    `If memory needs none of this, change nothing. ${MEMORY_STEP_FAILURE} End the weekly summary with one line: ${summary}, naming each correction as "X corrected to Y".`,
  ].join("\n");
}

/** The memory step's lines for this nudge, or none. */
function memoryStepLines(p: DuePromotion, pass: MemoryPass | undefined): string[] {
  if (!pass || (p.level !== "daily" && p.level !== "weekly")) return [];
  if (pass.skip !== undefined) {
    return [`No memory ${p.level === "daily" ? "pass" : "upkeep"} this time: ${pass.skip}. Write the rollup only, and end its summary with one line: \`memory: skipped (${pass.skip})\`.`, ""];
  }
  return [p.level === "daily" ? dailyMemoryPassText(p.period) : weeklyMemoryUpkeepText(p.period, pass), ""];
}

export function nudgeText(p: DuePromotion, sdkSessionId: string, sessionKey: string, memoryPass?: MemoryPass): string {
  const flag = p.level === "daily" ? "--date" :
               p.level === "weekly" ? "--week" :
               p.level === "monthly" ? "--month" : "--year";
  const childLabel = p.level === "daily" ? "raw events" : "child blocks";
  const higherLevelBudget = Math.max(
    BLOCK_SUMMARY_TOKEN_BUDGETS.weekly,
    BLOCK_SUMMARY_TOKEN_BUDGETS.monthly,
    BLOCK_SUMMARY_TOKEN_BUDGETS.yearly,
  );
  // The memory step is the owner's own DM session's alone: a group's nudge
  // (a group session, or one running on the DM session while the group is
  // summoned, whose key is the group's) never carries it, whatever the caller passed.
  const memoryStep = sessionKind(sessionKey) === "owner-dm" ? memoryStepLines(p, memoryPass) : [];
  const lines = [
    `An LCM rollup is due. The completed period \`${p.level} ${p.period}\` has ${p.childCount} ${childLabel} ready to consolidate.`,
    "",
    "⚠️ Before you run this: a rollup reloads the session and will interrupt any subagent that is currently working — its transcript is saved and it can be resumed, but its in-progress turn is cut. If a subagent is running right now, DEFER this rollup until it finishes; the next heartbeat re-nudges, so nothing is lost by waiting. (The command refuses with status \"deferred\" while background tasks are running; if it does, reply NO_REPLY.)",
    "",
    // Right after the warning, before anything about the summary itself.
    ...(isGroupSessionKey(sessionKey) ? [
      "Group scope: this is a group session — keep the rollup focused on this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere.",
      "",
    ] : []),
    ...memoryStep,
    ...(p.replacesExistingBlock ? [
      `IMPORTANT: \`${p.level} ${p.period}\` already has a rollup block. The command below REPLACES that block; it does not append to it.`,
      "Write a fresh summary covering the WHOLE period. Preserve the existing block's important content and integrate the newly eligible source material.",
      "",
    ] : []),
    "The source blocks are already visible in your context — read them and write the rollup summary in one turn. Run:",
    `  tomo lcm ${p.level} --session-id ${sdkSessionId} ${flag} ${p.period} --summary "<your text>"`,
    `  (No shell here — group session or private-memory-barred turn? Call the \`lcm_rollup\` tool instead: level "${p.level}", period "${p.period}", and the same summary. Same effect, no Bash.)`,
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
  void commandFor; // keep reference for potential future use
  return formatTomoEvent("lcm-rollup", lines.join("\n"), { name: `${p.level} ${p.period}` });
}

/**
 * Room a memory step needs below the forced-compaction line, in tokens. A
 * rollup turn that runs out of window ends on "Prompt is too long" and the
 * rollup is not written (the harness compacts instead), so the step is left
 * out when the session can't afford it: the rollup is what frees room.
 * The pass: a few searches, reads and edits. The `said` check: up to 20
 * lines × 3 recalls (5 excerpts of ≤400 characters each) and a search.
 */
export const MEMORY_PASS_MIN_ROOM_TOKENS = 40_000;
export const SAID_CHECK_MIN_ROOM_TOKENS = 150_000;

/** Where the memory tools write: the workspace's memory/ (the same root as the prompt's MEMORY_DIR). */
export function defaultMemoryDir(): string {
  return join(defaultRuntimePaths.workspaceDir, "memory");
}

export interface MemoryPassDeps {
  /** The memory root, resolved when a nudge is built. */
  memoryDir: () => string;
  /** The session's last recorded context usage, if known. */
  contextUsage?: (sessionKey: string) => { used: number; max: number } | undefined;
  /** The forced-compaction line, % of the window. */
  forceCompactAtPct?: () => number;
  now?: () => Date;
}

/**
 * The memory step for this nudge: only on the owner's DM session and the
 * daily and weekly levels. Never throws: whatever fails here (a scan, a
 * read), the nudge goes out with less of the step, never without the rollup.
 */
export function buildMemoryPass(p: DuePromotion, sessionKey: string, deps: MemoryPassDeps): MemoryPass | undefined {
  try {
    return memoryPassFor(p, sessionKey, deps);
  } catch (err) {
    log.warn({ err, sessionKey }, "Rollup memory step failed to build; nudging without it");
    return undefined;
  }
}

function memoryPassFor(p: DuePromotion, sessionKey: string, deps: MemoryPassDeps): MemoryPass | undefined {
  if (sessionKind(sessionKey) !== "owner-dm" || (p.level !== "daily" && p.level !== "weekly")) return undefined;
  const today = localDateTag((deps.now ?? (() => new Date()))());
  let room: number | undefined;
  try {
    const usage = deps.contextUsage?.(sessionKey);
    if (usage && usage.max > 0) {
      const pct = deps.forceCompactAtPct?.() ?? 95;
      room = Math.floor((usage.max * pct) / 100) - usage.used;
    }
  } catch (err) {
    log.warn({ err, sessionKey }, "Rollup memory step: context usage unreadable; assuming room");
  }
  if (room !== undefined && room < MEMORY_PASS_MIN_ROOM_TOKENS) return { skip: "the context is too full" };
  if (p.level === "daily") return { today };
  let memoryDir: string;
  try { memoryDir = deps.memoryDir(); } catch (err) {
    log.warn({ err, sessionKey }, "Rollup memory step: memory root unresolved; nudging without the said check");
    return { today };
  }
  let coreStatus: string | undefined;
  try { coreStatus = coreStatusLine(memoryDir); } catch (err) {
    log.warn({ err, sessionKey }, "Rollup memory step: core sizes unreadable");
  }
  if (room !== undefined && room < SAID_CHECK_MIN_ROOM_TOKENS) {
    return { today, coreStatus, saidSkipped: "the context is too full" };
  }
  try {
    return { today, coreStatus, said: collectSaidLines(memoryDir, p.period) };
  } catch (err) {
    log.warn({ err, sessionKey, period: p.period }, "Rollup memory step: said-line scan failed; nudging without it");
    return { today, coreStatus };
  }
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
  /** What the memory step of a DM nudge reads (the memory root, the session's context usage). */
  private memory: MemoryPassDeps;

  constructor(agent: Agent, cooldowns?: NudgeCooldownStore, memory?: Partial<MemoryPassDeps>) {
    this.agent = agent;
    this.memory = {
      memoryDir: memory?.memoryDir ?? defaultMemoryDir,
      contextUsage: memory?.contextUsage ?? ((key) => this.agent.contextUsageOf?.(key)),
      forceCompactAtPct: memory?.forceCompactAtPct ?? (() => config.lcm.forceCompactAtPct),
      ...(memory?.now ? { now: memory.now } : {}),
    };
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
      // A rollup reloads the session, and the reload kills its background
      // tasks — so `tomo lcm` and `lcm_rollup` refuse while any are running.
      // Asking anyway would only spend a model turn on a refusal; skip the
      // session without arming the cooldown, so the next tick asks again.
      // While a group is summoned into the owner's dm: session, that session
      // runs on the prompt without the owner's private context, and whatever
      // a rollup turn read would stay in a context the group is steering.
      // Deferred like the background-task case: no cooldown, so the first
      // tick after the summon ends asks.
      if (this.agent.hasActiveSummonInto(sessionKey)) {
        log.info({ sessionKey }, "Rollup nudge deferred (a group is summoned into this session)");
        continue;
      }
      if (this.agent.hasBackgroundWork(sessionKey)) {
        log.info({ sessionKey }, "Rollup nudge deferred (session has background tasks running)");
        continue;
      }
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
        // The memory step (owner DM, daily and weekly only) is built before
        // the cooldown is armed and cannot throw: a failed scan sends the
        // nudge with less of the step, never no nudge.
        const memoryPass = buildMemoryPass(next, sessionKey, this.memory);
        cooldownKey = `${sessionKey}:${next.level}:${next.period}`;
        this.lastNudged.set(cooldownKey, now);
        const delivered = await this.agent.handleCronMessage(
          nudgeText(next, sdkSessionId, sessionKey, memoryPass), sessionKey, {
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
