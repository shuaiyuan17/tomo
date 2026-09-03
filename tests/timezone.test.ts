import { describe, it, expect } from "vitest";
import { canonicalTimeZone, formatZonedClock, isValidTimeZone, validTimeZone } from "../src/timezone.js";

// ---------------------------------------------------------------------------
// The time zone gate every people-registry surface goes through. Two things
// matter here: nothing unusable ever gets past it, and every reading comes
// from the platform tz database rather than from arithmetic on a stored
// offset — which is what makes daylight saving somebody else's problem.
// ---------------------------------------------------------------------------

describe("time zone validation", () => {
  it("canonicalizes identifiers, including case and legacy spellings", () => {
    expect(canonicalTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(canonicalTimeZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(canonicalTimeZone("  America/New_York  ")).toBe("America/New_York");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
  });

  it("rejects junk, blanks, and missing values without throwing", () => {
    expect(canonicalTimeZone("Not/AZone")).toBeUndefined();
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(canonicalTimeZone("")).toBeUndefined();
    expect(canonicalTimeZone("   ")).toBeUndefined();
    expect(canonicalTimeZone(undefined)).toBeUndefined();
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  // Intl accepts these, and they are exactly the values that quietly sit an
  // hour wrong for half the year.
  it("rejects fixed-offset forms even though Intl accepts them", () => {
    expect(canonicalTimeZone("+09:00")).toBeUndefined();
    expect(canonicalTimeZone("-05:00")).toBeUndefined();
  });

  it("degrades an unusable value to undefined on the read path", () => {
    expect(validTimeZone("Not/AZone", { person: "Alice Example" })).toBeUndefined();
    expect(validTimeZone(undefined)).toBeUndefined();
    expect(validTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("formatZonedClock", () => {
  it("renders the wall clock of the requested zone", () => {
    // 2026-09-03T03:50Z
    const instant = new Date(Date.UTC(2026, 8, 3, 3, 50));
    expect(formatZonedClock(instant, "UTC")).toBe("09/03 03:50 UTC");
    expect(formatZonedClock(instant, "Asia/Tokyo")).toBe("09/03 12:50 GMT+9");
    // Crosses back over the date line into the previous day.
    expect(formatZonedClock(instant, "America/New_York")).toBe("09/02 23:50 EDT");
  });

  it("follows daylight saving through the tz database, not a stored offset", () => {
    // Same zone, same wall-clock hour, six months apart: the UTC instants are
    // an hour apart and the abbreviation changes. Anything computing from a
    // fixed offset would put one of these an hour out.
    const winter = new Date(Date.UTC(2026, 0, 15, 17, 0));
    const summer = new Date(Date.UTC(2026, 6, 15, 16, 0));
    expect(formatZonedClock(winter, "America/New_York")).toBe("01/15 12:00 EST");
    expect(formatZonedClock(summer, "America/New_York")).toBe("07/15 12:00 EDT");
  });

  it("falls back to the host zone when none is given", () => {
    const instant = new Date(Date.UTC(2026, 8, 3, 3, 50));
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formatZonedClock(instant)).toBe(formatZonedClock(instant, host));
  });
});
