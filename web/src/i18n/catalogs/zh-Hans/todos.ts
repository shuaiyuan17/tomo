import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { todos as en } from "../en/todos.js";

export const todos = {
  error: { unavailable: "读不了待办存储，没有做任何改动。" },
  waiting: { owner: "等你处理", me: "等 {{agent}} 处理", external: "等别人处理" },
  empty: { hidden: "你的对话里没有未完成的待办。", none: "没有未完成的待办。可以让 {{agent}} 帮你记一件事，或者发送 /todo add。" },
  groupDue_other: "{{count}} 项到期",
  hidden_other: "还有 {{count}} 项在这里看不到的对话里。",
  summary: {
    label: "概览", open: "未完成", due: "待回顾",
    full: "已到上限：先完成一项，{{agent}} 才能再加。",
    near_other: "还能加 {{count}} 项，之后 {{agent}} 得先完成一项。",
    left_other: "距上限还有 {{count}} 项。",
    progress: "{{max}} 项上限中已有 {{open}} 项未完成", dueNote: "已过回顾日期。", dueNone: "没有过了回顾日期的待办。",
    waitingNote: "{{agent}} {{me}} 项 · 别人 {{external}} 项",
  },
  next: "下一步", snoozeLast: "{{snooze}}，已用完", snoozeReason: "：{{reason}}", inGroup: "在 {{group}}", addedByYou: "你添加的",
  snoozed_other: "已推迟 {{count}}/{{max}} 次",
  due: "{{when}}到期", review: "{{when}}回顾", reviewOn: "{{date}}回顾",
  recent: { heading: "最近关闭", latest_other: "最近 {{count}} 项", done: "{{when}}完成 · {{who}}", dropped: "{{when}}放弃 · {{who}}", you: "你" },
} satisfies Translation<typeof en>;
