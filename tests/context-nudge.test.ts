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
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "none", newLatch: null });
  });

  it("nudges daily at the daily threshold when the range exists", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "daily", newLatch: "daily" });
  });

  it("escalates to compact when the daily range is empty", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      prunableSufficient: false,
      dailyRangeAvailable: false,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "daily-empty" });
  });

  it("tries prune first when enough tool output is reclaimable", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      prunableSufficient: true,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "prune", newLatch: "prune" });
  });

  it("tries prune before escalating an empty daily range", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: undefined,
      prunableSufficient: true,
      dailyRangeAvailable: false,
      thresholds,
    })).toEqual({ kind: "prune", newLatch: "prune" });
  });

  it("moves from a prune latch to daily without repeating prune", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: "prune",
      prunableSufficient: true,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "daily", newLatch: "daily" });
  });

  it("moves from a prune latch to compact when the daily range is empty", () => {
    expect(decideContextNudge({
      usedFrac: 0.72,
      latchState: "prune",
      prunableSufficient: true,
      dailyRangeAvailable: false,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "daily-empty" });
  });

  it("escalates from a daily latch at the compact threshold", () => {
    expect(decideContextNudge({
      usedFrac: 0.8,
      latchState: "daily",
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "threshold" });
  });

  it("escalates from a prune latch at the compact threshold", () => {
    expect(decideContextNudge({
      usedFrac: 0.8,
      latchState: "prune",
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "compact", newLatch: "compact", reason: "threshold" });
  });

  it("does not repeat a compact nudge while compact-latched", () => {
    expect(decideContextNudge({
      usedFrac: 0.8,
      latchState: "compact",
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "none", newLatch: "compact" });
  });

  it("clears a prune latch below reset without nudging", () => {
    expect(decideContextNudge({
      usedFrac: 0.59,
      latchState: "prune",
      prunableSufficient: false,
      dailyRangeAvailable: true,
      thresholds,
    })).toEqual({ kind: "none", newLatch: null });
  });
});
