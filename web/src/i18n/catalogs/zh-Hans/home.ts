import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { home as en } from "../en/home.js";

export const home = {
  weather: { clear: "晴", clouds: "多云", overcast: "阴", fog: "有雾", rain: "下雨", snow: "下雪", storm: "雷雨", withTemp: "{{temp}}°C，{{words}}" },
  span: {
    underMinute: "不到一分钟", minutes_other: "{{count}} 分钟", hoursMinutes: "{{hours}} 小时 {{minutes}} 分钟",
    hours_other: "{{count}} 小时", days_other: "{{count}} 天",
  },
  next: { now: "现在", in: "{{span}}后" },
  source: { owner: "正在处理你的消息", cron: "正在跑定时任务", heartbeat: "自己在想事情", group: "正在回群聊", other: "工作中" },
  tool: { shell: "在运行命令", files: "在处理文件", web: "在上网", search: "在搜索", subagent: "交给 subagent 处理", other: "在用工具" },
  trouble: { retry: "重试中", rate_limit: "被限流，等待中", error: "出错了" },
  troubleIdle: { retry: "重试中", rate_limit: "被限流，等待中", error: "上一轮出错了" },
  compacting: "正在压缩上下文", cronFired: "刚触发了一个定时任务", idle: "空闲", idleFor: "已空闲 {{span}}",
  subagents_other: "{{count}} 个帮手", tasks_other: "{{count}} 个后台任务",
  nextJob: "下个任务 {{when}}",
  failure: {
    chunk: "房间的绘制代码没加载出来。", webgl: "这个浏览器画不了 3D 房间（WebGL 不可用）。",
    lost: "房间停止绘制了（图形上下文丢失）。", note: "{{failure}}{{agent}} 在做什么仍会写在下面。",
  },
  heading: "{{agent}} 的小屋", retry: "再试一次", notFound: "这个 {{agent}} 还没有小屋。", unreadable: "读不了 {{agent}} 的小屋。",
  roomLabel: "{{agent}} 的小屋，{{name}}。{{caption}}。", smallRoom: "一个小房间", opening: "正在打开房间…",
  problem: "{{agent}} 最近的改动有问题，显示的是上一个正常的房间。",
  starter: "这是初始房间，{{agent}} 还没布置自己的。",
  viewLabel: "{{label}}。方向键旋转房间，加减号缩放，Home 键重置视角。", resetView: "重置视角", dragHint: "拖动旋转 · 双指缩放",
  unknownStatus: "暂时不知道 {{agent}} 在做什么",
} satisfies Translation<typeof en>;
