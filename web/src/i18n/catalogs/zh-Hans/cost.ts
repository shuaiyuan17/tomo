import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { cost as en } from "../en/cost.js";

export const cost = {
  category: {
    you: "你", youHint: "由消息触发的对话：你的，或群里的",
    background: "后台", backgroundHint: "心跳，以及接手已完成后台工作的对话",
    scheduled: "定时", scheduledHint: "Cron 任务和其他定时对话",
  },
  lessThan: "<{{value}}", resetsAt: "{{when}}重置",
  day: { today: "今天到目前为止", yesterday: "昨天", other: "当天" },
  typical: { above: "是平常一天的 {{ratio}} 倍", below: "比平常一天低 {{percent}}%", about: "和平常一天差不多" },
  turn: {
    heartbeat: "心跳", background: "后台工作完成", restart: "重启之后", delegate: "代发的消息",
    cron: "定时任务", scheduled: "定时对话", other: "对话",
    tools_other: "{{count}} 个工具", backfilled: "来自活动日志",
  },
  est: { label: "估", title: "由 Claude SDK 按 API 标价估算。如果你用的是订阅，这不是你实际付的钱。" },
  heatmap: {
    nothing: "{{day}}：没有记录", title: "{{day}}：{{cost}}", overcountedTitle: "{{day}}：{{cost}}（多算了，9 月 23 日修复之前）",
    overcountedLabel: "{{day}}：{{cost}}，多算了", top: "{{cost}}+", overcounted: "多算了（#389 之前）",
  },
  byHour: "按小时", byHourLabel: "每小时费用", loading: "费用加载中",
  error: { cost_unavailable: "这个安装没有费用数据。", invalid_range: "这一天无法显示。", other: "暂时看不了费用。" },
  empty: { heading: "还没有记录", body: "从现在起每一轮对话都会写进用量账本，结束后估算费用马上就会显示在这里。" },
  calendar: { heading: "十周", since: "自 {{day}} 起", pick: "选一天" },
  footnote: "金额是 Claude SDK 按 API 标价的估算。订阅是固定月费，所以把它当作工作量来看，而不是账单。9 月 23 日之前恢复的 session 会被多算（#389）；那些天用虚线表示，不参与比较。",
  quota: { sampled: "采样于 {{when}}", asOf: " · 截至 {{when}}" },
  glance: {
    heading: "概览", apiEquivalent: "按 API 计", thisWeek: "本周", noComparison: "还没有可比的数据", weekBefore: "上周 {{cost}}",
    days30: "30 天", includesOvercounted: "包含多算的天数", recorded_other: "记录了 {{count}} 天",
    perDay: "每天 {{cost}}", typical: "平常一天", median_other: "中位数，共 {{count}} 天",
    noFairDays: "还没有可比的天数", busiest: "最忙的一天",
  },
  dayPanel: {
    notRecorded: "这一天没有记录：用量账本是之后才开始的。",
    overcounted: "多算了：9 月 23 日修复（#389）之前，恢复的 session 会按整段历史计费，所以这一天偏高，不参与比较。",
    noTurns: "这一天没有对话。",
    turns_other: "{{count}} 轮对话",
    turnsPeak_other: "{{count}} 轮对话 · {{hour}} 前后最忙",
    whereHeading: "花在了哪里", costliest: "最贵的几轮对话",
    all_other: "全部 {{count}} 轮。",
    largest_other: "{{count}} 轮中最贵的 {{top}} 轮：占当天的 {{share}}%。",
    subagents: "每轮的金额包含运行期间完成的 subagent。",
  },
  period: {
    label: "时间段", days_other: "{{count}} 天", who: "由谁触发", whoLabel: "按触发方的费用",
    noTurns_other: "最近 {{count}} 天没有对话。",
    note_other: "共 {{turns}} 轮。后台指心跳，以及接手已完成 subagent 的对话。",
    overcounted: "包含多算的天数。",
    scheduled: "定时任务", scheduledLabel: "按定时任务的费用", last_other: "最近 {{count}} 天",
    tasks: "子会话", tasksLabel: "按子会话的费用", turns_other: "{{count}} 轮",
    runs_other: "{{count}} 次运行", runsEach_other: "{{count}} 次运行 · 每次 {{each}}",
  },
} satisfies Translation<typeof en>;
