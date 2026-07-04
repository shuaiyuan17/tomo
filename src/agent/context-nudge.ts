export type ContextNudgeLatch = "prune" | "daily" | "compact";

export type ContextNudgeDecision =
  | {
      kind: "none";
      newLatch: ContextNudgeLatch | null;
    }
  | {
      kind: "prune";
      newLatch: "prune";
    }
  | {
      kind: "daily";
      newLatch: "daily";
    }
  | {
      kind: "compact";
      newLatch: "compact";
      reason: "threshold" | "daily-empty";
    };

interface DecideContextNudgeInput {
  usedFrac: number;
  latchState: ContextNudgeLatch | undefined;
  prunableSufficient: boolean;
  dailyRangeAvailable: boolean;
  thresholds: {
    nudgeAtPct: number;
    nudgeResetPct: number;
    compactNudgePct: number;
  };
}

export function decideContextNudge(input: DecideContextNudgeInput): ContextNudgeDecision {
  const { usedFrac, latchState, prunableSufficient, dailyRangeAvailable, thresholds } = input;

  if (usedFrac < thresholds.nudgeResetPct / 100) {
    return { kind: "none", newLatch: null };
  }

  const compactFrac = Math.max(thresholds.compactNudgePct, thresholds.nudgeAtPct) / 100;
  if (usedFrac >= compactFrac) {
    if (latchState !== "compact") {
      return { kind: "compact", newLatch: "compact", reason: "threshold" };
    }
    return { kind: "none", newLatch: latchState };
  }

  if (usedFrac >= thresholds.nudgeAtPct / 100) {
    if (!latchState && prunableSufficient) {
      return { kind: "prune", newLatch: "prune" };
    }

    if (!latchState || latchState === "prune") {
      if (dailyRangeAvailable) {
        return { kind: "daily", newLatch: "daily" };
      }
      return { kind: "compact", newLatch: "compact", reason: "daily-empty" };
    }

    if (latchState === "daily" || latchState === "compact") {
      return { kind: "none", newLatch: latchState };
    }
  }

  return { kind: "none", newLatch: latchState ?? null };
}
