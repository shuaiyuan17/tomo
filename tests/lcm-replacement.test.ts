import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: { lcm: { dailyFreshTail: 32, globalFreshTail: false } },
}));

import { blockReplacementError } from "../src/cli/lcm.js";
import { buildRollupNudge } from "../src/lcm/runner.js";

describe("LCM replacement safety", () => {
  it("requires explicit replacement authorization for an existing block", () => {
    const error = blockReplacementError(
      { blockTag: "daily 2026-07-03", replacesExistingBlock: true },
      false,
      "session-123",
      "daily",
    );

    expect(error).toContain("already has a summary block");
    expect(error).toContain("tomo lcm blocks --session-id session-123 --level daily --full");
    expect(error).toContain("--replace");
  });

  it("allows block creation and explicitly authorized replacement", () => {
    expect(blockReplacementError(
      { blockTag: "daily 2026-07-03", replacesExistingBlock: false },
      false,
      "session-123",
      "daily",
    )).toBeNull();
    expect(blockReplacementError(
      { blockTag: "daily 2026-07-03", replacesExistingBlock: true },
      true,
      "session-123",
      "daily",
    )).toBeNull();
  });

  it("warns repeat-rollup nudges and supplies --replace", () => {
    const nudge = buildRollupNudge({
      level: "daily",
      period: "2026-07-03",
      childCount: 84,
      replacesExistingBlock: true,
    }, "session-123", "dm:shuai");

    expect(nudge).toContain("already has a summary block");
    expect(nudge).toContain("REPLACES that summary; it does not append");
    expect(nudge).toContain(
      "tomo lcm daily --session-id session-123 --date 2026-07-03 --replace --summary",
    );
  });

  it("keeps first-rollup nudges free of replacement instructions", () => {
    const nudge = buildRollupNudge({
      level: "daily",
      period: "2026-07-03",
      childCount: 42,
      replacesExistingBlock: false,
    }, "session-123", "dm:shuai");

    expect(nudge).not.toContain("already has a summary block");
    expect(nudge).not.toContain("--replace");
  });
});
