import type { Translation } from "../../catalog.js";
import type { todo as en } from "../en/todo.js";

export const todo = {
  usage: "用法：/todo、/todo all、/todo add <内容>、/todo done <id>、/todo drop <id> [原因]",
  unavailable: "无法读取待办：{{error}}",
  added: "已添加 {{line}}",
  done: "已完成：{{id}} {{title}}",
  dropped: "已放弃：{{id}} {{title}}",
  line: "{{id}} {{title}}{{next}} · {{waiting}} · {{review}}{{snoozed}}{{ref}}",
  next: " · 下一步：{{next}}",
  waitingOn: { me: "等我", owner: "等你", external: "等别人" },
  due: "{{date}} 到期",
  review: "{{date}} 复查",
  snoozed: " · 已推迟 {{snoozes}} 次",
  snoozedOf: " · 已推迟 {{snoozes}}/{{max}} 次",
  ref: " · {{ref}}",
  none: "没有未完成的待办。",
  header: "待办 · {{count}} 项未完成（{{owner}} 项等你，{{mine}} 项等我，{{external}} 项等别人）",
  waitingOnYou: "\n等你处理：",
  mine: "\n我的：",
  waitingOnOthers: "\n等别人：",
  more: "\n还有 {{count}} 项（/todo all）",
  hints: "\n/todo add <内容> · /todo done <id> · /todo drop <id> [原因]",
} satisfies Translation<typeof en>;
