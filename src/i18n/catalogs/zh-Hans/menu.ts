import type { Translation } from "../../catalog.js";
import type { menu as en } from "../en/menu.js";

export const menu = {
  new: "开始新对话",
  rewind: "把上下文回退 N 条用户消息（默认 1，仅限 owner 私聊）",
  model: "切换模型（Claude 别名或 LiteLLM provider/model）",
  restore: "从备份恢复配置并重启",
  login: "刷新 Claude 登录（仅限 owner 私聊）",
  mcp: "查看或重新授权外部 MCP 服务器",
  status: "查看当前 session 状态",
  tasks: "列出这个聊天正在运行和最近的任务（/tasks all：今天全部）",
  todo: "未完成的待办（/todo add <内容>、/todo done <id>、/todo drop <id>、/todo all）",
  cost: "查看当前 session 的费用",
  usage: "查看 Claude 订阅用量",
  pet: "看看 Tomo 的宠物",
  summon: "把你的主 Tomo session 叫进这个群",
  dismiss: "把这个群交回给它自己的 Tomo session",
  pause: "在这个群暂停 Tomo（/resume 之前忽略消息）",
  resume: "在 /pause 后恢复 Tomo",
} satisfies Translation<typeof en>;
