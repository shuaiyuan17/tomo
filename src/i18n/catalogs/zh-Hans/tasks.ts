import type { Translation } from "../../catalog.js";
import type { tasks as en } from "../en/tasks.js";

export const tasks = {
  none: "没有正在运行的任务。",
  header: "任务 · 今天 {{running}} 个运行中，{{done}} 个已完成",
  headerFailed: "任务 · 今天 {{running}} 个运行中，{{done}} 个已完成，{{failed}} 个失败",
  noDescription: "（无描述）",
  running: "{{mark}} {{description}} · {{kind}} · {{duration}}",
  runningLast: "{{mark}} {{description}} · {{kind}} · {{duration}} · 最近 {{at}}",
  ended: "{{mark}} {{description}} · {{kind}} · {{duration}} · {{at}}",
  more: "… 今天还有 {{count}} 个（/tasks all）",
  seconds: "{{n}} 秒",
  minutes: "{{n}} 分钟",
  hoursMinutes: "{{h}} 小时 {{m}} 分",
  kind: {
    agent: "agent", bash: "bash", workflow: "workflow", monitor: "monitor", mcp: "mcp", remoteAgent: "远程 agent",
  },
} satisfies Translation<typeof en>;
