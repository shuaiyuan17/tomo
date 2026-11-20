import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { tasks as en } from "../en/tasks.js";

export const tasks = {
  heading: "任务", close: "关闭任务", closeTitle: "关闭", view: "任务详情", list: "任务列表",
  watchers: "显示监视任务", watchersCount_other: "显示监视任务（{{count}}）",
  empty: "后台没有在运行的任务。", groupTag: " · 群",
  shellTitle: "{{label}}\n\n{{command}}\n\n打开查看完整命令", untitled: "未命名任务",
  backgroundTitle: "Tomo 回复后仍会继续运行", backgroundTag: "后台 · ", working: "运行中",
  foldedShells_other: "{{count}} 条 shell 命令已完成",
  lastStep_other: "{{tool}} · 调用了 {{count}} 次工具",
  type: { local_agent: "subagent", local_bash: "shell", local_workflow: "工作流", monitor: "监视", mcp_task: "MCP 任务", remote_agent: "远程 agent", task: "任务" },
  state: { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", ended: "已结束" },
  scheduled: {
    heading: "定时任务", once: "一次", repeats: "重复", viewAll: "查看全部",
    overdue: "已过期", dueNow: "马上", inMinutes_other: "{{count}} 分钟后",
    inHours_other: "{{count}} 小时后", today: "今天 {{time}}", tomorrow: "明天 {{time}}",
  },
  control: {
    background: "转到后台", backgroundTitle: "Tomo 不再等它；它会继续运行，完成后汇报", stop: "停止任务",
    stopFailed: "没能停止，它可能刚刚结束。", backgroundFailed: "没能转到后台，它可能已经结束，或者已经不在前台了。",
  },
  back: "返回任务", backgroundSuffix: " · 后台", now: "当前：",
  transcript: {
    label: "Subagent 记录", goneKept: "这个任务已经离开面板，无法再加载更多。已读到的内容会保留。",
    earlier: "加载更早的", nothingYet: "还没有内容。", noSteps: "没有记录的步骤。", messageFrom: "来自 {{agent}} 的消息", jump: "↓ 跳到最新",
  },
  brief: { heading: "任务说明", less: "收起", more: "展开", truncated: "{{text}}\n\n…（已截断）" },
  note: { loading: "打开中…", missing: "这个任务还没有记录。", gone: "这个任务已经离开面板，无法再加载更多。", error: "这个任务暂时无法显示。" },
  command: { heading: "命令", truncated: "\n…（已截断）" },
} satisfies Translation<typeof en>;
