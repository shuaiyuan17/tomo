import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { cron as en } from "../en/cron.js";

export const cron = {
  status: { interrupted: "被中断", error: "上次运行失败", empty: "上次运行没有回复", ok: "上次运行正常", never: "还没运行过" },
  enabled: "已启用", paused: "已暂停", oneShot: "一次性", nextRun: "下次运行", lastRun: "上次运行", statusLabel: "状态", message: "消息",
  empty: "没有定时任务。", gone: "这个任务已经不在计划里了。",
  error: {
    cron_changed: "打开后这个任务被改过。列表已刷新，看一下再试。",
    job_not_found: "这个任务已经不存在了。",
    unschedulable: "这个计划之后不会再运行了，所以无法恢复。",
    epoch_changed: "页面加载后 Tomo 重启过。列表已刷新，看一下再试。",
    cron_unavailable: "无法读写 cron 存储。",
    other: "没能确认改动。刷新后先检查任务再试。",
  },
  confirm: {
    pauseTitle: "暂停“{{name}}”？", pause: "暂停任务", pauseBody: "恢复之前不会再运行。已经在运行的不会被停止。",
    resumeTitle: "恢复“{{name}}”？", resume: "恢复任务",
    resumeOverdue: "计划时间已经过了，调度器下次检查时（约 30 秒内）就会运行。", resumeBody: "会按计划继续运行。",
    deleteTitle: "删除“{{name}}”？", delete: "删除任务",
    deleteBody: "任务会从计划中移除，这里无法撤销。已经在运行的不会被停止。",
  },
  pause: "暂停", resume: "恢复", delete: "删除", pauseLabel: "暂停 {{name}}", resumeLabel: "恢复 {{name}}", deleteLabel: "删除 {{name}}",
  schedule: "计划", session: "Session", working: "处理中…", offline: "连接后才能修改。",
} satisfies Translation<typeof en>;
