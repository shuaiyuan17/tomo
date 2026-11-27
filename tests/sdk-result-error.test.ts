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

/**
 * The CLI's API error message as the turn's last assistant frame: the turn
 * failed even when the result is not marked `is_error`, and only a login
 * refused before any work may be sent again.
 */
describe("describeResultFailure with the turn's API error message", () => {
  const text = "Not logged in · Please run /login";
  const auth = { kind: "authentication_failed" as const, text, nothingRan: true };

  it("is a failure carrying the error line even when the result is not marked as an error", () => {
    const failure = describeResultFailure({ subtype: "success", result: text, num_turns: 1 }, auth);
    expect(failure?.message).toBe(text);
    expect(failure?.isAuthFailureBeforeAnyWork).toBe(true);
  });

  it("keeps the result's own error text on an is_error result", () => {
    const failure = describeResultFailure({ subtype: "success", is_error: true, result: "API Error: 401 nope" }, auth);
    expect(failure?.message).toBe("API Error: 401 nope");
    expect(failure?.isAuthFailureBeforeAnyWork).toBe(true);
  });

  it.each([
    ["the turn had done something", { ...auth, nothingRan: false }],
    ["the error is another kind", { ...auth, kind: "overloaded" as const }],
  ])("is not safe to send again when %s", (_label, apiError) => {
    expect(describeResultFailure({ subtype: "success", is_error: true, result: text }, apiError)?.isAuthFailureBeforeAnyWork).toBe(false);
  });

  it("is not safe to send again without a typed API error", () => {
    expect(describeResultFailure({ subtype: "success", is_error: true, result: text })?.isAuthFailureBeforeAnyWork).toBe(false);
    expect(describeResultFailure({ subtype: "success", result: "fine" })).toBeNull();
  });
});
