import * as p from "@clack/prompts";
import {
  buildCostSummary,
  filterCostEntriesByRange,
  formatCost,
  parseCostEntries,
  type CostEntry,
  type CostRange,
} from "../../costs.js";

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

    const filtered = filterCostEntriesByRange(allEntries, choice as CostRange);
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
