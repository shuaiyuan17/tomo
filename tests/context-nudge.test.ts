import { describe, expect, it } from "vitest";
import { decideContextNudge, type ContextNudgeDecision, type ContextNudgeLatch } from "../src/agent/context-nudge.js";

const thresholds = {
  nudgeAtPct: 70,
  nudgeResetPct: 60,
  compactNudgePct: 80,
};

type Latch = ContextNudgeLatch | undefined;

/**
 * One row per situation: how full the context is, what was nudged last (the
 * latch), whether pruning would reclaim enough, and whether a daily rollup has
 * a range to work on. Between reset (60%) and the nudge threshold (70%) is the
 * hysteresis band: nothing is nudged, and the latch is kept, so a session
 * hovering around 70% is not nudged on every turn.
 */
describe("decideContextNudge", () => {
  it.each<[string, number, Latch, boolean, boolean, ContextNudgeDecision]>([
    // label                                                     used  latch      prunable daily  expected
    ["clears the latch below reset without nudging",             0.59, "daily",   false,   true,  { kind: "none", newLatch: null }],
    ["clears a prune latch below reset without nudging",         0.59, "prune",   false,   true,  { kind: "none", newLatch: null }],
    ["keeps the latch inside the hysteresis band",               0.65, "daily",   false,   true,  { kind: "none", newLatch: "daily" }],
    ["nudges nothing inside the band with no latch",             0.65, undefined, true,    true,  { kind: "none", newLatch: null }],
    ["nudges daily at the daily threshold when the range exists", 0.72, undefined, false, true,  { kind: "daily", newLatch: "daily" }],
    ["does not repeat a daily nudge while daily-latched",        0.72, "daily",   false,   true,  { kind: "none", newLatch: "daily" }],
    ["escalates to compact when the daily range is empty",       0.72, undefined, false,   false, { kind: "compact", newLatch: "compact", reason: "daily-empty" }],
    ["tries prune first when enough tool output is reclaimable", 0.72, undefined, true,    true,  { kind: "prune", newLatch: "prune" }],
    ["tries prune before escalating an empty daily range",       0.72, undefined, true,    false, { kind: "prune", newLatch: "prune" }],
    ["moves from a prune latch to daily without repeating prune", 0.72, "prune",  true,    true,  { kind: "daily", newLatch: "daily" }],
    ["moves from a prune latch to compact when the daily range is empty", 0.72, "prune", true, false, { kind: "compact", newLatch: "compact", reason: "daily-empty" }],
    ["escalates from a daily latch at the compact threshold",    0.8,  "daily",   false,   true,  { kind: "compact", newLatch: "compact", reason: "threshold" }],
    ["escalates from a prune latch at the compact threshold",    0.8,  "prune",   false,   true,  { kind: "compact", newLatch: "compact", reason: "threshold" }],
    ["nudges compact on a fresh session already past the threshold", 0.85, undefined, true, true, { kind: "compact", newLatch: "compact", reason: "threshold" }],
    ["does not repeat a compact nudge while compact-latched",    0.8,  "compact", false,   true,  { kind: "none", newLatch: "compact" }],
  ])("%s", (_label, usedFrac, latchState, prunableSufficient, dailyRangeAvailable, expected) => {
    expect(decideContextNudge({ usedFrac, latchState, prunableSufficient, dailyRangeAvailable, thresholds })).toEqual(expected);
  });

  // A compact threshold set below the nudge threshold is raised to it
  // (Math.max): nothing fires below 70%, so the 50% setting is not obeyed,
  // and at 70% the two thresholds coincide and compact wins.
  it("never puts the compact threshold below the nudge threshold", () => {
    const low = { ...thresholds, compactNudgePct: 50 };
    expect(decideContextNudge({ usedFrac: 0.65, latchState: undefined, prunableSufficient: false, dailyRangeAvailable: true, thresholds: low }))
      .toEqual({ kind: "none", newLatch: null });
    expect(decideContextNudge({ usedFrac: 0.7, latchState: undefined, prunableSufficient: false, dailyRangeAvailable: true, thresholds: low }))
      .toEqual({ kind: "compact", newLatch: "compact", reason: "threshold" });
  });
});
