import { describe, expect, it } from "vitest";

// Revert-catcher for vitest.config.ts blanking TOMO_LOG_FILE. Only bites when
// the suite runs from a shell that has the daemon's TOMO_LOG_FILE exported
// (the case that leaked test records into the production log); in a clean CI
// environment the variable is unset either way.
describe("test environment", () => {
  it("does not point the logger at a real log file", () => {
    expect(process.env.TOMO_LOG_FILE?.trim() ?? "").toBe("");
  });
});
