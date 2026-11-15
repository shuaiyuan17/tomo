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
  it("names the first row's day above the rows and puts each change of day at the END of the earlier row", () => {
    const yesterday = at(2026, 11, 14, 22);
    expect(dayDividers([{ at: yesterday }, { at: yesterday + 60_000 }, { at: at(2026, 11, 15, 1) }], now, "en-US"))
      .toEqual({ first: "Yesterday", after: [null, "Today", null] });
    // A row without a time (live content) takes the next timed row's day, else now.
    expect(dayDividers([{ at: yesterday }, {}], now, "en-US")).toEqual({ first: "Yesterday", after: ["Today", null] });
    expect(dayDividers([], now)).toEqual({ first: null, after: [] });
  });
  it("prepending a page never changes an existing row: only the label above the rows changes", () => {
    const shown = [{ at: at(2026, 11, 14, 9) }, { at: at(2026, 11, 15, 9) }];
    const before = dayDividers(shown, now, "en-US");
    // An earlier page that ends on the same day as the first shown row …
    const same = dayDividers([{ at: at(2026, 11, 14, 8) }, ...shown], now, "en-US");
    // … or on an earlier day: the new row carries the divider, at its end.
    const earlier = dayDividers([{ at: at(2026, 11, 13, 8) }, ...shown], now, "en-US");
    expect(same.after.slice(1)).toEqual(before.after);
    expect(earlier.after.slice(1)).toEqual(before.after);
    expect([same.after[0], earlier.after[0], earlier.first]).toEqual([null, "Yesterday", "Friday"]);
  });
  it("a late (pending / live) row never announces a day earlier than the row before it", () => {
    // An interrupted request from Monday, kept after today's history: no "Today … Monday … Today".
    const monday = at(2026, 11, 9, 9);
    expect(dayDividers([{ at: at(2026, 11, 15, 8) }, { at: monday, late: true }, {}], now, "en-US"))
      .toEqual({ first: "Today", after: [null, null, null] });
    // A late row on a later day still gets its divider; a history row is never moved.
    expect(dayDividers([{ at: at(2026, 11, 14, 8) }, { at: at(2026, 11, 15, 8), late: true }], now, "en-US").after).toEqual(["Today", null]);
    expect(dayDividers([{ at: at(2026, 11, 15, 8) }, { at: monday }], now, "en-US").after).toEqual(["Monday", null]);
  });
});
