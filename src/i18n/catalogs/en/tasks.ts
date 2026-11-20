/** The `/tasks` reply (src/agent/tasks-command.ts). */
export const tasks = {
  none: "No tasks running.",
  header: "Tasks · {{running}} running, {{done}} done today",
  headerFailed: "Tasks · {{running}} running, {{done}} done, {{failed}} failed today",
  noDescription: "(no description)",
  running: "{{mark}} {{description}} · {{kind}} · {{duration}}",
  runningLast: "{{mark}} {{description}} · {{kind}} · {{duration}} · last {{at}}",
  ended: "{{mark}} {{description}} · {{kind}} · {{duration}} · {{at}}",
  more: "… {{count}} more today (/tasks all)",
  seconds: "{{n}}s",
  minutes: "{{n}}m",
  hoursMinutes: "{{h}}h {{m}}m",
  kind: {
    agent: "agent", bash: "bash", workflow: "workflow", monitor: "monitor", mcp: "mcp", remoteAgent: "remote agent",
  },
} as const;
