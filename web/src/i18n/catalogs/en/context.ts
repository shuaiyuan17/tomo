/** The Study's Context page. */
export const context = {
  fill: { calm: "Room to spare", warn: "Filling up", critical: "Nearly full" },
  segment: { conversation: "Conversation", fixed: "Always loaded", used: "Used", reserved: "Compact buffer", free: "Free" },
  meterValue: "{{percent}} used, {{state}}", segmentTitle: "{{name}}: {{tokens}} tokens",
  window: {
    heading: "Context window · {{title}}", recorded: "Last recorded {{when}}", notRecorded: "No turn recorded yet",
    unavailable: "Unavailable until a turn reports its context window.", share: "{{percent}} of the window",
    tokens: "<used>{{used}}</used> of <max>{{max}}</max> tokens",
    estimated: "Estimated at the end of the last turn", reported: "Reported by the model at the end of the last turn",
    reservedNote: "kept for compaction",
  },
  stretches: {
    heading: "Largest stretches of the transcript",
    aside_one: "{{messages}} message · ≈{{tokens}} tokens", aside_other: "{{messages}} messages · ≈{{tokens}} tokens",
    tooLarge: "The transcript is too large to analyse here. Use <cmd>tomo lcm stats</cmd>.", empty: "No transcript to analyse yet.",
    tools: "Tools: {{tools}}", mixed: "Conversation and tools: {{tools}}",
    meta_one: "{{count}} message · {{when}}", meta_other: "{{count}} messages · {{when}}",
    metaTools_one: "{{count}} message · {{calls}} tool calls · {{when}}", metaTools_other: "{{count}} messages · {{calls}} tool calls · {{when}}",
  },
  level: { daily: "daily", weekly: "weekly", monthly: "monthly", yearly: "yearly", legacy: "legacy" },
  rollups: {
    heading: "Rolled-up history", count_one: "{{count}} {{level}}", count_other: "{{count}} {{level}}",
    empty: "No summary blocks in this session yet.", label: "Rollup blocks, newest first", legacy: "Compact summary",
    events_one: "{{events}} <unit>event</unit>", events_other: "{{events}} <unit>events</unit>",
    rolledUp: "rolled up {{when}}", shortened: "Preview shortened.", truncated: "Only the 100 most recent blocks are listed.",
  },
  compactions: { heading: "Compactions since Tomo started", seen_one: "{{count}} seen", seen_other: "{{count}} seen" },
  fills: {
    heading: "What fills it", headingStale: "What filled it", aside: "{{tokens}} used", asideStale: "{{tokens}} at the last full reading",
    stale: "From the last full reading, not the current figure above. Shares are of that reading.",
    staleEstimated: "From the last full reading, not the current figure above, which is an estimate. Shares are of that reading.",
    label: "What fills the window", labelStale: "What filled the window at the last full reading",
  },
  deferred: { heading: "Not loaded", note: "Tool definitions deferred until they are needed. They take no room in the window.", label: "Deferred, not in the window" },
} as const;
