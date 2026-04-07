import { describe, it, expect } from "vitest";

// Test the silent reply detection (extracted logic)
function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

describe("isSilentReply", () => {
  it("detects NO_REPLY", () => {
    expect(isSilentReply("NO_REPLY")).toBe(true);
  });

  it("detects with whitespace", () => {
    expect(isSilentReply("  NO_REPLY  ")).toBe(true);
    expect(isSilentReply("\nNO_REPLY\n")).toBe(true);
  });

  it("case insensitive", () => {
    expect(isSilentReply("no_reply")).toBe(true);
    expect(isSilentReply("No_Reply")).toBe(true);
  });

  it("rejects messages with content", () => {
    expect(isSilentReply("Here is a response. NO_REPLY")).toBe(false);
    expect(isSilentReply("NO_REPLY but also this")).toBe(false);
    expect(isSilentReply("hello")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSilentReply("")).toBe(false);
  });
});

// Test timestamp injection (extracted logic)
function injectTimestamp(text: string): string {
  const now = new Date("2026-04-06T17:30:00-07:00");
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const date = `${mm}/${dd}`;
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `[${weekday} ${date} ${time} ${tz}] ${text}`;
}

describe("injectTimestamp", () => {
  it("prepends timestamp to message", () => {
    const result = injectTimestamp("hello");
    expect(result).toMatch(/^\[.+ \d{2}\/\d{2} \d{2}:\d{2} .+\] hello$/);
  });

  it("preserves original text", () => {
    const result = injectTimestamp("test message");
    expect(result).toContain("test message");
  });
});
