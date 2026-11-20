/** The `/cost` reply (src/costs.ts buildSessionCostReport). */
export const cost = {
  title: "💰 Cost for {{session}}",
  range: { day: "1d", week: "7d", month: "1mo" },
  line_one: "{{range}}: {{total}} ({{count}} run)",
  line_other: "{{range}}: {{total}} ({{count}} runs)",
  lineAvg_one: "{{range}}: {{total}} ({{count}} run, {{avg}}/run)",
  lineAvg_other: "{{range}}: {{total}} ({{count}} runs, {{avg}}/run)",
} as const;
