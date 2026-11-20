import type { Translation } from "../../catalog.js";
import type { cost as en } from "../en/cost.js";

export const cost = {
  title: "💰 {{session}} 的费用",
  range: { day: "1 天", week: "7 天", month: "1 个月" },
  line_other: "{{range}}：{{total}}（{{count}} 次运行）",
  lineAvg_other: "{{range}}：{{total}}（{{count}} 次运行，平均每次 {{avg}}）",
} satisfies Translation<typeof en>;
