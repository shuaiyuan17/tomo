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

  it("never rescales a breakdown from another reading to look current: the meter stays undivided and the rows are flagged stale", () => {
    // The context query failed; only an estimate (100k) is known, and the rows (50k) are from the last full reading.
    const rows = [{ name: "Messages", tokens: 40_000 }, { name: "System prompt", tokens: 10_000 }];
    const mismatch = composeWindow(rows, 100_000, 200_000);
    expect(mismatch).toMatchObject({ stale: true, listed: 50_000, conversation: 0, fixed: 0, free: 100_000 });
    expect(mismatch.segments).toEqual([{ kind: "used", tokens: 100_000, percent: 50 }]);
    expect(mismatch.counted.map((row) => row.tokens)).toEqual([40_000, 10_000]);
    // An estimate is never a measured breakdown, even when the numbers happen to agree.
    expect(composeWindow(rows, 50_000, 200_000, true)).toMatchObject({ stale: true, conversation: 0 });
    // Rounding is not staleness.
    expect(composeWindow(rows, 50_200, 200_000)).toMatchObject({ stale: false, conversation: 40_160, fixed: 10_040 });
  });

  it("never overflows the window", () => {
    const over = composeWindow([{ name: "Messages", tokens: 300_000 }, { name: "Compact buffer", tokens: 3_000 }], 300_000, 200_000);
    expect(over).toMatchObject({ stale: false, conversation: 200_000, reserved: 0, free: 0 });
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
    // ISO week 1 can start in the previous year: both years are named.
    expect(rollupTitle("weekly 2026-W01", "en-US")).toBe("Dec 29, 2025 – Jan 4, 2026");
    expect(rollupTitle("weekly 2026-W53", "en-US")).toBe("Dec 28, 2026 – Jan 3, 2027");
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
    // A fuller window whose rows still add up to the reading: the conversation grew.
    const grown = (used: number) => context({ used, breakdown: BREAKDOWN.map((row) => row.name === "Messages" ? { ...row, tokens: used - 31_400 } : row) });
    expect(render(grown(170_000))).toMatch(/role="meter"[^>]*data-tone="warn"/);
    const full = render(grown(196_000));
    expect(full).toMatch(/role="meter"[^>]*data-tone="critical"/);
    expect(full).toContain("Nearly full");
    expect(full).toMatch(/data-segment="conversation"[^>]*class="[^"]*bg-destructive/);
  });

  // A failed context query leaves an estimate beside the rows of the last full reading: "97.0k · 100%" must not appear.
  it("shows a breakdown from another reading as that reading, not as the current measurement", () => {
    const html = render(context({ used: 60_000, estimated: true }));
    expect(html).toContain(">30%<");
    expect([...html.matchAll(/data-segment="(\w+)"/g)].map((m) => m[1])).toEqual(["used", "reserved"]);
    expect(html).toContain("What filled it");
    expect(html).toContain("data-stale-breakdown");
    expect(html).toContain("128k at the last full reading");
    const rows = /<ul aria-label="What filled the window at the last full reading"[^>]*>(.*?)<\/ul>/.exec(html)![1];
    expect(rows).toMatch(/97\.0k<span[^>]*>76%<\/span>/); // of the 128.4k it was measured with, not of the 60k estimate
    expect(html).not.toContain("What fills it");
    expect(render(context())).not.toContain("data-stale-breakdown");
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
