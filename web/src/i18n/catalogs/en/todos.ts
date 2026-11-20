/** The Study's Todos page. */
export const todos = {
  error: { unavailable: "The todo store could not be read. Nothing was changed." },
  waiting: { owner: "Waiting on you", me: "Waiting on {{agent}}", external: "Waiting on others" },
  empty: { hidden: "No open todos in your conversations.", none: "No open todos. Ask {{agent}} to keep track of something, or send /todo add." },
  groupDue_one: "{{count}} due", groupDue_other: "{{count}} due",
  hidden_one: "{{count}} more open in conversations that are not shown here.", hidden_other: "{{count}} more open in conversations that are not shown here.",
  summary: {
    label: "Summary", open: "Open", due: "Due for review",
    full: "At the limit: {{agent}} cannot add another until one is resolved.",
    near_one: "{{count}} left before {{agent}} has to resolve one first.", near_other: "{{count}} left before {{agent}} has to resolve one first.",
    left_one: "{{count}} left before the limit.", left_other: "{{count}} left before the limit.",
    progress: "{{open}} of {{max}} open todos", dueNote: "Past their review date.", dueNone: "Nothing is past its review date.",
    waitingNote: "{{me}} on {{agent}} · {{external}} on others",
  },
  next: "Next", snoozeLast: "{{snooze}}, none left", snoozeReason: ": {{reason}}", inGroup: "In {{group}}", addedByYou: "Added by you",
  snoozed_one: "Snoozed {{count}} of {{max}}", snoozed_other: "Snoozed {{count}} of {{max}}",
  due: "Due {{when}}", review: "Review {{when}}", reviewOn: "Review {{date}}",
  recent: { heading: "Recently closed", latest_one: "Latest {{count}}", latest_other: "Latest {{count}}", done: "Done {{when}} · by {{who}}", dropped: "Dropped {{when}} · by {{who}}", you: "you" },
} as const;
