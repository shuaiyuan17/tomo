import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { context as en } from "../en/context.js";

export const context = {
  fill: { calm: "还很宽裕", warn: "快满了", critical: "几乎满了" },
  segment: { conversation: "对话", fixed: "始终加载", used: "已用", reserved: "压缩预留", free: "空闲" },
  meterValue: "已用 {{percent}}，{{state}}", segmentTitle: "{{name}}：{{tokens}} token",
  window: {
    heading: "上下文窗口 · {{title}}", recorded: "最近记录于 {{when}}", notRecorded: "还没有记录过对话",
    unavailable: "有一轮对话上报上下文窗口后才能显示。", share: "占窗口 {{percent}}",
    tokens: "<used>{{used}}</used> / <max>{{max}}</max> token",
    estimated: "上一轮结束时的估算值", reported: "上一轮结束时模型上报的值",
    reservedNote: "留给压缩用",
  },
  stretches: {
    heading: "对话记录中最大的几段",
    aside_other: "{{messages}} 条消息 · ≈{{tokens}} token",
    tooLarge: "对话记录太大，这里分析不了。请用 <cmd>tomo lcm stats</cmd>。", empty: "还没有可分析的对话记录。",
    tools: "工具：{{tools}}", mixed: "对话和工具：{{tools}}",
    meta_other: "{{count}} 条消息 · {{when}}",
    metaTools_other: "{{count}} 条消息 · {{calls}} 次工具调用 · {{when}}",
  },
  level: { daily: "日", weekly: "周", monthly: "月", yearly: "年", legacy: "旧版" },
  rollups: {
    heading: "已汇总的历史", count_other: "{{level}} {{count}} 个",
    empty: "这个 session 里还没有汇总块。", label: "汇总块，最新的在前", legacy: "压缩摘要",
    events_other: "{{events}} <unit>条事件</unit>",
    rolledUp: "汇总于 {{when}}", shortened: "预览已截断。", truncated: "只列出了最近 100 个块。",
  },
  compactions: { heading: "Tomo 启动以来的压缩", seen_other: "共 {{count}} 次" },
  fills: {
    heading: "被什么占用", headingStale: "当时被什么占用", aside: "已用 {{tokens}}", asideStale: "上次完整读数 {{tokens}}",
    stale: "来自上次完整读数，不是上面的当前数值。占比按那次读数计算。",
    staleEstimated: "来自上次完整读数，不是上面的当前数值（当前数值是估算）。占比按那次读数计算。",
    label: "窗口被什么占用", labelStale: "上次完整读数时窗口被什么占用",
  },
  deferred: { heading: "未加载", note: "这些工具定义要用到时才加载，不占窗口空间。", label: "延迟加载，不在窗口里" },
} satisfies Translation<typeof en>;
