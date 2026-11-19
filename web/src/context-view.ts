import type { ContextCategory } from "../../src/sessions/types.js";

/** Pure helpers for the Study's Context page: how full, made of what, rolled up into what. */

/** How full the window is, as a state: the meter's colour and the words beside the number. */
export type FillTone = "calm" | "warn" | "critical";
/** From here the window is "filling up" (the daemon logs "nearing compaction" at the same point). */
export const CONTEXT_WARN_PERCENT = 80;
/** From here it is "nearly full". */
export const CONTEXT_CRITICAL_PERCENT = 95;
export const FILL_LABELS: Record<FillTone, string> = { calm: "Room to spare", warn: "Filling up", critical: "Nearly full" };

/** Used share of the window, 0–100 (0 without a window; never above 100). */
export function fillPercent(used: number, max: number): number {
  if (!(max > 0) || !(used > 0)) return 0;
  return Math.min(100, used / max * 100);
}

export function fillTone(percent: number): FillTone {
  return percent >= CONTEXT_CRITICAL_PERCENT ? "critical" : percent >= CONTEXT_WARN_PERCENT ? "warn" : "calm";
}

/** A share as text: whole percents, but a small non-zero share is "<1%" (not "0%") and a not-quite-full one is never "100%". */
export function formatPercent(percent: number): string {
  if (!(percent > 0)) return "0%";
  if (percent < 1) return "<1%";
  return `${percent >= 100 ? 100 : Math.min(99, Math.round(percent))}%`;
}

/**
 * What a breakdown row is. The SDK lists everything it can count under one
 * flat list of names: what occupies the window, tool definitions that are
 * deferred (not loaded, so not in `used`), the reserve kept for compaction,
 * and the free rest.
 */
export type CategoryKind = "conversation" | "fixed" | "deferred" | "reserved" | "free";
export function categoryKind(name: string): CategoryKind {
  const n = name.trim().toLowerCase();
  if (/\(deferred\)$/.test(n)) return "deferred";
  if (n === "free space") return "free";
  if (/\bbuffer$/.test(n)) return "reserved";
  if (n === "messages") return "conversation";
  return "fixed";
}

/** One piece of the window meter, as a share (0–100) of the whole window. */
export interface WindowSegment { kind: "conversation" | "fixed" | "used" | "reserved"; tokens: number; percent: number }
export interface WindowComposition {
  /** The conversation itself: the part that grows, and that rollups and compaction shrink. */
  conversation: number;
  /** Loaded on every turn whatever is said: system prompt, tool definitions, skills, memory. */
  fixed: number;
  /** Kept back for compaction. */
  reserved: number;
  free: number;
  /** Rows that occupy the window, largest first. */
  counted: ContextCategory[];
  /** Listed by the SDK but not loaded, largest first, without the "(deferred)" suffix. */
  deferred: ContextCategory[];
  /** Left to right; the rest of the meter is free space. Empty without a window. */
  segments: WindowSegment[];
  /** What the `counted` rows add up to. */
  listed: number;
  /**
   * The rows are not a measurement of `used`: the reading is an estimate, or
   * the rows do not add up to it (they are kept from the last full reading
   * when a later one fails). The meter is then one undivided piece and the
   * rows are to be shown as an earlier reading, with shares of `listed`.
   */
  stale: boolean;
}

/** Rows within this share of `used` count as adding up to it (rounding). */
const BREAKDOWN_TOLERANCE = 0.01;

/**
 * The window as parts of a whole. `used` is the authority. The meter is split
 * into conversation and always-loaded only when the breakdown measures that
 * same reading; a breakdown from another reading (see `stale`) is never
 * rescaled to look current, so the meter stays one undivided piece, as it is
 * without a breakdown.
 */
export function composeWindow(breakdown: ContextCategory[], used: number, max: number, estimated = false): WindowComposition {
  const rows = breakdown.filter((row) => row.tokens > 0);
  const of = (kind: CategoryKind) => rows.filter((row) => categoryKind(row.name) === kind);
  const sum = (list: ContextCategory[]) => list.reduce((total, row) => total + row.tokens, 0);
  const bySize = (a: ContextCategory, b: ContextCategory) => b.tokens - a.tokens;
  const counted = [...of("conversation"), ...of("fixed")].sort(bySize);
  const deferred = of("deferred").map((row) => ({ name: row.name.replace(/\s*\(deferred\)\s*$/i, ""), tokens: row.tokens })).sort(bySize);
  const total = Math.max(0, Math.min(used, max > 0 ? max : used));
  const listed = sum(counted);
  const stale = listed > 0 && (estimated || Math.abs(listed - used) > Math.max(1, used * BREAKDOWN_TOLERANCE));
  const split = listed > 0 && !stale;
  // Only rounding, or a reading above the window, is evened out here.
  const conversation = split ? Math.round(sum(of("conversation")) * total / listed) : 0;
  const fixed = split ? total - conversation : 0;
  const reserved = Math.max(0, Math.min(sum(of("reserved")), max - total));
  const free = Math.max(0, max - total - reserved);
  const share = (tokens: number) => max > 0 ? tokens / max * 100 : 0;
  const pieces: WindowSegment[] = split
    ? [{ kind: "conversation", tokens: conversation, percent: share(conversation) }, { kind: "fixed", tokens: fixed, percent: share(fixed) }]
    : [{ kind: "used", tokens: total, percent: share(total) }];
  pieces.push({ kind: "reserved", tokens: reserved, percent: share(reserved) });
  return { conversation, fixed, reserved, free, counted, deferred, listed, stale, segments: max > 0 ? pieces.filter((piece) => piece.tokens > 0) : [] };
}

const LEVELS = ["daily", "weekly", "monthly", "yearly"] as const;

/** Monday of an ISO week, as a UTC date. */
function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday;
}

/**
 * A rollup block's tag as the period it covers: `daily 2026-11-12` → "Thu,
 * Nov 12, 2026", `weekly 2026-W45` → "Nov 2 – Nov 8, 2026" (both years when the
 * week spans New Year), `monthly 2026-10`
 * → "October 2026", `yearly 2025` → "2025". A compact summary from before
 * rollups (`legacy`) is named as such; anything else is shown as written.
 */
export function rollupTitle(tag: string, locale?: string): string {
  if (tag === "legacy") return "Compact summary";
  const text = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date);
  const valid = (date: Date) => !Number.isNaN(date.getTime());
  let match = /^daily (\d{4})-(\d{2})-(\d{2})$/.exec(tag);
  if (match) {
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (valid(date) && date.getUTCMonth() === +match[2] - 1) return text(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  match = /^weekly (\d{4})-W(\d{2})$/.exec(tag);
  if (match && +match[2] >= 1 && +match[2] <= 53) {
    const from = isoWeekStart(+match[1], +match[2]);
    const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
    // A week that spans New Year names both years.
    const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
    return `${text(from, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${text(to, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  match = /^monthly (\d{4})-(\d{2})$/.exec(tag);
  if (match && +match[2] >= 1 && +match[2] <= 12) return text(new Date(Date.UTC(+match[1], +match[2] - 1, 1)), { month: "long", year: "numeric" });
  match = /^yearly (\d{4})$/.exec(tag);
  if (match) return match[1];
  return tag;
}

/** "2 daily · 1 weekly": how many blocks of each level, smallest period first; unknown levels last. */
export function rollupCounts(blocks: Array<{ level: string }>): Array<{ level: string; count: number }> {
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.level, (counts.get(block.level) ?? 0) + 1);
  const rank = (level: string) => { const i = (LEVELS as readonly string[]).indexOf(level); return i < 0 ? LEVELS.length : i; };
  return [...counts].map(([level, count]) => ({ level, count })).sort((a, b) => rank(a.level) - rank(b.level) || a.level.localeCompare(b.level));
}

/** How much a compaction freed, as a share of what was there (0–100); null when either reading is missing or nothing was freed. */
export function compactionFreed(preTokens: number | undefined, postTokens: number | undefined): number | null {
  if (preTokens === undefined || postTokens === undefined || !(preTokens > 0) || postTokens >= preTokens) return null;
  return (preTokens - postTokens) / preTokens * 100;
}
