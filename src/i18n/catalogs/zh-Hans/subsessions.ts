import type { Translation } from "../../catalog.js";
import type { subsessions as en } from "../en/subsessions.js";

export const subsessions = {
  stuck: "[{{id}} · {{title}}] 已暂停：连续 {{turns}} 轮没有进展。告诉我怎么继续，或者取消。",
  failing: "[{{id}} · {{title}}] 已暂停：最近几轮都失败了。说一声我就继续，或者取消。",
  finishedUnanswered: "[{{id}} · {{title}}] 没能回复发给它的消息，它仍是已完成状态，消息留着。再给它发消息，它会连同没回的一起再试。",
  stopped: "[{{id}} · {{title}}] 已停下。说一声我就继续，或者取消。",
  selfRestart: "[{{id}} · {{title}}] Tomo 按这个任务自己的要求重启了，所以先暂停。准备好了说一声继续。",
  failedInterrupted: "[{{id}} · {{title}}] 放弃了：连续 {{restarts}} 次被重启打断。还需要的话再说一次。",
  failedNoSession: "[{{id}} · {{title}}] 放弃了：重启后找不到它的 session，重新开始可能会重复已经做过的事。还需要的话再说一次。",
  inputFull: "[{{id}} · {{title}}] 丢掉了一次定时检查：已经有 {{max}} 条消息在等它处理，先处理完这些。",
  recoveryFailed: "⚠️ 重启后子会话没能恢复完（列表存不进去），先关掉，下次启动再试。没有取消或删除任何东西。",
  tableUnreadable: "⚠️ 读不了子会话列表（~/.tomo/data/subsessions.json），子会话先关掉，修好再开。没有取消或删除任何东西。",
  tableLost_other: "⚠️ 子会话列表好像丢了或者是从备份恢复的，但还有 {{count}} 个子会话的 session 在。什么都没删，查一下 ~/.tomo/data/subsessions.json。",
} satisfies Translation<typeof en>;
