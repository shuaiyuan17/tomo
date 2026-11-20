import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { study as en } from "../en/study.js";

export const study = {
  page: { todos: "待办", memory: "记忆", context: "上下文", model: "模型", cost: "费用", cron: "Cron", mcp: "MCP 服务器", config: "配置" },
  intro: {
    todos: "{{agent}} 在跟进的事，以及下一步轮到谁。这里只读：待办在对话里或用 /todo 修改。",
    memory: "{{agent}} 记住的内容，和工作区里写的一样。私密记忆永远不会在浏览器里显示。",
    context: "所选对话的上下文窗口用了多少、被什么占用，以及哪些已经汇总归档。",
    model: "所选对话用的是哪个模型。你自己的对话可以在这里切换。",
    cost: "按 API 价格算，{{agent}} 每天的工作值多少钱，以及用了多少套餐额度。",
    cron: "定时任务，以及它们上次运行的时间。",
    mcp: "config.json 和运行中 session 里的工具服务器，以及 session 报告的连接状态。",
    config: "已保存的 config.json。只显示已知不敏感的文本，其余都隐藏。",
  },
  refresh: "刷新", sections: "书房分区", chooseConversation: "在侧边栏选一个对话。",
  error: {
    memory_not_found: "这个文件不可用。", memory_limit: "文件太大，这里显示不了。",
    memory_invalid_path: "这个路径打不开。", cron_unavailable: "读不了 cron 存储。",
    config_invalid: "config.json 不是有效的 JSON。", config_unavailable: "读不了 config.json。",
    session_not_found: "这个对话已经不在了。", request_limit: "正忙，请稍后再试。",
    other: "暂时不可用。",
  },
  memory: {
    missing: "工作区里还没有 memory 文件夹。", search: "搜索记忆", clearSearch: "清除搜索", noMatches: "没有匹配结果。",
    searchTruncated: "只显示前面的匹配结果。", treeTruncated: "目录太大，只列出了一部分。",
    choose: "选一个文件来阅读。", updated: "更新于 {{when}}",
    hiddenLines_other: "有 {{count}} 行链接到私密记忆，未显示。",
  },
  mcp: {
    status: { connected: "已连接", failed: "失败", needsAuth: "需要登录", pending: "连接中", disabled: "已停用", noAnswer: "没有响应" },
    oauth: { loginRequired: "需要登录", authPending: "登录中", authFailed: "登录失败", hint: "{{state}}：在私聊里发送 <cmd>/mcp login {{name}}</cmd>。" },
    reconnect: {
      action: "重新连接", running: "重新连接中…", reconnected: "已重新连接。",
      failed: "重新连接失败。原因见日志；/new 会开启新的 session。",
      noLiveSession: "没有可以重新连接的运行中 session。新的 session 会重新连接所有服务器。",
      busy: "正在回复中，等结束后再试。",
      restarted: "页面加载后 Tomo 重启过，刷新后再试。", unavailable: "现在无法重新连接。",
    },
    emptyNoSession: "config.json 里没有外部 MCP 服务器，也没有运行中的 session 报告内置服务器。",
    empty: "config.json 里没有 MCP 服务器，运行中的 session 也没有报告。",
    liveUnavailable: "暂时拿不到实时连接状态。",
    noLiveSession: "没有运行中的 session：有 session 运行后才会显示连接状态。",
    enabled: "已启用", disabled: "已停用", alwaysLoaded: "始终加载", sessionProvided: "由 session 提供",
    configured: "已设置 {{names}}", noSettings: "没有连接设置", timeout: " · 超时 {{seconds}} 秒",
    notLoadedDisabled: "已停用，不加载。", statusUnknown: "状态未知。", notLoaded: "没有在任何运行中的 session 里加载。",
    noSession: "没有运行中的 session。", yourConversation: "你的对话",
  },
  config: {
    notSet: "未设置", hidden: "已隐藏", chars_other: "{{count}} 个字符", set: "已设置", empty: "空",
    missing: "还没有 config.json。", general: "通用",
    note: "只读 · 保存于 {{when}} · 守护进程实际使用的值在重启前可能不同。",
    truncated: "只列出了前 500 项设置。",
  },
} satisfies Translation<typeof en>;
