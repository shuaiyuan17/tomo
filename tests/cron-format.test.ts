import { describe, it, expect } from "vitest";
import { formatSchedule, formatDuration, formatRelative } from "../src/cron/format.js";

describe("formatDuration", () => {
  it("formats seconds, minutes, hours, days", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(20 * 60_000)).toBe("20m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(2.5 * 3_600_000)).toBe("2h 30m");
    expect(formatDuration(3 * 86_400_000)).toBe("3d");
    expect(formatDuration(26 * 3_600_000)).toBe("1d 2h");
  });

  it("clamps negative input to zero", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("formatRelative", () => {
  const now = 1_000_000_000_000;

  it("says now/just now inside the 30s window", () => {
    expect(formatRelative(now + 10_000, now)).toBe("now");
    expect(formatRelative(now - 10_000, now)).toBe("just now");
  });

  it("formats future and past", () => {
    expect(formatRelative(now + 20 * 60_000, now)).toBe("in 20m");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});

describe("formatSchedule", () => {
  it("formats 'every' intervals with sensible units", () => {
    expect(formatSchedule({ kind: "every", everyMs: 2 * 3_600_000 })).toBe("every 2h");
    expect(formatSchedule({ kind: "every", everyMs: 30 * 60_000 })).toBe("every 30m");
  });

  it("formats cron expressions with optional timezone", () => {
    expect(formatSchedule({ kind: "cron", expr: "0 9 * * *" })).toBe("0 9 * * *");
    expect(formatSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).toBe("0 9 * * * (UTC)");
  });

  it("formats 'at' schedules, falling back to raw text for unparseable dates", () => {
    const at = new Date("2026-12-25T09:00:00Z");
    expect(formatSchedule({ kind: "at", at: at.toISOString() })).toBe(`once at ${at.toLocaleString()}`);
    expect(formatSchedule({ kind: "at", at: "garbage" })).toBe("once at garbage");
  });
});
