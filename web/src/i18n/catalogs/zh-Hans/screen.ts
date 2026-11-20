import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { screen as en } from "../en/screen.js";

export const screen = {
  notice: {
    locked: "Mac 已锁定，这不是实时画面。",
    away: "Mac 屏幕前没有人登录，这不是实时画面。",
    unconfirmed: "无法确认屏幕已解锁，所以没有截取画面。",
    unavailable: "截取不了屏幕。Tomo 可能没有屏幕录制权限。",
    too_large: "这一帧太大，发送不了。",
  },
  unavailable: "这台机器上不能查看屏幕。", justNow: "刚刚",
  status: { disconnected: "已断开", paused: "已暂停", hidden: "已暂停（标签页在后台）", unavailable: "不可用", notLive: "非实时" },
  label: "屏幕（只读）", rate: "帧率", rateLabel_other: "每秒 {{count}} 帧", fps: "{{value}} 帧/秒",
  fullscreen: "全屏", close: "关闭屏幕", alt: "Mac 的屏幕",
  permissionHint: "只看到桌面背景、没有窗口？没有屏幕录制权限时 macOS 会隐藏窗口。",
  pausedNote: "已暂停。", waiting: "等待第一张画面…", lastPicture: "{{state}} · 最后一张画面 {{age}}", resize: "调整大小",
} satisfies Translation<typeof en>;
