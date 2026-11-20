import type { Translation } from "../../catalog.js";
import type { permissions as en } from "../en/permissions.js";

export const permissions = {
  marker: "权限请求 {{code}}",
  access: { read: "读取", write: "读写" },
  dm: "权限请求 {{code}}：一个群想要{{access}}一个路径。\n{{group}} · {{path}}\n理由（agent 填写，未经核实）：{{reason}}\n回复“1 {{code}}”允许一次（仅限文件工具；shell 需要“总是允许”），“2 {{code}}”总是允许，“3 {{code}}”拒绝，也可以引用这条消息回复。{{minutes}} 分钟后失效。",
  allowedOnce: "已允许一次（{{code}}）：{{group}} 可以{{access}} {{path}}，限一个回合，仅限文件工具（不含 shell）。",
  allowedAlways: "已总是允许（{{code}}）：{{group}} 可以{{access}} {{path}}。已作为 {{grant}} 存入它的沙箱配置；回复“revoke {{grant}}”可撤销。",
  denied: "已拒绝（{{code}}）。",
  revokeUnknown: "没有 id 为 {{grant}} 的“总是允许”，没有撤销任何内容。",
  revoked: "已撤销 {{grant}}：{{group}} 不能再访问 {{path}}。",
  revokeFailed: "无法撤销 {{grant}}：配置文件写入失败。",
  closedLate: "权限请求 {{code}} 已经结束（已回复或已过期），没有任何改动。",
  closed: "权限请求 {{code}} 已经结束，没有任何改动。",
  alwaysUnwritable: "无法为 {{code}} 保存“总是允许”：配置文件写入失败。请求仍然有效，可以再回复一次，或者只允许一次。",
} satisfies Translation<typeof en>;
