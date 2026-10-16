import { describe, expect, it } from "vitest";
import { describeResultFailure } from "../src/agent/live-session.js";

/**
 * describeResultFailure must carry `num_turns` onto the error, or a failed
 * resume (zero turns) can't be told apart from a turn that ran and failed —
 * and only the former is safe to re-run.
 */
describe("SdkResultError.isResumeMissing", () => {
  const missing = { subtype: "error_during_execution", errors: ["No conversation found with session ID: x"] };

  it("is true for a zero-turn missing-conversation result", () => {
    expect(describeResultFailure({ ...missing, num_turns: 0 })?.isResumeMissing).toBe(true);
  });

  it("is false when any turn ran", () => {
    expect(describeResultFailure({ ...missing, num_turns: 2 })?.isResumeMissing).toBe(false);
  });

  it("is false when num_turns is unknown", () => {
    expect(describeResultFailure(missing)?.isResumeMissing).toBe(false);
  });

  it("is false when another error is mixed in", () => {
    expect(
      describeResultFailure({ ...missing, errors: [...missing.errors, "Session is closed"], num_turns: 0 })?.isResumeMissing,
    ).toBe(false);
  });

  it("is false for other subtypes", () => {
    expect(describeResultFailure({ subtype: "error_max_turns", errors: missing.errors, num_turns: 0 })?.isResumeMissing).toBe(false);
  });
});
