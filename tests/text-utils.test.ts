import { describe, expect, it } from "vitest";
import { endsWithTrailingNoReply, stripTrailingNoReply } from "../src/agent/text-utils.js";

// Trailing bare-NO_REPLY line(s) mark a response as not-for-the-channel and
// suppress it whole (owner decision 2026-07-08). Inline mentions never trip
// the check — only trailing lines are inspected.
describe("endsWithTrailingNoReply", () => {
  it("is true for a bare NO_REPLY token", () => {
    expect(endsWithTrailingNoReply("NO_REPLY")).toBe(true);
    expect(endsWithTrailingNoReply("  no_reply  ")).toBe(true);
  });

  it("is true for narration followed by a trailing NO_REPLY line", () => {
    expect(endsWithTrailingNoReply("archived the logs, nothing urgent\nNO_REPLY")).toBe(true);
  });

  it("is true for multiple trailing NO_REPLY lines", () => {
    expect(endsWithTrailingNoReply("did housekeeping\nNO_REPLY\nNO_REPLY")).toBe(true);
    expect(endsWithTrailingNoReply("did housekeeping\nNO_REPLY\n\nNO_REPLY\n")).toBe(true);
  });

  it("is false for an inline mention mid-text", () => {
    expect(endsWithTrailingNoReply("I end housekeeping turns with NO_REPLY when done.")).toBe(false);
    expect(endsWithTrailingNoReply("did the thing. NO_REPLY")).toBe(false);
  });

  it("is false for empty and whitespace-only strings", () => {
    expect(endsWithTrailingNoReply("")).toBe(false);
    expect(endsWithTrailingNoReply("  \n  ")).toBe(false);
  });

  it("is false when NO_REPLY is followed by more prose", () => {
    expect(endsWithTrailingNoReply("NO_REPLY\njust kidding, here's the answer")).toBe(false);
    expect(endsWithTrailingNoReply("NO_REPLY plus more text")).toBe(false);
  });
});

describe("stripTrailingNoReply", () => {
  it("peels trailing NO_REPLY lines and reports them", () => {
    expect(stripTrailingNoReply("visible text\nNO_REPLY\nNO_REPLY")).toEqual({
      visible: "visible text",
      hadTrailingNoReply: true,
    });
  });

  it("returns the response untouched when there is no trailing token", () => {
    expect(stripTrailingNoReply("mentions NO_REPLY inline, then more")).toEqual({
      visible: "mentions NO_REPLY inline, then more",
      hadTrailingNoReply: false,
    });
  });
});
