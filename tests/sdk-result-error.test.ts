import { describe, expect, it } from "vitest";
import { describeResultFailure } from "../src/agent/live-session.js";

/**
 * describeResultFailure must carry `num_turns` onto the error, or a failed
 * resume (zero turns) can't be told apart from a turn that ran and failed —
 * and only the former is safe to re-run.
 */
describe("SdkResultError.isResumeMissing", () => {
  const missing = { subtype: "error_during_execution", errors: ["No conversation found with session ID: x"] };

  // Only a zero-turn result whose ONLY error is the missing conversation is
  // safe to re-run as a fresh session.
  it.each([
    ["is true for a zero-turn missing-conversation result", { ...missing, num_turns: 0 }, true],
    ["is false when any turn ran", { ...missing, num_turns: 2 }, false],
    ["is false when num_turns is unknown", missing, false],
    ["is false when another error is mixed in", { ...missing, errors: [...missing.errors, "Session is closed"], num_turns: 0 }, false],
    ["is false for other subtypes", { subtype: "error_max_turns", errors: missing.errors, num_turns: 0 }, false],
  ])("%s", (_label, result, expected) => {
    expect(describeResultFailure(result)?.isResumeMissing).toBe(expected);
  });
});
