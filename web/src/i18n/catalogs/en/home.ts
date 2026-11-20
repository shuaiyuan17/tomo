/** Home: the agent's room and the caption under it. */
export const home = {
  weather: { clear: "clear", clouds: "cloudy", overcast: "overcast", fog: "foggy", rain: "raining", snow: "snowing", storm: "stormy", withTemp: "{{temp}}°C, {{words}}" },
  span: {
    underMinute: "under a minute", minutes_one: "{{count}} min", minutes_other: "{{count}} min", hoursMinutes: "{{hours}} h {{minutes}} min",
    hours_one: "{{count}} h", hours_other: "{{count}} h", days_one: "{{count}} day", days_other: "{{count}} days",
  },
  next: { now: "now", in: "in {{span}}" },
  source: { owner: "Working on your message", cron: "Running a scheduled job", heartbeat: "Thinking on its own", group: "Answering a group chat", other: "Working" },
  tool: { shell: "running a command", files: "working with files", web: "on the web", search: "searching", subagent: "handing work to a subagent", other: "using a tool" },
  trouble: { retry: "retrying", rate_limit: "rate-limited, waiting", error: "hit an error" },
  troubleIdle: { retry: "Retrying", rate_limit: "Rate-limited, waiting", error: "The last turn hit an error" },
  compacting: "Compacting context", cronFired: "A scheduled job just fired", idle: "Idle", idleFor: "Idle for {{span}}",
  subagents_one: "{{count}} subagent", subagents_other: "{{count}} subagents", tasks_one: "{{count}} background task", tasks_other: "{{count}} background tasks",
  nextJob: "next job {{when}}",
  failure: {
    chunk: "The room's drawing code didn't load.", webgl: "This browser can't draw the 3D room (WebGL is unavailable).",
    lost: "The room stopped drawing (the graphics context was lost).", note: "{{failure}} What {{agent}} is doing is still written below.",
  },
  heading: "{{agent}}'s home", retry: "Try again", notFound: "This {{agent}} doesn't serve a home yet.", unreadable: "{{agent}}'s home couldn't be read.",
  roomLabel: "{{agent}}'s home, {{name}}. {{caption}}.", smallRoom: "a small room", opening: "Opening the room…",
  problem: "{{agent}}'s latest change has a problem; showing the last good room.",
  starter: "This is the starter room; {{agent}} hasn't made one of its own yet.",
  viewLabel: "{{label}}. Arrow keys turn the room, plus and minus zoom, Home resets the view.", resetView: "Reset view", dragHint: "Drag to turn · pinch to zoom",
} as const;
