import { readFileSync, existsSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";

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

function loadEvents(sdkSessionId: string): SdkEvent[] {
  const path = getSdkSessionPath(sdkSessionId);
  if (!existsSync(path)) return [];
  const events: SdkEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return events;
}

/** Return 0-based conv-index for every user/assistant event. */
function convIndices(events: SdkEvent[]): number[] {
  const out: number[] = [];
  let conv = 0;
  for (const e of events) {
    if (e.type === "user" || e.type === "assistant") {
      out.push(conv);
      conv++;
    }
  }
  return out;
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
 */
const DAILY_FRESH_TAIL = 32;

/**
 * Resolve the event range for a given rollup level + optional explicit period.
 * Returns null if there's nothing to compact (no matching events / children).
 */
export function resolveBlockRange(
  sdkSessionId: string,
  level: BlockLevel,
  period?: string,
): ResolvedRange | null {
  const events = loadEvents(sdkSessionId);
  if (events.length === 0) return null;
  const convIdx = convIndices(events);
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
  // compacted — we just stop short of the last DAILY_FRESH_TAIL matches.
  let effectiveMatches = matches;
  if (level === "daily") {
    const rawOnly = matches.filter((idx) => !events[idx].isCompactSummary);
    if (rawOnly.length <= DAILY_FRESH_TAIL) {
      // Nothing outside the fresh tail to compact (and no existing block to rebuild).
      if (!matches.some((idx) => events[idx].isCompactSummary)) {
        return null;
      }
      // Existing block exists but all raw is within fresh tail → compact just the block.
      effectiveMatches = matches.filter((idx) => events[idx].isCompactSummary);
    } else {
      const tailStart = rawOnly[rawOnly.length - DAILY_FRESH_TAIL];
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

  void convIdx;
  return { blockTag: tag, fromIdx: fromConv, toIdx: toConv, description };
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

/**
 * Group sessions use SDK default compact behavior — the block-rollup
 * hierarchy is designed for a continuous personal DM stream, not for
 * group chatter. Harness nudges (RollupRunner, hot-tail cap) skip groups.
 */
export function isGroupSessionKey(key: string): boolean {
  if (key.startsWith("dm:")) return false;
  const colonIdx = key.indexOf(":");
  if (colonIdx < 0) return false;
  const channel = key.slice(0, colonIdx);
  const chatId = key.slice(colonIdx + 1);
  if (channel === "telegram" && chatId.startsWith("-")) return true;
  if (channel === "imessage" && chatId.includes(";+;")) return true;
  return false;
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

export function findDuePromotions(sdkSessionId: string): DuePromotion[] {
  const events = loadEvents(sdkSessionId);
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
      if (wk !== currentWeek) {
        weeklyChildrenByWeek.set(wk, (weeklyChildrenByWeek.get(wk) ?? 0) + 1);
      }
      continue;
    }
    m = /^weekly (\d{4})-W(\d{2})$/.exec(tag);
    if (m) {
      const thursday = isoWeekThursday(Number(m[1]), Number(m[2]));
      const month = localMonthTag(thursday);
      if (month !== currentMonth) {
        monthlyChildrenByMonth.set(month, (monthlyChildrenByMonth.get(month) ?? 0) + 1);
      }
      continue;
    }
    m = /^monthly (\d{4})-\d{2}$/.exec(tag);
    if (m) {
      const year = m[1];
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

  // Also nudge for unconsolidated yesterday-or-earlier raw events
  // (agent forgot to write a daily before midnight).
  const rawDays = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (e.isCompactSummary) continue;
    if (!e.timestamp) continue;
    const day = localDateTag(new Date(e.timestamp));
    if (day !== currentDay) {
      rawDays.set(day, (rawDays.get(day) ?? 0) + 1);
    }
  }
  for (const [day, count] of rawDays) {
    if (!haveTags.has(`daily ${day}`)) {
      due.push({ level: "daily", period: day, childCount: count });
    }
  }

  // Oldest-first so the agent works chronologically
  due.sort((a, b) => a.period.localeCompare(b.period));
  return due;
}

/**
 * Count raw (non-summary) user/assistant events since the most recent
 * `daily <today>` block. Used to trigger the hot-tail cap nudge.
 */
export function countRawTailToday(sdkSessionId: string): number {
  const events = loadEvents(sdkSessionId);
  if (events.length === 0) return 0;
  const today = localDateTag(new Date());

  // Find last `daily <today>` block index
  let lastDailyTodayIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.isCompactSummary && e.blockTag === `daily ${today}`) {
      lastDailyTodayIdx = i;
    }
  }

  let raw = 0;
  for (let i = lastDailyTodayIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (e.isCompactSummary) continue;
    raw++;
  }
  return raw;
}
