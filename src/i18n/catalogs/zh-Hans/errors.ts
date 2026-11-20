import type { Translation } from "../../catalog.js";
import type { errors as en } from "../en/errors.js";

export const errors = {
  lockTimeout: "{{ms}} 毫秒内没能拿到锁 {{path}}",
  lockTimeoutHeld: "{{ms}} 毫秒内没能拿到锁 {{path}}（被进程 {{pid}} 占用）",
  todoStore: {
    read: "无法读取待办存储：{{path}}（{{detail}}）。没有做任何改动，请修复或恢复这个文件。",
    conflict: "待办存储在写入时被改动了：{{path}}。没有覆盖任何内容，请再试一次。",
  },
  rewind: {
    usage: "请用 /rewind 或 /rewind <正整数>。",
    invalidSession: "SDK session ID 无效。",
    changed: "回退期间 session 记录发生了变化，请再试一次。",
    writing: "session 记录还在写入中，请稍后再试 /rewind。",
    keptChanging: "回退期间 session 记录一直在变化，请稍后再试。",
    unreadable: "无法读取 session 记录。",
    tooFew_other: "当前上下文里只有 {{count}} 条记录的用户消息可以回退。更早或已压缩的消息可能无法回退；/new 可以重新开始。",
    boundary: "无法安全确定回退的位置。",
    noCompletedTurn: "当前上下文里的每条消息都是在工具调用期间到达的，没有可以回到的完整回合。/new 可以重新开始。",
    branchNotRemoved: "无法删除被拒绝的回退分支，请再试一次 /rewind。",
    stopping: "Tomo 正在停止，请在重启后再试。",
    noConversation: "没有可以回退的对话。",
    inProgress: "已经有一次回退在进行中。",
  },
  login: {
    otherOwnerInProgress: "另一位 owner 正在进行 Claude 登录",
    expired: "Claude 登录已在 10 分钟后过期，请重新发送 /login",
    submitFailed: "无法提交 Claude 登录代码：{{detail}}",
    startFailed: "无法开始 Claude 登录：{{detail}}",
    exitedSignal: "Claude 登录没有完成（信号 {{signal}}）",
    exitedCode: "Claude 登录没有完成（退出码 {{code}}）",
    noneWaiting: "当前没有等待中的 Claude 登录，请先发送 /login",
    otherOwner: "这个 Claude 登录属于另一位 owner",
    verifying: "这个 Claude 登录代码已经在验证中",
    invalidCode: "授权代码无效，请粘贴 Claude 返回的完整代码",
    stateMismatch: "授权代码和当前的 /login 请求不匹配",
    cancelled: "已取消 Claude 登录",
    stopped: "Claude 登录期间 Tomo 停止了",
    verificationFailed: "Claude 登录验证失败",
    verificationFailedDetail: "Claude 登录验证失败：{{detail}}",
  },
  mcpLogin: {
    unknownServer: "没有名为“{{server}}”的外部 MCP 服务器",
    noOAuth: "MCP 服务器“{{server}}”不使用 OAuth",
    noHeaders: "MCP 服务器“{{server}}”无法使用 OAuth 请求头",
    notInteractive: "MCP 服务器“{{server}}”没有开始交互式 OAuth 流程",
  },
} satisfies Translation<typeof en>;
