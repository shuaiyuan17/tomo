import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { categoryKind, compactionFreed, composeWindow, CONTEXT_CRITICAL_PERCENT, CONTEXT_WARN_PERCENT, fillPercent, fillTone, formatPercent,
  rollupCounts, rollupTitle } from "../web/src/context-view.js";
import { ContextView } from "../web/src/context-page.js";
import type { WebContext } from "../src/web/protocol.js";

/** The SDK's real shape: the counted rows add up to `used`; deferred, buffer and free do not count. */
const BREAKDOWN = [{ name: "System prompt", tokens: 9_200 }, { name: "System tools", tokens: 14_400 }, { name: "MCP tools", tokens: 3_400 },
  { name: "MCP tools (deferred)", tokens: 59_000 }, { name: "System tools (deferred)", tokens: 15_500 }, { name: "Custom agents", tokens: 500 },
  { name: "Memory files", tokens: 100 }, { name: "Skills", tokens: 3_800 }, { name: "Messages", tokens: 97_000 },
  { name: "Compact buffer", tokens: 3_000 }, { name: "Free space", tokens: 68_600 }];
const context = (over: Partial<WebContext> = {}): WebContext => ({ used: 128_400, max: 200_000, estimated: false, recordedAt: null, breakdown: BREAKDOWN,
  analysisStatus: "unavailable", analysis: null, summaries: [], summariesTruncated: false, ...over });
const render = (value: WebContext) => renderToStaticMarkup(createElement(ContextView, { value, title: "Owner conversation" }));

describe("how full the window is", () => {
  it("is a share of the window, clamped, and zero without a window", () => {
    expect(fillPercent(128_400, 200_000)).toBeCloseTo(64.2);
    expect(fillPercent(250_000, 200_000)).toBe(100);
    expect(fillPercent(10, 0)).toBe(0);
    expect(fillPercent(-5, 100)).toBe(0);
  });

  it("grades calm, warn and critical at the documented thresholds", () => {
    expect([0, 64, CONTEXT_WARN_PERCENT - 0.1].map(fillTone)).toEqual(["calm", "calm", "calm"]);
    expect([CONTEXT_WARN_PERCENT, 94.9].map(fillTone)).toEqual(["warn", "warn"]);
    expect([CONTEXT_CRITICAL_PERCENT, 100].map(fillTone)).toEqual(["critical", "critical"]);
  });

  it("never rounds a small share to 0% or an almost-full one to 100%", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.05)).toBe("<1%");
    expect(formatPercent(64.2)).toBe("64%");
    expect(formatPercent(99.7)).toBe("99%");
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("what the window is made of", () => {
  it("tells apart what occupies the window from deferred tools, the reserve and free space", () => {
    expect(BREAKDOWN.map((row) => categoryKind(row.name))).toEqual(["fixed", "fixed", "fixed", "deferred", "deferred", "fixed", "fixed", "fixed", "conversation", "reserved", "free"]);
    expect(categoryKind("Autocompact buffer")).toBe("reserved");
  });

  it("splits the window into conversation, always-loaded, reserve and free, which add up to the window", () => {
    const parts = composeWindow(BREAKDOWN, 128_400, 200_000);
    expect(parts).toMatchObject({ conversation: 97_000, fixed: 31_400, reserved: 3_000, free: 68_600 });
    expect(parts.conversation + parts.fixed + parts.reserved + parts.free).toBe(200_000);
    expect(parts.counted.map((row) => row.name)).toEqual(["Messages", "System tools", "System prompt", "Skills", "MCP tools", "Custom agents", "Memory files"]);
    expect(parts.deferred).toEqual([{ name: "MCP tools", tokens: 59_000 }, { name: "System tools", tokens: 15_500 }]);
    expect(parts.segments.map((s) => [s.kind, s.percent])).toEqual([["conversation", 48.5], ["fixed", 15.7], ["reserved", 1.5]]);
  });

  it("trusts `used` over a breakdown that does not add up to it, and never overflows the window", () => {
    // An estimated reading: the rows say 50k, the window reading says 100k.
    const scaled = composeWindow([{ name: "Messages", tokens: 40_000 }, { name: "System prompt", tokens: 10_000 }], 100_000, 200_000);
    expect(scaled).toMatchObject({ conversation: 80_000, fixed: 20_000, free: 100_000 });
    const over = composeWindow([{ name: "Messages", tokens: 300_000 }, { name: "Compact buffer", tokens: 3_000 }], 300_000, 200_000);
    expect(over).toMatchObject({ conversation: 200_000, reserved: 0, free: 0 });
    expect(over.segments.reduce((sum, s) => sum + s.percent, 0)).toBe(100);
  });

  it("is one undivided piece without a breakdown, and nothing without a window", () => {
    expect(composeWindow([], 50_000, 200_000).segments).toEqual([{ kind: "used", tokens: 50_000, percent: 25 }]);
    expect(composeWindow(BREAKDOWN, 0, 0).segments).toEqual([]);
  });
});

describe("rollup blocks", () => {
  it("titles a block by the period it covers", () => {
    expect(rollupTitle("daily 2026-11-12", "en-US")).toBe("Thu, Nov 12, 2026");
    expect(rollupTitle("weekly 2026-W45", "en-US")).toBe("Nov 2 – Nov 8, 2026");
    // ISO week 1 can start in the previous year.
    expect(rollupTitle("weekly 2026-W01", "en-US")).toBe("Dec 29 – Jan 4, 2026");
    expect(rollupTitle("monthly 2026-10", "en-US")).toBe("October 2026");
    expect(rollupTitle("yearly 2025", "en-US")).toBe("2025");
    expect(rollupTitle("legacy")).toBe("Compact summary");
  });

  it("shows a tag it cannot read as written", () => {
    for (const tag of ["daily 2026-13-40", "daily 2026-02-31", "weekly 2026-W54", "monthly 2026-00", "something else"]) expect(rollupTitle(tag, "en-US")).toBe(tag);
  });

  it("counts blocks per level, smallest period first", () => {
    expect(rollupCounts([{ level: "legacy" }, { level: "monthly" }, { level: "daily" }, { level: "weekly" }, { level: "daily" }]))
      .toEqual([{ level: "daily", count: 2 }, { level: "weekly", count: 1 }, { level: "monthly", count: 1 }, { level: "legacy", count: 1 }]);
  });

  it("says how much a compaction freed, or nothing when it cannot know", () => {
    expect(compactionFreed(200_000, 50_000)).toBe(75);
    expect(compactionFreed(undefined, 50_000)).toBeNull();
    expect(compactionFreed(50_000, 50_000)).toBeNull();
    expect(compactionFreed(0, 0)).toBeNull();
  });
});

describe("the Context page", () => {
  it("leads with the share used and its state, and draws the window as conversation, always-loaded and reserve", () => {
    const html = render(context());
    expect(html).toContain(">64%<");
    expect(html).toContain("Room to spare");
    expect(html).toMatch(/role="meter"[^>]*aria-valuenow="128400"/);
    expect(html).toMatch(/role="meter"[^>]*data-tone="calm"/);
    expect([...html.matchAll(/data-segment="(\w+)"/g)].map((m) => m[1])).toEqual(["conversation", "fixed", "reserved"]);
  });

  // The page used to list every SDK row as if it filled the window, "Free space" and deferred tools included.
  it("does not list free space, the buffer or deferred tools among what fills the window", () => {
    const html = render(context());
    const fills = /<ul aria-label="What fills the window"[^>]*>(.*?)<\/ul>/.exec(html)![1];
    expect(fills).toContain("Messages");
    expect(fills).not.toMatch(/Free space|Compact buffer|deferred/);
    expect(/<ul aria-label="Deferred, not in the window"[^>]*>(.*?)<\/ul>/.exec(html)![1]).toContain("59.0k");
  });

  it("colours the meter by how full the window is", () => {
    expect(render(context({ used: 170_000 }))).toMatch(/role="meter"[^>]*data-tone="warn"/);
    const full = render(context({ used: 196_000 }));
    expect(full).toMatch(/role="meter"[^>]*data-tone="critical"/);
    expect(full).toContain("Nearly full");
    expect(full).toMatch(/data-segment="conversation"[^>]*class="[^"]*bg-destructive/);
  });

  it("says a missing window is unavailable, never 0%", () => {
    const html = render(context({ used: null, max: null, breakdown: [] }));
    expect(html).toContain("Unavailable until a turn reports its context window.");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("0%");
  });

  it("lists rollups by period with their size, and compactions with what they freed", () => {
    const html = render(context({ summaries: [{ tag: "daily 2026-11-12", level: "daily", timestamp: "2026-11-13T09:00:00.000Z", eventsSummarized: 184, content: "Did things.", truncated: false }],
      recentCompactions: [{ timestamp: Date.UTC(2026, 10, 13), preTokens: 180_000, postTokens: 45_000 }] }));
    expect(html).toContain("daily 2026-11-12"); // the raw tag stays available (title)
    expect(html).toMatch(/184 <span[^>]*>events<\/span>/);
    expect(html).toContain("1 daily");
    expect(html).toContain("−75%");
  });
});
