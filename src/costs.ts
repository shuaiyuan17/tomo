import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimePaths } from "./runtime-paths.js";

export interface CostEntry {
  time: number;
  session: string;
  cost: number;
}

export type CostRange = "day" | "week" | "month" | "total";

export const DEFAULT_COST_LOG_PATH = join(defaultRuntimePaths.logsDir, "tomo.log");

export function parseCostEntries(logPath = DEFAULT_COST_LOG_PATH): CostEntry[] {
  if (!existsSync(logPath)) return [];

  const raw = readFileSync(logPath, "utf-8");
  const entries: CostEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line || !line.includes("Run completed")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.time !== "number") continue;
      const cost = parseCostValue(obj.cost);
      if (cost === null) continue;
      entries.push({
        time: obj.time,
        session: typeof obj.session === "string" && obj.session ? obj.session : "unknown",
        cost,
      });
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

export function filterCostEntriesByRange(
  entries: CostEntry[],
  range: CostRange,
  now = Date.now(),
): CostEntry[] {
  let cutoff: number;
  switch (range) {
    case "day": cutoff = now - 24 * 60 * 60 * 1000; break;
    case "week": cutoff = now - 7 * 24 * 60 * 60 * 1000; break;
    case "month": cutoff = now - 30 * 24 * 60 * 60 * 1000; break;
    default: cutoff = 0;
  }
  return entries.filter((e) => e.time >= cutoff);
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function buildCostSummary(entries: CostEntry[]): string {
  if (entries.length === 0) return "  No usage data.";

  const totalCost = totalCostFor(entries);
  const avgCost = totalCost / entries.length;

  const bySession = new Map<string, { cost: number; count: number }>();
  for (const e of entries) {
    const s = bySession.get(e.session) ?? { cost: 0, count: 0 };
    s.cost += e.cost;
    s.count++;
    bySession.set(e.session, s);
  }

  const lines: string[] = [
    `  Total cost:         ${formatCost(totalCost)}`,
    `  Total messages:     ${entries.length}`,
    `  Avg per message:    ${formatCost(avgCost)}`,
    "",
  ];

  const sorted = [...bySession.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [session, stats] of sorted) {
    const avg = stats.count > 0 ? formatCost(stats.cost / stats.count) : "$0.00";
    lines.push(`  ${session.padEnd(24)} ${formatCost(stats.cost).padStart(10)}  (${stats.count} msgs, ${avg}/msg)`);
  }

  return lines.join("\n");
}

export function buildSessionCostReport(
  sessionKey: string,
  opts: { logPath?: string; entries?: CostEntry[]; now?: number } = {},
): string {
  const allEntries = opts.entries ?? parseCostEntries(opts.logPath);
  const sessionEntries = allEntries.filter((e) => e.session === sessionKey);
  const now = opts.now ?? Date.now();
  const ranges: Array<{ label: string; range: CostRange }> = [
    { label: "1d", range: "day" },
    { label: "7d", range: "week" },
    { label: "1mo", range: "month" },
  ];

  const lines = [`Cost for ${sessionKey}`];
  for (const { label, range } of ranges) {
    const entries = filterCostEntriesByRange(sessionEntries, range, now);
    const total = totalCostFor(entries);
    const count = entries.length;
    const avg = count > 0 ? `, ${formatCost(total / count)}/run` : "";
    lines.push(`${label}: ${formatCost(total)} (${count} ${count === 1 ? "run" : "runs"}${avg})`);
  }

  return lines.join("\n");
}

function parseCostValue(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const cost = Number(raw.trim().replace(/^\$/, ""));
  return Number.isFinite(cost) ? cost : null;
}

function totalCostFor(entries: CostEntry[]): number {
  return entries.reduce((sum, e) => sum + e.cost, 0);
}
