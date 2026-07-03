import { describe, expect, it } from "vitest";
import { decideContextNudge } from "../src/agent/context-nudge.js";

const thresholds = {
  nudgeAtPct: 70,
  nudgeResetPct: 60,
  compactNudgePct: 80,
};

describe("decideContextNudge", () => {
  it("clears the latch below reset without nudging", () => {
    expect(decideContextNudge({
      usedFrac: 0.59,
      latchState: "daily",
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "none", newLatch: null });
  });

  it("nudges daily at the daily threshold when the range exists", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "daily", newLatch: "daily" });
  });

  it("escalates to compact when the daily range is empty", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      dailyRangeAvailable: false,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "daily-empty" });
  });

  it("escalates from a daily latch at the compact threshold", () => {
    expect(decideContextNudge({
      usedFrac: 0.8,
      latchState: "daily",
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "threshold" });
  });

  it("does not repeat a compact nudge while compact-latched", () => {
    expect(decideContextNudge({
      usedFrac: 0.8,
      latchState: "compact",
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "none", newLatch: "compact" });
  });
});
