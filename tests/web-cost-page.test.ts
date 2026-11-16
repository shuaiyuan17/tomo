import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WebCostDay, WebCostTurn } from "../src/web/protocol.js";
import { addDays, bin, busiestHour, calendarStart, calendarWeeks, costDayHash, dayEyebrow, duration, pickDay, quotaWindows, resetsIn, turnMeta, turnTitle, usd,
  versusTypical, weekday } from "../web/src/cost.js";
import { Columns, Heatmap, Ranked } from "../web/src/cost-charts.js";
import { focusFromHash, STUDY_PAGES, viewFromHash } from "../web/src/study-data.js";

const split = { you: 0, background: 0, scheduled: 0 };
const dayOf = (date: string, costUsd: number, extra: Partial<WebCostDay> = {}): WebCostDay =>
  ({ date, costUsd, turns: costUsd ? 3 : 0, byCategory: { ...split, you: costUsd }, recorded: true, overcounted: false, backfilled: false, ...extra });
const turn = (extra: Partial<WebCostTurn> = {}): WebCostTurn => ({ ts: 0, date: "2026-11-15", session: { label: "Shuai (DM)", kind: "dm" }, category: "you", source: "owner", costUsd: 1, ...extra });

describe("Cost page helpers", () => {
  it("routes #study/cost/<date> and sits between Model and Cron", () => {
    expect(STUDY_PAGES.slice(STUDY_PAGES.indexOf("model"), STUDY_PAGES.indexOf("model") + 3)).toEqual(["model", "cost", "cron"]);
    expect(viewFromHash(costDayHash("2026-11-14"))).toBe("cost");
    expect(focusFromHash(costDayHash("2026-11-14"))).toBe("2026-11-14");
    expect(costDayHash(null)).toBe("#study/cost");
  });

  it("opens the day the link names, unless it is not a real past day", () => {
    expect(pickDay("2026-11-02", "2026-11-15")).toBe("2026-11-02");
    expect(pickDay("2026-11-16", "2026-11-15")).toBe("2026-11-15");
    expect(pickDay("2026-02-30", "2026-11-15")).toBe("2026-11-15");
    expect(pickDay("cron-job-1", "2026-11-15")).toBe("2026-11-15");
    expect(pickDay(null, "2026-11-15")).toBe("2026-11-15");
  });

  it("lays ten Monday-to-Sunday weeks out to today, leaving later days empty", () => {
    expect(weekday("2026-11-15")).toBe(6);
    expect(calendarStart("2026-11-15")).toBe("2026-09-07");
    const days = Array.from({ length: 80 }, (_, i) => dayOf(addDays("2026-08-29", i), i));
    const weeks = calendarWeeks(days, "2026-11-12");
    expect(weeks).toHaveLength(10);
    expect(weeks[0][0]!.date).toBe("2026-09-07");
    expect(weeks[9].map((d) => d?.date ?? null)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", null, null, null]);
  });

  it("formats the figures", () => {
    expect([usd(0), usd(0.001), usd(3.456), usd(87.4), usd(2476.2), usd(12, true)]).toEqual(["$0", "<$0.01", "$3.46", "$87", "$2,476", "$12.00"]);
    expect([duration(undefined), duration(9_400), duration(552_000), duration(3_900_000)]).toEqual([undefined, "9s", "9m 12s", "1h 5m"]);
    expect([bin(0), bin(10), bin(60), bin(250)]).toEqual([0, 1, 3, 5]);
    expect([versusTypical(87, 52), versusTypical(30, 50), versusTypical(50, 52), versusTypical(5, undefined)])
      .toEqual(["1.7× a typical day", "40% below a typical day", "About a typical day", undefined]);
    expect([dayEyebrow("2026-11-15", "2026-11-15"), dayEyebrow("2026-11-14", "2026-11-15"), dayEyebrow("2026-10-31", "2026-11-15")]).toEqual(["Today so far", "Yesterday", "That day"]);
    expect(busiestHour(Array.from({ length: 24 }, (_, hour) => ({ hour, costUsd: hour === 11 ? 9 : 1, turns: 1, byCategory: split })))).toBe(11);
    expect(busiestHour([])).toBeUndefined();
  });

  it("names a turn by its trigger, else by what started it", () => {
    expect(turnTitle(turn({ trigger: "Should I create the GitHub repo?" }))).toBe("Should I create the GitHub repo?");
    expect(turnTitle(turn({ category: "scheduled", source: "cron", jobName: "Morning brief" }))).toBe("Morning brief");
    expect(turnTitle(turn({ category: "background", source: "background" }))).toBe("Background work finished");
    expect(turnMeta(turn({ durationMs: 20_000, tools: 5 }))).toBe("You · Shuai (DM) · 20s · 5 tools");
    expect(turnMeta(turn({ session: { label: "Book club", kind: "group" }, tools: 1, backfilled: true }))).toBe("You · Book club · 1 tool · from the activity log");
  });

  it("shows only the plan-wide 5-hour and 7-day windows that carry a percentage", () => {
    expect(quotaWindows([
      { window: "seven_day_opus", group: "weekly", scoped: true, percent: 72 },
      { window: "seven_day::", group: "weekly", percent: 61 },
      { window: "five_hour::", group: "session", percent: 34 },
    ]).map((w) => [w.title, w.window.percent])).toEqual([["5-hour", 34], ["7-day", 61]]);
    // A rate_limit_event sample names its window and carries no group.
    expect(quotaWindows([{ window: "five_hour", percent: 91 }]).map((w) => w.title)).toEqual(["5-hour"]);
    expect(quotaWindows([{ window: "seven_day", group: "weekly" }])).toEqual([]);
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(resetsIn("2026-11-15T14:14:00Z", now)).toBe("resets in 2h 14m");
    expect(resetsIn("2026-11-15T11:00:00Z", now)).toBeUndefined();
    expect(resetsIn(undefined, now)).toBeUndefined();
  });
});

describe("Cost charts", () => {
  it("draws over-counted days dashed, unrecorded days as blanks that cannot be picked, and marks the picked day", () => {
    const days = [dayOf("2026-09-07", 0, { recorded: false }), dayOf("2026-09-08", 400, { overcounted: true }), dayOf("2026-11-14", 30), dayOf("2026-11-15", 87)];
    const html = renderToStaticMarkup(createElement(Heatmap, { days, today: "2026-11-15", selected: "2026-11-14", onSelect: () => {} }));
    expect(html).toMatch(/<span title="Sep 7: nothing recorded" data-day="2026-09-07"/);
    expect(html).not.toMatch(/<button[^>]*data-day="2026-09-07"/);
    expect(html).toMatch(/<button[^>]*data-day="2026-09-08"[^>]*aria-label="Tuesday, September 8: \$400, over-counted"[^>]*border-dashed/);
    expect(html).toMatch(/<button[^>]*data-day="2026-11-14"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/<button[^>]*data-day="2026-11-15"[^>]*aria-pressed="false"/);
    expect(html).toContain("over-counted (before #389)");
    expect(renderToStaticMarkup(createElement(Heatmap, { days: days.slice(2), today: "2026-11-15", selected: "2026-11-15", onSelect: () => {} }))).not.toContain("over-counted (before #389)");
  });

  it("stacks columns per series and labels each one for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(Columns, { columns: [{ key: "9", label: "9", title: "9:00–10:00", parts: [4, 1, 0] }, { key: "10", label: "10", title: "10:00–11:00", parts: [0, 0, 0] }],
      colors: ["red", "green", "blue"], names: ["You", "Background", "Scheduled"] }));
    expect(html).toContain('aria-label="9:00–10:00: $5.00"');
    expect(html).toContain('aria-label="10:00–11:00: $0"');
    expect(html.match(/class="bar /g)).toHaveLength(2);
  });

  it("ranks rows against the largest", () => {
    const html = renderToStaticMarkup(createElement(Ranked, { rows: [{ name: "Morning brief", value: 40, note: "30 runs" }, { name: "Water", value: 10 }] }));
    expect(html).toMatch(/Morning brief<span[^>]*>30 runs<\/span>/);
    expect(html).toContain("width:100%");
    expect(html).toContain("width:25%");
  });
});
