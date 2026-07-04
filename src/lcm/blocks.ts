import { existsSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";
import { config } from "../config.js";
import { readJsonlFileSync } from "../jsonl.js";

/**
 * Hierarchical rollup block tags live on compact summary events. Each level
 * consumes the one below:
 *   daily YYYY-MM-DD   ← raw user/assistant events for that local-tz day
 *   weekly YYYY-Www    ← daily blocks for that ISO week
 *   monthly YYYY-MM    ← weekly blocks whose ISO week falls in that month
 *   yearly YYYY        ← monthly blocks for that year
 */
export type BlockLevel = "daily" | "weekly" | "monthly" | "yearly";

export interface ResolvedRange {
  /** The block tag that will be written (e.g. "daily 2026-04-17") */
  blockTag: string;
  /** Inclusive range in conversation (user/assistant) index space */
  fromIdx: number;
  toIdx: number;
  /** UUIDs of the first/last events of the resolved range, for drift detection. */
  firstUuid?: string;
  lastUuid?: string;
  /** Human-readable explanation of what gets compacted */
  description: string;
}

interface SdkEvent {
  type: string;
  uuid?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  blockTag?: string;
  [k: string]: any;
}

function loadEvents(sdkSessionId: string, sdkSessionsDir: string): SdkEvent[] {
  const path = getSdkSessionPath(sdkSessionId, sdkSessionsDir);
  if (!existsSync(path)) return [];
  return readJsonlFileSync<SdkEvent>(path);
}

/** ISO week tag for a Date (YYYY-Www). Matches Python's isocalendar. */
export function isoWeekTag(d: Date): string {
  // https://en.wikipedia.org/wiki/ISO_week_date#Algorithms
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Local-tz YYYY-MM-DD for a Date. */
function localDateTag(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Local-tz YYYY-MM for a Date. */
function localMonthTag(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * For daily rollups, keep the most recent N raw events outside the
 * compacted range so mid-day compacts don't wipe warm short-term texture.
 * Weekly+ consume block summaries (not raw events), so this doesn't apply.
 * Override via config.lcm.dailyFreshTail.
 */
function dailyFreshTail(): number {
  return config.lcm.dailyFreshTail;
}

/** Concatenate text-block content from an event (SDK or simple shape). */
function extractText(e: SdkEvent): string {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && typeof b === "object" && b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/**
 * Is this event a real CONVERSATIONAL turn — something the user actually said,
 * or an assistant text reply — as opposed to a system/heartbeat/cron injection
 * or pure tool machinery (tool_result user turns, tool_use-only assistant turns)?
 *
 * Used to COUNT the global fresh tail window (the newest N such turns). Retention
 * is positional from the Nth-newest candidate, so non-candidate events that fall
 * inside the retained suffix are still kept (chain continuity) — they just don't
 * advance the count.
 *
 * Classification (verified against real SDK session shapes 2026-06-05):
 *   - real user msg:   "[imessage · Fri 06/05 22:18 PDT] 🧱做好了"            → candidate
 *   - coalesced msgs:  "[imessage · …] [User sent 2 messages in quick succ…]" → candidate (real text)
 *   - cron:            "[imessage · …] System: Scheduled task …"             → NOT (System: after prefix)
 *   - continuity beat: "System: It is Fri … Weather …"                       → NOT (raw System:)
 *   - tool_result turn: user event with no text block                        → NOT (machinery)
 *   - tool_use-only assistant turn: no text                                  → NOT (machinery)
 */
export function isWarmTailCandidate(e: SdkEvent): boolean {
  if (e.type !== "user" && e.type !== "assistant") return false;
  if (e.isCompactSummary) return false;
  const text = extractText(e);
  if (e.type === "assistant") {
    // A real reply has text; pure tool_use turns are machinery.
    const trimmed = text.trim();
    if (!trimmed) return false;
    // Housekeeping cron/rollup/heartbeat turns often resolve silently.
    if (/^NO_REPLY$/i.test(trimmed)) return false;
    return true;
  }
  // user event
  if (!text) return false; // tool_result-only turn = machinery
  // Strip ALL leading bracketed prefixes (+ whitespace), then a System: prefix
  // means heartbeat/cron (both injected, not conversation). Looping matters:
  // a cron turn with a pending note prepended looks like
  //   "[System: <note>]\n\n[imessage · …] System: Scheduled task …"
  // so stripping just one bracket would leave "[imessage · …] System:" and
  // misclassify the cron as conversational. Coalesced real msgs
  //   "[imessage · …] [User sent 2 messages …] real text"
  // strip down to "real text" → still correctly a candidate.
  let stripped = text;
  for (let prev = ""; stripped !== prev; ) {
    prev = stripped;
    stripped = stripped.replace(/^\[[^\]]*\]\s*/, "");
  }
  if (stripped.startsWith("System:")) return false;
  return true;
}

/**
 * Global index where the warm tail begins: the index of the Nth-newest
 * warm-tail-candidate event. Everything at this index or later (candidates plus
 * interleaved machinery/system events) is the retained contiguous suffix.
 * Returns events.length when there's nothing to keep (n<=0 or no candidates) so
 * callers treat the tail as empty.
 */
export function globalFreshTailStartIdx(events: SdkEvent[], n: number): number {
  if (n <= 0) return events.length;
  const candidateIdx: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (isWarmTailCandidate(events[i])) candidateIdx.push(i);
  }
  if (candidateIdx.length === 0) return events.length;
  if (candidateIdx.length <= n) return candidateIdx[0];
  return candidateIdx[candidateIdx.length - n];
}

function monthForIsoWeekTag(weekTag: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekTag);
  if (!m) return null;
  return localMonthTag(isoWeekThursday(Number(m[1]), Number(m[2])));
}

function warmSuffixParentPeriods(events: SdkEvent[], tailStart: number): {
  weeks: Set<string>;
  months: Set<string>;
  years: Set<string>;
} {
  const weeks = new Set<string>();
  const months = new Set<string>();
  const years = new Set<string>();

  for (let i = tailStart; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (e.isCompactSummary) continue;
    if (!e.timestamp) continue;

    const day = localDateTag(new Date(e.timestamp));
    const week = isoWeekTag(new Date(day + "T12:00:00"));
    weeks.add(week);

    const month = monthForIsoWeekTag(week);
    if (month) {
      months.add(month);
      years.add(month.slice(0, 4));
    }
  }

  return { weeks, months, years };
}

/**
 * Resolve the event range for a given rollup level + optional explicit period.
 * Returns null if there's nothing to compact (no matching events / children).
 */
export function resolveBlockRange(
  sdkSessionId: string,
  level: BlockLevel,
  period: string | undefined,
  sdkSessionsDir: string,
): ResolvedRange | null {
  const events = loadEvents(sdkSessionId, sdkSessionsDir);
  if (events.length === 0) return null;
  const convIdxOf = (globalIdx: number): number | null => {
    // Map global index → conversation index (null if not a u/a event)
    let conv = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === "user" || events[i].type === "assistant") {
        if (i === globalIdx) return conv;
        conv++;
      }
    }
    return null;
  };

  const resolvedPeriod = period ?? defaultPeriod(level);
  const tag = `${level} ${resolvedPeriod}`;

  if (config.lcm.globalFreshTail && level !== "daily") {
    const tailStart = globalFreshTailStartIdx(events, dailyFreshTail());
    const warmPeriods = warmSuffixParentPeriods(events, tailStart);
    if (
      (level === "weekly" && warmPeriods.weeks.has(resolvedPeriod)) ||
      (level === "monthly" && warmPeriods.months.has(resolvedPeriod)) ||
      (level === "yearly" && warmPeriods.years.has(resolvedPeriod))
    ) {
      return null;
    }
  }

  // Find source events to compact for this level.
  const matches: number[] = []; // global indices
  for (let i = 0; i < events.length; i++) {
    if (matchesLevelPeriod(events[i], level, resolvedPeriod)) matches.push(i);
  }

  if (matches.length === 0) {
    return null;
  }

  // Daily rollup only: preserve a fresh tail of the most recent raw events.
  // The existing daily block (if any) and any earlier raw events still get
  // compacted — we just stop short of the last `tail` matches.
  //
  // The fresh tail only applies to *today*'s rollup (mid-day compacts shouldn't
  // wipe warm short-term texture). Past days are already cold — compact them
  // in full, regardless of event count. Without this distinction, any past day
  // with ≤ tail raw events can never be rolled up and stays forever in the
  // hot context as un-promoted raw events.
  let effectiveMatches = matches;
  if (level === "daily" && config.lcm.globalFreshTail) {
    // Global fresh tail: keep the newest N conversational turns warm across ALL
    // days (not just today), so a new day doesn't cold-start with summaries only.
    // The tail start is a session-global boundary; this day's raw is compacted
    // only up to (not into) that boundary. When the boundary later advances past
    // this day's leftovers, a rebuild rollup (triggered by findDuePromotions,
    // which uses the same boundary) absorbs them — that's the "GC" path.
    const tailStart = globalFreshTailStartIdx(events, dailyFreshTail());
    const rawOutsideTail = matches.filter(
      (idx) => !events[idx].isCompactSummary && idx < tailStart,
    );
    if (rawOutsideTail.length === 0) {
      // All of this day's raw is within the global warm tail → nothing to promote.
      if (!matches.some((idx) => events[idx].isCompactSummary)) {
        return null;
      }
      effectiveMatches = matches.filter((idx) => events[idx].isCompactSummary);
    } else {
      effectiveMatches = matches.filter(
        (idx) => idx < tailStart || events[idx].isCompactSummary,
      );
    }
  } else if (level === "daily" && resolvedPeriod === localDateTag(new Date())) {
    const tail = dailyFreshTail();
    const rawOnly = matches.filter((idx) => !events[idx].isCompactSummary);
    if (rawOnly.length <= tail) {
      // Nothing outside the fresh tail to compact (and no existing block to rebuild).
      if (!matches.some((idx) => events[idx].isCompactSummary)) {
        return null;
      }
      // Existing block exists but all raw is within fresh tail → compact just the block.
      effectiveMatches = matches.filter((idx) => events[idx].isCompactSummary);
    } else {
      const tailStart = rawOnly[rawOnly.length - tail];
      effectiveMatches = matches.filter((idx) => idx < tailStart || events[idx].isCompactSummary);
    }
  }

  const firstIdx = effectiveMatches[0];
  const lastIdx = effectiveMatches[effectiveMatches.length - 1];
  const fromConv = convIdxOf(firstIdx);
  const toConv = convIdxOf(lastIdx);
  if (fromConv === null || toConv === null) return null;

  // Describe what we're compacting for the CLI/skill output
  const existingBlock = events.find(
    (e) => e.isCompactSummary && e.blockTag === tag,
  );
  const count = effectiveMatches.length;
  const kept = matches.length - effectiveMatches.length;
  const tailSuffix = kept > 0 ? ` (${kept} most-recent events kept raw)` : "";
  const description = existingBlock
    ? `update ${tag}: ${count} events (existing block will be replaced)${tailSuffix}`
    : `create ${tag}: ${count} events${tailSuffix}`;

  return {
    blockTag: tag,
    fromIdx: fromConv,
    toIdx: toConv,
    firstUuid: events[firstIdx].uuid,
    lastUuid: events[lastIdx].uuid,
    description,
  };
}

function defaultPeriod(level: BlockLevel): string {
  const now = new Date();
  switch (level) {
    case "daily":
      return localDateTag(now);
    case "weekly": {
      // last completed ISO week = 7 days ago
      const d = new Date(now.getTime() - 7 * 86400000);
      return isoWeekTag(d);
    }
    case "monthly": {
      // last completed month = first day of previous month
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      return localMonthTag(d);
    }
    case "yearly":
      return String(now.getFullYear() - 1);
  }
}

function matchesLevelPeriod(e: SdkEvent, level: BlockLevel, period: string): boolean {
  // Include events that either (a) already carry the target blockTag (rebuild),
  // or (b) are source material for this level's rollup.
  const targetTag = `${level} ${period}`;
  if (e.isCompactSummary && e.blockTag === targetTag) return true;

  switch (level) {
    case "daily": {
      // Raw user/assistant events on this local-tz day.
      if (e.type !== "user" && e.type !== "assistant") return false;
      if (e.isCompactSummary) return false; // don't absorb non-matching summaries
      if (!e.timestamp) return false;
      const d = new Date(e.timestamp);
      return localDateTag(d) === period;
    }
    case "weekly": {
      // daily blocks whose date falls in this ISO week.
      if (!e.isCompactSummary || !e.blockTag) return false;
      const m = /^daily (\d{4}-\d{2}-\d{2})$/.exec(e.blockTag);
      if (!m) return false;
      const d = new Date(m[1] + "T12:00:00"); // noon local to avoid tz edge cases
      return isoWeekTag(d) === period;
    }
    case "monthly": {
      // weekly blocks whose ISO week has ≥4 days in this month.
      // Use the Thursday of the ISO week as representative (ISO spec).
      if (!e.isCompactSummary || !e.blockTag) return false;
      const m = /^weekly (\d{4})-W(\d{2})$/.exec(e.blockTag);
      if (!m) return false;
      const year = Number(m[1]);
      const week = Number(m[2]);
      const thursday = isoWeekThursday(year, week);
      return localMonthTag(thursday) === period;
    }
    case "yearly": {
      // monthly blocks for this year.
      if (!e.isCompactSummary || !e.blockTag) return false;
      const m = /^monthly (\d{4})-\d{2}$/.exec(e.blockTag);
      if (!m) return false;
      return m[1] === period;
    }
  }
}

/** Date of the Thursday (local) for a given ISO year + week. */
function isoWeekThursday(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Dow = jan4.getDay() || 7; // Mon=1..Sun=7
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - jan4Dow + 1);
  const thursday = new Date(week1Mon);
  thursday.setDate(week1Mon.getDate() + (isoWeek - 1) * 7 + 3);
  return thursday;
}

/**
 * Scan for rollups that are due — completed calendar units with un-promoted
 * children. Used by startup/cron to nudge the agent.
 */
export interface DuePromotion {
  level: BlockLevel;
  period: string;
  childCount: number;
}

export function findDuePromotions(sdkSessionId: string, sdkSessionsDir: string): DuePromotion[] {
  const events = loadEvents(sdkSessionId, sdkSessionsDir);
  if (events.length === 0) return [];

  const now = new Date();
  const currentDay = localDateTag(now);
  const currentWeek = isoWeekTag(now);
  const currentMonth = localMonthTag(now);
  const currentYear = String(now.getFullYear());

  // Existing block tags already present
  const haveTags = new Set<string>();
  for (const e of events) {
    if (e.isCompactSummary && e.blockTag) haveTags.add(e.blockTag);
  }

  // Global fresh tail boundary (events.length when the flag is off → inert).
  const tailStart = config.lcm.globalFreshTail
    ? globalFreshTailStartIdx(events, dailyFreshTail())
    : events.length;

  // Parent periods that still contain raw events INSIDE the global warm suffix.
  // Child blocks in such periods are partial *by design* (their newest turns are
  // intentionally kept warm, not yet summarized), so they must NOT be promoted
  // upward — else the parent would summarize an incomplete child and never
  // re-run (haveTags) after the child later rebuilds to absorb the aged-out raw.
  //
  // Scope to in-suffix raw ONLY (not all raw): aged-out leftover raw must NOT
  // block weekly, or we'd deadlock — the daily path suppresses sub-floor
  // (<FLOOR_WITH_BLOCK) rebuilds, so a day with a block + 2 aged-out raw would
  // be neither daily-due nor weekly-eligible. Sub-floor aged-out residue is
  // tolerated (weekly promotes a near-complete block) exactly as in the
  // today-only path. Under flag-off, tailStart=length → this set is empty →
  // default behavior fully preserved.
  const warmPeriods = warmSuffixParentPeriods(events, tailStart);

  // Candidate periods: for each source block, derive its parent period.
  const weeklyChildrenByWeek = new Map<string, number>();
  const monthlyChildrenByMonth = new Map<string, number>();
  const yearlyChildrenByYear = new Map<string, number>();

  for (const e of events) {
    if (!e.isCompactSummary || !e.blockTag) continue;
    const tag = e.blockTag;

    let m = /^daily (\d{4}-\d{2}-\d{2})$/.exec(tag);
    if (m) {
      const wk = isoWeekTag(new Date(m[1] + "T12:00:00"));
      // Skip the whole week while any raw in that week is still warm-by-design.
      if (warmPeriods.weeks.has(wk)) continue;
      if (wk !== currentWeek) {
        weeklyChildrenByWeek.set(wk, (weeklyChildrenByWeek.get(wk) ?? 0) + 1);
      }
      continue;
    }
    m = /^weekly (\d{4})-W(\d{2})$/.exec(tag);
    if (m) {
      const thursday = isoWeekThursday(Number(m[1]), Number(m[2]));
      const month = localMonthTag(thursday);
      // Skip the whole month while any raw in a child week is still warm.
      if (warmPeriods.months.has(month)) continue;
      if (month !== currentMonth) {
        monthlyChildrenByMonth.set(month, (monthlyChildrenByMonth.get(month) ?? 0) + 1);
      }
      continue;
    }
    m = /^monthly (\d{4})-\d{2}$/.exec(tag);
    if (m) {
      const year = m[1];
      // Skip the whole year while any raw in a child month is still warm.
      if (warmPeriods.years.has(year)) continue;
      if (year !== currentYear) {
        yearlyChildrenByYear.set(year, (yearlyChildrenByYear.get(year) ?? 0) + 1);
      }
    }
  }

  const due: DuePromotion[] = [];

  for (const [wk, count] of weeklyChildrenByWeek) {
    if (!haveTags.has(`weekly ${wk}`)) {
      due.push({ level: "weekly", period: wk, childCount: count });
    }
  }
  for (const [m, count] of monthlyChildrenByMonth) {
    if (!haveTags.has(`monthly ${m}`)) {
      due.push({ level: "monthly", period: m, childCount: count });
    }
  }
  for (const [y, count] of yearlyChildrenByYear) {
    if (!haveTags.has(`yearly ${y}`)) {
      due.push({ level: "yearly", period: y, childCount: count });
    }
  }

  // Nudge for any past day that has raw (non-summary) user/assistant events
  // sitting in the chain. Two scenarios to catch:
  //   1. No `daily <day>` block exists yet — agent forgot to write one.
  //   2. `daily <day>` block exists BUT extra raw events leaked past it, e.g.
  //      fresh-tail leftovers from when that day was "today", or a partial
  //      early-day compact that never got re-run. Rebuild semantics absorb
  //      these cleanly when the agent re-runs `tomo lcm daily --date <day>`.
  // Small raw-tail floors avoid spamming nudges for one or two orphaned
  // metadata/attachment residuals.
  const FLOOR_WITH_BLOCK = 8;   // block exists — only nudge if meaningful leftover
  const FLOOR_WITHOUT_BLOCK = 1; // no block — any raw event is a reason to nudge

  // With the global fresh tail on, raw events inside the warm-tail suffix are
  // intentionally kept un-promoted — they must NOT trigger a daily nudge (else
  // we'd re-nudge forever while they sit warm). Once the boundary advances past
  // them, they fall outside the suffix and DO get counted → the rollup rebuild
  // absorbs them. So the `i >= tailStart` check (tailStart computed above) is
  // both the no-nudge guard and the GC trigger.
  const rawDays = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (e.isCompactSummary) continue;
    if (!e.timestamp) continue;
    if (i >= tailStart) continue; // inside the global warm tail → not due
    const day = localDateTag(new Date(e.timestamp));
    if (day !== currentDay) {
      rawDays.set(day, (rawDays.get(day) ?? 0) + 1);
    }
  }
  for (const [day, count] of rawDays) {
    const hasBlock = haveTags.has(`daily ${day}`);
    const floor = hasBlock ? FLOOR_WITH_BLOCK : FLOOR_WITHOUT_BLOCK;
    if (count >= floor) {
      due.push({ level: "daily", period: day, childCount: count });
    }
  }

  // Oldest-first so the agent works chronologically
  due.sort((a, b) => a.period.localeCompare(b.period));
  return due;
}
