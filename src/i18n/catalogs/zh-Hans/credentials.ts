import type { Translation } from "../../catalog.js";
import type { credentials as en } from "../en/credentials.js";

export const credentials = {
  prompt: "Tomo 需要一个凭据。\n名称：{{name}}\n用途（agent 填写，未经核实）：{{purpose}}",
  promptReplaces: "Tomo 需要一个凭据。\n名称：{{name}}\n用途（agent 填写，未经核实）：{{purpose}}\n你的回复会替换这个名称下已保存的值。",
  promptTelegram: "\n你在这个聊天里发的下一条消息会被存为这个凭据，不会给模型看到。存好后 Tomo 会把它从聊天里删除。",
  promptMessages: "\n你在这个聊天里发的下一条消息会被存为这个凭据，不会给模型看到。它会留在“信息”App 里，之后请自己删除。",
  promptCancel: "回复“cancel”可拒绝。{{minutes}} 分钟后失效。",
  deleted: "已从这个聊天里删除。",
  heldBack: "Tomo 的凭据状态无法读取，所以这条消息被拦下了，没有给模型看到。{{deleted}}请修复或删除 ~/.tomo/data/credentials/state.json。",
  late: "一条在 {{name}} 请求过期前后发出的消息来晚了。它没有被保存，也没有给模型看到。{{deleted}}如果它是别的内容，请重新发送。",
  where: { web: "web UI 的卡片", telegram: "Telegram", imessage: "iMessage" },
  offChannel: "Tomo 正在 {{where}} 等待 {{name}}，所以这条消息被丢弃了，没有给模型看到。{{deleted}}请在那里回复或取消。",
  cancelled: "已取消 {{name}} 的请求。",
  invalid: "这条没有被保存，也没有给模型看到。{{tidy}}{{name}} 需要纯文本（可打印 ASCII，{{min}} 到 {{max}} 个字符），不能带附件。请重新发送，或回复“cancel”。",
  storeFailed: "无法保存 {{name}}：凭据存储不可用。没有任何内容给模型看到。{{tidy}}",
  stored: "已保存为 {{name}}。{{tidy}}",
  tidyDeleted: "你的消息已从这个聊天里删除。",
  tidyTelegram: "Tomo 没能删除你的消息，请自己从这个聊天里删除。",
  tidyMessages: "你的消息还留在“信息”App 里，请在那里删除。",
  expired: "{{name}} 的请求已过期。现在不要发送：这里的消息又会给模型看到了。",
} satisfies Translation<typeof en>;
