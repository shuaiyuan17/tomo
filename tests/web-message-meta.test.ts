import { describe, expect, it } from "vitest";
import { channelLabel, dayDividers, dayLabel, dividerBefore, messageTime } from "../web/src/message-meta.js";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const now = at(2026, 11, 15, 10);

describe("message meta line", () => {
  it("names channels as their products spell them", () => {
    expect(channelLabel("web")).toBe("Web");
    expect(channelLabel("imessage")).toBe("iMessage");
    expect(channelLabel("telegram")).toBe("Telegram");
    expect(channelLabel("signal")).toBe("Signal");
    expect(channelLabel(undefined)).toBe("");
  });
  it("shows the hour without a leading zero", () => {
    expect(messageTime(at(2026, 11, 15, 6, 5), "en-US")).toBe("6:05 AM");
  });
});

describe("day dividers", () => {
  it("words a day relative to today", () => {
    expect(dayLabel(at(2026, 11, 15, 0, 1), now, "en-US")).toBe("Today");
    expect(dayLabel(at(2026, 11, 14, 23, 59), now, "en-US")).toBe("Yesterday");
    expect(dayLabel(at(2026, 11, 11), now, "en-US")).toBe("Wednesday");
    expect(dayLabel(at(2026, 11, 1), now, "en-US")).toBe("Sun, Nov 1");
    expect(dayLabel(at(2025, 12, 30), now, "en-US")).toBe("Tue, Dec 30, 2025");
  });
  it("marks the first message and each change of day, nothing else", () => {
    expect(dividerBefore(undefined, at(2026, 11, 15, 9), now, "en-US")).toBe("Today");
    expect(dividerBefore(at(2026, 11, 15, 8), at(2026, 11, 15, 9), now, "en-US")).toBeNull();
    expect(dividerBefore(at(2026, 11, 14, 23), at(2026, 11, 15, 0, 30), now, "en-US")).toBe("Today");
  });
  it("puts a tool run on the day of the reply it leads into, so the divider never splits them", () => {
    const yesterday = at(2026, 11, 14, 22);
    expect(dayDividers([yesterday, undefined, at(2026, 11, 15, 1)], now, "en-US")).toEqual(["Yesterday", "Today", null]);
    // A trailing run with no message after it is today's.
    expect(dayDividers([yesterday, undefined], now, "en-US")).toEqual(["Yesterday", "Today"]);
    expect(dayDividers([], now)).toEqual([]);
  });
});
