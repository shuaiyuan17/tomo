import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { tasks as en } from "../en/tasks.js";

export const tasks = {
  heading: "任务", close: "关闭任务", closeTitle: "关闭", view: "任务详情", list: "任务列表",
  watchers: "显示监视任务", watchersCount_other: "显示监视任务（{{count}}）",
  empty: "后台没有在运行的任务。", groupTag: " · 群",
  shellTitle: "{{label}}\n\n{{command}}\n\n打开查看完整命令", untitled: "未命名任务",
  backgroundTitle: "Tomo 回复后仍会继续运行", backgroundTag: "后台 · ", working: "运行中", childrenRunning: "它启动的任务还在跑",
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
  subsession: {
    group: "子会话", openTitle: "打开 {{id}}，和它对话",
    earlier_other: "更早的 {{n}} 个",
    state: { working: "工作中", background: "工作中（后台运行）", active: "进行中", queued: "排队中", waitingOwner: "等你回复", needsYou: "等你处理", waiting: "等待中", finished: "已完成", cancelled: "已取消", failed: "失败" },
    conversation: "和 {{id}} 的对话",
    you: "你", tag: { ask: "提问", notify: "通知" }, report: "报告", earlierReport: "较早的报告 #{{seq}}",
    checkpoint: { heading: "检查点" },
    doing: { heading: "{{agent}} 在做什么", inProgress: "进行中", pending: "未开始", done: "已完成", earlier: "显示更早的 {{count}} 项", fewer: "收起" },
    progress: { label: "{{agent}} 在做什么：", show: "展开 {{agent}} 在做的事", hide: "收起 {{agent}} 在做的事", next: "下一步：{{step}}", count: "已完成 {{done}}/{{total}} 步" },
    updates: {
      planChanged: "计划调整：{{reason}}", withReason: "{{label}}：{{reason}}", heading: "决定与进展", more: "全部显示（{{count}}）", fewer: "收起",
      milestone: { started: "开始", waitingOwner: "等你回复", finished: "完成", reopened: "重新打开", cancelled: "已取消", failed: "失败" },
    },
    files_other: "{{count}} 个文件",
    label: "发给 {{id}} 的消息", placeholder: "给 {{id}} 发消息…", send: "发给 {{id}}",
    sending: "发送中…", sent: "已发送", retry: "重试",
    ended: "这个任务已经结束，不能再发消息。", gone: "这个任务已经不在了。",
    markDone: {
      label: "完成", marking: "正在标记…", title: "报告里要你做的事已经做完",
      error: {
        nothing: "没什么要标记的：它已经不需要你做什么了。", newer: "有一份更新的报告，先看看它。",
        gone: "这个任务已经不在了。", unavailable: "现在连不上子会话。", network: "没收到确认，再试一次。",
      },
    },
    error: {
      ended: "没发出：任务已经结束。", full: "没发出：等它处理的消息太多了。",
      gone: "没发出：任务已经不在了。", unavailable: "没发出：现在连不上子会话。",
      network: "没收到确认，可能没送达。",
    },
  },
} satisfies Translation<typeof en>;
