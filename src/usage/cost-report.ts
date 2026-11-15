import type {
  WebCost, WebCostCategory, WebCostCron, WebCostDay, WebCostGlance, WebCostHour, WebCostLimits, WebCostModel, WebCostPeriod,
  WebCostSession, WebCostSplit, WebCostTurn,
} from "../web/protocol.js";
import type { CostRow, LedgerReader } from "./ledger-reader.js";
import { addDays, daysBetween, localParts } from "./local-time.js";

/** Longest range one request may ask for, in days. */
export const MAX_RANGE_DAYS = 400;
/** Default range: the last 30 days, today included. */
export const DEFAULT_RANGE_DAYS = 30;
export const DEFAULT_TOP_TURNS = 10;
export const MAX_TOP_TURNS = 50;
/** Label of the scheduled turns that have no cron job. */
export const OTHER_SCHEDULED = "Other scheduled";

export interface SessionLabel { id?: string; label: string; kind: WebCostSession["kind"] }

export interface CostReportOptions {
  from: string;
  to: string;
  timeZone: string;
  now: number;
  top?: number;
  /** Display name, web id and kind of a ledger session key. */
  describeSession: (sessionKey: string) => SessionLabel;
  limits?: WebCostLimits | null;
}

const split = (): WebCostSplit => ({ you: 0, background: 0, scheduled: 0 });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface DayAcc { costUsd: number; turns: number; byCategory: WebCostSplit; overcounted: boolean; backfilled: boolean }

/** The ledger month files (`YYYY-MM.ndjson`) that can hold rows of local dates `from`–`to`. */
export function monthFilesFor(files: readonly string[], from: string, to: string): string[] {
  // A month file is named by the writer's local month; the owner's zone may
  // differ by up to a day, so take one day of slack on each side.
  const lo = addDays(from, -1).slice(0, 7);
  const hi = addDays(to, 1).slice(0, 7);
  return files.filter((f) => { const month = f.slice(0, 7); return month >= lo && month <= hi; });
}

/**
 * Everything the Cost page shows for `from`–`to` (inclusive local dates),
 * plus "At a glance", which is always relative to today.
 *
 * Over-counted days (before #389) are summed and shown like any other, but
 * never compared: the typical day and the busiest day skip them, and a
 * week holding one gets `comparable: false` and no ratio.
 */
export function buildCostReport(reader: LedgerReader, options: CostReportOptions): WebCost {
  const { from, to, timeZone, now } = options;
  const today = localParts(now, timeZone).date;
  const glanceFrom = addDays(today, -29);
  const files = reader.files();
  const wanted = new Set([...monthFilesFor(files, from, to), ...monthFilesFor(files, glanceFrom, today)]);
  // The earliest file says since when anything is recorded.
  if (files.length > 0) wanted.add(files[0]);
  const chosen = files.filter((f) => wanted.has(f));
  const perFile = reader.rows(chosen);

  let recordedSince: number | null = null;
  if (files.length > 0) for (const row of perFile[0]) if (recordedSince === null || row.ts < recordedSince) recordedSince = row.ts;
  const firstRecorded = recordedSince === null ? null : localParts(recordedSince, timeZone).date;

  const days = new Map<string, DayAcc>();
  const dayAcc = (date: string) => {
    let acc = days.get(date);
    if (!acc) days.set(date, acc = { costUsd: 0, turns: 0, byCategory: split(), overcounted: false, backfilled: false });
    return acc;
  };
  const hours: WebCostHour[] = Array.from({ length: 24 }, (_, hour) => ({ hour, costUsd: 0, turns: 0, byCategory: split() }));
  const sessions = new Map<string, WebCostSession & { key: string }>();
  const crons = new Map<string, WebCostCron>();
  const models = new Map<string, WebCostModel>();
  const totals = { costUsd: 0, turns: 0, byCategory: split(), overcountedCostUsd: 0 };
  let unsplitCostUsd = 0;
  const top = Math.min(Math.max(options.top ?? DEFAULT_TOP_TURNS, 0), MAX_TOP_TURNS);
  const topRows: { row: CostRow; date: string }[] = [];

  for (const rows of perFile) {
    for (const row of rows) {
      const { date, hour } = localParts(row.ts, timeZone);
      const inGlance = date >= glanceFrom && date <= today;
      const inRange = date >= from && date <= to;
      if (!inGlance && !inRange) continue;
      const day = dayAcc(date);
      day.costUsd += row.costUsd;
      day.turns++;
      day.byCategory[row.category] += row.costUsd;
      if (row.overcounted) day.overcounted = true;
      if (row.backfilled) day.backfilled = true;
      if (!inRange) continue;

      totals.costUsd += row.costUsd;
      totals.turns++;
      totals.byCategory[row.category] += row.costUsd;
      if (row.overcounted) totals.overcountedCostUsd += row.costUsd;

      const h = hours[hour];
      h.costUsd += row.costUsd;
      h.turns++;
      h.byCategory[row.category] += row.costUsd;

      let session = sessions.get(row.sessionKey);
      if (!session) {
        const label = options.describeSession(row.sessionKey);
        sessions.set(row.sessionKey, session = { key: row.sessionKey, ...label, costUsd: 0, turns: 0, byCategory: split() });
      }
      session.costUsd += row.costUsd;
      session.turns++;
      session.byCategory[row.category] += row.costUsd;

      if (row.category === "scheduled") {
        const jobKey = row.source === "cron" && (row.jobId || row.jobName) ? `job:${row.jobId ?? row.jobName}` : "other";
        let cron = crons.get(jobKey);
        if (!cron) crons.set(jobKey, cron = jobKey === "other"
          ? { jobId: null, name: OTHER_SCHEDULED, costUsd: 0, runs: 0 }
          : { jobId: row.jobId ?? null, name: row.jobName ?? row.jobId!, costUsd: 0, runs: 0 });
        cron.costUsd += row.costUsd;
        cron.runs++;
        if (jobKey !== "other" && row.jobName) cron.name = row.jobName;
      }

      if (row.models) {
        for (const [id, m] of Object.entries(row.models)) {
          let model = models.get(id);
          if (!model) models.set(id, model = { model: id, costUsd: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 } });
          model.costUsd += m.costUsd;
          model.turns++;
          model.tokens.input += m.input;
          model.tokens.output += m.output;
          model.tokens.cacheRead += m.cacheRead;
          model.tokens.cacheCreated += m.cacheCreated;
        }
      } else {
        unsplitCostUsd += row.costUsd;
      }

      if (top > 0 && (topRows.length < top || row.costUsd > topRows[topRows.length - 1].row.costUsd)) {
        let i = topRows.length;
        while (i > 0 && topRows[i - 1].row.costUsd < row.costUsd) i--;
        topRows.splice(i, 0, { row, date });
        if (topRows.length > top) topRows.pop();
      }
    }
  }

  const dayOut = (date: string): WebCostDay => {
    const acc = days.get(date);
    const recorded = firstRecorded !== null && date >= firstRecorded && date <= today;
    return { date, costUsd: acc?.costUsd ?? 0, turns: acc?.turns ?? 0, byCategory: acc?.byCategory ?? split(), recorded,
      overcounted: acc?.overcounted ?? false, backfilled: acc?.backfilled ?? false };
  };
  const span = (a: string, b: string) => Array.from({ length: daysBetween(a, b) + 1 }, (_, i) => dayOut(addDays(a, i)));

  const period = (a: string, b: string): WebCostPeriod => {
    const list = span(a, b);
    return { from: a, to: b, costUsd: list.reduce((s, d) => s + d.costUsd, 0), comparable: !list.some((d) => d.overcounted) };
  };
  const thisWeek = period(addDays(today, -6), today);
  const lastWeek = period(addDays(today, -13), addDays(today, -7));
  const fair = span(glanceFrom, today).filter((d) => d.recorded && !d.overcounted);
  const busiest = fair.reduce<WebCostDay | null>((best, d) => (!best || d.costUsd > best.costUsd ? d : best), null);
  const glance: WebCostGlance = {
    today,
    thisWeek,
    lastWeek,
    weekRatio: thisWeek.comparable && lastWeek.comparable && lastWeek.costUsd > 0 ? thisWeek.costUsd / lastWeek.costUsd : null,
    last30: period(glanceFrom, today),
    typicalDay: fair.length > 0 ? { costUsd: median(fair.map((d) => d.costUsd)), days: fair.length } : null,
    busiestDay: busiest ? { date: busiest.date, costUsd: busiest.costUsd } : null,
  };

  const byCost = <T extends { costUsd: number }>(a: T, b: T) => b.costUsd - a.costUsd;
  return {
    from, to, timeZone, recordedSince,
    totals,
    days: span(from, to),
    hours,
    sessions: [...sessions.values()].sort(byCost).map(({ key: _key, ...s }) => s),
    crons: [...crons.values()].sort(byCost),
    models: [...models.values()].sort(byCost),
    unsplitCostUsd,
    topTurns: topRows.map(({ row, date }) => turnOut(row, date, options.describeSession(row.sessionKey))),
    glance,
    limits: options.limits ?? null,
    generatedAt: now,
  };
}

function turnOut(row: CostRow, date: string, session: SessionLabel): WebCostTurn {
  return {
    ts: row.ts, date, session, category: row.category as WebCostCategory, source: row.source,
    ...(row.jobName ? { jobName: row.jobName } : {}),
    costUsd: row.costUsd,
    ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    ...(row.tools !== undefined ? { tools: row.tools } : {}),
    ...(row.numTurns !== undefined ? { numTurns: row.numTurns } : {}),
    ...(row.trigger ? { trigger: row.trigger } : {}),
    ...(row.overcounted ? { overcounted: true as const } : {}),
    ...(row.backfilled ? { backfilled: true as const } : {}),
  };
}
