import { readFileSync, existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { LOG_PATH } from "./shared.js";

interface CostEntry {
  time: number;
  session: string;
  cost: number;
}

function parseCostEntries(): CostEntry[] {
  if (!existsSync(LOG_PATH)) return [];

  const raw = readFileSync(LOG_PATH, "utf-8");
  const entries: CostEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line || !line.includes("Run completed")) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.cost !== "string" || typeof obj.time !== "number") continue;
      const cost = parseFloat(obj.cost.replace("$", ""));
      if (isNaN(cost)) continue;
      entries.push({
        time: obj.time,
        session: obj.session ?? "unknown",
        cost,
      });
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

function filterByRange(entries: CostEntry[], range: string): CostEntry[] {
  const now = Date.now();
  let cutoff: number;
  switch (range) {
    case "day": cutoff = now - 24 * 60 * 60 * 1000; break;
    case "week": cutoff = now - 7 * 24 * 60 * 60 * 1000; break;
    case "month": cutoff = now - 30 * 24 * 60 * 60 * 1000; break;
    default: cutoff = 0;
  }
  return entries.filter((e) => e.time >= cutoff);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function buildCostSummary(entries: CostEntry[]): string {
  if (entries.length === 0) return "  No usage data.";

  const totalCost = entries.reduce((s, e) => s + e.cost, 0);
  const avgCost = totalCost / entries.length;

  // Group by session
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

  // Sort sessions by cost descending
  const sorted = [...bySession.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [session, stats] of sorted) {
    const avg = stats.count > 0 ? formatCost(stats.cost / stats.count) : "$0.00";
    lines.push(`  ${session.padEnd(24)} ${formatCost(stats.cost).padStart(10)}  (${stats.count} msgs, ${avg}/msg)`);
  }

  return lines.join("\n");
}

export async function configCostAnalysis(): Promise<void> {
  const allEntries = parseCostEntries();

  if (allEntries.length === 0) {
    p.log.info("No cost data found. Cost data is recorded when Tomo runs as a daemon.");
    return;
  }

  for (;;) {
    const choice = await p.select({
      message: "Cost analysis — select time range",
      options: [
        { value: "day", label: "Today", hint: "last 24 hours" },
        { value: "week", label: "This week", hint: "last 7 days" },
        { value: "month", label: "This month", hint: "last 30 days" },
        { value: "total", label: "All time" },
        { value: "back", label: "Back" },
      ],
    });

    if (p.isCancel(choice) || choice === "back") break;

    const filtered = filterByRange(allEntries, choice as string);
    const rangeLabel = choice === "total" ? "All time" : choice === "day" ? "Last 24 hours" : choice === "week" ? "Last 7 days" : "Last 30 days";

    p.log.info(`${rangeLabel}\n${buildCostSummary(filtered)}`);

    // Offer per-session drill-in
    if (filtered.length === 0) continue;

    const sessions = new Map<string, CostEntry[]>();
    for (const e of filtered) {
      const arr = sessions.get(e.session) ?? [];
      arr.push(e);
      sessions.set(e.session, arr);
    }

    if (sessions.size <= 1) continue;

    const drillIn = await p.select({
      message: "View session detail?",
      options: [
        ...[...sessions.entries()]
          .sort((a, b) => b[1].reduce((s, e) => s + e.cost, 0) - a[1].reduce((s, e) => s + e.cost, 0))
          .map(([key, entries]) => ({
            value: key,
            label: key,
            hint: `${formatCost(entries.reduce((s, e) => s + e.cost, 0))} / ${entries.length} msgs`,
          })),
        { value: "back", label: "Back" },
      ],
    });

    if (p.isCancel(drillIn) || drillIn === "back") continue;

    const sessionEntries = sessions.get(drillIn as string) ?? [];
    const totalCost = sessionEntries.reduce((s, e) => s + e.cost, 0);
    const avgCost = sessionEntries.length > 0 ? totalCost / sessionEntries.length : 0;
    const firstMsg = sessionEntries.length > 0 ? new Date(sessionEntries[0].time).toLocaleString() : "—";
    const lastMsg = sessionEntries.length > 0 ? new Date(sessionEntries[sessionEntries.length - 1].time).toLocaleString() : "—";

    p.log.info([
      `Session: ${drillIn}`,
      `  Total cost:       ${formatCost(totalCost)}`,
      `  Messages:         ${sessionEntries.length}`,
      `  Avg per message:  ${formatCost(avgCost)}`,
      `  First message:    ${firstMsg}`,
      `  Last message:     ${lastMsg}`,
    ].join("\n"));
  }
}
