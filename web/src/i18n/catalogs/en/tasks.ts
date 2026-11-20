/** The Tasks rail: running tasks, the task view's states, and upcoming scheduled jobs. */
export const tasks = {
  heading: "Tasks", close: "Close tasks", closeTitle: "Close", view: "The task view", list: "Task list",
  watchers: "Show watchers", watchersCount_one: "Show watchers ({{count}})", watchersCount_other: "Show watchers ({{count}})",
  empty: "Nothing running in the background.", groupTag: " · group",
  shellTitle: "{{label}}\n\n{{command}}\n\nOpen to see the full command", untitled: "Untitled task",
  backgroundTitle: "Keeps running after Tomo has replied", backgroundTag: "background · ", working: "Working",
  foldedShells_one: "{{count}} shell command done", foldedShells_other: "{{count}} shell commands done",
  lastStep_one: "{{tool}} · {{count}} tool use", lastStep_other: "{{tool}} · {{count}} tool uses",
  type: { local_agent: "subagent", local_bash: "shell", local_workflow: "workflow", monitor: "monitor", mcp_task: "MCP task", remote_agent: "remote agent", task: "task" },
  state: { running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", ended: "Ended" },
  scheduled: {
    heading: "Scheduled", once: "Once", repeats: "Repeats", viewAll: "View all",
    overdue: "overdue", dueNow: "due now", inMinutes_one: "in {{count}} min", inMinutes_other: "in {{count}} min",
    inHours_one: "in {{count}} h", inHours_other: "in {{count}} h", today: "Today {{time}}", tomorrow: "Tomorrow {{time}}",
  },
  control: {
    background: "Move to background", backgroundTitle: "Tomo stops waiting for it; it keeps running and reports back when it is done", stop: "Stop task",
    stopFailed: "Couldn't stop it. It may have just finished.", backgroundFailed: "Couldn't move it. It may have finished, or is no longer in the foreground.",
  },
  back: "Back to tasks", backgroundSuffix: " · background", now: "Now:",
  transcript: {
    label: "Subagent transcript", goneKept: "This task has left the panel, so nothing more can be loaded. What was read stays here.",
    earlier: "Load earlier", nothingYet: "Nothing yet.", noSteps: "No recorded steps.", messageFrom: "Message from {{agent}}", jump: "↓ Jump to latest",
  },
  brief: { heading: "Brief", less: "Show less", more: "Show more", truncated: "{{text}}\n\n… (truncated)" },
  note: { loading: "Opening…", missing: "Nothing recorded for this task yet.", gone: "This task has left the panel, so nothing more can be loaded.", error: "This task can't be shown right now." },
  command: { heading: "Command", truncated: "\n… (truncated)" },
} as const;
