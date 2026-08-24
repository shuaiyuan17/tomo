import { describe, it, expect } from "vitest";
import { nudgeText } from "../src/lcm/runner.js";

const promo = (level: "daily" | "weekly") => ({
  level,
  period: level === "daily" ? "2026-08-23" : "2026-W34",
  childCount: 42,
}) as Parameters<typeof nudgeText>[0];

describe("rollup nudge text", () => {
  it("tells the writer to pair an interval with the date when duration is load-bearing", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    // The guidance itself...
    expect(text).toMatch(/elapsed interval carries meaning/);
    // ...and the worked example, which is what actually gets imitated.
    expect(text).toContain('"opened 8/7, sat 17 days"');
    // The reason, without which this reads as "add more words".
    expect(text).toMatch(/arithmetic they will not actually do/);
  });

  it("also tells the writer when NOT to, so it does not become an every-line tic", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    expect(text).toMatch(/Skip it where duration is not load-bearing/);
  });

  it("carries the guidance at every level, not just daily", () => {
    // A weekly rollup is where intervals matter most — it spans the longest gaps.
    const weekly = nudgeText(promo("weekly"), "sess-1", "dm:someone");
    expect(weekly).toMatch(/elapsed interval carries meaning/);
  });
});
